import {
  ConfigError,
  checkSetup,
  exampleLayout,
  MODULES,
  plannedDailyCost,
  resolveConfig,
  type Acuity,
  type ModuleName,
  type QueueDiscipline,
  type StepInput,
} from '@er/sim';
import { useMemo, useState } from 'react';
import { minutes, percent } from '../format';
import { downloadJson, quickScore, type GameConfig, type QuickScore } from '../sandbox';
import { detailedProcess, ProcessEditor } from './ProcessEditor';
import { Stepper } from './ScheduleEditor';

const MODULE_TEXT: Record<ModuleName, [string, string]> = {
  staffing: ['Shift schedules', 'Staff come and go on shifts instead of a fixed number all day.'],
  process: ['Custom patient process', 'Build your own steps: vitals, labs, imaging, and who does them.'],
  diagnosis: ['Diagnosis', 'Rushed assessments miss things; missed patients come back sicker.'],
  boarding: ['Boarding', 'Admitted patients wait in your beds until a ward bed is free.'],
  layout: ['Floor plan', 'Staff walk between rooms; distance costs time.'],
  budget: ['Budget', 'A daily cap on the cost of your setup.'],
  shocks: ['Shocks', 'A surge of extra patients on day two.'],
  burnout: ['Burnout', 'Tired staff get slower and make more mistakes.'],
};

export interface SandboxState {
  modules: Record<ModuleName, boolean>;
  days: number;
  arrivalMultiplier: number;
  doctors: number;
  triageNurses: number;
  fastTrackClinicians: number;
  nurses: number;
  techs: number;
  bedsMain: number;
  bedsFastTrack: number;
  discipline: QueueDiscipline;
  fastTrackFrom: Acuity | null;
  thoroughness: number;
  escalation: boolean;
  capPerDay: number;
  steps: StepInput[];
}

export const PRESETS: Record<string, { label: string; state: Partial<SandboxState> }> = {
  default: { label: 'A normal week', state: {} },
  boarding: {
    label: 'Hospital nearly full',
    state: { modules: { ...allOff(), boarding: true }, days: 3 },
  },
  flu: {
    label: 'Flu surge',
    state: { modules: { ...allOff(), shocks: true, burnout: true }, days: 4 },
  },
  process: {
    label: 'Detailed process (vitals, labs, imaging)',
    state: { modules: { ...allOff(), process: true, diagnosis: true }, nurses: 3, techs: 2 },
  },
  everything: {
    label: 'Everything on',
    state: { modules: Object.fromEntries(MODULES.map((m) => [m, true])) as Record<ModuleName, boolean>, nurses: 3, techs: 2, days: 3 },
  },
};

function allOff(): Record<ModuleName, boolean> {
  return Object.fromEntries(MODULES.map((m) => [m, false])) as Record<ModuleName, boolean>;
}

export function defaultSandbox(): SandboxState {
  return {
    modules: allOff(),
    days: 7,
    arrivalMultiplier: 1,
    doctors: 4,
    triageNurses: 1,
    fastTrackClinicians: 0,
    nurses: 0,
    techs: 0,
    bedsMain: 20,
    bedsFastTrack: 6,
    discipline: 'acuity',
    fastTrackFrom: null,
    thoroughness: 0.5,
    escalation: false,
    capPerDay: 30000,
    steps: detailedProcess(),
  };
}

