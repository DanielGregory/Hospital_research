import type { LevelConfig } from '../levels';

export function Briefing({ level, onContinue, onBack }: { level: LevelConfig; onContinue: () => void; onBack: () => void }) {
  return (
    <main className="screen briefing">
      <p className="eyebrow">Simulation {level.level.number}</p>
      <h1>{level.level.title}</h1>
      {level.level.briefing.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      <h2>Goals</h2>
      <ul className="goals">
        {level.level.goals.map((g) => (
          <li key={g.metric}>{g.label}</li>
        ))}
      </ul>
      <div className="actions">
        <button onClick={onBack}>Back</button>
        <button className="primary" onClick={onContinue} data-testid="continue">
          Continue
        </button>
      </div>
    </main>
  );
}
