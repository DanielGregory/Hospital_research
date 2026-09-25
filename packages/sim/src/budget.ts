/**
 * Money: the planned daily cost of a setup (for the budget cap, checked before a
 * run) and the actual cost of a run (a metric, computed for every run).
 */
import type { ResolvedConfig } from './config.js';
import { checkLimits, staffingSummary } from './levels.js';
import { ROLES, type Lane, type Role } from './types.js';

export interface CostBreakdown {
  staff: number;
  beds: number;
  escalation: number;
  space: number;
  /** Live decisions: call-in premium pay and patients turned away by diversion. */
  calls: number;
  total: number;
}

function footprintCells(c: ResolvedConfig): number {
  return c.layout ? c.layout.footprint.join('').split('').filter((x) => x === '#').length : 0;
}

/**
 * Planned cost per day from the starting setup: rostered staff-hours (weekly average),
 * treatment spaces, floor space, and escalation if declared from the start.
 * Unlimited beds are costed at the params default count.
 */
export function plannedDailyCost(c: ResolvedConfig): CostBreakdown {
  const b = c.budgetRates;
  const hours = staffingSummary(c);
  const staff = ROLES.reduce((s, r) => s + hours[r].hoursPerDay * b.hourlyWage[r], 0);
  const bedsOf = (lane: Lane) => (Number.isFinite(c.beds[lane]) ? c.beds[lane] : 0);
  const beds = bedsOf('main') * b.bedPerDay.main + bedsOf('fastTrack') * b.bedPerDay.fastTrack;
  const escalation = c.modules.boarding && c.boarding.escalation ? 24 * b.escalationPerHour : 0;
  const space = footprintCells(c) * b.spacePerCellPerDay;
  return { staff, beds, escalation, space, calls: 0, total: staff + beds + escalation + space };
}

/** Problems with a setup against the budget cap (budget module), empty when within it or no cap. */
export function checkBudget(c: ResolvedConfig): string[] {
  if (!c.modules.budget || c.budgetCapPerDay === null) return [];
  const planned = plannedDailyCost(c).total;
  return planned > c.budgetCapPerDay + 1e-6 ? [`budget: planned ${Math.round(planned).toLocaleString('en-US')} per day exceeds the cap of ${c.budgetCapPerDay.toLocaleString('en-US')}`] : [];
}

/** Actual cost over the measurement window, from time-weighted staff and bed counts. */
export function actualCost(
  c: ResolvedConfig,
  staffMinutes: Record<Role, number>,
  bedMinutes: Record<Lane, number>,
  escalatedMinutes: number,
  windowMinutes: number,
  live: { callInMinutes: Record<Role, number>; diverted: number } = { callInMinutes: { triageNurse: 0, doctor: 0, fastTrackClinician: 0, nurse: 0, tech: 0, security: 0 }, diverted: 0 },
): CostBreakdown {
  const b = c.budgetRates;
  const staff = ROLES.reduce((s, r) => s + (staffMinutes[r] / 60) * b.hourlyWage[r], 0);
  const beds = (bedMinutes.main / 1440) * b.bedPerDay.main + (bedMinutes.fastTrack / 1440) * b.bedPerDay.fastTrack;
  const escalation = (escalatedMinutes / 60) * b.escalationPerHour;
  const space = footprintCells(c) * b.spacePerCellPerDay * (windowMinutes / 1440);
  // Called-in staff are already in `staff` at the normal wage; this adds the premium.
  const premium = ROLES.reduce((s, r) => s + (live.callInMinutes[r] / 60) * b.hourlyWage[r] * (c.liveCalls.callInWageMultiplier - 1), 0);
  const calls = premium + live.diverted * c.liveCalls.diversionCostPerPatient;
  return { staff, beds, escalation, space, calls, total: staff + beds + escalation + space + calls };
}

/** Everything that stops a setup from starting: level limits and the budget cap. */
export function checkSetup(c: ResolvedConfig): string[] {
  return [...checkLimits(c), ...checkBudget(c)];
}
