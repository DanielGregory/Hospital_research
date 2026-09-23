/**
 * Career headquarters: your hospital between weeks. Every rule (prices, events, settlement) comes
 * from the sim's `career` module; this screen only shows the state and sends the player's changes.
 */
import { hourlyLoad, PARAMS, plannedDailyCost, resolveConfig, type CareerState, type MilestoneId, type Role, type Shift, type UpgradeId } from '@er/sim';
import { useState } from 'react';
import { SimpleControl } from '../screens/Setup';
import { ScheduleEditor, Stepper } from '../screens/ScheduleEditor';
import { WeekChart } from './charts';
import { career, careerSeed, money } from './store';

export function Career(props: {
  state: CareerState | null;
  onChange: (s: CareerState | null) => void;
  onPlay: () => void;
  onSimulate: () => void;
  onBack: () => void;
}) {
  const { state } = props;
  if (!state) return <NewCareer onStart={props.onChange} onBack={props.onBack} />;
  if (state.over) return <CareerOver state={state} onRestart={() => props.onChange(null)} onBack={props.onBack} />;
  return <HQ {...props} state={state} />;
}

function NewCareer({ onStart, onBack }: { onStart: (s: CareerState) => void; onBack: () => void }) {
  const [name, setName] = useState('St Elsewhere General');
  const c = PARAMS.career;
  return (
    <main className="screen narrow">
      <p className="eyebrow">Career</p>
      <h1>Run your own hospital</h1>
      <p className="lede">
        One emergency department, week after week. You are paid for every patient treated, and charged for staff, beds, upgrades and every person who leaves
        unseen or comes back sicker. Reputation brings more patients. Flu seasons, heatwaves, full wards and major incidents will test you.
      </p>
      <section className="card">
        <label className="control">
          Hospital name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} data-testid="career-name" />
        </label>
        <p className="muted small">
          You start with {money(c.startMoney)} and a reputation of {c.startReputation}. If the balance falls below {money(c.bankruptAt)}, the board replaces you.
        </p>
      </section>
      <div className="actions">
        <button onClick={onBack}>Back</button>
        <button className="primary push" disabled={!name.trim()} onClick={() => onStart(career.newCareer(name.trim(), careerSeed(name.trim(), Date.now())))} data-testid="career-start">
          Open the doors
        </button>
      </div>
    </main>
  );
}

function CareerOver({ state, onRestart, onBack }: { state: CareerState; onRestart: () => void; onBack: () => void }) {
  return (
    <main className="screen">
      <section className="card career-over" data-testid="career-over">
        <p className="eyebrow">Career over · after {state.history.length} weeks</p>
        <h1>The board has replaced you</h1>
        <p>
          {state.hospital.name} ran out of money (balance {money(state.money)}). You finished with a reputation of {Math.round(state.reputation)} and{' '}
          {state.milestones.length} of {Object.keys(career.MILESTONES).length} milestones.
        </p>
      </section>
      <History state={state} />
      <div className="actions">
        <button onClick={onBack}>Menu</button>
        <button className="primary push" onClick={onRestart} data-testid="career-restart">
          Start a new career
        </button>
      </div>
    </main>
  );
}

