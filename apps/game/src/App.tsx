import { evaluateGoals, type Metrics } from '@er/sim';
import { useState } from 'react';
import { buildConfig, initialValues, type SetupValues } from './controls';
import { LEVELS, type LevelConfig } from './levels';
import type { GameRunner } from './runner';
import { Briefing } from './screens/Briefing';
import { Debrief } from './screens/Debrief';
import { Menu } from './screens/Menu';
import { Play } from './screens/Play';
import { Setup } from './screens/Setup';

type Screen =
  | { name: 'menu' }
  | { name: 'briefing'; level: LevelConfig }
  | { name: 'setup'; level: LevelConfig; values: SetupValues }
  | { name: 'play'; level: LevelConfig; values: SetupValues; run: number }
  | { name: 'debrief'; level: LevelConfig; values: SetupValues; metrics: Metrics };

const RESULTS_KEY = 'er-shift-results';

function loadResults(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(RESULTS_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function saveResults(r: Record<string, boolean>) {
  try {
    localStorage.setItem(RESULTS_KEY, JSON.stringify(r));
  } catch {
    // Storage unavailable (private mode etc.): results just aren't remembered.
  }
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'menu' });
  const [results, setResults] = useState(loadResults);

  const finish = (level: LevelConfig, values: SetupValues, runner: GameRunner) => {
    const metrics = runner.sim.metrics();
    const passed = evaluateGoals(metrics, level.level.goals).passed;
    const next = { ...results, [level.id]: results[level.id] === true || passed };
    setResults(next);
    saveResults(next);
    setScreen({ name: 'debrief', level, values, metrics });
  };

  switch (screen.name) {
    case 'menu':
      return <Menu results={results} onPick={(level) => setScreen({ name: 'briefing', level })} />;
    case 'briefing':
      return (
        <Briefing
          level={screen.level}
          onBack={() => setScreen({ name: 'menu' })}
          onContinue={() => setScreen({ name: 'setup', level: screen.level, values: initialValues(screen.level) })}
        />
      );
    case 'setup':
      return (
        <Setup
          level={screen.level}
          values={screen.values}
          onChange={(values) => setScreen({ ...screen, values })}
          onBack={() => setScreen({ name: 'briefing', level: screen.level })}
          onStart={() => setScreen({ name: 'play', level: screen.level, values: screen.values, run: Date.now() })}
        />
      );
    case 'play':
      return (
        <Play
          key={screen.run}
          config={buildConfig(screen.level, screen.values)}
          seed={screen.level.level.seed ?? 1}
          values={screen.values}
          onFinish={(runner) => finish(screen.level, screen.values, runner)}
          onQuit={() => setScreen({ name: 'menu' })}
        />
      );
    case 'debrief': {
      const idx = LEVELS.findIndex((l) => l.id === screen.level.id);
      const next = LEVELS[idx + 1];
      return (
        <Debrief
          level={screen.level}
          metrics={screen.metrics}
          onMenu={() => setScreen({ name: 'menu' })}
          onRetry={() => setScreen({ name: 'setup', level: screen.level, values: screen.values })}
          onNext={next ? () => setScreen({ name: 'briefing', level: next }) : undefined}
        />
      );
    }
  }
}
