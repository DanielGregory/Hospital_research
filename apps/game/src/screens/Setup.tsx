import { plannedDailyCost, resolveConfig, type Acuity, type PlayerControl, type QueueDiscipline, type Shift } from '@er/sim';
import { buildConfig, scheduleRole, setupProblems, type SetupValues } from '../controls';
import type { LevelConfig } from '../levels';
import { BenchmarkCard } from '../play/benchmark';
import { WalkMap } from '../play/WalkMap';
import { quickScore, type QuickScore } from '../sandbox';
import { useState } from 'react';
import type { LayoutSpec, RoomSpec } from '@er/sim';
import { FloorDesigner, type Tool } from './FloorDesigner';
import { ScheduleEditor, Stepper } from './ScheduleEditor';

export function Setup(props: {
  level: LevelConfig;
  values: SetupValues;
  onChange: (v: SetupValues) => void;
  onStart: () => void;
  onBack: () => void;
  /** Show the level's best found setup as a target (not on daily challenges: they play another day). */
  showBenchmark?: boolean;
  beaten?: boolean;
}) {
  const { level, values, onChange, onStart, onBack } = props;
  const problems = setupProblems(level, values);
  const config = buildConfig(level, values);
  const set = (ctl: PlayerControl, v: unknown) => onChange({ ...values, [ctl]: v });

  return (
    <main className="screen narrow setup">
      <p className="eyebrow">Simulation {String(level.level.number).padStart(2, '0')} · setup</p>
      <h1>{level.level.title}</h1>
      <p className="lede">Set things up before the shift starts. Everything else is locked for this simulation.</p>
      {level.level.playerControls.length === 0 && <p>Nothing to set up. Watch closely.</p>}
      {props.showBenchmark && level.level.benchmark && <BenchmarkCard benchmark={level.level.benchmark} values={values} onUse={onChange} beaten={props.beaten} />}
      {level.level.playerControls.filter(scheduleRole).map((ctl) => (
        <ScheduleEditor key={ctl} role={scheduleRole(ctl)!} shifts={(values[ctl] as Shift[]) ?? []} config={config} onChange={(s) => set(ctl, s)} />
      ))}
      {level.level.playerControls.includes('layout.rooms') && level.layout && (
        <PlanSection level={level} rooms={(values['layout.rooms'] as RoomSpec[]) ?? level.layout.rooms} onChange={(rooms) => set('layout.rooms', rooms)} problems={problems} />
      )}
      {level.level.playerControls.some((c) => !scheduleRole(c) && c !== 'layout.rooms') && (
        <section className="card">
          {level.level.playerControls
            .filter((c) => !scheduleRole(c) && c !== 'layout.rooms')
            .map((ctl) => (
              <SimpleControl key={ctl} control={ctl} value={values[ctl]} onChange={(v) => set(ctl, v)} />
            ))}
        </section>
      )}
      {config.modules?.budget && <BudgetLine planned={plannedCost(config)} cap={config.budget?.capPerDay ?? null} />}
      {problems.length > 0 && (
        <ul className="problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button onClick={onBack}>Back</button>
        <button className="primary push" disabled={problems.length > 0} onClick={onStart} data-testid="start">
          Start the shift
        </button>
      </div>
    </main>
  );
}

const LEVEL_TOOLS: Tool[] = ['waiting', 'triage', 'trauma', 'acute', 'station', 'door', 'erase'];

/** A level that hands the player the floor plan: the designer, and a test on days other than the level's. */
function PlanSection(props: { level: LevelConfig; rooms: RoomSpec[]; onChange: (rooms: RoomSpec[]) => void; problems: string[] }) {
  const spec: LayoutSpec = { ...props.level.layout!, rooms: props.rooms };
  const [test, setTest] = useState<QuickScore | null>(null);
  const run = () => setTest(quickScore(buildConfig(props.level, { 'layout.rooms': props.rooms }), [101, 102, 103]));
  return (
    <section className="plan-section" data-testid="plan-section">
      <FloorDesigner
        spec={spec}
        onChange={(next) => {
          props.onChange(next.rooms);
          setTest(null);
        }}
        tools={LEVEL_TOOLS}
      />
      <div className="actions" style={{ marginTop: 8 }}>
        <button onClick={run} disabled={props.problems.length > 0} data-testid="test-plan">
          Try it on three other days
        </button>
      </div>
      {test && (
        <section className="card score" data-testid="plan-test">
          <h3>Three practice days (not the day you will play)</h3>
          <table className="metrics">
            <tbody>
              <tr>
                <th scope="row">Door to doctor, median</th>
                <td>{Math.round(test.doorToDoctorMedian)} min</td>
              </tr>
              <tr>
                <th scope="row">Doctors&apos; busy time spent walking</th>
                <td>{test.doctorWalkingShare === null ? '—' : `${(test.doctorWalkingShare * 100).toFixed(1)}%`}</td>
              </tr>
              <tr>
                <th scope="row">Left without being seen</th>
                <td>{(test.lwbsRate * 100).toFixed(1)}%</td>
              </tr>
            </tbody>
          </table>
          {test.walks && <WalkMap layout={test.walks.layout} walks={test.walks.walks} caption="Where people walked (first practice day)" />}
        </section>
      )}
    </section>
  );
}

function plannedCost(config: unknown): number | null {
  try {
    return plannedDailyCost(resolveConfig(config)).total;
  } catch {
    return null;
  }
}

function BudgetLine({ planned, cap }: { planned: number | null; cap: number | null }) {
  if (planned === null) return null;
  const share = cap ? Math.min(1, planned / cap) : 0;
  const over = cap !== null && planned > cap;
  return (
    <div className="budget" data-testid="budget-line">
      <p className={over ? 'over' : 'muted'}>
        Planned cost {Math.round(planned).toLocaleString('en-US')} per day{cap !== null ? ` of ${cap.toLocaleString('en-US')}` : ''}
      </p>
      {cap !== null && (
        <div className="progress budget-bar" aria-hidden>
          <span style={{ width: `${share * 100}%` }} className={over ? 'over-bar' : ''} />
        </div>
      )}
    </div>
  );
}

/** Controls that are a single value. Also used live during play. */
export function SimpleControl({ control, value, onChange }: { control: PlayerControl; value: unknown; onChange: (v: unknown) => void }) {
  switch (control) {
    case 'queue.discipline':
      return (
        <fieldset className="control">
          <legend>Who sees a doctor next?</legend>
          {(
            [
              ['fifo', 'Whoever arrived first'],
              ['acuity', 'Sickest first (by triage level)'],
            ] as [QueueDiscipline, string][]
          ).map(([v, label]) => (
            <label key={v}>
              <input type="radio" name="discipline" checked={value === v} onChange={() => onChange(v)} data-testid={`discipline-${v}`} /> {label}
            </label>
          ))}
        </fieldset>
      );
    case 'fastTrack.enabled':
      return (
        <label className="control check">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} data-testid="fasttrack-enabled" /> Fast track open
        </label>
      );
    case 'fastTrack.minAcuity':
      return (
        <label className="control control-row">
          Send to fast track: triage level{' '}
          <select value={String(value)} onChange={(e) => onChange(Number(e.target.value) as Acuity)}>
            <option value="4">4 and 5</option>
            <option value="5">5 only</option>
            <option value="3">3, 4 and 5</option>
          </select>
        </label>
      );
    case 'beds.main':
    case 'beds.fastTrack':
      return (
        <div className="control control-row">
          {control === 'beds.main' ? 'Main ED treatment spaces' : 'Fast-track spaces'}{' '}
          <Stepper value={Number(value ?? 0)} min={1} max={60} onChange={onChange} label={control} />
        </div>
      );
    case 'boarding.escalation':
      return (
        <label className="control check">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} data-testid="escalation" /> Declare hospital
          full-capacity protocol (wards discharge faster)
        </label>
      );
    case 'diagnosis.thoroughness':
      return (
        <label className="control">
          How thorough are doctor assessments? <strong>{Math.round(Number(value) * 100)}%</strong>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={Number(value)}
            onChange={(e) => onChange(Number(e.target.value))}
            aria-label="Thoroughness"
            className="slider"
          />
          <span className="muted">Faster, more misses ↔ slower, fewer misses</span>
        </label>
      );
    case 'staffing.doctors':
    case 'staffing.triageNurses':
    case 'staffing.fastTrackClinicians':
      return (
        <div className="control control-row">
          {control === 'staffing.doctors' ? 'Doctors' : control === 'staffing.triageNurses' ? 'Triage nurses' : 'Fast-track clinicians'}{' '}
          <Stepper value={Number(value ?? 0)} min={0} max={12} onChange={onChange} label={control} />
        </div>
      );
    default:
      return null;
  }
}
