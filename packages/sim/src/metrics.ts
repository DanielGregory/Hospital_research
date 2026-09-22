/**
 * Run metrics. Patient-level stats cover patients who arrived inside the
 * measurement window [warmupMinutes, durationMinutes]; time averages cover the
 * same window up to the current clock.
 */

import type { Simulation } from './engine.js';
import { summarize, type Summary } from './stats.js';
import { ACUITIES, type Acuity } from './types.js';

/** Spec metrics that need modules not built yet. Listed so output never implies they are zero. */
export const NOT_YET_MODELED = [
  'lwbsRate',
  'bounceBackRate72h',
  'deteriorationEventsWhileWaiting',
  'staffFatigue',
  'boardingHours',
  'cost',
  'compositeScore',
] as const;

export interface Metrics {
  configId: string;
  seed: number;
  simMinutes: number;
  window: { start: number; end: number };
  arrivals: number;
  /** Arrivals per minute observed in the window. */
  arrivalRatePerMinute: number;
  seenByDoctor: number;
  departed: number;
  inSystemAtEnd: number;
  /** Door-to-doctor time in minutes, patients seen by the end of the run. */
  doorToDoctor: Summary;
  /** Arrival to departure, patients who have left. */
  lengthOfStay: Summary;
  lengthOfStayByAcuity: Record<`${Acuity}`, Summary>;
  timeAverageInSystem: number;
  timeAverageWaiting: number;
  doctorUtilization: number | null;
  notYetModeled: readonly string[];
}

export function computeMetrics(sim: Simulation): Metrics {
  const c = sim.config;
  const start = c.warmupMinutes;
  const end = Math.min(sim.now, c.durationMinutes);
  const span = Math.max(0, end - start);

  const d2d: number[] = [];
  const los: number[] = [];
  const losBy: Record<Acuity, number[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  let arrivals = 0;
  let seen = 0;
  let departed = 0;
  let inSystemAtEnd = 0;

  for (const p of sim.allPatients()) {
    if (p.departureTime === undefined) inSystemAtEnd++;
    if (p.arrivalTime < start || p.arrivalTime > end) continue;
    arrivals++;
    if (p.doctorStartTime !== undefined) {
      seen++;
      d2d.push(p.doctorStartTime - p.arrivalTime);
    }
    if (p.departureTime !== undefined) {
      departed++;
      const stay = p.departureTime - p.arrivalTime;
      los.push(stay);
      losBy[p.trueAcuity].push(stay);
    }
  }

  const busyArea = sim.tw.busyDoctors.integral(end);
  const dutyArea = sim.tw.onDutyDoctors.integral(end);

  return {
    configId: c.id,
    seed: sim.seed,
    simMinutes: end,
    window: { start, end },
    arrivals,
    arrivalRatePerMinute: span > 0 ? arrivals / span : 0,
    seenByDoctor: seen,
    departed,
    inSystemAtEnd,
    doorToDoctor: summarize(d2d),
    lengthOfStay: summarize(los),
    lengthOfStayByAcuity: Object.fromEntries(ACUITIES.map((a) => [`${a}`, summarize(losBy[a])])) as Record<`${Acuity}`, Summary>,
    timeAverageInSystem: span > 0 ? sim.tw.inSystem.integral(end) / span : 0,
    timeAverageWaiting: span > 0 ? sim.tw.inQueue.integral(end) / span : 0,
    doctorUtilization: dutyArea > 0 ? busyArea / dutyArea : null,
    notYetModeled: NOT_YET_MODELED,
  };
}
