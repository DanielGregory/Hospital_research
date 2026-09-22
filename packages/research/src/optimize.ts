/**
 * Simulated annealing over configs. Every candidate is scored on the same seeds
 * (common random numbers), so differences come from the settings, not the dice.
 * The result is the best setup *found*, not a proven optimum.
 */
import { applySettings, checkSetup, ConfigError, getPath, resolveConfig, Rng, Simulation } from '@er/sim';

export interface Dimension {
  /** Dot path into the config. */
  path: string;
  /** Allowed values, in an order where neighbours are "close" (the search moves one step at a time). */
  values: unknown[];
}

export interface SearchSpace {
  dims: Dimension[];
}

export interface Objective {
  /** Metric dot path to maximise (e.g. "compositeScore"), or to minimise with direction "min". */
  metric: string;
  direction?: 'max' | 'min';
}

export interface OptimizeOptions {
  base: unknown;
  space: SearchSpace;
  objective?: Objective;
  seeds: number[];
  iterations: number;
  /** Seed for the search itself. */
  searchSeed?: number;
  /** Starting temperature, in objective units. */
  temperature?: number;
  onProgress?: (i: number, current: number, best: number) => void;
}

export interface Candidate {
  settings: Record<string, unknown>;
  /** Mean objective over seeds; -Infinity when the setup is invalid or over its limits. */
  value: number;
  problems: string[];
}

export interface OptimizeResult {
  bestFound: Candidate;
  start: Candidate;
  evaluations: number;
  history: { iteration: number; value: number; best: number; accepted: boolean }[];
}

export function evaluate(base: unknown, settings: Record<string, unknown>, seeds: number[], objective: Objective = { metric: 'compositeScore' }): Candidate {
  const config = applySettings(base as object, settings);
  let problems: string[];
  try {
    problems = checkSetup(resolveConfig(config));
  } catch (e) {
    problems = e instanceof ConfigError ? e.problems : [String(e)];
  }
  if (problems.length) return { settings, value: -Infinity, problems };
  const sign = objective.direction === 'min' ? -1 : 1;
  let sum = 0;
  for (const s of seeds) {
    const v = getPath(new Simulation(config, s).run().metrics, objective.metric);
    if (typeof v !== 'number') return { settings, value: -Infinity, problems: [`objective ${objective.metric} is not a number`] };
    sum += sign * v;
  }
  return { settings, value: sum / seeds.length, problems: [] };
}

export function optimize(o: OptimizeOptions): OptimizeResult {
  const rng = new Rng(o.searchSeed ?? 1);
  const dims = o.space.dims;
  if (dims.some((d) => d.values.length === 0)) throw new Error('every dimension needs at least one value');
  const key = (idx: number[]) => idx.join(',');
  const settingsOf = (idx: number[]) => Object.fromEntries(dims.map((d, i) => [d.path, d.values[idx[i]!]]));
  const cache = new Map<string, Candidate>();
  const score = (idx: number[]) => {
    const k = key(idx);
    if (!cache.has(k)) cache.set(k, evaluate(o.base, settingsOf(idx), o.seeds, o.objective));
    return cache.get(k)!;
  };

  // Start from the base config's own values where they are in the space.
  let cur = dims.map((d) => {
    const v = JSON.stringify(getPath(o.base, d.path));
    const i = d.values.findIndex((x) => JSON.stringify(x) === v);
    return i >= 0 ? i : 0;
  });
  let curC = score(cur);
  const start = curC;
  let best = curC;
  const T0 = o.temperature ?? 5;
  const history: OptimizeResult['history'] = [];

  for (let i = 0; i < o.iterations; i++) {
    const next = [...cur];
    const d = rng.int(dims.length);
    const n = dims[d]!.values.length;
    if (n > 1) next[d] = Math.min(n - 1, Math.max(0, next[d]! + (rng.next() < 0.5 ? -1 : 1) * (1 + rng.int(2))));
    const c = score(next);
    const T = Math.max(1e-6, T0 * (1 - i / o.iterations));
    const delta = c.value - curC.value;
    const accepted = Number.isFinite(c.value) && (delta >= 0 || !Number.isFinite(curC.value) || rng.next() < Math.exp(delta / T));
    if (accepted) {
      cur = next;
      curC = c;
      if (c.value > best.value) best = c;
    }
    history.push({ iteration: i, value: curC.value, best: best.value, accepted });
    o.onProgress?.(i, curC.value, best.value);
  }
  const unsign = (c: Candidate): Candidate => (o.objective?.direction === 'min' ? { ...c, value: -c.value } : c);
  return {
    bestFound: unsign(best),
    start: unsign(start),
    evaluations: cache.size,
    history: history.map((h) => (o.objective?.direction === 'min' ? { ...h, value: -h.value, best: -h.best } : h)),
  };
}
