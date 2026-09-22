import type { Acuity, Command, PlayerControl, QueueDiscipline, SimSnapshot } from '@er/sim';
import { useEffect, useRef, useState } from 'react';
import type { SetupValues } from '../controls';
import { clockLabel } from '../format';
import type { LevelConfig } from '../levels';
import { drawFloor } from '../render/draw';
import { layoutFloor } from '../render/floorPlan';
import { GameRunner, SPEEDS, type Speed } from '../runner';
import { SimpleControl } from './Setup';

/** Controls that can change mid-shift, and the command each one sends. */
const LIVE: Partial<Record<PlayerControl, (v: unknown, all: SetupValues) => Command>> = {
  'queue.discipline': (v) => ({ type: 'setQueueDiscipline', discipline: v as QueueDiscipline }),
  'fastTrack.enabled': (v, all) => ({ type: 'setFastTrack', enabled: v === true, minAcuity: all['fastTrack.minAcuity'] as Acuity | undefined }),
  'fastTrack.minAcuity': (v, all) => ({ type: 'setFastTrack', enabled: all['fastTrack.enabled'] !== false, minAcuity: v as Acuity }),
  'staffing.doctors': (v) => ({ type: 'setStaff', role: 'doctor', count: Number(v) }),
  'staffing.triageNurses': (v) => ({ type: 'setStaff', role: 'triageNurse', count: Number(v) }),
  'staffing.fastTrackClinicians': (v) => ({ type: 'setStaff', role: 'fastTrackClinician', count: Number(v) }),
};

export function Play(props: { config: LevelConfig; seed: number; values: SetupValues; onFinish: (runner: GameRunner) => void; onQuit: () => void }) {
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

  const showFastTrack = runner.sim.config.fastTrack.enabled || runner.sim.config.staff.fastTrackClinician > 0 || !!runner.sim.config.schedule.fastTrackClinician || config.level.playerControls.some((c) => c.startsWith('fastTrack'));

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
          drawFloor(ctx, layoutFloor(s, w, h, showFastTrack), w, h, showFastTrack);
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

  const waitingTriage = snap.patients.filter((p) => p.location === 'waitingTriage').length;
  const waitingDoctor = snap.patients.filter((p) => p.location === 'waitingDoctor' || p.location === 'waitingFastTrack').length;
  const c = runner.sim.config;
  const progress = snap.now / snap.durationMinutes;
  const live = config.level.playerControls.filter((ctl) => LIVE[ctl]);

  return (
    <main className="screen play">
      <header className="hud">
        <div>
          <p className="eyebrow">Simulation {config.level.number}</p>
          <strong className="clock" data-testid="clock">
            {clockLabel(c.startDayOfWeek, c.startHour, snap.now)}
          </strong>
          <div className="progress" aria-hidden>
            <span style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
        <dl className="stats">
          <div>
            <dt>Waiting for triage</dt>
            <dd>{waitingTriage}</dd>
          </div>
          <div>
            <dt>Waiting for a doctor</dt>
            <dd>{waitingDoctor}</dd>
          </div>
          <div>
            <dt>Seen</dt>
            <dd>{snap.totals.treated}</dd>
          </div>
          <div>
            <dt>Left without being seen</dt>
            <dd>{snap.totals.lwbs}</dd>
          </div>
        </dl>
        <div className="speed" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button key={s} className={s === speed ? 'on' : ''} onClick={() => setRunSpeed(s)} data-testid={`speed-${s}`} aria-pressed={s === speed}>
              {s === 0 ? 'Pause' : `${s}×`}
            </button>
          ))}
          <button onClick={() => runner.skipToEnd()} data-testid="skip">
            End shift
          </button>
        </div>
      </header>
      <div className="floor">
        <canvas ref={canvasRef} aria-label="Emergency department floor" />
        <Legend />
      </div>
      {live.length > 0 && (
        <section className="live-controls">
          {live.map((ctl) => (
            <SimpleControl key={ctl} control={ctl} value={values[ctl]} onChange={(v) => change(ctl, v)} />
          ))}
        </section>
      )}
      <div className="actions">
        <button onClick={onQuit}>Quit to menu</button>
      </div>
    </main>
  );
}

function Legend() {
  return (
    <ul className="legend-row">
      {[1, 2, 3, 4, 5].map((a) => (
        <li key={a}>
          <span className="dot" style={{ background: `var(--esi-${a})` }} /> ESI {a}
        </li>
      ))}
      <li>
        <span className="dot" style={{ background: 'var(--untriaged)' }} /> Not triaged
      </li>
      <li>
        <span className="square" /> Staff (hollow = free)
      </li>
    </ul>
  );
}
