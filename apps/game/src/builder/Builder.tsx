/**
 * Build your hospital, in 3D: pick a size, draw rooms straight onto the 3D floor, set the staff and
 * the rest of the hospital (ICU, wards, labs and imaging), then test a week, watch it run, or take
 * it to the planner. Presentation only: the sim validates and runs everything.
 */
import { ConfigError, resolveConfig, resolveLayout, Simulation, type Cell, type SimConfig, type SimSnapshot } from '@er/sim';
import type { Comparison } from '@er/research';
import { applySettings } from '@er/sim';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bottlenecks, DiagnosticsCard, UnitsCard } from '../planner/Planner';
import { loadProject, saveProject } from '../planner/project';
import type { WorkerRequest, WorkerResponse } from '../planner/worker';
import { furnishGrid } from '../render/gridFurnish';
import { layoutGrid } from '../render/gridPlan';
import type { Scene3D } from '../render/scene3d';
import { webglAvailable } from '../render/webgl';
import { downloadJson, type GameConfig } from '../sandbox';
import { RoomPanel, ToolBar, useFloorEditor, type FloorEditor, type Tool } from '../screens/FloorDesigner';
import { ScheduleEditor, Stepper } from '../screens/ScheduleEditor';
import { loadHospital, newHospital, planBeds, saveHospital, SIZES, toDepartment, withTypicalStaffing, withVisits, type Hospital, type HospitalSize } from './hospital';

type Step = 'floor' | 'staff' | 'hospital' | 'try';

const TOOLS: Tool[] = ['waiting', 'triage', 'trauma', 'acute', 'fastTrack', 'station', 'door', 'entrance', 'ambulance', 'erase'];
/** Plan units per grid cell in the 3D view (as in play). */
const CELL = 40;

/** Problems that stop the hospital from running, in plain words. */
function problemsOf(config: SimConfig): string[] {
  try {
    resolveConfig(config);
    return [];
  } catch (e) {
    return e instanceof ConfigError ? e.problems : [String(e)];
  }
}

export function Builder(props: { onBack: () => void; onWatch: (config: GameConfig) => void; onPlanner: () => void }) {
  const [hospital, setHospitalState] = useState<Hospital | null>(loadHospital);
  const [step, setStep] = useState<Step>('floor');
  const setHospital = (h: Hospital) => {
    setHospitalState(h);
    saveHospital(h);
  };
  if (!hospital) return <StartPicker onPick={(size) => setHospital(newHospital(size))} onBack={props.onBack} />;

  const config = hospital.config;
  const problems = problemsOf(config);
  const ready = problems.length === 0;
  const set = (path: string, v: unknown) => setHospital({ ...hospital, config: applySettings(config, { [path]: v }) });

  return (
    <main className="screen builder" data-testid="builder">
      <header className="planner-head">
        <div>
          <p className="eyebrow">Build your hospital</p>
          <input
            className="title-input"
            value={hospital.name}
            onChange={(e) => setHospital({ ...hospital, name: e.target.value, config: { ...config, name: e.target.value } })}
            aria-label="Hospital name"
            data-testid="hospital-name"
          />
        </div>
        <nav className="seg planner-tabs" aria-label="Steps">
          {(
            [
              ['floor', '1 · Floor'],
              ['staff', '2 · Staff'],
              ['hospital', '3 · Beds upstairs, labs'],
              ['try', '4 · Try it'],
            ] as [Step, string][]
          ).map(([s, label]) => (
            <button key={s} className={s === step ? 'on' : ''} aria-pressed={s === step} onClick={() => setStep(s)} data-testid={`step-${s}`}>
              {label}
            </button>
          ))}
        </nav>
      </header>

      {step === 'floor' && <FloorStep hospital={hospital} onChange={setHospital} />}
      {step === 'staff' && (
        <StaffStep hospital={hospital} onChange={setHospital} ready={ready} problems={problems} />
      )}
      {step === 'hospital' && (
        <>
          <p className="lede">
            Most waiting in a real ED is not about the ED: admitted patients wait for an ICU or ward bed, and tests wait for a scanner. Set what sits behind your
            department.
          </p>
          <UnitsCard base={config} set={set} />
          <DiagnosticsCard base={config} set={set} />
        </>
      )}
      {step === 'try' && <TryStep hospital={hospital} ready={ready} problems={problems} onWatch={props.onWatch} onPlanner={props.onPlanner} />}

      <div className="actions builder-actions">
        <button onClick={props.onBack}>Menu</button>
        <button
          className="ghost"
          onClick={() => {
            if (window.confirm('Start again? Your hospital will be replaced.')) setHospitalState(null);
          }}
        >
          Start again
        </button>
        {step !== 'try' ? (
          <button className="primary push" onClick={() => setStep(step === 'floor' ? 'staff' : step === 'staff' ? 'hospital' : 'try')} data-testid="builder-next">
            Next: {step === 'floor' ? 'staff' : step === 'staff' ? 'beds upstairs and labs' : 'try it'}
          </button>
        ) : (
          <button className="primary push" onClick={() => props.onWatch({ ...config, name: hospital.name })} disabled={!ready} data-testid="open-doors">
            ▶ Open the doors
          </button>
        )}
      </div>
    </main>
  );
}