/** Turn the sandbox form into a runnable config. */
export function sandboxConfig(s: SandboxState): GameConfig {
  const m = s.modules;
  return {
    id: 'sandbox',
    name: 'Sandbox',
    durationMinutes: s.days * 1440,
    warmupMinutes: s.days > 2 ? 1440 : 0,
    modules: m,
    arrivals: { rateMultiplier: s.arrivalMultiplier },
    staffing: {
      doctors: s.doctors,
      triageNurses: s.triageNurses,
      fastTrackClinicians: s.fastTrackClinicians,
      nurses: s.nurses,
      techs: s.techs,
      ...(m.staffing
        ? {
            schedule: {
              doctor: [
                { startHour: 22, hours: 12, count: Math.max(1, Math.floor(s.doctors / 2)) },
                { startHour: 10, hours: 12, count: s.doctors },
              ],
            },
          }
        : {}),
    },
    ...(m.layout ? { layout: exampleLayout() } : { beds: { main: s.bedsMain, fastTrack: s.bedsFastTrack } }),
    queue: { discipline: s.discipline },
    fastTrack: { enabled: s.fastTrackFrom !== null && !m.process, minAcuity: s.fastTrackFrom ?? 4 },
    diagnosis: { thoroughness: s.thoroughness },
    boarding: { inpatientBeds: 40, initialOccupied: 38, dischargesPerDay: 20, escalation: s.escalation },
    shocks: [{ type: 'surge', startMinute: 1440, endMinute: 2880, multiplier: 1.4 }],
    budget: { capPerDay: s.capPerDay },
    ...(m.process
      ? { process: { steps: s.steps, routing: s.fastTrackFrom !== null ? [{ minAcuity: s.fastTrackFrom, maxAcuity: 5, lane: 'fastTrack' as const }] : [] } }
      : {}),
  };
}

