import { Simulation } from './engine.js';

export { Simulation, TIMELINE_STEP, type IncidentRecord, type SimSnapshot, type RunResult, type PatientView, type PatientLocation, type FatigueRecord, type TimelineSample } from './engine.js';
export {
  resolveConfig,
  validateConfig,
  pipelineAsSteps,
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
export { computeMetrics, NOT_YET_MODELED, WAIT_CAUSES, type Metrics, type AcuityGroup, type WaitCause } from './metrics.js';
export {
  evaluateGoals,
  checkLimits,
  staffingSummary,
  getMetric,
  PLAYER_CONTROLS,
  LIVE_CALLS,
  COACH_TRIGGERS,
  type LiveCall,
  type CoachTip,
  type CoachTrigger,
  type Goal,
  type GoalResult,
  type LevelSpec,
  type LevelBenchmark,
  beatsBenchmark,
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
export {
  resolveLayout,
  checkLayoutShape,
  checkLayoutForSim,
  footprintPreset,
  defaultCapacity,
  exampleLayout,
  walkHeat,
  ROOM_TYPES,
  FOOTPRINT_PRESETS,
  type LayoutSpec,
  type RoomSpec,
  type RoomType,
  type ResolvedLayout,
  type ResolvedRoom,
  type Cell,
  type FootprintPreset,
  type WalkTrip,
} from './layout.js';
export { plannedDailyCost, checkBudget, checkSetup, actualCost, type CostBreakdown } from './budget.js';
export { compositeScore, type ScoreBreakdown } from './score.js';
export * as career from './career.js';
export type { CareerState, Hospital, UpgradeId, WeekEvent, WeekRecord, MilestoneId, Settlement, LedgerLine } from './career.js';
export { patientStories, STORY_KINDS, type PatientStory, type StoryKind } from './stories.js';
export { drawProfile } from './engine.js';
export { parseCsv, parseTime, parseVisits, summarizeVisits, fitVisits, visitsCsv, visitsFromPatients, VISIT_COLUMNS, type Visit, type VisitParse, type VisitSummary, type VisitDisposition } from './visits.js';
export { findBottlenecks, testProcessingHours, type Bottleneck, type BottleneckKey } from './bottleneck.js';
