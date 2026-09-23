/**
 * "Beat the best found": the best setup a search found for this level's day, shown as a target.
 * Always "best found", never "optimal": it is only the best of the setups the search tried.
 */
import { beatsBenchmark, type LevelBenchmark, type PlayerControl, type Shift } from '@er/sim';
import { useState } from 'react';
import { ROLE_LABEL, type SetupValues } from '../controls';
import { hourLabel } from '../format';
import { TOOL_LABEL } from '../screens/FloorDesigner';

export const CONTROL_LABEL: Record<PlayerControl, string> = {
  'queue.discipline': 'Who sees a doctor next',
  'staffing.doctors': 'Doctors',
  'staffing.triageNurses': 'Triage nurses',
  'staffing.fastTrackClinicians': 'Fast-track clinicians',
  'staffing.schedule.doctor': `${ROLE_LABEL.doctor}: shifts`,
  'staffing.schedule.triageNurse': `${ROLE_LABEL.triageNurse}: shifts`,
  'staffing.schedule.fastTrackClinician': `${ROLE_LABEL.fastTrackClinician}: shifts`,
  'fastTrack.enabled': 'Fast track',
  'fastTrack.minAcuity': 'Sent to fast track',
  'beds.main': 'Main ED treatment spaces',
  'beds.fastTrack': 'Fast-track spaces',
  'boarding.escalation': 'Full-capacity protocol',
  'diagnosis.thoroughness': 'Thoroughness',
  'process.steps': 'Patient process',
  'layout.rooms': 'Floor plan',
} as Record<PlayerControl, string>;

/** A setting in words, e.g. "2 from 22:00 for 12 h · 3 from 08:00 for 12 h". */
export function describeValue(ctl: PlayerControl, v: unknown): string {
  if (ctl === 'layout.rooms') {
    const rooms = (v as { type: string; x: number; y: number }[]) ?? [];
    return rooms.map((r) => `${TOOL_LABEL[r.type as keyof typeof TOOL_LABEL] ?? r.type} at ${r.x},${r.y}`).join(' · ');
  }
  if (ctl.startsWith('staffing.schedule.')) {
    const shifts = (v as Shift[]) ?? [];
    return shifts.length ? shifts.map((s) => `${s.count} from ${hourLabel(s.startHour)} for ${s.hours} h`).join(' · ') : 'none';
  }
  if (ctl === 'queue.discipline') return v === 'acuity' ? 'Sickest first' : 'Whoever arrived first';
  if (ctl === 'fastTrack.enabled') return v ? 'Open' : 'Closed';
  if (ctl === 'boarding.escalation') return v ? 'Declared' : 'Not declared';
  if (ctl === 'fastTrack.minAcuity') return v === 3 ? 'Levels 3, 4 and 5' : v === 4 ? 'Levels 4 and 5' : 'Level 5 only';
  if (ctl === 'diagnosis.thoroughness') return `${Math.round(Number(v) * 100)}%`;
  return String(v);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Controls where the player's setup differs from the best found. */
export function differences(b: LevelBenchmark, values: SetupValues): PlayerControl[] {
  return (Object.keys(b.settings) as PlayerControl[]).filter((c) => !same(b.settings[c], values[c]));
}

/** On the setup screen: the target, and (only if asked) what the best found setup is. */
export function BenchmarkCard(props: { benchmark: LevelBenchmark; values: SetupValues; onUse: (v: SetupValues) => void; beaten?: boolean }) {
  const { benchmark: b, values } = props;
  const [open, setOpen] = useState(false);
  const diff = differences(b, values);
  return (
    <section className="card benchmark" data-testid="benchmark">
      <div className="benchmark-head">
        <div>
          <p className="eyebrow">Beat the best found</p>
          <p className="benchmark-score">
            <strong data-testid="benchmark-score">{b.score.toFixed(1)}</strong>
            <span className="muted">/100</span>
          </p>
        </div>
        <p>
          The best of <strong>{b.evaluated}</strong> setups a computer search tried on this exact shift. Meet the goals and score higher to beat it.
          {props.beaten && (
            <span className="chip pass" style={{ marginLeft: 8 }}>
              ✓ You have beaten it
            </span>
          )}
        </p>
      </div>
      <p className="muted small">
        It is a plan made before the shift, with no decisions during it. Calls you make as things happen can do better. It is the best found, not a proof that
        nothing better exists.
      </p>
      <div className="actions">
        <button onClick={() => setOpen(!open)} aria-expanded={open} data-testid="benchmark-reveal">
          {open ? 'Hide it' : 'Show me the best found setup'}
        </button>
        {open && diff.length > 0 && (
          <button onClick={() => props.onUse({ ...values, ...b.settings })} data-testid="benchmark-use">
            Load it into my setup
          </button>
        )}
      </div>
      {open && (
        <table className="metrics benchmark-table">
          <thead>
            <tr>
              <th />
              <th>Best found</th>
              <th>Yours</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(b.settings) as PlayerControl[]).map((c) => (
              <tr key={c} className={diff.includes(c) ? 'differs' : ''}>
                <th scope="row">{CONTROL_LABEL[c] ?? c}</th>
                <td>{describeValue(c, b.settings[c])}</td>
                <td>{diff.includes(c) ? describeValue(c, values[c]) : 'same'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && b.fixed && b.fixed.length > 0 && <p className="muted small">The search left {b.fixed.map((c) => (CONTROL_LABEL[c] ?? c).toLowerCase()).join(', ')} as shipped.</p>}
    </section>
  );
}

/** On the debrief: how the run compares with the best found. */
export function BenchmarkResult({ benchmark: b, score, goalsMet }: { benchmark: LevelBenchmark; score: number; goalsMet: boolean }) {
  const beat = beatsBenchmark(b, score, goalsMet);
  const gap = score - b.score;
  return (
    <section className={`card benchmark-result ${beat ? 'beat' : ''}`} data-testid="benchmark-result">
      {beat ? (
        <p>
          <span className="badge-beat">★ You beat the best found</span> {score.toFixed(1)} against {b.score.toFixed(1)}, the best of {b.evaluated} setups the
          search tried.
        </p>
      ) : !goalsMet ? (
        <p>
          Best found on this shift: <strong>{b.score.toFixed(1)}</strong>. Meet the goals first, then beat the score.
        </p>
      ) : (
        <p>
          Best found on this shift: <strong>{b.score.toFixed(1)}</strong>. You scored {score.toFixed(1)},{' '}
          {Math.abs(gap) < 0.05 ? 'level with it. Anything higher beats it.' : `${Math.abs(gap).toFixed(1)} points behind.`}
        </p>
      )}
    </section>
  );
}
