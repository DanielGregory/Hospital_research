import { Simulation } from './engine.js';

export { Simulation, type SimSnapshot, type RunResult, type PatientView, type PatientLocation, type FatigueRecord } from './engine.js';
export {
  resolveConfig,
  validateConfig,
  ConfigError,
  MODULES,
  MODULE_PHASE,
  IMPLEMENTED_MODULES,
  type SimConfig,
  type ResolvedConfig,
  type ShockSpec,
  type StepInput,
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
export { applySettings, getPath, type Settings } from './settings.js';
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
export { hourlyLoad, onDutyByHour, meanDoctorMinutes, type HourLoad } from './analytic/load.js';
export { defaultPipeline, checkPipeline, makeStep, STEP_KINDS, DIAGNOSTIC_KINDS, type StepDef, type StepKind, type RoutingRule } from './pipeline.js';
export { balanceReport, type BalanceReport, type BalanceRow } from './balance.js';