export function Sandbox(props: { state: SandboxState; onChange: (s: SandboxState) => void; onPlay: (c: GameConfig) => void; onLayout: () => void; onBack: () => void }) {
  const { state: s, onChange } = props;
  const [score, setScore] = useState<{ q: QuickScore; composite: number; cost: number } | null>(null);
  const set = (patch: Partial<SandboxState>) => {
    onChange({ ...s, ...patch });
    setScore(null);
  };
  const config = useMemo(() => sandboxConfig(s), [s]);
  const { problems, planned } = useMemo(() => {
    try {
      const r = resolveConfig(config);
      return { problems: checkSetup(r), planned: plannedDailyCost(r).total };
    } catch (e) {
      return { problems: e instanceof ConfigError ? e.problems : [String(e)], planned: null };
    }
  }, [config]);

  const test = async () => {
    const q = quickScore(config);
    const { Simulation } = await import('@er/sim');
    const m = new Simulation(config, 1).run().metrics;
    setScore({ q, composite: m.compositeScore, cost: m.cost.perDay });
  };

  const stepper = (label: string, key: keyof SandboxState, min: number, max: number) => (
    <span className="knob">
      {label} <Stepper value={s[key] as number} min={min} max={max} onChange={(v) => set({ [key]: v } as Partial<SandboxState>)} label={label} />
    </span>
  );

  return (
    <main className="screen sandbox">
      <p className="eyebrow">Sandbox</p>
      <h1>Build your own ED</h1>
      <div className="presets" role="group" aria-label="Presets">
        {Object.entries(PRESETS).map(([k, p]) => (
          <button key={k} onClick={() => set({ ...defaultSandbox(), ...p.state })} data-testid={`preset-${k}`}>
            {p.label}
          </button>
        ))}
        <button onClick={props.onLayout}>Layout only…</button>
      </div>

      <h2>Systems</h2>
      <ul className="modules">
        {MODULES.map((m) => (
          <li key={m}>
            <label>
              <input type="checkbox" checked={s.modules[m]} onChange={(e) => set({ modules: { ...s.modules, [m]: e.target.checked } })} data-testid={`module-${m}`} />{' '}
              <strong>{MODULE_TEXT[m][0]}</strong>
              <span className="muted"> {MODULE_TEXT[m][1]}</span>
            </label>
          </li>
        ))}
      </ul>

      <h2>Setup</h2>
      <div className="knobs">
        {stepper('Days', 'days', 1, 14)}
        <span className="knob">
          Arrivals{' '}
          <select value={s.arrivalMultiplier} onChange={(e) => set({ arrivalMultiplier: Number(e.target.value) })} aria-label="Arrival level">
            {[0.6, 0.8, 1, 1.2, 1.4, 1.6].map((v) => (
              <option key={v} value={v}>
                {Math.round(v * 100)}% of normal
              </option>
            ))}
          </select>
        </span>
        {stepper('Doctors', 'doctors', 0, 12)}
        {stepper('Triage nurses', 'triageNurses', 0, 4)}
        {stepper('Fast-track clinicians', 'fastTrackClinicians', 0, 4)}
        {s.modules.process && stepper('Nurses', 'nurses', 0, 10)}
        {s.modules.process && stepper('Technicians', 'techs', 0, 6)}
        {!s.modules.layout && stepper('Main beds', 'bedsMain', 1, 60)}
        {!s.modules.layout && stepper('Fast-track beds', 'bedsFastTrack', 1, 20)}
        <span className="knob">
          Queue{' '}
          <select value={s.discipline} onChange={(e) => set({ discipline: e.target.value as QueueDiscipline })} aria-label="Queue order">
            <option value="acuity">Sickest first</option>
            <option value="fifo">Arrival order</option>
          </select>
        </span>
        {!s.modules.process && (
          <span className="knob">
            Fast track{' '}
            <select value={s.fastTrackFrom ?? ''} onChange={(e) => set({ fastTrackFrom: e.target.value ? (Number(e.target.value) as Acuity) : null })} aria-label="Fast track">
              <option value="">closed</option>
              <option value="4">ESI 4–5</option>
              <option value="5">ESI 5</option>
            </select>
          </span>
        )}
        {s.modules.diagnosis && !s.modules.process && (
          <label className="knob">
            Thoroughness {Math.round(s.thoroughness * 100)}%
            <input type="range" min={0} max={1} step={0.05} value={s.thoroughness} onChange={(e) => set({ thoroughness: Number(e.target.value) })} />
          </label>
        )}
        {s.modules.boarding && (
          <label className="knob">
            <input type="checkbox" checked={s.escalation} onChange={(e) => set({ escalation: e.target.checked })} /> Full-capacity protocol
          </label>
        )}
        {s.modules.budget && (
          <span className="knob">
            Budget per day{' '}
            <select value={s.capPerDay} onChange={(e) => set({ capPerDay: Number(e.target.value) })} aria-label="Budget per day">
              {Array.from({ length: 11 }, (_, i) => 15000 + i * 2500).map((v) => (
                <option key={v} value={v}>
                  {v.toLocaleString('en-US')}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>
      {planned !== null && (
        <p className="muted" data-testid="planned-cost">
          Planned cost: {Math.round(planned).toLocaleString('en-US')} per day
        </p>
      )}

      {s.modules.process && (
        <ProcessEditor steps={s.steps} fastTrackFrom={s.fastTrackFrom} onChange={(steps) => set({ steps })} onFastTrackFrom={(fastTrackFrom) => set({ fastTrackFrom })} />
      )}

      {problems.length > 0 && (
        <ul className="problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="actions">
        <button onClick={props.onBack}>Back</button>
        <button onClick={() => downloadJson('sandbox.json', config)} disabled={problems.length > 0}>
          Export config
        </button>
        <button onClick={test} disabled={problems.length > 0} data-testid="sandbox-test">
          Test (three runs)
        </button>
        <button className="primary" onClick={() => props.onPlay(config)} disabled={problems.length > 0} data-testid="sandbox-play">
          Watch it run
        </button>
      </div>

      {score && (
        <table className="metrics" data-testid="sandbox-score">
          <tbody>
            {(
              [
                ['Balanced score', `${Math.round(score.composite)} / 100`],
                ['Door to doctor, median', minutes(score.q.doorToDoctorMedian)],
                ['Length of stay, median', minutes(score.q.lengthOfStayMedian)],
                ['Left without being seen', percent(score.q.lwbsRate)],
                ['Cost per day', Math.round(score.cost).toLocaleString('en-US')],
              ] as [string, string][]
            ).map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