function StartPicker({ onPick, onBack }: { onPick: (s: HospitalSize) => void; onBack: () => void }) {
  return (
    <main className="screen builder" data-testid="builder-start">
      <p className="eyebrow">Build your hospital</p>
      <h1>How big is your emergency department?</h1>
      <p className="lede">
        Pick a starting point. You get a working floor plan with typical staffing for that size, and you can change everything: drag rooms around in 3D, add beds,
        change shifts, then open the doors and watch it run.
      </p>
      <div className="sandbox-grid">
        {(Object.keys(SIZES) as HospitalSize[]).map((k) => (
          <button key={k} className="sandbox-card" onClick={() => onPick(k)} data-testid={`size-${k}`}>
            <strong>{SIZES[k].label}</strong>
            <span>{SIZES[k].blurb}</span>
          </button>
        ))}
      </div>
      <div className="actions">
        <button onClick={onBack}>Menu</button>
      </div>
    </main>
  );
}

// ---- 1. Floor ---------------------------------------------------------------------------

function FloorStep({ hospital, onChange }: { hospital: Hospital; onChange: (h: Hospital) => void }) {
  const layout = hospital.config.layout!;
  const setLayout = (l: typeof layout) => onChange({ ...hospital, config: { ...hospital.config, layout: l } });
  const ed = useFloorEditor(layout, setLayout, TOOLS);
  const [three, setThree] = useState(webglAvailable);
  const resolved = useMemo(() => resolveLayout(layout), [layout]);
  const planProblems = resolved.layout ? problemsOf(hospital.config).filter((p) => p.startsWith('layout')) : resolved.problems;
  return (
    <>
      <p className="lede">
        Pick a room type, then drag across the floor to build it. Beds, desks and chairs appear as you go. Staff walk from the station to every bed and back, so
        where rooms go matters.
      </p>
      <div className="builder-stage">
        <ToolBar ed={ed} tools={TOOLS} vertical />
        {three ? <Floor3D hospital={hospital} ed={ed} onFail={() => setThree(false)} /> : <p className="card">3D needs WebGL, which this browser does not offer.</p>}
      </div>
      {ed.message && (
        <p className="over" role="alert">
          {ed.message}
        </p>
      )}
      {planProblems.length > 0 && (
        <ul className="problems" role="alert">
          {planProblems.map((p) => (
            <li key={p}>{p.replace(/^layout(\.[a-z]+)?: /, '')}</li>
          ))}
        </ul>
      )}
      <RoomPanel spec={layout} ed={ed} />
    </>
  );
}

const ROOM_COLOR: Record<string, string> = {
  waiting: '--room-waiting',
  triage: '--room-triage',
  trauma: '--room-trauma',
  acute: '--room-acute',
  fastTrack: '--room-fastTrack',
  station: '--room-station',
  imaging: '--room-imaging',
  lab: '--room-lab',
};

