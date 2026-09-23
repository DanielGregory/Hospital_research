/**
 * "Beat the best found": search a level's own player controls on the level's own day and keep
 * the best setup found. Setups that meet the level's goals always rank above setups that don't;
 * among them the balanced score decides. It is the best of the setups tried, never a proven optimum.
 */
import { applySettings, evaluateGoals, Simulation, type LevelBenchmark, type LevelSpec, type Metrics, type PlayerControl } from '@er/sim';
import { evaluate, optimize, type Candidate, type SearchSpace } from './optimize.js';

/** Each failed goal costs a full score range, so any setup meeting the goals beats any that doesn't. */
const GOAL_PENALTY = 100;

export interface BenchmarkOptions {
  iterations?: number;
  searchSeed?: number;
  /** Spaces this small are tried in full instead of searched. */
  exhaustiveUpTo?: number;
}

export function levelObjective(level: LevelSpec) {
  return {
    metric: 'compositeScore',
    fn: (m: Metrics) => m.compositeScore - GOAL_PENALTY * evaluateGoals(m, level.goals).results.filter((r) => !r.passed).length,
  };
}

export function benchmarkLevel(config: { level: LevelSpec }, space: SearchSpace, o: BenchmarkOptions = {}): LevelBenchmark & { searched: 'exhaustive' | 'annealing' } {
  const level = config.level;
  if (level.seed === undefined) throw new Error('benchmark: the level needs a fixed seed');
  for (const d of space.dims) if (!level.playerControls.includes(d.path as PlayerControl)) throw new Error(`benchmark: ${d.path} is not a player control of this level`);
  const seeds = [level.seed];
  const objective = levelObjective(level);
  const size = space.dims.reduce((n, d) => n * d.values.length, 1);
  let best: Candidate;
  let evaluated: number;
  let searched: 'exhaustive' | 'annealing';
  if (size <= (o.exhaustiveUpTo ?? 400)) {
    searched = 'exhaustive';
    evaluated = 0;
    best = { settings: {}, value: -Infinity, problems: [] };
    const idx = space.dims.map(() => 0);
    for (let k = 0; k < size; k++) {
      let r = k;
      space.dims.forEach((d, i) => {
        idx[i] = r % d.values.length;
        r = Math.floor(r / d.values.length);
      });
      const c = evaluate(config, Object.fromEntries(space.dims.map((d, i) => [d.path, d.values[idx[i]!]])), seeds, objective);
      evaluated++;
      if (c.value > best.value) best = c;
    }
  } else {
    searched = 'annealing';
    // Two searches: from the shipped setup and from the level's reference solution.
    const starts = [config, level.reference ? applySettings(config, level.reference) : null].filter((x) => x !== null);
    const runs = starts.map((base, i) => optimize({ base, space, objective, seeds, iterations: o.iterations ?? 300, searchSeed: (o.searchSeed ?? 1) + i }));
    best = runs.map((r) => r.bestFound).reduce((a, b) => (b.value > a.value ? b : a));
    evaluated = runs.reduce((n, r) => n + r.evaluations, 0);
  }
  if (!Number.isFinite(best.value)) throw new Error('benchmark: no valid setup in the space');
  const fixed = level.playerControls.filter((c) => !space.dims.some((d) => d.path === c));
  const metrics = levelMetrics(config, best.settings);
  return {
    settings: best.settings as LevelBenchmark['settings'],
    score: round2(metrics.compositeScore),
    goalsMet: evaluateGoals(metrics, level.goals).passed,
    evaluated,
    ...(fixed.length ? { fixed } : {}),
    searched,
  };
}

/** Metrics of a setup on the level seed. */
export function levelMetrics(config: { level: LevelSpec }, settings: Record<string, unknown>): Metrics {
  return new Simulation(applySettings(config, settings), config.level.seed ?? 1).run().metrics;
}

export const round2 = (x: number) => Math.round(x * 100) / 100;

/** Did the player beat the best found? Goals must be met, and the score must be higher. */
export function beatsBenchmark(b: Pick<LevelBenchmark, 'score' | 'goalsMet'>, score: number, goalsMet: boolean): boolean {
  return goalsMet && (!b.goalsMet || score > b.score);
}
