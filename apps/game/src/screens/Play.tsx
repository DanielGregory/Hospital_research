import { LIVE_CALLS, type Acuity, type Command, type LiveCall, type PlayerControl, type SimSnapshot } from '@er/sim';
import { useEffect, useRef, useState } from 'react';
import { ROLE_LABEL, type SetupValues } from '../controls';
import { clockLabel, minutes } from '../format';
import type { LevelConfig } from '../levels';
import { AlertWatch, type Alert } from '../play/alerts';
import { nextTip } from '../play/coach';
import { LivePanel, PLANNED, QUICK } from '../play/LivePanel';
import { personName } from '../play/names';
import { initialPlan, PlanDrawer, type PlanState } from '../play/PlanDrawer';
import { soundPreference, Soundscape } from '../play/sound';
import { acuityColor, drawFloor, inkOn } from '../render/draw';
import { layoutFloor, type FloorPlan } from '../render/floorPlan';
import { furnishGrid } from '../render/gridFurnish';
import { layoutGrid } from '../render/gridPlan';
import { Crowd, withActors, type Actor } from '../render/motion';
import type { Scene3D } from '../render/scene3d';
import { layoutWard } from '../render/wardPlan';
import { webglAvailable } from '../render/webgl';
import { GameRunner, SPEEDS, type Speed } from '../runner';
import type { GameConfig } from '../sandbox';

/** In a sandbox run the player may use every live control and every live call. */
export const SANDBOX_LIVE: PlayerControl[] = ['queue.discipline', 'staffing.doctors', 'staffing.triageNurses', 'fastTrack.enabled', 'beds.main'];

type View = '3d' | '2d';

/** The 3D view lays custom floor plans out at 2 m per grid cell (plans use 20 units per metre). */
const GRID_CELL_3D = 40;

const WAITING_FOR: Record<string, string> = {
  triage: 'waiting for triage',
  registration: 'waiting to register',
  bed: 'waiting for a bed',
  transfer: 'on the way to a bed',
  doctorEval: 'waiting for a doctor',
  disposition: 'waiting for a decision',
};

/** Display name for a patient. */
export function patientName(id: number, seed: number): string {
  const n = personName('patient', id, seed);
  return `${n.first} ${n.last}`;
}

/** One line about a person, for the hover tooltip. Names are made up. */
export function describe(a: Actor, seed = 1): string {
  if (a.kind === 'staff') {
    const d = a.data;
    const n = personName('staff', d.id, seed);
    const who = d.role === 'doctor' ? `Dr ${n.last}` : `${n.first} ${n.last}, ${ROLE_LABEL[d.role].replace(/s$/, '').toLowerCase()}`;
    return [who, d.busy ? 'with a patient' : 'free', d.leaving ? 'going off shift' : null, d.fatigue > 0.3 ? 'tired' : null].filter(Boolean).join(' · ');
  }
  const d = a.data;
  const level = d.acuity === undefined ? 'not triaged yet' : `ESI ${d.acuity}`;
  const status = a.leaving
    ? 'leaving'
    : d.boarding
      ? 'admitted, waiting for a ward bed'
      : d.inBed
        ? `in ${d.bedLabel ?? 'a bed'}`
        : d.waitingFor
          ? (WAITING_FOR[d.waitingFor] ?? `waiting (${d.waitingFor})`)
          : 'being seen';
  return [patientName(d.id, seed), level, status, `here ${minutes(d.waited)}`, d.special === 'massCasualty' ? 'came by ambulance' : d.special === 'bounceBack' ? 'came back' : null]
    .filter(Boolean)
    .join(' · ');
}

function savedView(): View {
  let v: string | null = null;
  try {
    v = localStorage.getItem('er-view');
  } catch {
    // storage blocked
  }
  if (v === '2d') return '2d';
  return webglAvailable() ? '3d' : '2d';
}

function savedAutoPause(): boolean {
  try {
    return localStorage.getItem('er-autopause') !== 'off';
  } catch {
    return true;
  }
}

/** Something holding the clock: an alert that paused the game, or a tutorial tip. */
interface Hold {
  title: string;
  body: string;
  resumeTo: Speed;
}

