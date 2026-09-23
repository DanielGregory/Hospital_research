import type { Acuity, Command, PlayerControl, QueueDiscipline, SimSnapshot } from '@er/sim';
import { useEffect, useRef, useState } from 'react';
import type { SetupValues } from '../controls';
import { clockLabel } from '../format';
import type { GameConfig } from '../sandbox';
import { acuityColor, drawFloor, inkOn } from '../render/draw';
import { layoutFloor, type FloorPlan } from '../render/floorPlan';
import { layoutGrid } from '../render/gridPlan';
import { Crowd, withActors } from '../render/motion';
import type { Scene3D } from '../render/scene3d';
import { webglAvailable } from '../render/webgl';
import { GameRunner, SPEEDS, type Speed } from '../runner';
import { SimpleControl } from './Setup';

/** In a sandbox run the player may use every live control. */
export const SANDBOX_LIVE: PlayerControl[] = ['queue.discipline', 'staffing.doctors', 'staffing.triageNurses', 'fastTrack.enabled', 'beds.main'];

/** Controls that can change mid-shift, and the command each one sends. */
const LIVE: Partial<Record<PlayerControl, (v: unknown, all: SetupValues) => Command>> = {
  'queue.discipline': (v) => ({ type: 'setQueueDiscipline', discipline: v as QueueDiscipline }),
  'fastTrack.enabled': (v, all) => ({ type: 'setFastTrack', enabled: v === true, minAcuity: all['fastTrack.minAcuity'] as Acuity | undefined }),
  'fastTrack.minAcuity': (v, all) => ({ type: 'setFastTrack', enabled: all['fastTrack.enabled'] !== false, minAcuity: v as Acuity }),
  'staffing.doctors': (v) => ({ type: 'setStaff', role: 'doctor', count: Number(v) }),
  'staffing.triageNurses': (v) => ({ type: 'setStaff', role: 'triageNurse', count: Number(v) }),
  'staffing.fastTrackClinicians': (v) => ({ type: 'setStaff', role: 'fastTrackClinician', count: Number(v) }),
  'beds.main': (v) => ({ type: 'setBeds', lane: 'main', count: Number(v) }),
  'beds.fastTrack': (v) => ({ type: 'setBeds', lane: 'fastTrack', count: Number(v) }),
  'boarding.escalation': (v) => ({ type: 'setEscalation', enabled: v === true }),
};

type View = '3d' | '2d';

/** Plan size for the 3D view: 20 units per metre, so the default floor is 34 × 22 m. */
const PLAN_3D = { width: 680, height: 440, corridor: 40, gridCell: 40 };

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

export function Play(props: { config: GameConfig; seed: number; values: SetupValues; onFinish: (runner: GameRunner) => void; onQuit: () => void }) {
  const { config, seed, onFinish, onQuit } = props;
  const runnerRef = useRef<GameRunner | null>(null);
  runnerRef.current ??= new GameRunner(config, seed);
  const runner = runnerRef.current;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<View>(savedView);
  const sceneRef = useRef<Scene3D | null>(null);
  const [snap, setSnap] = useState<SimSnapshot>(() => runner.sim.snapshot());
  const [speed, setSpeed] = useState<Speed>(1);
  const [values, setValues] = useState<SetupValues>(props.values);
  const finished = useRef(false);
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

  const controls = config.level?.playerControls ?? SANDBOX_LIVE;
  const showFastTrack =
    runner.sim.config.fastTrack.enabled ||
    runner.sim.config.staff.fastTrackClinician > 0 ||
    !!runner.sim.config.schedule.fastTrackClinician ||
    controls.some((c) => c.startsWith('fastTrack'));

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    const crowd = new Crowd();
    let instant = true;
    let size = '';
    let scene: Scene3D | null = null;
    let cancelled = false;
    const canvas = canvasRef.current;
    const layout = runner.sim.config.layout;
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
          const plan: FloorPlan = layout
            ? layoutGrid(s, layout, layout.width * PLAN_3D.gridCell, layout.height * PLAN_3D.gridCell)
            : layoutFloor(s, PLAN_3D.width, PLAN_3D.height, showFastTrack, { corridor: PLAN_3D.corridor, staffBesideBed: true });
          const actors = crowd.update(plan, dt, { speed: 50 * pace, instant });
          scene.render(plan, actors, dt, t / 1000);
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
            const plan = layout ? layoutGrid(s, layout, w, h) : layoutFloor(s, w, h, showFastTrack);
            const actors = crowd.update(plan, dt, { speed: w * 0.07 * pace, instant });
            drawFloor(ctx, withActors(plan, actors), w, h);
          }
        }
        instant = false;
      }
      if (t - lastUi > 100 || s.finished) {
        setSnap(s);
        lastUi = t;
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
  }, [runner, showFastTrack, view]);

  const chooseView = (v: View) => {
    try {
      localStorage.setItem('er-view', v);
    } catch {
      // storage blocked
    }
    setView(v);
  };

  const setRunSpeed = (s: Speed) => {
    runner.speed = s;
    setSpeed(s);
  };

  const change = (ctl: PlayerControl, v: unknown) => {
    const next = { ...values, [ctl]: v };
    setValues(next);
    runner.command(LIVE[ctl]!(v, next));
  };

  const waitingTriage = snap.patients.filter((p) => p.waitingFor === 'triage').length;
  const waitingBed = snap.patients.filter((p) => p.waitingFor === 'bed').length;
  const boarding = snap.patients.filter((p) => p.boarding).length;
  const c = runner.sim.config;
  const progress = snap.now / snap.durationMinutes;
  const live = controls.filter((ctl) => LIVE[ctl] && !(ctl.startsWith('beds.') && c.layout));

  const lwbsAlert = snap.totals.lwbs > 0 && snap.totals.lwbs / Math.max(1, snap.totals.arrived) > 0.05;
  return (
    <main className="screen play">
      <header className="hud">
        <div className="clock-tile">
          <p className="eyebrow">{config.level ? `Simulation ${String(config.level.number).padStart(2, '0')}` : 'Sandbox'}</p>
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
          <Stat label="Beds in use" value={`${snap.beds.main.occupied}${snap.beds.main.capacity !== null ? `/${snap.beds.main.capacity}` : ''}`} />
          {snap.inpatient && <Stat label="Boarding" value={boarding} />}
          <Stat label="Home / admitted" value={`${snap.totals.discharged} / ${snap.totals.admitted}`} />
          <Stat label="Left unseen" value={snap.totals.lwbs} alert={lwbsAlert} />
        </dl>
        <div className="speed-controls">
          <div className="segmented" role="group" aria-label="Speed">
            {SPEEDS.map((s) => (
              <button key={s} className={s === speed ? 'on' : ''} onClick={() => setRunSpeed(s)} data-testid={`speed-${s}`} aria-pressed={s === speed}>
                {s === 0 ? 'Pause' : `${s}×`}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="play-body">
        <div className="floor">
          {/* A canvas holds one kind of context, so each view gets its own element. */}
          <canvas key={view} ref={canvasRef} className={view === '3d' ? 'three' : ''} aria-label="Emergency department floor" data-testid={`floor-${view}`} />
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
          {view === '3d' && <p className="floor-hint">Drag to turn · right-drag to move · scroll or pinch to zoom</p>}
        </div>
        <aside className="side">
          {live.length > 0 && (
            <section className="card live-controls">
              <h3>Change now</h3>
              {live.map((ctl) => (
                <SimpleControl key={ctl} control={ctl} value={values[ctl]} onChange={(v) => change(ctl, v)} />
              ))}
            </section>
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
    </ul>
  );
}
