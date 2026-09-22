import { evaluateGoals, type LayoutSpec, type Metrics } from '@er/sim';
import { useState } from 'react';
import { buildConfig, initialValues, valuesFor, type SetupValues } from './controls';
import { LEVELS, type LevelConfig } from './levels';
import type { GameRunner } from './runner';
import type { GameConfig } from './sandbox';
import { Briefing } from './screens/Briefing';
import { Debrief } from './screens/Debrief';
import { LayoutEditor } from './screens/LayoutEditor';
import { Menu } from './screens/Menu';
import { Play, SANDBOX_LIVE } from './screens/Play';
import { defaultSandbox, Sandbox, type SandboxState } from './screens/Sandbox';
import { Setup } from './screens/Setup';

/** Where a run came from, so "try again" returns there. */
type Origin = { kind: 'level'; level: LevelConfig; values: SetupValues } | { kind: 'layout'; layout: LayoutSpec } | { kind: 'sandbox' };

type Screen =
  | { name: 'menu' }
  | { name: 'briefing'; level: LevelConfig }
  | { name: 'setup'; level: LevelConfig; values: SetupValues }
  | { name: 'layout'; layout?: LayoutSpec }
  | { name: 'sandbox' }
  | { name: 'play'; config: GameConfig; seed: number; values: SetupValues; origin: Origin; run: number }
  | { name: 'debrief'; config: GameConfig; metrics: Metrics; origin: Origin };

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
  const [sandbox, setSandbox] = useState<SandboxState>(defaultSandbox);

  const finish = (config: GameConfig, origin: Origin, runner: GameRunner) => {
    const metrics = runner.sim.metrics();
    if (origin.kind === 'level') {
      const passed = evaluateGoals(metrics, origin.level.level.goals).passed;
      const next = { ...results, [origin.level.id]: results[origin.level.id] === true || passed };
      setResults(next);
      saveResults(next);
    }
    setScreen({ name: 'debrief', config, metrics, origin });
  };

  const back = (origin: Origin): Screen =>
    origin.kind === 'level'
      ? { name: 'setup', level: origin.level, values: origin.values }
      : origin.kind === 'layout'
        ? { name: 'layout', layout: origin.layout }
        : { name: 'sandbox' };

  switch (screen.name) {
    case 'menu':
      return (
        <Menu
          results={results}
          onPick={(level) => setScreen({ name: 'briefing', level })}
          onLayout={() => setScreen({ name: 'layout' })}
          onSandbox={() => setScreen({ name: 'sandbox' })}
        />
      );
    case 'sandbox':
      return (
        <Sandbox
          state={sandbox}
          onChange={setSandbox}
          onBack={() => setScreen({ name: 'menu' })}
          onLayout={() => setScreen({ name: 'layout' })}
          onPlay={(config) => setScreen({ name: 'play', config, seed: 1, values: valuesFor(config, SANDBOX_LIVE), origin: { kind: 'sandbox' }, run: Date.now() })}
        />
      );
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
          onStart={() =>
            setScreen({
              name: 'play',
              config: buildConfig(screen.level, screen.values),
              seed: screen.level.level.seed ?? 1,
              values: screen.values,
              origin: { kind: 'level', level: screen.level, values: screen.values },
              run: Date.now(),
            })
          }
        />
      );
    case 'layout':
      return (
        <LayoutEditor
          initial={screen.layout}
          onBack={() => setScreen({ name: 'menu' })}
          onPlay={(config) =>
            setScreen({ name: 'play', config, seed: 1, values: valuesFor(config, SANDBOX_LIVE), origin: { kind: 'layout', layout: config.layout! }, run: Date.now() })
          }
        />
      );
    case 'play':
      return (
        <Play
          key={screen.run}
          config={screen.config}
          seed={screen.seed}
          values={screen.values}
          onFinish={(runner) => finish(screen.config, screen.origin, runner)}
          onQuit={() => setScreen({ name: 'menu' })}
        />
      );
    case 'debrief': {
      const o = screen.origin;
      const idx = o.kind === 'level' ? LEVELS.findIndex((l) => l.id === o.level.id) : -1;
      const next = idx >= 0 ? LEVELS[idx + 1] : undefined;
      return (
        <Debrief
          level={screen.config.level}
          metrics={screen.metrics}
          onMenu={() => setScreen({ name: 'menu' })}
          onRetry={() => setScreen(back(o))}
          retryLabel={o.kind === 'layout' ? 'Back to the layout' : o.kind === 'sandbox' ? 'Back to the sandbox' : undefined}
          onNext={next ? () => setScreen({ name: 'briefing', level: next }) : undefined}
        />
      );
    }
  }
}
