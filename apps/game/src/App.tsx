import { evaluateGoals, type LayoutSpec, type Metrics } from '@er/sim';
import { dailyChallenge, dateKey, shareText, type Daily } from './play/daily';
import { loadBest, recordBest, starsFor, type Best } from './play/stars';
import type { RunAnalysis } from './play/Why';
import { useEffect, useState } from 'react';
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
import { Shell } from './screens/Shell';

/** Where a run came from, so "try again" returns there. */
type Origin =
  | { kind: 'level'; level: LevelConfig; values: SetupValues; daily?: Daily }
  | { kind: 'layout'; layout: LayoutSpec }
  | { kind: 'sandbox' };

type Screen =
  | { name: 'menu' }
  | { name: 'briefing'; level: LevelConfig; daily?: Daily }
  | { name: 'setup'; level: LevelConfig; values: SetupValues; daily?: Daily }
  | { name: 'layout'; layout?: LayoutSpec }
  | { name: 'sandbox' }
  | { name: 'play'; config: GameConfig; seed: number; values: SetupValues; origin: Origin; run: number }
  | { name: 'debrief'; config: GameConfig; metrics: Metrics; origin: Origin; run: RunAnalysis; stars?: number };

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
  return <Screens />;
}

/** A shared daily link (?daily=YYYY-MM-DD) opens that day's challenge. */
function startScreen(): Screen {
  try {
    const d = new URLSearchParams(window.location.search).get('daily');
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const daily = dailyChallenge(LEVELS, d);
      return { name: 'briefing', level: daily.level, daily };
    }
  } catch {
    // no URL (tests)
  }
  return { name: 'menu' };
}

function Screens() {
  const [screen, setScreen] = useState<Screen>(startScreen);
  const [results, setResults] = useState(loadResults);
  const [best, setBest] = useState<Record<string, Best>>(loadBest);
  const [sandbox, setSandbox] = useState<SandboxState>(defaultSandbox);

  const finish = (config: GameConfig, origin: Origin, runner: GameRunner) => {
    const metrics = runner.sim.metrics();
    const c = runner.sim.config;
    const run: RunAnalysis = {
      timeline: [...runner.sim.timeline],
      log: runner.sim.commandLog(),
      clock: { startDayOfWeek: c.startDayOfWeek, startHour: c.startHour },
      incidents: c.shocks.filter((s) => s.type === 'massCasualty').map((s) => ({ start: s.atMinute, end: s.atMinute + s.overMinutes })),
    };
    let stars: number | undefined;
    if (origin.kind === 'level') {
      stars = starsFor(origin.level.level, metrics);
      const key = origin.daily ? `daily:${origin.daily.date}` : origin.level.id;
      setBest(recordBest(best, key, { stars, score: metrics.compositeScore }));
      if (!origin.daily) {
        const passed = evaluateGoals(metrics, origin.level.level.goals).passed;
        const next = { ...results, [origin.level.id]: results[origin.level.id] === true || passed };
        setResults(next);
        saveResults(next);
      }
    }
    setScreen({ name: 'debrief', config, metrics, origin, run, stars });
  };
  const today = dailyChallenge(LEVELS, dateKey(new Date()));

  const back = (origin: Origin): Screen =>
    origin.kind === 'level'
      ? { name: 'setup', level: origin.level, values: origin.values, daily: origin.daily }
      : origin.kind === 'layout'
        ? { name: 'layout', layout: origin.layout }
        : { name: 'sandbox' };

  useEffect(() => window.scrollTo(0, 0), [screen.name]);
  const home = () => setScreen({ name: 'menu' });
  const crumb =
    screen.name === 'menu'
      ? undefined
      : screen.name === 'briefing' || screen.name === 'setup'
        ? screen.level.level.title
        : screen.name === 'layout'
          ? 'Layout editor'
          : screen.name === 'sandbox'
            ? 'Sandbox'
            : (screen.config.level?.title ?? 'Sandbox');
  return (
    <Shell crumb={crumb} onHome={home}>
      {body()}
    </Shell>
  );

  function body() {
    switch (screen.name) {
      case 'menu':
        return (
          <Menu
            results={results}
            best={best}
            daily={today}
            onDaily={() => setScreen({ name: 'briefing', level: today.level, daily: today })}
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
            onPlay={(config) =>
              setScreen({ name: 'play', config, seed: 1, values: valuesFor(config, SANDBOX_LIVE), origin: { kind: 'sandbox' }, run: Date.now() })
            }
          />
        );
      case 'briefing':
        return (
          <Briefing
            level={screen.level}
            daily={screen.daily?.date}
            onBack={() => setScreen({ name: 'menu' })}
            onContinue={() => setScreen({ name: 'setup', level: screen.level, values: initialValues(screen.level), daily: screen.daily })}
          />
        );
      case 'setup':
        return (
          <Setup
            level={screen.level}
            values={screen.values}
            onChange={(values) => setScreen({ ...screen, values })}
            onBack={() => setScreen({ name: 'briefing', level: screen.level, daily: screen.daily })}
            onStart={() =>
              setScreen({
                name: 'play',
                config: buildConfig(screen.level, screen.values),
                seed: screen.daily?.seed ?? screen.level.level.seed ?? 1,
                values: screen.values,
                origin: { kind: 'level', level: screen.level, values: screen.values, daily: screen.daily },
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
              setScreen({
                name: 'play',
                config,
                seed: 1,
                values: valuesFor(config, SANDBOX_LIVE),
                origin: { kind: 'layout', layout: config.layout! },
                run: Date.now(),
              })
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
        const next = idx >= 0 && !(o.kind === 'level' && o.daily) ? LEVELS[idx + 1] : undefined;
        return (
          <Debrief
            level={screen.config.level}
            metrics={screen.metrics}
            run={screen.run}
            stars={screen.stars}
            share={
              o.kind === 'level' && o.daily
                ? shareText(o.daily, screen.stars ?? 0, screen.metrics.compositeScore, `${window.location.origin}${window.location.pathname}`)
                : undefined
            }
            onMenu={() => setScreen({ name: 'menu' })}
            onRetry={() => setScreen(back(o))}
            retryLabel={o.kind === 'layout' ? 'Back to the layout' : o.kind === 'sandbox' ? 'Back to the sandbox' : undefined}
            onNext={next ? () => setScreen({ name: 'briefing', level: next }) : undefined}
          />
        );
      }
    }
  }
}