export function Play(props: { config: GameConfig; seed: number; values: SetupValues; onFinish: (runner: GameRunner) => void; onQuit: () => void }) {
  const { config, seed, onFinish, onQuit } = props;
  const runnerRef = useRef<GameRunner | null>(null);
  runnerRef.current ??= new GameRunner(config, seed);
  const runner = runnerRef.current;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<View>(savedView);
  const sceneRef = useRef<Scene3D | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [snap, setSnap] = useState<SimSnapshot>(() => runner.sim.snapshot());
  const [speed, setSpeed] = useState<Speed>(1);
  const [plan, setPlan] = useState<PlanState>(() => initialPlan(config, props.values));
  const [planOpen, setPlanOpen] = useState<Speed | null>(null);
  const [alerts, setAlerts] = useState<(Alert & { key: number })[]>([]);
  const [hold, setHold] = useState<Hold | null>(null);
  const [coach, setCoach] = useState<{ text: string; highlight?: string } | null>(null);
  const [autoPause, setAutoPause] = useState(savedAutoPause);
  const [soundOn, setSoundOn] = useState(soundPreference);
  const [notice, setNotice] = useState<string | null>(null);
  const finished = useRef(false);
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  const sound = useRef<Soundscape | null>(null);
  sound.current ??= new Soundscape(soundOn);
  // Refs the frame loop reads without restarting.
  const live = useRef({ autoPause, holding: false, planOpen: false });
  live.current = { autoPause, holding: hold !== null, planOpen: planOpen !== null };
  const watch = useRef(new AlertWatch());
  const shownTips = useRef(new Set<number>());
  const alertKey = useRef(0);

  const level = config.level ?? null;
  const controls = level?.playerControls ?? SANDBOX_LIVE;
  const calls: readonly LiveCall[] = level ? (level.liveCalls ?? []) : LIVE_CALLS;
  const planControls = controls.filter((c) => PLANNED.includes(c));
  const showFastTrack =
    runner.sim.config.fastTrack.enabled ||
    runner.sim.config.staff.fastTrackClinician > 0 ||
    !!runner.sim.config.schedule.fastTrackClinician ||
    controls.some((c) => c.startsWith('fastTrack'));

  const setRunSpeed = (s: Speed) => {
    runner.speed = s;
    setSpeed(s);
  };

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    let lastTip = 0;
    const crowd = new Crowd();
    let instant = true;
    let size = '';
    let scene: Scene3D | null = null;
    let cancelled = false;
    const canvas = canvasRef.current;
    const layout = runner.sim.config.layout;
    const tips = level?.coach ?? [];
    const frame = (t: number) => {
      const dt = Math.min(0.1, (t - last) / 1000);
      runner.advance(t - last);
      last = t;
      const s = runner.sim.snapshot();
      // People walk a little faster when the clock runs faster, and still finish their walk when paused.
      const pace = 1 + runner.speed * 0.4;
      if (canvas && (view === '2d' || scene)) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (scene) {
          if (size !== `${w}x${h}`) {
            size = `${w}x${h}`;
            scene.resize(w, h);
          }
          const floor: FloorPlan = layout
            ? furnishGrid(layoutGrid(s, layout, layout.width * GRID_CELL_3D, layout.height * GRID_CELL_3D), s, layout)
            : layoutWard(s, showFastTrack);
          const actors = crowd.update(floor, dt, { speed: 50 * pace, instant });
          scene.render(floor, actors, dt, t / 1000);
          // Tooltip for whoever is under the pointer, a few times a second.
          if (t - lastTip > 150) {
            lastTip = t;
            const p = pointer.current;
            const hit = p ? scene.pick(p.x, p.y) : null;
            const a = hit ? crowd.get(hit.key) : undefined;
            setTip(hit && a ? { x: hit.x, y: hit.y, text: describe(a, seed) } : null);
          }
        } else {
          const dpr = window.devicePixelRatio || 1;
          if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
          }
          // A resize moves everything: place people rather than walk them.
          if (size !== `${w}x${h}`) {
            size = `${w}x${h}`;
            instant = true;
          }
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            const floor = layout ? layoutGrid(s, layout, w, h) : layoutFloor(s, w, h, showFastTrack);
            const actors = crowd.update(floor, dt, { speed: w * 0.07 * pace, instant });
            drawFloor(ctx, withActors(floor, actors), w, h);
          }
        }
        instant = false;
      }
      sound.current?.update({
        waiting: s.patients.filter((p) => p.location === 'waiting').length,
        inBeds: s.patients.filter((p) => p.location === 'bed').length,
        running: runner.speed > 0,
      });
      if (t - lastUi > 100 || s.finished) {
        setSnap(s);
        lastUi = t;
        if (!s.finished) {
          // Alerts: show them, sound them, and pause for the serious ones if the player wants that.
          const fresh = watch.current.check(s);
          if (fresh.length) {
            if (fresh.some((a) => a.kind === 'incident')) sound.current?.siren(5);
            else if (fresh.some((a) => a.severity !== 'info')) sound.current?.chime();
            const stop = fresh.find((a) => a.pause);
            const pausing = !!stop && live.current.autoPause && !live.current.holding && !live.current.planOpen && runner.speed > 0;
            if (pausing) {
              setHold({ title: stop.title, body: stop.body, resumeTo: runner.speed as Speed });
              setRunSpeed(0);
            }
            // The alert that paused the game is shown in the pause card, not twice.
            const cards = fresh.filter((a) => !(pausing && a === stop));
            if (cards.length) setAlerts((old) => [...cards.map((a) => ({ ...a, key: alertKey.current++ })), ...old].slice(0, 4));
          }
          // Tutorial tips.
          const due = live.current.holding || live.current.planOpen ? null : nextTip(tips, shownTips.current, s);
          if (due !== null) {
            shownTips.current.add(due);
            const tipDef = tips[due]!;
            if (tipDef.pause) {
              setHold({ title: 'Tip', body: tipDef.text, resumeTo: (runner.speed || 1) as Speed });
              setCoach(tipDef.highlight ? { text: '', highlight: tipDef.highlight } : null);
              setRunSpeed(0);
            } else setCoach({ text: tipDef.text, highlight: tipDef.highlight });
          }
        }
      }
      if (s.finished && !finished.current) {
        finished.current = true;
        onFinishRef.current(runner);
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    // three.js loads with the first 3D frame, not with the menus. The sim keeps running meanwhile.
    if (view === '3d' && canvas) {
      import('../render/scene3d')
        .then(({ Scene3D }) => {
          if (cancelled) return;
          scene = new Scene3D(canvas);
          scene.namer = (id) => {
            const n = personName('patient', id, seed);
            return `${n.first[0]}. ${n.last}`;
          };
          sceneRef.current = scene;
        })
        .catch(() => !cancelled && setView('2d'));
    }
    raf = requestAnimationFrame(frame);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      scene?.dispose();
      sceneRef.current = null;
    };
  }, [runner, showFastTrack, view, level, seed]);

  useEffect(() => () => sound.current?.close(), []);

  // Highlight whatever the current tip points at.
  useEffect(() => {
    const el = coach?.highlight ? document.querySelector(`[data-coach="${coach.highlight}"]`) : null;
    el?.classList.add('coach-highlight');
    return () => el?.classList.remove('coach-highlight');
  }, [coach]);

  const chooseView = (v: View) => {
    try {
      localStorage.setItem('er-view', v);
    } catch {
      // storage blocked
    }
    setView(v);
  };

  const send = (cmd: Command) => {
    try {
      runner.command(cmd);
      setNotice(null);
    } catch (e) {
      setNotice(e instanceof Error ? e.message.replace(/^Invalid config:\s*-?\s*/, '').replace(/^command: /, '') : String(e));
    }
  };

  const change = (ctl: PlayerControl, v: unknown) => {
    const next = { ...plan.values, [ctl]: v };
    setPlan({ ...plan, values: next });
    send(QUICK[ctl]!(v, next));
    if (coach?.highlight === ctl) setCoach(null);
  };

  const resume = () => {
    if (hold) setRunSpeed(hold.resumeTo);
    setHold(null);
    setCoach(null);
  };

  const openPlan = () => {
    setPlanOpen(runner.speed as Speed);
    setRunSpeed(0);
  };

  const closePlan = (resumeTo: Speed | null) => {
    if (resumeTo !== null) setRunSpeed(resumeTo || 1);
    setPlanOpen(null);
  };

  const toggleAutoPause = (on: boolean) => {
    setAutoPause(on);
    try {
      localStorage.setItem('er-autopause', on ? 'on' : 'off');
    } catch {
      // storage blocked
    }
  };

  const waitingTriage = snap.patients.filter((p) => p.waitingFor === 'triage').length;
  const waitingBed = snap.patients.filter((p) => p.waitingFor === 'bed').length;
  const boarding = snap.patients.filter((p) => p.boarding).length;
  const c = runner.sim.config;
  const progress = snap.now / snap.durationMinutes;
  const lwbsAlert = snap.totals.lwbs > 0 && snap.totals.lwbs / Math.max(1, snap.totals.arrived) > 0.05;
  const incoming = snap.incidents.find((i) => i.startsInMinutes > 0);

  return (
    <main className="screen play" onPointerDown={() => sound.current?.start()}>
      <header className="hud">
        <div className="clock-tile">
          <p className="eyebrow">{level ? `Simulation ${String(level.number).padStart(2, '0')}` : 'Sandbox'}</p>
          <strong className="clock" data-testid="clock">
            {clockLabel(c.startDayOfWeek, c.startHour, snap.now)}
          </strong>
          <div className="progress" aria-label={`${Math.round(progress * 100)}% of the shift`}>
            <span style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
        <dl className="stats">
          <Stat label="Waiting for triage" value={waitingTriage} />
          <Stat label="Waiting for a bed" value={waitingBed} />
          <Stat
            label="Beds in use"
            value={`${snap.beds.main.occupied}${snap.beds.main.capacity !== null ? `/${snap.beds.main.capacity + snap.live.hallwayBeds}` : ''}`}
          />
          {snap.inpatient && <Stat label="Boarding" value={boarding} />}
          <Stat label="Home / admitted" value={`${snap.totals.discharged} / ${snap.totals.admitted}`} />
          <Stat label="Left unseen" value={snap.totals.lwbs} alert={lwbsAlert} />
        </dl>
        <div className="speed-controls" data-coach="speed">
          <div className="segmented" role="group" aria-label="Speed">
            {SPEEDS.map((s) => (
              <button key={s} className={s === speed ? 'on' : ''} onClick={() => setRunSpeed(s)} data-testid={`speed-${s}`} aria-pressed={s === speed}>
                {s === 0 ? 'Pause' : `${s}×`}
              </button>
            ))}
          </div>
          <div className="hud-toggles">
            <label className="check small">
              <input type="checkbox" checked={autoPause} onChange={(e) => toggleAutoPause(e.target.checked)} data-testid="auto-pause" /> Pause on alerts
            </label>
            <button
              className="ghost small"
              onClick={() => {
                sound.current?.start();
                sound.current?.setOn(!soundOn);
                setSoundOn(!soundOn);
              }}
              aria-pressed={soundOn}
              data-testid="sound"
            >
              {soundOn ? 'Sound on' : 'Sound off'}
            </button>
          </div>
        </div>
      </header>
      {incoming && (
        <div className="incident-bar" role="alert">
          <strong>Major incident:</strong> about {incoming.patients} casualties, first in {Math.ceil(incoming.startsInMinutes)} min
        </div>
      )}
      <div className="play-body">
        <div className="floor" data-coach="floor">
          {/* A canvas holds one kind of context, so each view gets its own element. */}
          <canvas
            key={view}
            ref={canvasRef}
            className={view === '3d' ? 'three' : ''}
            aria-label="Emergency department floor"
            data-testid={`floor-${view}`}
            onPointerMove={(e) => (pointer.current = { x: e.clientX, y: e.clientY })}
            onPointerLeave={() => {
              pointer.current = null;
              setTip(null);
            }}
          />
          {tip && view === '3d' && (
            <div className="floor-tip" style={{ left: tip.x + 22, top: tip.y + 10 }} role="status">
              {tip.text}
            </div>
          )}
          <ul className="alerts" aria-live="polite">
            {alerts.map((a) => (
              <li key={a.key} className={`alert-card ${a.severity}`}>
                <strong>{a.title}</strong>
                <span>{a.body}</span>
                <button className="ghost small" onClick={() => setAlerts((xs) => xs.filter((x) => x.key !== a.key))} aria-label="Dismiss">
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {hold && (
            <div className="hold" role="dialog" aria-label={hold.title}>
              <p className="eyebrow">{hold.title === 'Tip' ? 'Tip · paused' : 'Paused'}</p>
              {hold.title !== 'Tip' && <h3>{hold.title}</h3>}
              <p>{hold.body}</p>
              <div className="actions" style={{ marginTop: 8 }}>
                {planControls.length > 0 && hold.title !== 'Tip' && (
                  <button
                    onClick={() => {
                      const to = hold.resumeTo;
                      setHold(null);
                      setPlanOpen(to);
                    }}
                  >
                    Adjust the plan…
                  </button>
                )}
                <button className="primary" onClick={resume} data-testid="resume">
                  {hold.title === 'Tip' ? 'Got it' : 'Resume'}
                </button>
              </div>
            </div>
          )}
          {coach?.text && !hold && (
            <div className="coach" role="status">
              <span>{coach.text}</span>
              <button className="ghost small" onClick={() => setCoach(null)}>
                OK
              </button>
            </div>
          )}
          <div className="floor-tools">
            <div className="segmented" role="group" aria-label="View">
              {(['3d', '2d'] as const).map((v) => (
                <button key={v} className={v === view ? 'on' : ''} aria-pressed={v === view} onClick={() => chooseView(v)} data-testid={`view-${v}`}>
                  {v.toUpperCase()}
                </button>
              ))}
            </div>
            {view === '3d' && (
              <button className="ghost small" onClick={() => sceneRef.current?.resetView()}>
                Reset view
              </button>
            )}
          </div>
          {view === '3d' && <p className="floor-hint">Drag to turn · right-drag to move · scroll or pinch to zoom · hover over anyone</p>}
        </div>
        <aside className="side">
          <LivePanel
            controls={controls}
            calls={calls}
            values={plan.values}
            snap={snap}
            hasLayout={!!c.layout}
            onChange={change}
            onCommand={send}
            onPlan={planControls.length > 0 ? openPlan : null}
          />
          {notice && (
            <p className="problems" role="alert">
              {notice}
            </p>
          )}
          <section className="card">
            <h3>Key</h3>
            <Legend view={view} />
          </section>
          <div className="actions" style={{ marginTop: 0 }}>
            <button onClick={() => runner.skipToEnd()} data-testid="skip">
              End shift now
            </button>
            <button className="ghost" onClick={onQuit}>
              Quit
            </button>
          </div>
        </aside>
      </div>
      {planOpen !== null && (
        <PlanDrawer
          level={level ? (config as LevelConfig) : null}
          controls={planControls}
          plan={plan}
          onClose={() => closePlan(planOpen)}
          onApply={(next, cmds) => {
            for (const cmd of cmds) runner.command(cmd); // throws on a bad plan; the drawer shows why
            setPlan(next);
            closePlan(planOpen);
          }}
        />
      )}
    </main>
  );
}

function Stat({ label, value, alert }: { label: string; value: number | string; alert?: boolean }) {
  return (
    <div className={`stat ${alert ? 'alert' : ''}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Legend({ view }: { view: View }) {
  const esi = ['Resuscitation', 'Emergent', 'Urgent', 'Less urgent', 'Non-urgent'];
  const staff: [string, string, string][] = [
    ['--staff', 'D', 'Doctor'],
    ['--staff-triage', 'T', 'Triage nurse'],
    ['--staff-ft', 'F', 'Fast-track clinician'],
  ];
  return (
    <ul className="legend-list">
      {esi.map((label, i) => (
        <li key={label}>
          <span className="dot" style={{ background: `var(--esi-${i + 1})`, color: inkOn(acuityColor((i + 1) as Acuity)) }}>
            {i + 1}
          </span>
          ESI {i + 1} · {label}
        </li>
      ))}
      <li>
        <span className="dot" style={{ background: 'var(--untriaged)' }} /> Not triaged yet
      </li>
      {staff.map(([v, letter, label]) => (
        <li key={label}>
          <span className="staff-key" style={{ background: `var(${v})` }}>
            {letter}
          </span>
          {label} {view === '3d' ? '(badge outline = free)' : '(outline = free)'}
        </li>
      ))}
      <li>
        <span className="ring" /> Admitted, waiting for a ward bed
      </li>
      <li>
        <span className="trauma-key" /> Trauma bay (sickest patients first)
      </li>
    </ul>
  );
}
