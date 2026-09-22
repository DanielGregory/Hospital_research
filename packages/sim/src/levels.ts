/**
 * Story-level data: goals, limits, player controls, narrative.
 * Pure functions only; the game decides how to present them.
 */

import type { ResolvedConfig } from './config.js';
import type { Metrics } from './metrics.js';
import { onDutyCount, scheduleBoundaries } from './schedule.js';
import { ROLES, type Role } from './types.js';

export interface Goal {
  /** Dot path into Metrics, e.g. "doorToDoctor.median" or "lwbsRate". */
  metric: string;
  max?: number;
  min?: number;
  label: string;
  /** Pass when the metric has no data (e.g. no urgent patients arrived). Default false. */
  passIfNoData?: boolean;
}

/** Settings the player may change in a level. Everything else is locked. */
export const PLAYER_CONTROLS = [
  'queue.discipline',
  'staffing.doctors',
  'staffing.triageNurses',
  'staffing.fastTrackClinicians',
  'staffing.schedule.doctor',
  'staffing.schedule.triageNurse',
  'staffing.schedule.fastTrackClinician',
  'fastTrack.enabled',
  'fastTrack.minAcuity',
] as const;
export type PlayerControl = (typeof PLAYER_CONTROLS)[number];

export interface LevelLimits {
  /** Average staff-hours per day, by role. */
  staffHoursPerDay?: Partial<Record<Role, number>>;
  /** Most staff of a role on duty at once. */
  maxOnDuty?: Partial<Record<Role, number>>;
}

export interface LevelSpec {
  number: number;
  title: string;
  /** The level's fixed day: story mode always plays this seed. */
  seed?: number;
  briefing: string[];
  debrief: { pass: string[]; fail: string[] };
  goals: Goal[];
  playerControls: PlayerControl[];
  limits?: LevelLimits;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string');

export function checkLevel(level: unknown): string[] {
  const p: string[] = [];
  if (!isObj(level)) return ['level: must be an object'];
  if (!(Number.isInteger(level.number) && (level.number as number) >= 1)) p.push('level.number: positive integer');
  if (typeof level.title !== 'string' || !level.title) p.push('level.title: non-empty string');
  if (level.seed !== undefined && !(Number.isInteger(level.seed) && (level.seed as number) >= 0 && (level.seed as number) <= 0xffffffff))
    p.push('level.seed: integer in [0, 2^32)');
  if (!strings(level.briefing)) p.push('level.briefing: array of paragraphs');
  if (!(isObj(level.debrief) && strings(level.debrief.pass) && strings(level.debrief.fail)))
    p.push('level.debrief: { pass: string[], fail: string[] }');
  if (!Array.isArray(level.goals)) p.push('level.goals: array');
  else
    level.goals.forEach((g, i) => {
      if (!isObj(g) || typeof g.metric !== 'string' || typeof g.label !== 'string') p.push(`level.goals[${i}]: { metric, label, max?, min? }`);
      else if (g.max === undefined && g.min === undefined) p.push(`level.goals[${i}]: needs max or min`);
      else if ([g.max, g.min].some((v) => v !== undefined && typeof v !== 'number')) p.push(`level.goals[${i}]: max/min must be numbers`);
    });
  if (!Array.isArray(level.playerControls)) p.push('level.playerControls: array');
  else
    for (const ctl of level.playerControls)
      if (!(PLAYER_CONTROLS as readonly unknown[]).includes(ctl)) p.push(`level.playerControls: unknown control '${String(ctl)}'`);
  if (level.limits !== undefined) {
    if (!isObj(level.limits)) p.push('level.limits: must be an object');
    else
      for (const key of ['staffHoursPerDay', 'maxOnDuty']) {
        const m = level.limits[key];
        if (m === undefined) continue;
        if (!isObj(m) || Object.entries(m).some(([r, v]) => !(ROLES as readonly string[]).includes(r) || typeof v !== 'number'))
          p.push(`level.limits.${key}: object of role -> number`);
      }
  }
  return p;
}

/** Look up a dot path in metrics. Returns undefined for unknown paths. */
export function getMetric(metrics: Metrics, path: string): number | null | undefined {
  let cur: unknown = metrics;
  for (const key of path.split('.')) {
    if (!isObj(cur) || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return typeof cur === 'number' || cur === null ? cur : undefined;
}

export interface GoalResult extends Goal {
  value: number | null;
  passed: boolean;
  /** Set when the metric path does not exist (a config bug). */
  error?: string;
}

export function evaluateGoals(metrics: Metrics, goals: readonly Goal[]): { passed: boolean; results: GoalResult[] } {
  const results = goals.map((g): GoalResult => {
    const v = getMetric(metrics, g.metric);
    if (v === undefined) return { ...g, value: null, passed: false, error: `unknown metric '${g.metric}'` };
    const passed = v === null ? g.passIfNoData === true : (g.max === undefined || v <= g.max) && (g.min === undefined || v >= g.min);
    return { ...g, value: v, passed };
  });
  return { passed: results.every((r) => r.passed), results };
}

/** Staff-hours per day and peak on-duty count implied by the starting config (averaged over a week). */
export function staffingSummary(c: ResolvedConfig): Record<Role, { hoursPerDay: number; maxOnDuty: number }> {
  const out = {} as Record<Role, { hoursPerDay: number; maxOnDuty: number }>;
  for (const role of ROLES) {
    const shifts = c.modules.staffing ? c.schedule[role] : undefined;
    if (!shifts) {
      out[role] = { hoursPerDay: c.staff[role] * 24, maxOnDuty: c.staff[role] };
      continue;
    }
    const hoursPerDay = shifts.reduce((s, sh) => s + (sh.count * sh.hours * (sh.days?.length ?? 7)) / 7, 0);
    // Peak: check just after every boundary across one week.
    let maxOnDuty = onDutyCount(shifts, 0, 0);
    for (const t of scheduleBoundaries(shifts, 0, 7 * 1440)) maxOnDuty = Math.max(maxOnDuty, onDutyCount(shifts, 0, t));
    out[role] = { hoursPerDay, maxOnDuty };
  }
  return out;
}

/** Problems with the starting config against the level's limits (empty = within limits). */
export function checkLimits(c: ResolvedConfig): string[] {
  const limits = c.level?.limits;
  if (!limits) return [];
  const sum = staffingSummary(c);
  const out: string[] = [];
  for (const role of ROLES) {
    const h = limits.staffHoursPerDay?.[role];
    if (h !== undefined && sum[role].hoursPerDay > h + 1e-9)
      out.push(`${role}: ${sum[role].hoursPerDay.toFixed(1)} staff-hours/day exceeds the limit of ${h}`);
    const m = limits.maxOnDuty?.[role];
    if (m !== undefined && sum[role].maxOnDuty > m) out.push(`${role}: ${sum[role].maxOnDuty} on duty at once exceeds the limit of ${m}`);
  }
  return out;
}
