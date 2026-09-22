import type { Acuity, Command, PlayerControl, QueueDiscipline, SimSnapshot } from '@er/sim';
import { useEffect, useRef, useState } from 'react';
import type { SetupValues } from '../controls';
import { clockLabel } from '../format';
import type { GameConfig } from '../sandbox';
import { acuityColor, drawFloor, inkOn } from '../render/draw';
import { layoutFloor } from '../render/floorPlan';
import { layoutGrid } from '../render/gridPlan';
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

export function Play(props: { config: GameConfig; seed: number; values: SetupValues; onFinish: (runner: GameRunner) => void; onQuit: () => void }) {
  const { config, seed, onFinish, onQuit } = props;
  const runnerRef = useRef<GameRunner | null>(null);
  runnerRef.current ??= new GameRunner(config, seed);
  const runner = runnerRef.current;
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
    const frame = (t: number) => {
      runner.advance(t - last);
      last = t;
      const s = runner.sim.snapshot();
      const canvas = canvasRef.current;
      if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          const layout = runner.sim.config.layout;
          drawFloor(ctx, layout ? layoutGrid(s, layout, w, h) : layoutFloor(s, w, h, showFastTrack), w, h);
        }
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
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [runner, showFastTrack]);

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
          <canvas ref={canvasRef} aria-label="Emergency department floor" />
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
            <Legend />
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

function Legend() {
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
          {label} (outline = free)
        </li>
      ))}
      <li>
        <span className="ring" /> Admitted, waiting for a ward bed
      </li>
    </ul>
  );
}
