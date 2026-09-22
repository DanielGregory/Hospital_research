import { LEVELS, type LevelConfig } from '../levels';

export function Menu(props: { onPick: (l: LevelConfig) => void; onLayout: () => void; onSandbox: () => void; results: Record<string, boolean> }) {
  const { onPick, onLayout, onSandbox, results } = props;
  const next = LEVELS.find((l) => results[l.id] !== true) ?? LEVELS[0]!;
  return (
    <main className="screen menu">
      <section className="hero">
        <p className="eyebrow">Training programme · emergency medicine</p>
        <h1>Run the emergency department.</h1>
        <p className="lede">
          Staff it, route the patients, design the floor. Then watch the shift play out, one patient at a time, and find out what your choices cost.
        </p>
        <div className="actions">
          <button className="primary" onClick={() => onPick(next)} data-testid="continue-story">
            {Object.keys(results).length ? `Continue: ${next.level.title}` : 'Start training'}
          </button>
          <button onClick={onSandbox}>Open the sandbox</button>
        </div>
      </section>

      <h2>Simulations</h2>
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
                  {passed && <span className="chip pass">✓ Passed</span>}
                  {!passed && results[l.id] === false && <span className="chip">Tried</span>}
                  {l.id === next.id && !passed && <span className="chip next">Up next</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <h2>Sandbox</h2>
      <div className="sandbox-grid">
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