/** The 3D floor, drawn on as you build. */
function Floor3D({ hospital, ed, onFail }: { hospital: Hospital; ed: FloorEditor; onFail: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<Scene3D | null>(null);
  const [top, setTop] = useState(true);
  const layout = hospital.config.layout!;
  const resolved = useMemo(() => resolveLayout(layout).layout ?? null, [layout]);
  // Staff at their posts when the hospital can run; an empty floor while it cannot.
  const snapshot = useMemo<SimSnapshot | null>(() => {
    if (!resolved) return null;
    try {
      return new Simulation(hospital.config, 1).snapshot();
    } catch {
      return { now: 0, patients: [], staff: [] } as unknown as SimSnapshot;
    }
  }, [hospital.config, resolved]);
  const plan = useMemo(
    () => (resolved && snapshot ? furnishGrid(layoutGrid(snapshot, resolved, resolved.width * CELL, resolved.height * CELL), snapshot, resolved) : null),
    [resolved, snapshot],
  );
  const live = useRef({ plan, top, onFail });
  live.current = { plan, top, onFail };

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    let scene: Scene3D | null = null;
    let size = '';
    let framed = false;
    const canvas = canvasRef.current!;
    const frame = (t: number) => {
      if (scene && live.current.plan) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (size !== `${w}x${h}`) {
          size = `${w}x${h}`;
          scene.resize(w, h);
        }
        scene.render(live.current.plan, [], 0.016, t / 1000);
        if (!framed) {
          framed = true;
          scene.topView(live.current.top);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    import('../render/scene3d')
      .then(({ Scene3D }) => {
        if (cancelled) return;
        scene = new Scene3D(canvas);
        scene.setEditing(true);
        sceneRef.current = scene;
      })
      .catch(() => !cancelled && live.current.onFail());
    raf = requestAnimationFrame(frame);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      scene?.dispose();
      sceneRef.current = null;
    };
  }, []);

  // The block being dragged.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const color = getComputedStyle(document.documentElement).getPropertyValue(ROOM_COLOR[ed.tool] ?? '--accent').trim() || '#2553c9';
    s.setGhost(ed.sel ? { x: ed.sel.x * CELL, y: ed.sel.y * CELL, w: ed.sel.w * CELL, h: ed.sel.h * CELL } : null, color);
  }, [ed.sel, ed.tool]);

  const cellAt = (e: React.PointerEvent): Cell | null => {
    const p = sceneRef.current?.floorPoint(e.clientX, e.clientY);
    if (!p || !resolved) return null;
    return { x: Math.min(resolved.width - 1, Math.max(0, Math.floor(p.x / CELL))), y: Math.min(resolved.height - 1, Math.max(0, Math.floor(p.y / CELL))) };
  };
  const [hover, setHover] = useState<Cell | null>(null);

  return (
    <div className="stage3d">
      <canvas
        ref={canvasRef}
        className="floor floor-3d"
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const c = cellAt(e);
          if (c && ed.down(c) === 'drag') e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const c = cellAt(e);
          setHover(c);
          if (c) ed.move(c);
        }}
        onPointerUp={() => ed.up()}
        onPointerCancel={() => ed.cancel()}
        onPointerLeave={() => setHover(null)}
        data-testid="floor-3d-builder"
        aria-label="3D floor: drag to build a room"
      />
      <div className="stage-overlay">
        <span className="chip">
          {ed.sel ? `${ed.sel.w} × ${ed.sel.h} squares` : hover ? `Square ${hover.x + 1}, ${hover.y + 1}` : 'Drag on the floor to build'}
        </span>
        <span className="muted small stage-help">Right-drag or two fingers to turn · scroll or pinch to zoom</span>
        <button
          className="small-btn"
          onClick={() => {
            setTop(!top);
            sceneRef.current?.topView(!top);
          }}
          data-testid="camera-toggle"
        >
          {top ? 'Angled view' : 'Top view'}
        </button>
      </div>
      <p className="stage-beds chip">{planBeds(layout)} beds</p>
    </div>
  );
}

// ---- 2. Staff ---------------------------------------------------------------------------

