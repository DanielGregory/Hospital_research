import { LEVELS, type LevelConfig } from '../levels';

export function Menu({ onPick, onLayout, results }: { onPick: (l: LevelConfig) => void; onLayout: () => void; results: Record<string, boolean> }) {
  return (
    <main className="screen menu">
      <h1>ER Shift</h1>
      <p className="lede">Run an emergency department. Staff it, set how patients flow, and watch what happens.</p>
      <ol className="level-list">
        {LEVELS.map((l) => (
          <li key={l.id}>
            <button className="level" onClick={() => onPick(l)} data-testid={`level-${l.level.number}`}>
              <span className="level-num">{l.level.number}</span>
              <span className="level-title">{l.level.title}</span>
              {results[l.id] !== undefined && <span className={results[l.id] ? 'badge pass' : 'badge'}>{results[l.id] ? 'Passed' : 'Tried'}</span>}
            </button>
          </li>
        ))}
      </ol>
      <h2>Sandbox</h2>
      <div className="actions">
        <button onClick={onLayout} data-testid="layout-editor">
          Layout editor
        </button>
      </div>
    </main>
  );
}
