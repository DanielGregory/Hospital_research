/**
 * The planner: describe the department (or calibrate it from visit records), check the model
 * against the data, define what-ifs, run them on the same simulated weeks, and read the result
 * as ranges and confidence intervals. Heavy work runs in a worker; nothing here simulates.
 */
import type { CheckRow, Comparison, Difference, Kpi, Range, ScenarioResult } from '@er/research';
import { applySettings, PARAMS, type Role, type Shift, type SimConfig } from '@er/sim';
import { useEffect, useRef, useState } from 'react';
import { ScheduleEditor, Stepper } from '../screens/ScheduleEditor';
import type { GameConfig } from '../sandbox';
import { exampleDepartment, loadProject, newProject, saveProject, service, TEMPLATES, unitsOf, toScenario, type Project, type ScenarioSpec, type TemplateId } from './project';
import type { WorkerRequest, WorkerResponse } from './worker';
import { planBeds } from '../builder/hospital';
import { NATIONAL } from '../data/national';
import { HospitalSearch } from '../data/HospitalSearch';
import { titleCase } from '../data/cms';
import type { CmsHospital } from '@er/sim';

type Tab = 'department' | 'scenarios' | 'results' | 'report';

export function Planner(props: { onBack?: () => void; onWatch: (config: GameConfig, name: string) => void }) {
  const [project, setProjectState] = useState<Project>(loadProject);
  const [tab, setTab] = useState<Tab>(project.results ? 'results' : 'department');
  const [busy, setBusy] = useState<{ label: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<Extract<WorkerResponse, { kind: 'calibrate' | 'check' }> | null>(null);
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const worker = useRef<Worker | null>(null);

  const setProject = (p: Project) => {
    setProjectState(p);
    saveProject(p);
  };
  useEffect(() => () => worker.current?.terminate(), []);

  const run = (req: WorkerRequest, onDone: (r: WorkerResponse) => void) => {
    worker.current?.terminate();
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    setError(null);
    setBusy({ label: 'Starting', done: 0, total: 1 });
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if (m.kind === 'progress') return setBusy({ label: m.label, done: m.done, total: m.total });
      setBusy(null);
      w.terminate();
      if (m.kind === 'error') setError(m.message);
      else onDone(m);
    };
    w.postMessage(req);
  };

  const dept = project.department;
  const base = dept.config;
  const setBase = (config: SimConfig) => setProject({ ...project, department: { ...dept, config }, results: undefined });
  const seeds = Array.from({ length: project.weeks }, (_, i) => i + 1);

  const runScenarios = () =>
    run({ kind: 'compare', base, scenarios: project.scenarios.map((s) => toScenario(s, base)), seeds }, (m) => {
      if (m.kind !== 'compare') return;
      setProject({ ...project, results: { at: new Date().toISOString(), comparison: m.comparison } });
      setTab('results');
    });

  return (
    <main className="screen planner" data-testid="planner">
      <header className="planner-head no-print">
        <div>
          <p className="eyebrow">Planner · scenario testing</p>
          <h1>{dept.name}</h1>
        </div>
        <nav className="seg planner-tabs" aria-label="Planner steps">
          {(
            [
              ['department', '1 · Department'],
              ['scenarios', '2 · What-ifs'],
              ['results', '3 · Results'],
              ['report', '4 · Report'],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button key={t} className={t === tab ? 'on' : ''} aria-pressed={t === tab} onClick={() => setTab(t)} data-testid={`tab-${t}`} disabled={(t === 'results' || t === 'report') && !project.results}>
              {label}
            </button>
          ))}
        </nav>
      </header>

      {busy && (
        <div className="card planner-busy no-print" role="status" data-testid="planner-busy">
          <strong>{busy.label}…</strong>
          <div className="progress" aria-hidden>
            <span style={{ width: `${(100 * busy.done) / Math.max(1, busy.total)}%` }} />
          </div>
          <span className="muted small">
            {busy.done} of {busy.total}
          </span>
        </div>
      )}
      {error && (
        <p className="problems" role="alert">
          {error}
        </p>
      )}

      {tab === 'department' && (
        <DepartmentTab
          project={project}
          onProject={setProject}
          onBase={setBase}
          csv={csv}
          onCsv={(c) => {
            setCsv(c);
            setCheck(null);
          }}
          check={check}
          busy={busy !== null}
          onCheck={(kind) =>
            csv &&
            run({ kind, base, csv: csv.text, seeds: [1, 2, 3, 4, 5] }, (m) => {
              if (m.kind !== 'calibrate' && m.kind !== 'check') return;
              setCheck(m);
              if (m.kind === 'calibrate' && m.data)
                setProject({
                  ...project,
                  department: { ...dept, config: m.config, calibration: { file: csv.name, visits: m.data.visits, days: m.data.days, fitted: m.fitted, notes: m.notes } },
                  results: undefined,
                });
            })
          }
          onNext={() => setTab('scenarios')}
          onHospital={(h, period) =>
            run(
              {
                kind: 'fitHospital',
                // Always from the national starting department, so picking again never compounds.
                base: exampleDepartment().config,
                targets: { visitsPerDay: h.visitsPerYear! / 365, medianMinutesDischarged: h.medianMinutesDischarged, lwbsRate: h.lwbsRate },
                seeds: [1, 2],
              },
              (m) => {
                if (m.kind !== 'fitHospital') return;
                setCheck(null);
                setProject({
                  ...project,
                  department: {
                    name: titleCase(h.name),
                    config: { ...m.fit.config, name: titleCase(h.name) },
                    hospital: { id: h.id, name: titleCase(h.name), city: titleCase(h.city), state: h.state, period, check: m.fit.check, notes: m.fit.notes },
                  },
                  results: undefined,
                });
              },
            )
          }
        />
      )}
      {tab === 'scenarios' && <ScenariosTab project={project} onProject={setProject} onRun={runScenarios} busy={busy !== null} />}
      {tab === 'results' && project.results && (
        <ResultsTab comparison={project.results.comparison} onWatch={(r) => props.onWatch(applySettings(base, r.scenario.settings) as GameConfig, r.scenario.name)} />
      )}
      {tab === 'report' && project.results && <Report project={project} check={check?.check ?? null} />}

      <div className="actions no-print">
        {props.onBack && <button onClick={props.onBack}>Menu</button>}
        <button
          className="ghost"
          onClick={() => {
            if (window.confirm('Start a new project? The current one will be replaced.')) {
              setProject(newProject());
              setCheck(null);
              setCsv(null);
              setTab('department');
            }
          }}
        >
          New project
        </button>
      </div>
    </main>
  );
}