function StaffStep({ hospital, onChange, ready, problems }: { hospital: Hospital; onChange: (h: Hospital) => void; ready: boolean; problems: string[] }) {
  const config = hospital.config;
  const schedule = (role: 'doctor' | 'triageNurse' | 'nurse' | 'security') => config.staffing?.schedule?.[role] ?? [];
  const setSchedule = (role: string, s: unknown) => onChange({ ...hospital, config: applySettings(config, { [`staffing.schedule.${role}`]: s }) });
  return (
    <>
      <section className="card">
        <div className="control control-row">
          Patients a day <Stepper value={hospital.visitsPerDay} min={10} max={400} onChange={(v) => onChange(withVisits(hospital, v))} label="Patients a day" />
        </div>
        <p className="muted small">Arrivals follow a typical day: quiet overnight, busiest from late morning to evening, and Mondays are busiest.</p>
        <button onClick={() => onChange(withTypicalStaffing(hospital))} disabled={!ready} data-testid="typical-staffing">
          Use typical staffing for {hospital.visitsPerDay} patients and {planBeds(config.layout!)} beds
        </button>
      </section>
      {!ready ? (
        <ul className="problems" role="alert">
          <li>Finish the floor plan first:</li>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : (
        <>
          <ScheduleEditor role="doctor" shifts={schedule('doctor')} config={config as GameConfig} onChange={(s) => setSchedule('doctor', s)} />
          <ScheduleEditor role="triageNurse" shifts={schedule('triageNurse')} config={config as GameConfig} onChange={(s) => setSchedule('triageNurse', s)} />
          <ScheduleEditor role="nurse" shifts={schedule('nurse')} config={config as GameConfig} onChange={(s) => setSchedule('nurse', s)} />
          <p className="muted small">
            Bedside nurses take patients at set ratios (ESI 1 one-to-one, ESI 2 two per nurse, then 4, 5 and 6). A bed with no nurse free stays empty.
          </p>
        </>
      )}
    </>
  );
}

// ---- 4. Try it --------------------------------------------------------------------------

function TryStep(props: { hospital: Hospital; ready: boolean; problems: string[]; onWatch: (c: GameConfig) => void; onPlanner: () => void }) {
  const { hospital } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; comparison: Comparison } | null>(null);
  const key = JSON.stringify(hospital.config);
  const worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);
  const test = () => {
    worker.current?.terminate();
    const w = new Worker(new URL('../planner/worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    setBusy('Simulating three weeks');
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if (m.kind === 'progress') return setBusy(`Simulating three weeks (${m.done} of ${m.total})`);
      setBusy(null);
      w.terminate();
      if (m.kind === 'compare') setResult({ key, comparison: m.comparison });
    };
    w.postMessage({ kind: 'compare', base: hospital.config, scenarios: [], seeds: [1, 2, 3] } satisfies WorkerRequest);
  };
  const c = result?.key === key ? result.comparison : null;
  const k = (id: string) => c?.baseline.kpis[id];
  const rows: [string, string, (v: number) => string][] = [
    ['d2dMedian', 'Door to provider (median)', (v) => `${Math.round(v)} min`],
    ['losMedian', 'Length of stay (median)', (v) => `${(v / 60).toFixed(1)} h`],
    ['lwbs', 'Left without being seen', (v) => `${(v * 100).toFixed(1)}%`],
    ['boarding', 'Admitted patients waiting for a bed upstairs (average)', (v) => `${v.toFixed(1)} h`],
    ['costPerDay', 'Cost per day (placeholder rates)', (v) => Math.round(v).toLocaleString('en-US')],
  ];
  if (!props.ready)
    return (
      <ul className="problems" role="alert">
        <li>The hospital cannot open yet:</li>
        {props.problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    );
  return (
    <>
      <section className="card">
        <h3>Test a normal week</h3>
        <p className="muted small">Runs your hospital through three typical weeks in the background and shows how it copes and where patients wait.</p>
        <div className="actions">
          <button className="primary" onClick={test} disabled={busy !== null} data-testid="test-hospital">
            {busy ?? (c ? 'Test again' : 'Test it')}
          </button>
          <button onClick={() => props.onWatch({ ...hospital.config, name: hospital.name })} data-testid="watch-hospital">
            Watch a week in 3D
          </button>
        </div>
        {c && (
          <table className="metrics" data-testid="hospital-results">
            <tbody>
              {rows
                .filter(([id]) => k(id)?.median !== null && k(id)?.median !== undefined)
                .map(([id, label, f]) => (
                  <tr key={id}>
                    <th scope="row">{label}</th>
                    <td>
                      {f(k(id)!.median!)} <span className="muted small">({f(k(id)!.lo!)}–{f(k(id)!.hi!)})</span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>
      {c && <Bottlenecks comparison={c} />}
      <section className="card">
        <h3>Plan changes</h3>
        <p className="muted small">
          Take this hospital to the planner to compare changes side by side (more beds, a new shift, a fast track, more ICU beds, a second CT) with confidence
          intervals and a printable report.
        </p>
        <div className="actions">
          <button
            onClick={() => {
              const p = loadProject();
              saveProject({ ...p, department: toDepartment(hospital), results: undefined });
              props.onPlanner();
            }}
            data-testid="to-planner"
          >
            Compare changes in the planner
          </button>
          <button onClick={() => downloadJson(`${hospital.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'hospital'}.json`, hospital.config)}>Download config</button>
        </div>
      </section>
    </>
  );
}
