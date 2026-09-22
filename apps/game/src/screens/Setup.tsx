import { plannedDailyCost, resolveConfig, type Acuity, type PlayerControl, type QueueDiscipline, type Shift } from '@er/sim';
import { buildConfig, scheduleRole, setupProblems, type SetupValues } from '../controls';
import type { LevelConfig } from '../levels';
import { ScheduleEditor, Stepper } from './ScheduleEditor';

export function Setup(props: { level: LevelConfig; values: SetupValues; onChange: (v: SetupValues) => void; onStart: () => void; onBack: () => void }) {
  const { level, values, onChange, onStart, onBack } = props;
  const problems = setupProblems(level, values);
  const config = buildConfig(level, values);
  const set = (ctl: PlayerControl, v: unknown) => onChange({ ...values, [ctl]: v });

  return (
    <main className="screen setup">
      <p className="eyebrow">Simulation {level.level.number} · setup</p>
      <h1>{level.level.title}</h1>
      {level.level.playerControls.length === 0 && <p>Nothing to set up. Watch closely.</p>}
      {level.level.playerControls.map((ctl) => {
        const role = scheduleRole(ctl);
        if (role) return <ScheduleEditor key={ctl} role={role} shifts={(values[ctl] as Shift[]) ?? []} config={config} onChange={(s) => set(ctl, s)} />;
        return <SimpleControl key={ctl} control={ctl} value={values[ctl]} onChange={(v) => set(ctl, v)} />;
      })}
      {config.modules?.budget && (
        <BudgetLine planned={plannedCost(config)} cap={config.budget?.capPerDay ?? null} />
      )}
      {problems.length > 0 && (
        <ul className="problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button onClick={onBack}>Back</button>
        <button className="primary" disabled={problems.length > 0} onClick={onStart} data-testid="start">
          Start shift
        </button>
      </div>
    </main>
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
        <label className="control">
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
        <div className="control">
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
        <div className="control">
          {control === 'staffing.doctors' ? 'Doctors' : control === 'staffing.triageNurses' ? 'Triage nurses' : 'Fast-track clinicians'}{' '}
          <Stepper value={Number(value ?? 0)} min={0} max={12} onChange={onChange} label={control} />
        </div>
      );
    default:
      return null;
  }
}
