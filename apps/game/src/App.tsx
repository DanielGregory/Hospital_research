import { beatsBenchmark, evaluateGoals, patientStories, Simulation, type CareerState, type LayoutSpec, type Metrics, type Settlement } from '@er/sim';
import { Career } from './career/Career';
import { Planner } from './planner/Planner';
import { CareerWeek } from './career/CareerWeek';
import { career, careerLive, loadCareer, saveCareer } from './career/store';
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
  | { kind: 'sandbox' }
  | { kind: 'career'; state: CareerState }
  | { kind: 'planner' };

type Screen =
  | { name: 'menu' }
  | { name: 'briefing'; level: LevelConfig; daily?: Daily }
  | { name: 'setup'; level: LevelConfig; values: SetupValues; daily?: Daily }
  | { name: 'layout'; layout?: LayoutSpec }
  | { name: 'sandbox' }
  | { name: 'play'; config: GameConfig; seed: number; values: SetupValues; origin: Origin; run: number }
  | { name: 'debrief'; config: GameConfig; metrics: Metrics; origin: Origin; run: RunAnalysis; stars?: number }
  | { name: 'career' }
  | { name: 'planner' }
  | { name: 'careerWeek'; before: { money: number; reputation: number }; settlement: Settlement; metrics: Metrics; run: RunAnalysis };

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

/** What the debrief needs to explain a run, read from the finished (or stopped) simulation. */
function analysisOf(sim: Simulation, seed: number): RunAnalysis {
  const c = sim.config;
  return {
    stories: patientStories(sim.allPatients(), sim.now, c.warmupMinutes),
    seed,
    ...(c.layout ? { walks: { layout: c.layout, walks: { staff: sim.walkTrips('staff'), patient: sim.walkTrips('patient') } } } : {}),
    timeline: [...sim.timeline],
    log: sim.commandLog(),
    clock: { startDayOfWeek: c.startDayOfWeek, startHour: c.startHour },
    incidents: c.shocks.filter((s) => s.type === 'massCasualty').map((s) => ({ start: s.atMinute, end: s.atMinute + s.overMinutes })),
  };
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
  const [careerState, setCareerState] = useState<CareerState | null>(loadCareer);
  const setCareer = (s: CareerState | null) => {
    saveCareer(s);
    setCareerState(s);
  };

  /** Close a career week: settle the accounts and save before showing the result. */
  const endWeek = (state: CareerState, sim: Simulation) => {
    const seed = career.weekSeed(state);
    const metrics = sim.metrics();
    const settlement = career.settleWeek(state, metrics);
    setCareer(settlement.state);
    setScreen({ name: 'careerWeek', before: { money: state.money, reputation: state.reputation }, settlement, metrics, run: analysisOf(sim, seed) });
  };

  const finish = (config: GameConfig, origin: Origin, runner: GameRunner, seed: number) => {
    if (origin.kind === 'career') return endWeek(origin.state, runner.sim);
    const metrics = runner.sim.metrics();
    const run = analysisOf(runner.sim, seed);
    let stars: number | undefined;
    if (origin.kind === 'level') {
      stars = starsFor(origin.level.level, metrics);
      const key = origin.daily ? `daily:${origin.daily.date}` : origin.level.id;
      const passed = evaluateGoals(metrics, origin.level.level.goals).passed;
      const bm = origin.level.level.benchmark;
      const beat = !origin.daily && bm !== undefined && beatsBenchmark(bm, metrics.compositeScore, passed);
      setBest(recordBest(best, key, { stars, score: metrics.compositeScore, ...(beat ? { beat } : {}) }));
      if (!origin.daily) {
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
        : origin.kind === 'planner'
          ? { name: 'planner' }
          : origin.kind === 'career'
            ? { name: 'career' }
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
            : screen.name === 'career' || screen.name === 'careerWeek'
              ? 'Career'
              : screen.name === 'planner'
                ? 'Planner'
              : screen.origin.kind === 'career'
                ? 'Career'
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
            career={careerState}
            onCareer={() => setScreen({ name: 'career' })}
            onPlanner={() => setScreen({ name: 'planner' })}
          />
        );
      case 'planner':
        return (
          <Planner
            onBack={home}
            onWatch={(config, name) =>
              setScreen({
                name: 'play',
                config: { ...config, name },
                seed: 1,
                values: valuesFor(config, SANDBOX_LIVE),
                origin: { kind: 'planner' },
                run: Date.now(),
              })
            }
          />
        );
      case 'career':
        return (
          <Career
            state={careerState}
            onChange={setCareer}
            onBack={home}
            onPlay={() => {
              const s = careerState!;
              const config = career.weekConfig(s);
              setScreen({ name: 'play', config, seed: career.weekSeed(s), values: valuesFor(config, careerLive(s).controls), origin: { kind: 'career', state: s }, run: Date.now() });
            }}
            onSimulate={() => {
              const s = careerState!;
              const sim = new Simulation(career.weekConfig(s), career.weekSeed(s));
              sim.run();
              endWeek(s, sim);
            }}
          />
        );
      case 'careerWeek':
        return <CareerWeek before={screen.before} settlement={screen.settlement} metrics={screen.metrics} run={screen.run} onContinue={() => setScreen({ name: 'career' })} />;
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
            showBenchmark={!screen.daily}
            beaten={best[screen.level.id]?.beat === true}
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
            onFinish={(runner) => finish(screen.config, screen.origin, runner, screen.seed)}
            onQuit={() => setScreen(screen.origin.kind === 'career' ? { name: 'career' } : screen.origin.kind === 'planner' ? { name: 'planner' } : { name: 'menu' })}
            live={screen.origin.kind === 'career' ? careerLive(screen.origin.state) : undefined}
            unit={screen.origin.kind === 'career' ? 'week' : 'shift'}
            title={screen.origin.kind === 'career' ? `${screen.origin.state.hospital.name} · week ${screen.origin.state.week}` : screen.origin.kind === 'planner' ? `Planner · ${screen.config.name}` : undefined}
            canStop={screen.config.id === 'sandbox-endless'}
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
            showBenchmark={o.kind === 'level' && !o.daily}
            share={
              o.kind === 'level' && o.daily
                ? shareText(o.daily, screen.stars ?? 0, screen.metrics.compositeScore, `${window.location.origin}${window.location.pathname}`)
                : undefined
            }
            onMenu={() => setScreen({ name: 'menu' })}
            onRetry={() => setScreen(back(o))}
            retryLabel={o.kind === 'layout' ? 'Back to the layout' : o.kind === 'sandbox' ? 'Back to the sandbox' : o.kind === 'planner' ? 'Back to the planner' : undefined}
            onNext={next ? () => setScreen({ name: 'briefing', level: next }) : undefined}
          />
        );
      }
    }
  }
}
