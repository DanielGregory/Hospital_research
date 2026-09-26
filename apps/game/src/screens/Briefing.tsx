import type { LevelConfig } from '../levels';

export function Briefing({ level, daily, onContinue, onBack }: { level: LevelConfig; daily?: string; onContinue: () => void; onBack: () => void }) {
  const n = String(level.level.number).padStart(2, '0');
  return (
    <main className="screen narrow briefing">
      <p className="eyebrow">Simulation {n}</p>
      <h1>{level.level.title}</h1>
      {daily && (
        <p className="daily-note" data-testid="daily-note">
          Daily challenge for {daily}: everyone plays exactly the same day. Compare your stars and score with friends.
        </p>
      )}
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
