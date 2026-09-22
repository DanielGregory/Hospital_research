/**
 * Level balance check: how often the shipped setup and the level's reference
 * solution meet the goals across many days. Used by tests and `headless balance`.
 */
import { resolveConfig } from './config.js';
import { Simulation } from './engine.js';
import { evaluateGoals, type Goal } from './levels.js';
import { applySettings } from './settings.js';

export interface BalanceRow {
  passRate: number;
  goalPassRates: Record<string, number>;
  /** Pass/fail on the level's own seed. */
  onLevelSeed: boolean;
  /** Pass/fail per seed, in the order given. */
  bySeed: boolean[];
}

export interface BalanceReport {
  levelId: string;
  seeds: number;
  shipped: BalanceRow;
  reference: BalanceRow | null;
  /** Seeds where the shipped setup fails and the reference passes (good candidates for level.seed). */
  discriminatingSeeds: number[];
}

function row(config: unknown, goals: readonly Goal[], seeds: readonly number[], levelSeed: number): BalanceRow {
  const results = seeds.map((s) => evaluateGoals(new Simulation(config, s).run().metrics, goals));
  const goalPassRates: Record<string, number> = {};
  goals.forEach((g, i) => (goalPassRates[g.metric] = results.filter((r) => r.results[i]!.passed).length / results.length));
  return {
    passRate: results.filter((r) => r.passed).length / results.length,
    goalPassRates,
    onLevelSeed: evaluateGoals(new Simulation(config, levelSeed).run().metrics, goals).passed,
    bySeed: results.map((r) => r.passed),
  };
}

export function balanceReport(level: unknown, seeds: readonly number[], settings: Record<string, unknown> = {}): BalanceReport {
  const shipped = applySettings(level as Record<string, unknown>, settings);
  const c = resolveConfig(shipped);
  if (!c.level) throw new Error('not a level config');
  const seed = c.level.seed ?? 1;
  const shippedRow = row(shipped, c.level.goals, seeds, seed);
  const referenceRow = c.level.reference ? row(applySettings(shipped, c.level.reference), c.level.goals, seeds, seed) : null;
  return {
    levelId: c.id,
    seeds: seeds.length,
    shipped: shippedRow,
    reference: referenceRow,
    discriminatingSeeds: referenceRow ? seeds.filter((_, i) => !shippedRow.bySeed[i] && referenceRow.bySeed[i]) : [],
  };
}
