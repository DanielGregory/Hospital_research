import type { LevelConfig } from '../levels';

export function Briefing({ level, onContinue, onBack }: { level: LevelConfig; onContinue: () => void; onBack: () => void }) {
  const n = String(level.level.number).padStart(2, '0');
  return (
    <main className="screen narrow briefing">
      <p className="eyebrow">Simulation {n}</p>
      <h1>{level.level.title}</h1>
      <article className="transmission">
        <div className="transmission-head">
          <span>Briefing // sim-{n}</span>
          <span className="live">Incoming</span>
        </div>
        <div className="transmission-body">
          {level.level.briefing.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      </article>
      <h2>Your goals</h2>
      <ul className="goal-list">
        {level.level.goals.map((g) => (
          <li key={g.metric}>
            <span className="target" aria-hidden />
            {g.label}
          </li>
        ))}
      </ul>
      <div className="actions">
        <button onClick={onBack}>Back</button>
        <button className="primary" onClick={onContinue} data-testid="continue">
          Continue to setup
        </button>
      </div>
    </main>
  );
}