function HQ(props: { state: CareerState; onChange: (s: CareerState) => void; onPlay: () => void; onSimulate: () => void; onBack: () => void }) {
  const { state, onChange } = props;
  const h = state.hospital;
  const [problem, setProblem] = useState<string | null>(null);
  const [schedule, setSchedule] = useState(h.schedule);
  const [beds, setBeds] = useState(h.beds);
  const scheduleCheck = career.setPolicy(state, { schedule });
  const scheduleProblem = scheduleCheck.ok ? null : scheduleCheck.reason;
  const hasFt = h.upgrades.includes('fastTrackArea');
  const events = career.weekEvents(state);
  const config = career.weekConfig(state);
  const resolved = resolveConfig(config);
  const daily = plannedDailyCost(resolved);
  const upkeep = career.upkeepPerWeek(h);
  const expected = Math.round(hourlyLoad(resolved).reduce((s, l) => s + l.arrivalsPerHour, 0));
  const bedCost = (lane: 'main' | 'fastTrack') => {
    const d = beds[lane] - h.beds[lane];
    return d > 0 ? d * PARAMS.career.bedPrice[lane] : d * PARAMS.career.bedPrice[lane] * PARAMS.career.bedRefundShare;
  };
  const apply = (r: ReturnType<typeof career.setPolicy>) => {
    if (r.ok) {
      onChange(r.state);
      setProblem(null);
    } else setProblem(r.reason);
    return r.ok;
  };
  const changeSchedule = (role: Role, shifts: Shift[]) => {
    const next = { ...schedule, [role]: shifts };
    setSchedule(next);
    const r = career.setPolicy(state, { schedule: next });
    if (r.ok) onChange(r.state);
  };
  const bedsPending = beds.main !== h.beds.main || beds.fastTrack !== h.beds.fastTrack;
  const applyBeds = () => {
    let s = state;
    for (const lane of ['main', 'fastTrack'] as const) {
      if (beds[lane] === s.hospital.beds[lane]) continue;
      const r = career.setBeds(s, lane, beds[lane]);
      if (!r.ok) {
        setProblem(r.reason);
        return;
      }
      s = r.state;
    }
    onChange(s);
    setProblem(null);
  };
  const buy = (id: UpgradeId) => {
    const r = career.buyUpgrade(state, id);
    if (apply(r) && r.ok) setBeds(r.state.hospital.beds);
  };
  const blocked = scheduleProblem !== null || bedsPending;

  return (
    <main className="screen career" data-testid="career-hq">
      <header className="career-head">
        <div>
          <p className="eyebrow">Career · week {state.week}</p>
          <h1>{h.name}</h1>
        </div>
        <dl className="career-stats">
          <div>
            <dt>Balance</dt>
            <dd className={state.money < 0 ? 'neg' : ''} data-testid="career-money">
              {money(state.money)}
            </dd>
          </div>
          <div>
            <dt>Reputation</dt>
            <dd data-testid="career-reputation">{Math.round(state.reputation)}</dd>
            <span className="rep-meter" aria-hidden>
              <span style={{ width: `${state.reputation}%` }} />
            </span>
          </div>
          <div>
            <dt>Weeks run</dt>
            <dd>{state.history.length}</dd>
          </div>
        </dl>
        <div className="actions career-quick">
          <button onClick={props.onSimulate} disabled={blocked}>
            Simulate the week
          </button>
          <button className="primary" onClick={props.onPlay} disabled={blocked}>
            Run the week live
          </button>
        </div>
      </header>

      <div className="career-grid">
        <section className="card">
          <h3>This week’s forecast</h3>
          <ul className="forecast" data-testid="forecast">
            {career.forecast(events).map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p className="muted small">About {expected} patients expected. Reputation and word of mouth bring more.</p>
        </section>
        <section className="card">
          <h3>Running costs this week</h3>
          <table className="metrics ledger">
            <tbody>
              <tr>
                <th scope="row">Staff (as planned)</th>
                <td>{money(daily.staff * 7)}</td>
              </tr>
              <tr>
                <th scope="row">Treatment spaces</th>
                <td>{money(daily.beds * 7)}</td>
              </tr>
              {upkeep > 0 && (
                <tr>
                  <th scope="row">Upkeep of upgrades</th>
                  <td>{money(upkeep)}</td>
                </tr>
              )}
              <tr className="total">
                <th scope="row">Planned total</th>
                <td data-testid="career-planned">{money(daily.total * 7 + upkeep)}</td>
              </tr>
            </tbody>
          </table>
          <p className="muted small">
            Income: {money(PARAMS.career.paymentPerPatient)} per patient treated, plus a quality bonus for a good week. Penalties for people who leave unseen,
            come back, or turn critical while waiting.
          </p>
        </section>
      </div>

      <h2>Your department</h2>
      <div className="career-grid">
        <section className="card">
          <h3>Treatment spaces</h3>
          <div className="bed-row">
            Main ED{' '}
            <Stepper value={beds.main} min={4} max={PARAMS.career.maxBeds.main} onChange={(v) => setBeds({ ...beds, main: v })} label="Main ED spaces" />
            <span className="muted small">{money(PARAMS.career.bedPrice.main)} each</span>
          </div>
          {hasFt && (
            <div className="bed-row">
              Fast track{' '}
              <Stepper value={beds.fastTrack} min={2} max={PARAMS.career.maxBeds.fastTrack} onChange={(v) => setBeds({ ...beds, fastTrack: v })} label="Fast-track spaces" />
              <span className="muted small">{money(PARAMS.career.bedPrice.fastTrack)} each</span>
            </div>
          )}
          {bedsPending && (
            <div className="actions" style={{ marginTop: 8 }}>
              <button onClick={() => setBeds(h.beds)}>Cancel</button>
              <button className="primary" onClick={applyBeds} data-testid="beds-apply">
                {bedCost('main') + bedCost('fastTrack') >= 0 ? `Build for ${money(bedCost('main') + bedCost('fastTrack'))}` : `Remove (refund ${money(-(bedCost('main') + bedCost('fastTrack')))})`}
              </button>
            </div>
          )}
          <p className="muted small">Removing a space refunds {Math.round(PARAMS.career.bedRefundShare * 100)}% of its price. Every space also costs a daily rate.</p>
        </section>
        <section className="card">
          <h3>How the department works</h3>
          <SimpleControl control="queue.discipline" value={h.discipline} onChange={(v) => apply(career.setPolicy(state, { discipline: v as CareerState['hospital']['discipline'] }))} />
          <SimpleControl control="diagnosis.thoroughness" value={h.thoroughness} onChange={(v) => apply(career.setPolicy(state, { thoroughness: Number(v) }))} />
          {hasFt && (
            <>
              <SimpleControl control="fastTrack.enabled" value={h.fastTrackOpen} onChange={(v) => apply(career.setPolicy(state, { fastTrackOpen: v === true }))} />
              <SimpleControl control="fastTrack.minAcuity" value={h.fastTrackMinAcuity} onChange={(v) => apply(career.setPolicy(state, { fastTrackMinAcuity: v as 3 | 4 | 5 }))} />
            </>
          )}
        </section>
      </div>

      <h2>Shifts</h2>
      <p className="muted">The same pattern every day of the week. The department always needs a doctor and a triage nurse on duty.</p>
      {(['doctor', 'triageNurse', ...(hasFt ? (['fastTrackClinician'] as Role[]) : [])] as Role[]).map((role) => (
        <ScheduleEditor key={role} role={role} shifts={schedule[role] ?? []} config={career.weekConfig({ ...state, hospital: { ...h, schedule } })} onChange={(s) => changeSchedule(role, s)} />
      ))}

      <h2>Upgrades</h2>
      <ul className="shop" data-testid="shop">
        {career.UPGRADES.map((u) => {
          const owned = h.upgrades.includes(u.id);
          return (
            <li key={u.id} className={owned ? 'owned' : ''}>
              <strong>{u.name}</strong>
              {owned ? (
                <span className="chip pass">Built</span>
              ) : (
                <button onClick={() => buy(u.id)} disabled={state.money < u.price} data-testid={`buy-${u.id}`}>
                  Buy {money(u.price)}
                </button>
              )}
              <span className="effect">
                {u.effect} <span className="price">Upkeep {money(u.upkeep)} a week.</span>
              </span>
            </li>
          );
        })}
      </ul>

      {(problem || scheduleProblem) && (
        <p className="problems" role="alert">
          {problem ?? scheduleProblem}
        </p>
      )}
      {bedsPending && <p className="muted">Build or cancel the bed change before the week starts.</p>}
      <div className="actions">
        <button onClick={props.onBack}>Menu</button>
        <button className="push" onClick={props.onSimulate} disabled={blocked} data-testid="career-simulate">
          Simulate the week
        </button>
        <button className="primary" onClick={props.onPlay} disabled={blocked} data-testid="career-play">
          Run the week live
        </button>
      </div>

      {state.history.length > 0 && <History state={state} />}
    </main>
  );
}

/** Score and reputation (one 0–100 axis), the balance (its own axis), milestones and past weeks. */
export function History({ state, fresh = [] }: { state: CareerState; fresh?: MilestoneId[] }) {
  const w = state.history;
  return (
    <section className="career-history">
      <h2>History</h2>
      {w.length > 0 && (
        <div className="career-grid">
          <section className="card">
            <WeekChart
              title="Balanced score and reputation"
              min={0}
              max={100}
              format={(v) => String(Math.round(v))}
              series={[
                { label: 'Score', slot: 1, values: w.map((r) => r.score) },
                { label: 'Reputation', slot: 2, values: w.map((r) => r.reputation) },
              ]}
              testId="chart-score"
            />
          </section>
          <section className="card">
            <WeekChart
              title="Balance at the end of each week"
              zeroLine
              format={(v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)))}
              series={[{ label: 'Balance', slot: 1, values: w.map((r) => r.money) }]}
              testId="chart-money"
            />
          </section>
        </div>
      )}
      <div className="career-grid">
        <section className="card">
          <h3>
            Milestones · {state.milestones.length}/{Object.keys(career.MILESTONES).length}
          </h3>
          <ul className="milestones" data-testid="milestones">
            {(Object.entries(career.MILESTONES) as [MilestoneId, string][]).map(([id, text]) => {
              const got = state.milestones.includes(id);
              return (
                <li key={id} className={`${got ? 'got' : ''} ${fresh.includes(id) ? 'new' : ''}`}>
                  <span className="mark" aria-label={got ? 'reached' : 'not yet'}>
                    {got ? '★' : '☆'}
                  </span>
                  {text}
                  {fresh.includes(id) && <span className="chip next">New</span>}
                </li>
              );
            })}
          </ul>
        </section>
        {w.length > 0 && (
          <section className="card">
            <h3>Past weeks</h3>
            <div className="viz-table">
              <table className="metrics">
                <thead>
                  <tr>
                    <th>Week</th>
                    <th>Score</th>
                    <th>Net</th>
                    <th>Left unseen</th>
                    <th>Events</th>
                  </tr>
                </thead>
                <tbody>
                  {[...w].reverse().map((r) => (
                    <tr key={r.week}>
                      <td>{r.week}</td>
                      <td>{Math.round(r.score)}</td>
                      <td className={r.net < 0 ? 'neg' : ''}>{money(r.net)}</td>
                      <td>{(r.lwbsRate * 100).toFixed(1)}%</td>
                      <td>{r.events.map((e) => EVENT_NAME[e.kind]).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </section>
  );
}

export const EVENT_NAME: Record<string, string> = { quiet: 'quiet', flu: 'flu surge', heatwave: 'heatwave', wardsFull: 'wards full', incident: 'major incident' };
