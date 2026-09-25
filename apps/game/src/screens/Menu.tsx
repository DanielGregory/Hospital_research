import type { CareerState } from '@er/sim';
import { money } from '../career/store';
import { LEVELS, type LevelConfig } from '../levels';
import type { Daily } from '../play/daily';
import type { Best } from '../play/stars';
import { Stars } from './Debrief';

export function Menu(props: {
  onPick: (l: LevelConfig) => void;
  onLayout: () => void;
  onSandbox: () => void;
  onDaily: () => void;
  results: Record<string, boolean>;
  best: Record<string, Best>;
  daily: Daily;
  career: CareerState | null;
  onCareer: () => void;
  onPlanner: () => void;
}) {
  const { onPick, onLayout, onSandbox, results, best, daily } = props;
  const todays = best[`daily:${daily.date}`];
  const next = LEVELS.find((l) => results[l.id] !== true) ?? LEVELS[0]!;
  return (
    <main className="screen menu">
      <section className="hero">
        <p className="eyebrow">ER Planner · emergency department simulation</p>
        <h1>Test changes to your emergency department before you make them.</h1>
        <p className="lede">
          Calibrate the model to your department’s own visit data, then compare staffing, space, fast track, ICU and ward capacity, labs and imaging, security and
          surge plans. See where the real bottleneck is, watch it in 3D, and print a report.
        </p>
        <div className="actions">
          <button className="primary" onClick={props.onPlanner} data-testid="planner-card">
            Open the planner
          </button>
          <button onClick={() => onPick(next)} data-testid="continue-story">
            {Object.keys(results).length ? `Continue training: ${next.level.title}` : 'Try a training scenario'}
          </button>
        </div>
      </section>

      <h2>Training scenarios</h2>
      <p className="muted">
        Short, guided shifts that teach how emergency departments behave under pressure: triage, surges, fast track, boarding, major incidents, budgets and floor
        design. Good for new charge nurses, residents and managers.
      </p>
      <ol className="level-grid">
        {LEVELS.map((l) => {
          const passed = results[l.id] === true;
          return (
            <li key={l.id}>
              <button className={`level-card ${passed ? 'passed' : ''}`} onClick={() => onPick(l)} data-testid={`level-${l.level.number}`}>
                <span className="level-num">{String(l.level.number).padStart(2, '0')}</span>
                <span className="level-title">{l.level.title}</span>
                {l.level.tagline && <span className="level-tagline">{l.level.tagline}</span>}
                <span className="level-meta">
                  {best[l.id] && <Stars n={best[l.id]!.stars} />}
                  {best[l.id]?.beat && (
                    <span className="chip beat" title="You beat the best found setup">
                      ★ Beat best found
                    </span>
                  )}
                  {passed && <span className="chip pass">✓ Passed</span>}
                  {!passed && results[l.id] === false && <span className="chip">Tried</span>}
                  {l.id === next.id && !passed && <span className="chip next">Up next</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <button className="daily-card" onClick={props.onDaily} data-testid="daily">
        <span className="eyebrow">Daily challenge · {daily.date}</span>
        <strong>{daily.level.level.title}</strong>
        <span>The same shift for everyone today.</span>
        {todays ? (
          <span className="daily-best">
            <Stars n={todays.stars} /> best {Math.round(todays.score)}/100
          </span>
        ) : (
          <span className="chip next">Not played yet</span>
        )}
      </button>

      <h2>More</h2>
      <div className="sandbox-grid">
        <button className="sandbox-card" onClick={props.onCareer} data-testid="career">
          <strong>{props.career ? props.career.hospital.name : 'Run your own hospital'}</strong>
          <span>
            {props.career
              ? props.career.over
                ? `Career over after ${props.career.history.length} weeks.`
                : `Week ${props.career.week} · balance ${money(props.career.money)} · reputation ${Math.round(props.career.reputation)}`
              : 'Week after week: money, reputation, upgrades, flu seasons and major incidents. Keep improving your department.'}
          </span>
        </button>
        <button className="sandbox-card" onClick={onSandbox} data-testid="sandbox">
          <strong>Build your own ED</strong>
          <span>Switch every system on or off, set staffing and beds, design the patient process, and test it.</span>
        </button>
        <button className="sandbox-card" onClick={onLayout} data-testid="layout-editor">
          <strong>Layout editor</strong>
          <span>Draw the floor plan. Staff walk every metre, so where you put the rooms matters.</span>
        </button>
      </div>
    </main>
  );
}
