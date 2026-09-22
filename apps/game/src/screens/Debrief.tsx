import { evaluateGoals, type Metrics } from '@er/sim';
import { metricValue, minutes, percent } from '../format';
import type { LevelConfig } from '../levels';

export function Debrief(props: { level: LevelConfig; metrics: Metrics; onRetry: () => void; onNext?: () => void; onMenu: () => void }) {
  const { level, metrics: m, onRetry, onNext, onMenu } = props;
  const { passed, results } = evaluateGoals(m, level.level.goals);
  const rows: [string, string][] = [
    ['Patients arrived', String(m.arrivals)],
    ['Seen by a doctor', String(m.seenByDoctor)],
    ['Left without being seen', `${m.lwbsCount} (${percent(m.lwbsRate)})`],
    ['Door to doctor, median', minutes(m.doorToDoctor.median)],
    ['Door to doctor, 90th percentile', minutes(m.doorToDoctor.p90)],
    ['ESI 1–2 door to doctor, median', minutes(m.doorToDoctorByGroup.urgent.median)],
    ['Length of stay, median', minutes(m.lengthOfStay.median)],
    ['Admitted', `${m.admitted} (${percent(m.admissionRate)})`],
    ['Got worse while waiting', String(m.deterioration.events)],
    ...(m.boarding.boarders > 0 ? ([['Boarding, average', minutes((m.boarding.meanHours ?? 0) * 60)]] as [string, string][]) : []),
    ...(m.diagnosis.misdiagnosisRate !== null
      ? ([
          ['Missed diagnoses (now revealed)', percent(m.diagnosis.misdiagnosisRate)],
          ['Came back within 72 h', String(m.diagnosis.bounceBacks72h)],
        ] as [string, string][])
      : []),
    ['Doctors busy', percent(m.utilizationByRole.doctor)],
    ['Triage accuracy (now revealed)', percent(m.triage.accuracy)],
  ];
  return (
    <main className="screen debrief">
      <p className="eyebrow">Simulation {level.level.number} · debrief</p>
      <h1 data-testid="result">{passed ? 'Goals met' : 'Goals not met'}</h1>
      <ul className="goals results">
        {results.map((r) => (
          <li key={r.metric} className={r.passed ? 'pass' : 'fail'}>
            <span className="mark" aria-hidden>
              {r.passed ? '✓' : '✗'}
            </span>
            {r.label}
            <span className="value">{r.value === null ? 'no patients in this group' : metricValue(r.metric, r.value)}</span>
          </li>
        ))}
      </ul>
      {(passed ? level.level.debrief.pass : level.level.debrief.fail).map((p, i) => (
        <p key={i} className="narrative">
          {p}
        </p>
      ))}
      <table className="metrics">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button onClick={onMenu}>Menu</button>
        <button onClick={onRetry} data-testid="retry">
          Try again
        </button>
        {passed && onNext && (
          <button className="primary" onClick={onNext} data-testid="next">
            Next simulation
          </button>
        )}
      </div>
    </main>
  );
}
