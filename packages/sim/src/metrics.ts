/**
 * Run metrics. Patient-level stats cover patients who arrived inside the
 * measurement window [warmupMinutes, durationMinutes]; time averages cover the
 * same window up to the current clock.
 */

import type { Simulation } from './engine.js';
import { summarize, type Summary } from './stats.js';
import { ACUITIES, ROLES, type Acuity, type Patient, type Role } from './types.js';

/** Spec metrics that need modules not built yet. Listed so output never implies they are zero. */
export const NOT_YET_MODELED = [
  'bounceBackRate72h',
  'deteriorationEventsWhileWaiting',
  'staffFatigue',
  'boardingHours',
  'cost',
  'compositeScore',
] as const;

/** ESI groups used by level goals: urgent = 1–2, standard = 3, minor = 4–5 (by true acuity). */
export type AcuityGroup = 'urgent' | 'standard' | 'minor';
const GROUP_OF: Record<Acuity, AcuityGroup> = { 1: 'urgent', 2: 'urgent', 3: 'standard', 4: 'minor', 5: 'minor' };

export interface Metrics {
  configId: string;
  seed: number;
  simMinutes: number;
  window: { start: number; end: number };
  arrivals: number;
  /** Arrivals per minute observed in the window. */
  arrivalRatePerMinute: number;
  seenByDoctor: number;
  treated: number;
  lwbsCount: number;
  /** Left without being seen / arrivals. */
  lwbsRate: number;
  lwbsRateByAcuity: Record<`${Acuity}`, number | null>;
  inSystemAtEnd: number;
  /** Arrival to triage start, patients triaged. */
  doorToTriage: Summary;
  /** Arrival to doctor start, patients seen by the end of the run. */
  doorToDoctor: Summary;
  doorToDoctorByAcuity: Record<`${Acuity}`, Summary>;
  doorToDoctorByGroup: Record<AcuityGroup, Summary>;
  /** Arrival to discharge, treated patients. */
  lengthOfStay: Summary;
  lengthOfStayByAcuity: Record<`${Acuity}`, Summary>;
  lengthOfStayByGroup: Record<AcuityGroup, Summary>;
  /** Mean arrival-to-departure over everyone who left, including LWBS (for Little's Law). */
  meanTimeInSystem: number | null;
  triage: {
    triaged: number;
    /** Share assigned their true ESI level. */
    accuracy: number | null;
    /** Assigned less urgent than true. */
    underTriageRate: number | null;
    overTriageRate: number | null;
  };
  fastTrack: { treated: number; shareOfTreated: number | null };
  timeAverageInSystem: number;
  timeAverageWaiting: number;
  utilizationByRole: Record<Role, number | null>;
  staffHoursByRole: Record<Role, number>;
  notYetModeled: readonly string[];
}