// ---- 1. Department ------------------------------------------------------------------

function DepartmentTab(props: {
  project: Project;
  onProject: (p: Project) => void;
  onBase: (c: SimConfig) => void;
  csv: { name: string; text: string } | null;
  onCsv: (c: { name: string; text: string }) => void;
  check: Extract<WorkerResponse, { kind: 'calibrate' | 'check' }> | null;
  busy: boolean;
  onCheck: (kind: 'check' | 'calibrate') => void;
  onNext: () => void;
  onHospital: (h: CmsHospital, period: string) => void;
}) {
  const { project } = props;
  const dept = project.department;
  const base = dept.config;
  const modules = base.modules ?? {};
  const set = (path: string, v: unknown) => props.onBase(applySettings(base, { [path]: v }));
  const schedule = (role: Role): Shift[] => base.staffing?.schedule?.[role] ?? [];
  const loadSample = async () => {
    const text = (await import('../../../../configs/planner/sample-visits.csv?raw')).default;
    props.onCsv({ name: 'sample-visits.csv (synthetic)', text });
  };
  return (
    <>
      <section className="card">
        <label className="control">
          Department name
          <input value={dept.name} onChange={(e) => props.onProject({ ...project, department: { ...dept, name: e.target.value } })} data-testid="dept-name" />
        </label>
        <p className="muted small">
          Describe the department as it runs today. This is the baseline every what-if is compared with. Until you fit it to your own visit data, it starts from a
          typical US emergency department fitted to national data ({NATIONAL.name}: {NATIONAL.close} of {NATIONAL.checked} checks match national figures).
        </p>
      </section>

      <section className="card" data-testid="start-hospital">
        <h3>Start from a real hospital (US)</h3>
        <p className="muted small">
          Pick a hospital to start from its published emergency department figures (CMS Care Compare): visits a year, median time in the ED for patients sent home, and
          the share who left before being seen. Beds and shifts are scaled from a typical department until you enter the real ones.
        </p>
        <HospitalSearch busy={props.busy} action="Start from this hospital" onPick={(h, data) => props.onHospital(h, data.periods.OP_18b ?? data.periods.OP_22 ?? '')} />
        {dept.hospital && (
          <div data-testid="hospital-check">
            <p className="chip pass" style={{ marginTop: 8 }}>
              Started from {dept.hospital.name}, {dept.hospital.city}, {dept.hospital.state} (CMS, {dept.hospital.period})
            </p>
            <table className="metrics">
              <thead>
                <tr>
                  <th>Measure</th>
                  <th>Hospital reports</th>
                  <th>Model</th>
                </tr>
              </thead>
              <tbody>
                {dept.hospital.check.map((c) => (
                  <tr key={c.label}>
                    <th scope="row">{c.label}</th>
                    <td>{c.target === null ? '—' : unitFmt[c.unit](c.target)}</td>
                    <td>{c.model === null ? '—' : unitFmt[c.unit](c.model)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {dept.hospital.notes.map((n) => (
              <p key={n} className="muted small">
                {n}
              </p>
            ))}
          </div>
        )}
      </section>

      <section className="card calibrate" data-testid="calibrate">
        <h3>Your data (optional, recommended)</h3>
        <p>
          Load an export of ED visits: one row per visit with arrival, triage, provider and departure times, acuity and disposition. It stays in this browser; nothing is
          uploaded.
        </p>
        <div className="actions">
          <label className="button file">
            Choose a CSV file…
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) props.onCsv({ name: f.name, text: await f.text() });
              }}
              data-testid="csv-input"
            />
          </label>
          <button onClick={() => void loadSample()} data-testid="use-sample">
            Use the sample file
          </button>
        </div>
        {props.csv && (
          <>
            <p className="muted small">Loaded {props.csv.name}.</p>
            <div className="actions">
              <button onClick={() => props.onCheck('check')} disabled={props.busy} data-testid="check-model">
                Check the model against it
              </button>
              <button className="primary" onClick={() => props.onCheck('calibrate')} disabled={props.busy} data-testid="fit-model">
                Fit the model to it
              </button>
            </div>
          </>
        )}
        {dept.calibration && (
          <p className="chip pass" style={{ marginTop: 8 }}>
            Calibrated from {dept.calibration.file}: {dept.calibration.visits.toLocaleString('en-US')} visits over {dept.calibration.days} days
          </p>
        )}
        {props.check && <CheckTable result={props.check} />}
      </section>

      <h2>Staffing</h2>
      {(['doctor', 'triageNurse'] as Role[]).map((role) => (
        <ScheduleEditor key={role} role={role} shifts={schedule(role)} config={base as GameConfig} onChange={(s) => set(`staffing.schedule.${role}`, s)} />
      ))}
      {modules.nursing && (
        <>
          <ScheduleEditor role="nurse" shifts={schedule('nurse')} config={base as GameConfig} onChange={(s) => set('staffing.schedule.nurse', s)} />
          <p className="muted small">
            Bedside nurses take patients at set ratios (ESI 1 one-to-one, ESI 2 two per nurse, then 4, 5 and 6). A bed with no nurse free stays empty.
            {!schedule('nurse').length && ` With no shifts set, ${PARAMS.nursing.defaultNurses} nurses are on around the clock.`}
          </p>
        </>
      )}
      {modules.security && <ScheduleEditor role="security" shifts={schedule('security')} config={base as GameConfig} onChange={(s) => set('staffing.schedule.security', s)} />}

      <h2>Space and systems</h2>
      <section className="card">
        {modules.layout ? (
          <p>Treatment spaces come from the drawn floor plan ({base.layout ? planBeds(base.layout) : 0} beds). Change them in Build your hospital.</p>
        ) : (
          <div className="control control-row">
            Main ED treatment spaces <Stepper value={base.beds?.main ?? 20} min={1} max={80} onChange={(v) => set('beds.main', v)} label="Main ED spaces" />
          </div>
        )}
        {(
          [
            ['boarding', 'Admitted patients wait in ED beds until an inpatient bed is free (boarding)'],
            ['diagnostics', 'Labs and imaging as shared services with their own queues and opening hours'],
            ['nursing', 'Bedside nurse-to-patient ratios decide which beds can be used'],
            ['diagnosis', 'Missed diagnoses and returns within 72 hours'],
            ['security', 'Agitation and security incidents'],
            ['burnout', 'Staff fatigue over long shifts'],
          ] as [keyof NonNullable<SimConfig['modules']>, string][]
        ).map(([m, label]) => (
          <label key={m} className="control check">
            <input type="checkbox" checked={modules[m] === true} onChange={(e) => set(`modules.${m}`, e.target.checked)} data-testid={`module-${m}`} /> {label}
          </label>
        ))}
      </section>
      {modules.boarding && <UnitsCard base={base} set={set} />}
      {modules.diagnostics && <DiagnosticsCard base={base} set={set} />}

      <div className="actions">
        <button className="primary push" onClick={props.onNext} data-testid="to-scenarios">
          Next: what-ifs
        </button>
      </div>
    </>
  );
}

const UNIT_ROWS = [
  ['icu', 'ICU beds'],
  ['stepdown', 'Step-down beds'],
  ['ward', 'Ward beds'],
] as const;

/** Inpatient beds for ED admissions: one pool, or separate ICU, step-down and ward units. */
export function UnitsCard({ base, set }: { base: SimConfig; set: (path: string, v: unknown) => void }) {
  const units = base.boarding?.units;
  return (
    <section className="card" data-testid="units-card">
      <h3>Inpatient beds</h3>
      <label className="control check">
        <input type="checkbox" checked={!!units} onChange={(e) => set('boarding.units', e.target.checked ? unitsOf(base) : undefined)} data-testid="separate-units" /> Separate
        ICU, step-down and ward beds
      </label>
      {units ? (
        <>
          {UNIT_ROWS.map(([u, label]) => (
            <div key={u} className="control control-row">
              {label} available to ED admissions{' '}
              <Stepper
                value={units[u]?.beds ?? 0}
                min={0}
                max={u === 'ward' ? 400 : 60}
                onChange={(v) => set('boarding.units', { ...units, [u]: { ...(units[u] ?? {}), beds: v } })}
                label={label}
              />
            </div>
          ))}
          <p className="muted small">
            Each admitted patient needs one unit, mostly by acuity. Units start about 90% full with their own patients, who go home over the week. A patient waiting
            for an ICU bed holds an ED bed and needs a nurse close to one-to-one.
          </p>
        </>
      ) : (
        <p className="muted small">One shared pool of inpatient beds. Switch on separate units to see whether it is the ICU, step-down or the wards that hold patients in the ED.</p>
      )}
    </section>
  );
}

const SERVICE_ROWS = [
  ['lab', 'Lab analysers (tests at once)'],
  ['xray', 'X-ray rooms'],
  ['ct', 'CT scanners'],
  ['ultrasound', 'Ultrasound rooms'],
] as const;

/** Lab and imaging capacity. */
export function DiagnosticsCard({ base, set }: { base: SimConfig; set: (path: string, v: unknown) => void }) {
  const us = base.diagnostics?.services?.ultrasound?.openHours;
  const us24 = us === null || (us === undefined && PARAMS.diagnostics.services.ultrasound.openHours === null);
  return (
    <section className="card" data-testid="diagnostics-card">
      <h3>Labs and imaging</h3>
      {SERVICE_ROWS.map(([sv, label]) => (
        <div key={sv} className="control control-row">
          {label}{' '}
          <Stepper value={service(base, sv, 'servers')} min={1} max={sv === 'lab' ? 30 : 6} onChange={(v) => set(`diagnostics.services.${sv}.servers`, v)} label={label} />
        </div>
      ))}
      <label className="control check">
        <input type="checkbox" checked={us24} onChange={(e) => set('diagnostics.services.ultrasound.openHours', e.target.checked ? null : PARAMS.diagnostics.services.ultrasound.openHours ?? [8, 22])} data-testid="us-24h" />{' '}
        Ultrasound staffed 24 hours
      </label>
      <p className="muted small">
        Tests are ordered by the patient’s condition. Orders queue for a machine, then wait for a report; the patient keeps their bed meanwhile.
      </p>
    </section>
  );
}

const unitFmt: Record<CheckRow['unit'], (v: number) => string> = {
  perDay: (v) => v.toFixed(1),
  min: (v) => `${Math.round(v)} min`,
  share: (v) => `${(v * 100).toFixed(1)}%`,
  hours: (v) => `${v.toFixed(1)} h`,
};

function CheckTable({ result }: { result: Extract<WorkerResponse, { kind: 'calibrate' | 'check' }> }) {
  if (!result.data)
    return (
      <ul className="problems" role="alert">
        {result.problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    );
  const close = result.check.filter((r) => r.status === 'close').length;
  const rated = result.check.filter((r) => r.status !== 'no data').length;
  return (
    <div className="check" data-testid="baseline-check">
      <h4>
        {result.kind === 'calibrate' ? 'After fitting' : 'Before fitting'}: {close} of {rated} measures close to your data
      </h4>
      {result.notes.map((n) => (
        <p key={n} className="muted small">
          {n}
        </p>
      ))}
      <table className="metrics check-table">
        <thead>
          <tr>
            <th>Measure</th>
            <th>Your data</th>
            <th>Model (5 runs: median, range)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {result.check.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td>{r.data === null ? '—' : unitFmt[r.unit](r.data)}</td>
              <td>
                {r.model.median === null ? '—' : unitFmt[r.unit](r.model.median)}
                {r.model.lo !== null && r.model.hi !== null && (
                  <span className="muted small">
                    {' '}
                    ({unitFmt[r.unit](r.model.lo)}–{unitFmt[r.unit](r.model.hi)})
                  </span>
                )}
              </td>
              <td>
                <span className={`chip ${r.status === 'close' ? 'pass' : r.status === 'off' ? 'warn' : ''}`}>{r.status === 'close' ? '✓ close' : r.status === 'off' ? '△ off' : 'no data'}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Close: within 10% (or a small absolute margin). Treat what-ifs on measures marked off with caution.</p>
    </div>
  );
}

// ---- 2. What-ifs ----------------------------------------------------------------------

function ScenariosTab(props: { project: Project; onProject: (p: Project) => void; onRun: () => void; busy: boolean }) {
  const { project } = props;
  const base = project.department.config;
  const update = (scenarios: ScenarioSpec[]) => props.onProject({ ...project, scenarios, results: undefined });
  const [add, setAdd] = useState<TemplateId>(() => (Object.values(TEMPLATES).find((t) => !t.unavailable?.(project.department.config)) ?? TEMPLATES.doctorShift).id);
  return (
    <>
      <p className="lede">Each what-if is one change to the baseline. All of them run on the same simulated weeks, so differences come from the change, not luck.</p>
      <ul className="scenario-list" data-testid="scenario-list">
        {project.scenarios.map((s, i) => {
          const t = TEMPLATES[s.template];
          return (
            <li key={s.id} className="card scenario">
              <div className="scenario-head">
                <input className="scenario-name" value={s.name ?? t.label} onChange={(e) => update(project.scenarios.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="Scenario name" />
                <button className="icon" onClick={() => update(project.scenarios.filter((_, j) => j !== i))} aria-label={`Remove ${s.name ?? t.label}`}>
                  ×
                </button>
              </div>
              <p className="muted small">{t.describe(s.params, base)}</p>
              <div className="scenario-fields">
                {t.fields.map((f) => (
                  <label key={f.key} className="control-row">
                    {f.label}{' '}
                    <input
                      type="number"
                      min={f.min}
                      max={f.max}
                      step={f.step ?? 1}
                      value={s.params[f.key] ?? t.defaults[f.key]}
                      onChange={(e) => {
                        const v = Math.min(f.max, Math.max(f.min, Number(e.target.value)));
                        update(project.scenarios.map((x, j) => (j === i ? { ...x, params: { ...x.params, [f.key]: v } } : x)));
                      }}
                    />
                    {f.unit && <span className="muted"> {f.unit}</span>}
                  </label>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="card add-scenario">
        <label className="control-row">
          Add a what-if{' '}
          <select value={add} onChange={(e) => setAdd(e.target.value as TemplateId)} data-testid="add-template">
            {Object.values(TEMPLATES)
              .filter((t) => !t.unavailable?.(project.department.config))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
          </select>
        </label>
        <button
          onClick={() => update([...project.scenarios, { id: `s${Date.now()}`, template: add, params: { ...TEMPLATES[add].defaults } }])}
          disabled={project.scenarios.length >= 8}
          data-testid="add-scenario"
        >
          Add
        </button>
      </div>
      <section className="card">
        <label className="control-row">
          Simulated weeks per scenario{' '}
          <select value={project.weeks} onChange={(e) => props.onProject({ ...project, weeks: Number(e.target.value), results: undefined })} data-testid="weeks">
            {[5, 10, 20, 40].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">More weeks give narrower intervals. 20 weeks × {project.scenarios.length + 1} setups takes a few seconds.</p>
      </section>
      <div className="actions">
        <button className="primary push" onClick={props.onRun} disabled={props.busy || project.scenarios.length === 0} data-testid="run-scenarios">
          Run {project.scenarios.length} what-if{project.scenarios.length === 1 ? '' : 's'}
        </button>
      </div>
    </>
  );
}

// ---- 3. Results -------------------------------------------------------------------------

const fmt = (k: Kpi, v: number | null | undefined, signed = false): string => {
  if (v === null || v === undefined) return '—';
  const s = signed && v > 0 ? '+' : signed && v < 0 ? '−' : '';
  const a = signed ? Math.abs(v) : v;
  switch (k.unit) {
    case 'min':
      return `${s}${a.toFixed(1)} min`;
    case 'hours':
      return `${s}${a.toFixed(2)} h`;
    case 'share':
      return `${s}${(a * 100).toFixed(1)}${signed ? ' pts' : '%'}`;
    case 'money':
      return `${s}${Math.round(a).toLocaleString('en-US')}`;
    default:
      return `${s}${a.toFixed(1)}`;
  }
};

export function verdict(k: Kpi, d: Difference | undefined): { label: string; cls: string } {
  if (!d || d.mean === null || d.ciLo === null || d.ciHi === null) return { label: 'no data', cls: '' };
  if (Math.abs(d.mean) < 1e-9 && d.ciLo === d.ciHi) return { label: 'no change', cls: '' };
  const lower = d.ciHi < 0;
  const higher = d.ciLo > 0;
  if (!lower && !higher) return { label: 'no clear change', cls: '' };
  const better = (lower && k.better === 'lower') || (higher && k.better === 'higher');
  return better ? { label: 'better', cls: 'pass' } : { label: 'worse', cls: 'fail' };
}

function ResultsTab({ comparison: c, onWatch }: { comparison: Comparison; onWatch: (r: ScenarioResult) => void }) {
  const kpis = c.kpis.filter((k) => c.baseline.kpis[k.key]?.n);
  const [focus, setFocus] = useState(kpis[0]?.key ?? 'd2dMedian');
  const k = kpis.find((x) => x.key === focus) ?? kpis[0]!;
  return (
    <>
      <p className="lede">
        {c.seeds.length} simulated weeks per setup, the same weeks for each. Ranges show how much a typical week varies; the change is the average difference from the
        baseline with a 95% confidence interval.
      </p>
      <div className="results-scroll">
        <table className="metrics results-table" data-testid="results-table">
          <thead>
            <tr>
              <th />
              <th>Baseline</th>
              {c.scenarios.map((r) => (
                <th key={r.scenario.id}>{r.scenario.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {kpis.map((kpi) => (
              <tr key={kpi.key} className={kpi.key === focus ? 'focus' : ''} onClick={() => setFocus(kpi.key)}>
                <th scope="row">{kpi.label}</th>
                <td>
                  <RangeCell k={kpi} r={c.baseline.kpis[kpi.key]!} />
                </td>
                {c.scenarios.map((r) => (
                  <td key={r.scenario.id}>{r.problems.length ? <span className="muted small">not run</span> : <ChangeCell k={kpi} d={r.diff?.[kpi.key]} />}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {c.scenarios.some((r) => r.problems.length) && (
        <ul className="problems">
          {c.scenarios
            .filter((r) => r.problems.length)
            .map((r) => (
              <li key={r.scenario.id}>
                {r.scenario.name}: {r.problems.join('; ')}
              </li>
            ))}
        </ul>
      )}
      <ForestPlot comparison={c} kpi={k} />
      <Bottlenecks comparison={c} />
      <section className="card">
        <h3>Watch a setup</h3>
        <p className="muted small">Play one week of any setup in 3D to see what the numbers mean on the floor.</p>
        <div className="actions">
          {[c.baseline, ...c.scenarios]
            .filter((r) => !r.problems.length)
            .map((r) => (
              <button key={r.scenario.id} onClick={() => onWatch(r)} data-testid={`watch-${r.scenario.id}`}>
                {r.scenario.name}
              </button>
            ))}
        </div>
      </section>
    </>
  );
}

const hoursText = (h: number) => (h >= 10 ? `${Math.round(h).toLocaleString('en-US')} h` : `${h.toFixed(1)} h`);

/** Where the waiting comes from: root causes per setup, largest first. */
export function Bottlenecks({ comparison: c }: { comparison: Comparison }) {
  const setups = [c.baseline, ...c.scenarios].filter((r) => !r.problems.length && r.bottlenecks?.length);
  const [pick, setPick] = useState(setups[0]?.scenario.id ?? '');
  const r = setups.find((x) => x.scenario.id === pick) ?? setups[0];
  if (!r) return null;
  const top = r.bottlenecks.slice(0, 5);
  return (
    <section className="card bottlenecks" data-testid="bottlenecks">
      <h3>Where the waiting comes from</h3>
      <p className="muted small">
        Patient-hours of queueing per week, by root cause. “No beds” is split into beds held by admitted patients, beds full with ED patients, and free beds with no nurse;
        waiting for results is split by lab and imaging service.
      </p>
      {setups.length > 1 && (
        <div className="seg" role="group" aria-label="Setup">
          {setups.map((x) => (
            <button key={x.scenario.id} className={x === r ? 'on' : ''} aria-pressed={x === r} onClick={() => setPick(x.scenario.id)}>
              {x.scenario.name}
            </button>
          ))}
        </div>
      )}
      <ol className="cause-list">
        {top.map((b) => (
          <li key={b.key} data-testid={`cause-${b.key}`}>
            <div className="cause-head">
              <strong>{b.label}</strong>
              <span className="muted">
                {hoursText(b.hours)} · {Math.round(b.share * 100)}%
              </span>
            </div>
            <div className="cause-bar" aria-hidden="true">
              <span style={{ width: `${Math.max(2, b.share * 100)}%` }} />
            </div>
            <p className="small">{b.what}</p>
            <p className="small muted">{b.lever}</p>
          </li>
        ))}
      </ol>
      {r.processingHours > 0.5 && (
        <p className="muted small">Not counted above: {hoursText(r.processingHours)} a week of tests being run and reported with no queue, which is the time the work takes.</p>
      )}
    </section>
  );
}

/** A range without repeating the unit: "15.1–29.3 min". */
function rangeText(k: Kpi, lo: number | null, hi: number | null): string {
  if (lo === null || hi === null) return '';
  const a = fmt(k, lo);
  const b = fmt(k, hi);
  const unit = / (min|h)$/.exec(b)?.[0] ?? (b.endsWith('%') ? '%' : '');
  return `${unit ? a.slice(0, a.length - unit.length) : a}–${b}`;
}

function RangeCell({ k, r }: { k: Kpi; r: Range }) {
  return (
    <span className="range-cell">
      <strong>{fmt(k, r.median)}</strong>
      {r.lo !== null && r.hi !== null && <span className="muted small">{rangeText(k, r.lo, r.hi)} in a typical week</span>}
    </span>
  );
}

function ChangeCell({ k, d }: { k: Kpi; d: Difference | undefined }) {
  const v = verdict(k, d);
  if (!d || d.mean === null) return <span className="muted">—</span>;
  return (
    <span className="change-cell">
      <strong>{fmt(k, d.mean, true)}</strong>
      <span className="muted small">
        {fmt(k, d.ciLo, true)} to {fmt(k, d.ciHi, true)}
      </span>
      <span className={`chip ${v.cls}`}>{v.label}</span>
      {d.betterShare !== null && v.label !== 'no change' && <span className="muted small">better in {Math.round(d.betterShare * 100)}% of weeks</span>}
    </span>
  );
}

/** Change from baseline for one KPI: a dot per scenario with its 95% interval, around a zero line. */
function ForestPlot({ comparison: c, kpi }: { comparison: Comparison; kpi: Kpi }) {
  const rows = c.scenarios.filter((r) => r.diff?.[kpi.key]?.mean !== null && r.diff?.[kpi.key] !== undefined);
  if (!rows.length) return null;
  const vals = rows.flatMap((r) => [r.diff![kpi.key]!.ciLo!, r.diff![kpi.key]!.ciHi!, 0]);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo || 1) * 0.1;
  const W = 720;
  const left = 230;
  const right = 90;
  const rowH = 34;
  const H = rows.length * rowH + 34;
  const x = (v: number) => left + ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (W - left - right);
  return (
    <figure className="viz forest card" data-testid="forest-plot">
      <figcaption>
        Change from baseline: {kpi.label.toLowerCase()} ({kpi.better === 'lower' ? 'left is better' : 'right is better'})
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Change in ${kpi.label} by scenario, with 95% intervals`}>
        <line className="zero" x1={x(0)} x2={x(0)} y1={6} y2={H - 24} />
        <text className="tick" x={x(0)} y={H - 8} textAnchor="middle">
          no change
        </text>
        {rows.map((r, i) => {
          const d = r.diff![kpi.key]!;
          const y = 18 + i * rowH;
          const v = verdict(kpi, d);
          return (
            <g key={r.scenario.id}>
              <text className="row-label" x={left - 10} y={y + 4} textAnchor="end">
                {r.scenario.name.length > 30 ? `${r.scenario.name.slice(0, 29)}…` : r.scenario.name}
              </text>
              <line className="ci" x1={x(d.ciLo!)} x2={x(d.ciHi!)} y1={y} y2={y} />
              <circle className={`pt ${v.cls}`} cx={x(d.mean!)} cy={y} r={5}>
                <title>
                  {r.scenario.name}: {fmt(kpi, d.mean, true)} (95% CI {fmt(kpi, d.ciLo, true)} to {fmt(kpi, d.ciHi, true)}), {v.label}
                </title>
              </circle>
              <text className="val" x={x(d.ciHi!) + 8} y={y + 4}>
                {fmt(kpi, d.mean, true)}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="muted small">Click a row in the table above to chart that measure.</p>
    </figure>
  );
}

/** Lower-case a label for use mid-sentence, keeping abbreviations like ESI. */
const lower = (s: string) => (/^[A-Z]{2,}/.test(s) ? s : s[0]!.toLowerCase() + s.slice(1));

// ---- 4. Report --------------------------------------------------------------------------

function Report({ project, check }: { project: Project; check: CheckRow[] | null }) {
  const c = project.results!.comparison;
  const dept = project.department;
  const kpis = c.kpis.filter((k) => c.baseline.kpis[k.key]?.n);
  const base = dept.config;
  const staffLine = (role: Role) =>
    (base.staffing?.schedule?.[role] ?? [])
      .map((s) => `${s.count} × ${String(s.startHour).padStart(2, '0')}:00 for ${s.hours} h`)
      .join(', ') || 'none';
  return (
    <article className="report" data-testid="report">
      <div className="actions no-print">
        <button className="primary" onClick={() => window.print()} data-testid="print-report">
          Print or save as PDF
        </button>
      </div>
      <header>
        <p className="eyebrow">Scenario report · {new Date(project.results!.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
        <h1>{dept.name}: what-if analysis</h1>
      </header>
      <section>
        <h2>Summary</h2>
        <ul>
          {c.scenarios.map((r) => {
            const top = kpis
              .map((k) => ({ k, v: verdict(k, r.diff?.[k.key]), d: r.diff?.[k.key] }))
              .filter((x) => x.v.cls)
              .slice(0, 3);
            return (
              <li key={r.scenario.id}>
                <strong>{r.scenario.name}</strong> ({r.scenario.description?.replace(/\.$/, '')}):{' '}
                {r.problems.length
                  ? `could not run: ${r.problems.join('; ')}`
                  : top.length
                    ? top.map((x) => `${lower(x.k.label)} ${x.v.label} (${fmt(x.k, x.d?.mean, true)})`).join('; ')
                    : 'no clear change on the main measures'}
                .
              </li>
            );
          })}
        </ul>
      </section>
      <section>
        <h2>Results</h2>
        <table className="metrics report-table">
          <thead>
            <tr>
              <th />
              <th>Baseline (median, 5–95%)</th>
              {c.scenarios.map((r) => (
                <th key={r.scenario.id}>{r.scenario.name}: change (95% CI)</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {kpis.map((k) => (
              <tr key={k.key}>
                <th scope="row">{k.label}</th>
                <td>
                  {fmt(k, c.baseline.kpis[k.key]!.median)} ({fmt(k, c.baseline.kpis[k.key]!.lo)}–{fmt(k, c.baseline.kpis[k.key]!.hi)})
                </td>
                {c.scenarios.map((r) => {
                  const d = r.diff?.[k.key];
                  return (
                    <td key={r.scenario.id}>
                      {d && d.mean !== null ? `${fmt(k, d.mean, true)} (${fmt(k, d.ciLo, true)} to ${fmt(k, d.ciHi, true)}), ${verdict(k, d).label}` : '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {c.baseline.bottlenecks?.length > 0 && (
        <section>
          <h2>Where the waiting comes from</h2>
          <p>Root causes of queueing in the baseline, in patient-hours per week (share of all queueing):</p>
          <ol>
            {c.baseline.bottlenecks.slice(0, 5).map((b) => (
              <li key={b.key}>
                <strong>{b.label}</strong>: {hoursText(b.hours)} ({Math.round(b.share * 100)}%). {b.what} {b.lever}
              </li>
            ))}
          </ol>
          {c.scenarios
            .filter((r) => !r.problems.length && r.bottlenecks?.[0] && r.bottlenecks[0].key !== c.baseline.bottlenecks[0]!.key)
            .map((r) => (
              <p key={r.scenario.id}>
                With {r.scenario.name.toLowerCase()}, the largest cause becomes {lower(r.bottlenecks[0]!.label)} ({Math.round(r.bottlenecks[0]!.share * 100)}%).
              </p>
            ))}
        </section>
      )}
      <section>
        <h2>The baseline</h2>
        <ul>
          <li>Providers: {staffLine('doctor')}</li>
          <li>Triage nurses: {staffLine('triageNurse')}</li>
          {base.modules?.security && <li>Security officers: {staffLine('security')}</li>}
          {base.modules?.nursing && <li>Bedside nurses: {staffLine('nurse')}</li>}
          <li>Main ED treatment spaces: {base.modules?.layout && base.layout ? `${planBeds(base.layout)} (drawn floor plan)` : (base.beds?.main ?? 20)}</li>
          {base.modules?.boarding && base.boarding?.units && (
            <li>
              Inpatient beds for ED admissions: {UNIT_ROWS.map(([u, label]) => `${label.toLowerCase()} ${base.boarding!.units![u]?.beds ?? 0}`).join(', ')}
            </li>
          )}
          {base.modules?.diagnostics && (
            <li>
              Labs and imaging: {service(base, 'lab', 'servers')} lab slots, {service(base, 'xray', 'servers')} X-ray, {service(base, 'ct', 'servers')} CT,{' '}
              {service(base, 'ultrasound', 'servers')} ultrasound
            </li>
          )}
          <li>
            Systems modelled:{' '}
            {Object.entries(base.modules ?? {})
              .filter(([, on]) => on)
              .map(([m]) => m)
              .join(', ') || 'core flow only'}
          </li>
        </ul>
        {dept.hospital && (
          <p>
            Started from the published emergency department figures of {dept.hospital.name}, {dept.hospital.city}, {dept.hospital.state} (CMS Care Compare,{' '}
            {dept.hospital.period}):{' '}
            {dept.hospital.check
              .filter((c) => c.target !== null)
              .map((c) => `${lower(c.label)} ${unitFmt[c.unit](c.target!)} (model ${c.model === null ? '—' : unitFmt[c.unit](c.model)})`)
              .join('; ')}
            . Beds and shifts were estimated by scaling unless entered.
          </p>
        )}
        {dept.calibration ? (
          <p>
            Calibrated from {dept.calibration.file} ({dept.calibration.visits.toLocaleString('en-US')} visits over {dept.calibration.days} days).{' '}
            {dept.calibration.notes.join(' ')}
          </p>
        ) : (
          <p className="warn-text">
            Not calibrated to this department: the baseline is a typical US emergency department fitted to {NATIONAL.name}. Staffing, space and other
            numbers not in that survey are placeholders, so treat results as illustrative until the model is fitted to the department’s own visits.
          </p>
        )}
        {check && (
          <p>
            Model check against the data: {check.filter((r) => r.status === 'close').length} of {check.filter((r) => r.status !== 'no data').length} measures within 10%
            {check.some((r) => r.status === 'off') ? ` (off: ${check.filter((r) => r.status === 'off').map((r) => r.label.toLowerCase()).join(', ')})` : ''}.
          </p>
        )}
      </section>
      <section>
        <h2>Method and limits</h2>
        <p>
          Discrete-event simulation of patient flow: arrivals by hour and weekday, triage, treatment spaces, provider evaluation, test results, disposition and, where
          enabled, boarding, missed diagnoses and security incidents. Each setup was run for {c.seeds.length} weeks using the same random patient streams
          (common random numbers), so differences reflect the change tested. Intervals are 95% confidence intervals for the average weekly difference. Results
          describe this model, not guarantees; parameters marked as placeholders should be validated with the department before decisions are made. National
          figures: {NATIONAL.citation}
        </p>
      </section>
    </article>
  );
}
