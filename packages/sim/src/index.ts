import { Simulation } from './engine.js';

export { Simulation, type SimSnapshot, type RunResult } from './engine.js';
export {
  resolveConfig,
  validateConfig,
  ConfigError,
  MODULES,
  MODULE_PHASE,
  IMPLEMENTED_MODULES,
  type SimConfig,
  type ResolvedConfig,
  type ModuleName,
} from './config.js';
export { computeMetrics, NOT_YET_MODELED, type Metrics, type AcuityGroup } from './metrics.js';
export {
  evaluateGoals,
  checkLimits,
  staffingSummary,
  getMetric,
  PLAYER_CONTROLS,
  type Goal,
  type GoalResult,
  type LevelSpec,
  type LevelLimits,
  type PlayerControl,
} from './levels.js';
export { onDutyCount, scheduleBoundaries } from './schedule.js';
export { PARAMS } from './params.js';
export { Rng } from './rng.js';
export { EventQueue } from './eventQueue.js';
export { PatientQueue } from './patientQueue.js';
export { ArrivalProcess, arrivalRatePerMinute } from './arrivals.js';
export { summarize, percentileSorted, type Summary } from './stats.js';
export { mmc, type MMcResult } from './analytic/queueing.js';
export * from './types.js';

/** Convenience: run a config to completion. */
export function runSimulation(config: unknown, seed: number) {
  return new Simulation(config, seed).run();
}
