import { evaluateGoals, type LevelSpec, type Metrics } from '@er/sim';
import { metricValue, minutes, percent } from '../format';

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
    ...(m.walking ? ([["Doctors' busy time spent walking", percent(m.walking.shareOfBusyByRole.doctor)]] as [string, string][]) : []),
    ['Triage accuracy (now revealed)', percent(m.triage.accuracy)],
    ['Cost per day', Math.round(m.cost.perDay).toLocaleString('en-US')],
  ];
  const tone = !level ? '' : passed ? 'pass' : 'fail';
  return (
    <main className="screen debrief">
      <section className={`result-banner ${tone}`}>
        <ScoreRing score={m.compositeScore} />
        <div>
          <p className="eyebrow">{level ? `Simulation ${String(level.number).padStart(2, '0')} · debrief` : 'Sandbox · results'}</p>
          <h1 data-testid="result">{!level ? 'Shift complete' : passed ? 'Goals met' : 'Goals not met'}</h1>
          {level && (
            <p className="muted" style={{ margin: 0 }}>
              {results.filter((r) => r.passed).length} of {results.length} goals met · balanced score{' '}
              <span data-testid="composite">{Math.round(m.compositeScore)}</span>/100
            </p>
          )}
          {!level && (
            <p className="muted" style={{ margin: 0 }}>
              Balanced score <span data-testid="composite">{Math.round(m.compositeScore)}</span>/100
            </p>
          )}
        </div>
      </section>

      {results.length > 0 && (
        <ul className="goals results">
          {results.map((r) => (
            <li key={r.metric} className={r.passed ? 'pass' : 'fail'}>
              <span className="mark" aria-label={r.passed ? 'met' : 'not met'}>
                {r.passed ? '✓' : '✕'}
              </span>
              <span>{r.label}</span>
              <span className="value">{r.value === null ? 'no patients in this group' : metricValue(r.metric, r.value)}</span>
            </li>
          ))}
        </ul>
      )}

      {(level ? (passed ? level.debrief.pass : level.debrief.fail) : []).map((p, i) => (
        <p key={i} className="narrative">
          {p}
        </p>
      ))}

      <div className="debrief-grid">
        <section className="card">
          <h3>What made up the score</h3>
          <table className="metrics score-breakdown">
            <tbody>
              {m.scoreBreakdown.map((t) => (
                <tr key={t.metric}>
                  <th scope="row">
                    {SCORE_LABEL[t.metric] ?? t.metric} <span className="muted">×{t.weight}</span>
                  </th>
                  <td>{t.value === null ? '—' : metricValue(t.metric, t.value)}</td>
                  <td>
                    <span className="meter" role="img" aria-label={`${Math.round(t.subscore * 100)}% of full marks`}>
                      <span style={{ width: `${t.subscore * 100}%` }} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h3>The shift in numbers</h3>
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
        </section>
      </div>

      <div className="actions">
        <button onClick={onMenu}>Menu</button>
        <button onClick={onRetry} data-testid="retry">
          {props.retryLabel ?? 'Try again'}
        </button>
        {passed && onNext && (
          <button className="primary push" onClick={onNext} data-testid="next">
            Next simulation
          </button>
        )}
      </div>
    </main>
  );
}

function ScoreRing({ score }: { score: number }) {
  const r = 44;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, score));
  return (
    <svg className="score-ring" viewBox="0 0 108 108" role="img" aria-label={`Balanced score ${Math.round(v)} out of 100`}>
      <circle className="track" cx="54" cy="54" r={r} fill="none" strokeWidth="9" />
      <circle
        className="value"
        cx="54"
        cy="54"
        r={r}
        fill="none"
        strokeWidth="9"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - v / 100)}
        transform="rotate(-90 54 54)"
      />
      <text x="54" y="58" textAnchor="middle">
        {Math.round(v)}
      </text>
      <text x="54" y="74" textAnchor="middle" className="sub">
        SCORE
      </text>
    </svg>
  );
}
