/** The end of a career week: what happened, the ledger, reputation, milestones and why. */
import { PARAMS, type Metrics, type Settlement } from '@er/sim';
import { minutes, percent } from '../format';
import { Why, type RunAnalysis } from '../play/Why';
import { EVENT_NAME, History } from './Career';
import { career, money } from './store';

export function CareerWeek(props: { before: { money: number; reputation: number }; settlement: Settlement; metrics: Metrics; run: RunAnalysis; onContinue: () => void }) {
  const { settlement: st, metrics: m, before } = props;
  const r = st.record;
  const repDelta = r.reputation - before.reputation;
  const total = (ls: { amount: number }[]) => ls.reduce((s, l) => s + l.amount, 0);
  return (
    <main className="screen debrief" data-testid="career-week">
      <section className={`result-banner ${r.net >= 0 ? 'pass' : 'fail'}`}>
        <div>
          <p className="eyebrow">
            {st.state.hospital.name} · week {r.week}
            {r.events.length ? ` · ${r.events.map((e) => EVENT_NAME[e.kind]).join(', ')}` : ''}
          </p>
          <h1 data-testid="week-net">
            {r.net >= 0 ? 'Profit' : 'Loss'} of {money(Math.abs(r.net))}
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            Balanced score {Math.round(r.score)}/100 · reputation {Math.round(before.reputation)} → {Math.round(r.reputation)} ({repDelta >= 0 ? '+' : '−'}
            {Math.abs(repDelta).toFixed(1)}) · balance {money(r.money)}
          </p>
        </div>
      </section>

      {st.state.over && (
        <section className="card career-over" role="alert">
          <h3>The board has stepped in</h3>
          <p>The balance fell below {money(PARAMS.career.bankruptAt)}. Your career ends here.</p>
        </section>
      )}

      {st.newMilestones.length > 0 && (
        <section className="card">
          <h3>Milestone{st.newMilestones.length > 1 ? 's' : ''} reached</h3>
          <ul className="milestones">
            {st.newMilestones.map((id) => (
              <li key={id} className="got new">
                <span className="mark">★</span>
                {career.MILESTONES[id]}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="debrief-grid">
        <section className="card">
          <h3>The week’s accounts</h3>
          <table className="metrics ledger" data-testid="ledger">
            <tbody>
              {r.income.map((l) => (
                <tr key={l.label}>
                  <th scope="row">{l.label}</th>
                  <td>{money(l.amount)}</td>
                </tr>
              ))}
              {r.costs.map((l) => (
                <tr key={l.label}>
                  <th scope="row">{l.label}</th>
                  <td className="neg">−{money(l.amount)}</td>
                </tr>
              ))}
              <tr className="total">
                <th scope="row">Net</th>
                <td className={r.net < 0 ? 'neg' : ''}>{money(total(r.income) - total(r.costs))}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section className="card">
          <h3>The week in numbers</h3>
          <table className="metrics">
            <tbody>
              {(
                [
                  ['Patients arrived', String(m.arrivals)],
                  ['Treated', String(m.treated)],
                  ['Left without being seen', `${m.lwbsCount} (${percent(m.lwbsRate)})`],
                  ['Door to doctor, median', minutes(m.doorToDoctor.median)],
                  ['ESI 1–2 door to doctor, median', minutes(m.doorToDoctorByGroup.urgent.median)],
                  ['Became critical while waiting', String(m.deterioration.critical)],
                  ['Missed diagnoses coming back', String(m.diagnosis.bounceBacks72h)],
                  ['Boarding, average', minutes((m.boarding.meanHours ?? 0) * 60)],
                  ['Doctors busy', percent(m.utilizationByRole.doctor)],
                ] as [string, string][]
              ).map(([k, v]) => (
                <tr key={k}>
                  <th scope="row">{k}</th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <Why m={m} run={props.run} />

      <div className="actions">
        <button className="primary push" onClick={props.onContinue} data-testid="career-continue">
          {st.state.over ? 'See how it ended' : `On to week ${st.state.week}`}
        </button>
      </div>

      <History state={st.state} fresh={st.newMilestones} />
    </main>
  );
}