export function computeMetrics(sim: Simulation): Metrics {
  const c = sim.config;
  const start = c.warmupMinutes;
  const end = Math.min(sim.now, c.durationMinutes);
  const span = Math.max(0, end - start);

  const inWindow: Patient[] = [];
  let inSystemAtEnd = 0;
  for (const p of sim.allPatients()) {
    if (p.state !== 'departed') inSystemAtEnd++;
    if (p.arrivalTime >= start && p.arrivalTime <= end) inWindow.push(p);
  }

  const by = <K extends string>(keys: readonly K[], key: (p: Patient) => K, val: (p: Patient) => number | undefined) => {
    const lists = Object.fromEntries(keys.map((k) => [k, [] as number[]])) as Record<K, number[]>;
    for (const p of inWindow) {
      const v = val(p);
      if (v !== undefined) lists[key(p)].push(v);
    }
    return Object.fromEntries(keys.map((k) => [k, summarize(lists[k])])) as Record<K, Summary>;
  };
  const acuityKeys = ACUITIES.map((a) => `${a}` as `${Acuity}`);
  const groups: AcuityGroup[] = ['urgent', 'standard', 'minor'];
  const d2d = (p: Patient) => (p.doctorStartTime !== undefined ? p.doctorStartTime - p.arrivalTime : undefined);
  const los = (p: Patient) => (p.outcome === 'treated' ? p.departureTime! - p.arrivalTime : undefined);

  const all = (f: (p: Patient) => number | undefined) => summarize(inWindow.map(f).filter((v): v is number => v !== undefined));

  let lwbs = 0;
  let treated = 0;
  let ftTreated = 0;
  let triaged = 0;
  let correct = 0;
  let under = 0;
  let over = 0;
  let leftSum = 0;
  let leftN = 0;
  const lwbsBy: Record<Acuity, [number, number]> = { 1: [0, 0], 2: [0, 0], 3: [0, 0], 4: [0, 0], 5: [0, 0] };
  for (const p of inWindow) {
    lwbsBy[p.trueAcuity][1]++;
    if (p.outcome === 'lwbs') {
      lwbs++;
      lwbsBy[p.trueAcuity][0]++;
    }
    if (p.outcome === 'treated') {
      treated++;
      if (p.lane === 'fastTrack') ftTreated++;
    }
    if (p.departureTime !== undefined) {
      leftSum += p.departureTime - p.arrivalTime;
      leftN++;
    }
    if (p.assignedAcuity !== undefined) {
      triaged++;
      if (p.assignedAcuity === p.trueAcuity) correct++;
      else if (p.assignedAcuity > p.trueAcuity) under++;
      else over++;
    }
  }

  const utilizationByRole = {} as Record<Role, number | null>;
  const staffHoursByRole = {} as Record<Role, number>;
  for (const role of ROLES) {
    const duty = sim.tw.onDuty[role].integral(end);
    utilizationByRole[role] = duty > 0 ? sim.tw.busy[role].integral(end) / duty : null;
    staffHoursByRole[role] = duty / 60;
  }

  return {
    configId: c.id,
    seed: sim.seed,
    simMinutes: end,
    window: { start, end },
    arrivals: inWindow.length,
    arrivalRatePerMinute: span > 0 ? inWindow.length / span : 0,
    seenByDoctor: inWindow.filter((p) => p.doctorStartTime !== undefined).length,
    treated,
    lwbsCount: lwbs,
    lwbsRate: inWindow.length > 0 ? lwbs / inWindow.length : 0,
    lwbsRateByAcuity: Object.fromEntries(ACUITIES.map((a) => [`${a}`, lwbsBy[a][1] > 0 ? lwbsBy[a][0] / lwbsBy[a][1] : null])) as Record<
      `${Acuity}`,
      number | null
    >,
    inSystemAtEnd,
    doorToTriage: all((p) => (p.triageStartTime !== undefined ? p.triageStartTime - p.arrivalTime : undefined)),
    doorToDoctor: all(d2d),
    doorToDoctorByAcuity: by(acuityKeys, (p) => `${p.trueAcuity}`, d2d),
    doorToDoctorByGroup: by(groups, (p) => GROUP_OF[p.trueAcuity], d2d),
    lengthOfStay: all(los),
    lengthOfStayByAcuity: by(acuityKeys, (p) => `${p.trueAcuity}`, los),
    lengthOfStayByGroup: by(groups, (p) => GROUP_OF[p.trueAcuity], los),
    meanTimeInSystem: leftN > 0 ? leftSum / leftN : null,
    triage: {
      triaged,
      accuracy: triaged > 0 ? correct / triaged : null,
      underTriageRate: triaged > 0 ? under / triaged : null,
      overTriageRate: triaged > 0 ? over / triaged : null,
    },
    fastTrack: { treated: ftTreated, shareOfTreated: treated > 0 ? ftTreated / treated : null },
    timeAverageInSystem: span > 0 ? sim.tw.inSystem.integral(end) / span : 0,
    timeAverageWaiting: span > 0 ? sim.tw.waiting.integral(end) / span : 0,
    utilizationByRole,
    staffHoursByRole,
    notYetModeled: NOT_YET_MODELED,
  };
}
