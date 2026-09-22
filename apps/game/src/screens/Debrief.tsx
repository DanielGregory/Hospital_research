import { evaluateGoals, type Metrics } from '@er/sim';
import { metricValue, minutes, percent } from '../format';
import type { LevelSpec } from '@er/sim';

const SCORE_LABEL: Record<string, string> = {
  'doorToDoctor.median': 'Door to doctor, median',
  'doorToDoctorByGroup.urgent.median': 'ESI 1–2 door to doctor',
  lwbsRate: 'Left without being seen',
  'lengthOfStay.median': 'Length of stay, median',
  'deterioration.per100Arrivals': 'Got worse while waiting (per 100)',
  'diagnosis.bounceBackRate72h': 'Came back within 72 h',
  'boarding.meanHours': 'Boarding time (hours)',
};

export function Debrief(props: { level?: LevelSpec; metrics: Metrics; onRetry: () => void; onNext?: () => void; onMenu: () => void; retryLabel?: string }) {
  const { level, metrics: m, onRetry, onNext, onMenu } = props;
  const { passed, results } = evaluateGoals(m, level?.goals ?? []);
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
    ['Cost per day', Math.round(m.cost.perDay).toLocaleString('en-US')],
    ...(m.walking ? ([["Doctors' busy time spent walking", percent(m.walking.shareOfBusyByRole.doctor)]] as [string, string][]) : []),
    ['Triage accuracy (now revealed)', percent(m.triage.accuracy)],
  ];
  return (
    <main className="screen debrief">
      <p className="eyebrow">{level ? `Simulation ${level.number} · debrief` : 'Sandbox · results'}</p>
      <h1 data-testid="result">{!level ? 'Shift complete' : passed ? 'Goals met' : 'Goals not met'}</h1>
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
      {(level ? (passed ? level.debrief.pass : level.debrief.fail) : []).map((p, i) => (
        <p key={i} className="narrative">
          {p}
        </p>
      ))}
      <h2>
        Balanced score: <span data-testid="composite">{Math.round(m.compositeScore)}</span> / 100
      </h2>
      <table className="metrics score-breakdown">
        <tbody>
          {m.scoreBreakdown.map((t) => (
            <tr key={t.metric}>
              <th scope="row">
                {SCORE_LABEL[t.metric] ?? t.metric} <span className="muted">×{t.weight}</span>
              </th>
              <td>{t.value === null ? '—' : metricValue(t.metric, t.value)}</td>
              <td>
                <span className="meter" aria-label={`${Math.round(t.subscore * 100)}% of full marks`}>
                  <span style={{ width: `${t.subscore * 100}%` }} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
          {props.retryLabel ?? 'Try again'}
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
