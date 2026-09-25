/**
 * Run metrics. Patient-level stats cover patients who arrived inside the
 * measurement window [warmupMinutes, durationMinutes]; time averages cover the
 * same window up to the current clock.
 */

import type { ResolvedConfig } from './config.js';
import { actualCost, type CostBreakdown } from './budget.js';
import type { IncidentRecord, Simulation } from './engine.js';
import { compositeScore, type ScoreBreakdown } from './score.js';
import { summarize, type Summary } from './stats.js';
import { ACUITIES, ROLES, SERVICE_IDS, UNIT_IDS, type Acuity, type Patient, type Role, type ServiceId, type UnitId } from './types.js';

/** Spec metrics that need modules not built yet. Listed so output never implies they are zero. */
export const NOT_YET_MODELED: readonly string[] = [];

/** ESI groups used by level goals: urgent = 1–2, standard = 3, minor = 4–5 (by true acuity at arrival). */
export type AcuityGroup = 'urgent' | 'standard' | 'minor';
const GROUP_OF: Record<Acuity, AcuityGroup> = { 1: 'urgent', 2: 'urgent', 3: 'standard', 4: 'minor', 5: 'minor' };

export const WAIT_CAUSES = ['triage', 'bed', 'doctor', 'results', 'boarding'] as const;
export type WaitCause = (typeof WAIT_CAUSES)[number];

export interface Metrics {
  configId: string;
  seed: number;
  simMinutes: number;
  window: { start: number; end: number };
  arrivals: number;
  arrivalsBySource: { walkIn: number; massCasualty: number; bounceBack: number };
  /** Arrivals per minute observed in the window. */
  arrivalRatePerMinute: number;
  seenByDoctor: number;
  /** Discharged + admitted. */
  treated: number;
  discharged: number;
  admitted: number;
  admissionRate: number | null;
  lwbsCount: number;
  /** Left without being seen / arrivals. */
  lwbsRate: number;
  lwbsRateByAcuity: Record<`${Acuity}`, number | null>;
  inSystemAtEnd: number;
  /** Arrival to triage start, patients triaged. */
  doorToTriage: Summary;
  /** Arrival to first doctor contact, patients seen by the end of the run. */
  doorToDoctor: Summary;
  doorToDoctorByAcuity: Record<`${Acuity}`, Summary>;
  doorToDoctorByGroup: Record<AcuityGroup, Summary>;
  /** Arrival to bed, patients who got one. */
  doorToBed: Summary;
  /** Arrival to departure, discharged and admitted patients. */
  lengthOfStay: Summary;
  lengthOfStayByAcuity: Record<`${Acuity}`, Summary>;
  lengthOfStayByGroup: Record<AcuityGroup, Summary>;
  /** Discharged patients only (CMS OP-18 style). */
  lengthOfStayDischarged: Summary;
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
  /** Patients whose condition worsened while waiting to be seen; `critical`: worsened to ESI 1. */
  deterioration: { events: number; patients: number; per100Arrivals: number; critical: number };
  /** Live decisions and what they cost in patients (diversion) and care (hallway). */
  live: {
    diverted: number;
    diversionHours: number;
    callIns: number;
    callInHours: number;
    hallwayPatients: number;
    hallwayHours: number;
  };
  /** Diagnostics module: per service, orders, waits for a machine or analyser, turnaround, how busy it was and the worst backlog. */
  diagnostics: Record<
    ServiceId,
    { servers: number; orders: number; meanQueueMinutes: number | null; meanTurnaroundMinutes: number | null; p90TurnaroundMinutes: number | null; utilization: number | null; peakQueue: number; queuedAtEnd: number }
  > | null;
  /** Security module: agitation incidents inside the window (null when the module is off). */
  security: {
    incidents: number;
    violent: number;
    staffInjuries: number;
    /** Per 1,000 visits in the window. */
    incidentsPer1000Visits: number;
    /** Who responded. */
    bySecurity: number;
    byClinician: number;
    unanswered: number;
    /** Average minutes until someone arrived. */
    meanResponseMinutes: number | null;
    /** Clinician time taken by incidents (hours): patient care that did not happen. */
    clinicianHours: number;
    /** Incidents by patients boarding in the ED. */
    boarding: number;
  } | null;
  /**
   * Where waiting went, in patient-hours inside the window: before triage, for a bed, for a
   * doctor (first evaluation), for test results, and admitted patients boarding in ED beds.
   */
  waits: Record<WaitCause, number>;
  diagnosis: {
    /** Misdiagnosed / (discharged + admitted). */
    misdiagnosisRate: number | null;
    /** Discharged patients who return within 72 h (including returns due after the run ends). */
    bounceBacks72h: number;
    /** Of those, how many are due after the run ends (the debrief can reveal them). */
    bounceBacksAfterRun: number;
    bounceBackRate72h: number | null;
  };
  boarding: {
    boarders: number;
    /** Total hours admitted patients spent boarding in ED beds (ongoing boarding counted up to the end). */
    hours: number;
    meanHours: number | null;
    medianHours: number | null;
    maxHours: number | null;
    timeAverageBoarders: number;
    /** Separate inpatient units (boarding.units): admissions, boarders and boarding time by unit. */
    byUnit: Partial<Record<UnitId, { beds: number; admitted: number; boarders: number; hours: number; meanHours: number | null; maxHours: number | null }>> | null;
  };
  bedOccupancy: { main: number | null; fastTrack: number | null };
  /** Times a doctor was pulled from a less urgent patient to an ESI 1 (pre-emption). */
  preemptions: number;
  timeAverageInSystem: number;
  /** Time-average number in the department not yet seen by a doctor. */
  timeAverageWaiting: number;
  utilizationByRole: Record<Role, number | null>;
  /** Layout module: minutes staff spent walking, and walking as a share of their busy time. */
  walking: { minutesByRole: Record<Role, number>; shareOfBusyByRole: Record<Role, number | null> } | null;
  staffHoursByRole: Record<Role, number>;
  /** End-of-shift fatigue (burnout module); null when the module is off. */
  staffFatigue: { mean: number; max: number; byRole: Record<Role, number | null> } | null;
  /** Money spent in the measurement window (see budget.ts). */
  cost: CostBreakdown & { perDay: number; perPatient: number | null };
  /** 0–100 from the config's score terms (higher is better). */
  compositeScore: number;
  scoreBreakdown: ScoreBreakdown['terms'];
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
    if (p.departureTime === undefined) inSystemAtEnd++;
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
  const treatedOutcome = (p: Patient) => p.outcome === 'discharged' || p.outcome === 'admitted';
  const los = (p: Patient) => (treatedOutcome(p) ? p.departureTime! - p.arrivalTime : undefined);
  const all = (f: (p: Patient) => number | undefined) => summarize(inWindow.map(f).filter((v): v is number => v !== undefined));

  let lwbs = 0;
  let discharged = 0;
  let admitted = 0;
  let ftTreated = 0;
  let triaged = 0;
  let correct = 0;
  let under = 0;
  let over = 0;
  let leftSum = 0;
  let leftN = 0;
  let detEvents = 0;
  let detPatients = 0;
  let misdiagnosed = 0;
  let bounce = 0;
  let bounceLater = 0;
  let critical = 0;
  let hallwayPatients = 0;
  const waits: Record<WaitCause, number> = { triage: 0, bed: 0, doctor: 0, results: 0, boarding: 0 };
  // Patient-minutes between two times, clipped to the window.
  const clip = (a: number | undefined, b: number | undefined) => (a === undefined ? 0 : Math.max(0, Math.min(b ?? end, end) - Math.max(a, start)));
  const boardingHours: number[] = [];
  const sources = { walkIn: 0, massCasualty: 0, bounceBack: 0 };
  const lwbsBy: Record<Acuity, [number, number]> = { 1: [0, 0], 2: [0, 0], 3: [0, 0], 4: [0, 0], 5: [0, 0] };
  for (const p of inWindow) {
    sources[p.source]++;
    lwbsBy[p.initialAcuity][1]++;
    if (p.outcome === 'lwbs') {
      lwbs++;
      lwbsBy[p.initialAcuity][0]++;
    }
    if (p.outcome === 'discharged') discharged++;
    if (p.outcome === 'admitted') admitted++;
    if (treatedOutcome(p) && p.lane === 'fastTrack') ftTreated++;
    if (p.departureTime !== undefined) {
      leftSum += p.departureTime - p.arrivalTime;
      leftN++;
    }
    if (p.triageAssigned !== undefined && p.acuityAtTriage !== undefined) {
      triaged++;
      if (p.triageAssigned === p.acuityAtTriage) correct++;
      else if (p.triageAssigned > p.acuityAtTriage) under++;
      else over++;
    }
    detEvents += p.deteriorations;
    if (p.deteriorations > 0) detPatients++;
    if (p.misdiagnosed) misdiagnosed++;
    if (p.returnsAt !== undefined) bounce++;
    if (p.returnsAt !== undefined && p.returnsAt > c.durationMinutes) bounceLater++;
    if (p.becameCritical) critical++;
    if (p.hallway) hallwayPatients++;
    const leftAt = p.departureTime;
    waits.triage += clip(p.arrivalTime, p.triageStartTime ?? (p.assignedAcuity === undefined ? leftAt : p.arrivalTime));
    if (p.bedRequestTime !== undefined) waits.bed += clip(p.bedRequestTime, p.bedTime ?? leftAt);
    if (p.doctorQueueTime !== undefined) waits.doctor += clip(p.doctorQueueTime, p.doctorStartTime ?? leftAt);
    for (const st of Object.values(p.steps)) if (st.kind === 'workup' || st.kind === 'labs' || st.kind === 'imaging') waits.results += clip(st.start, st.end ?? leftAt);
    if (p.boardingStartTime !== undefined) waits.boarding += clip(p.boardingStartTime, leftAt);
    if (p.boardingStartTime !== undefined) boardingHours.push(((p.departureTime ?? end) - p.boardingStartTime) / 60);
  }
  const treated = discharged + admitted;

  const utilizationByRole = {} as Record<Role, number | null>;
  const staffHoursByRole = {} as Record<Role, number>;
  for (const role of ROLES) {
    const duty = sim.tw.onDuty[role].integral(end);
    utilizationByRole[role] = duty > 0 ? sim.tw.busy[role].integral(end) / duty : null;
    staffHoursByRole[role] = duty / 60;
  }

  let walking: Metrics['walking'] = null;
  if (c.layout) {
    const minutesByRole = { ...sim.walkingMinutes };
    const shareOfBusyByRole = {} as Record<Role, number | null>;
    for (const role of ROLES) {
      const busy = sim.tw.busy[role].integral(end);
      shareOfBusyByRole[role] = busy > 0 ? minutesByRole[role] / busy : null;
    }
    walking = { minutesByRole, shareOfBusyByRole };
  }

  let staffFatigue: Metrics['staffFatigue'] = null;
  if (c.modules.burnout) {
    const recs = sim.fatigueRecords().filter((r) => r.end > start && r.end - r.start > 0);
    const byRole = {} as Record<Role, number | null>;
    for (const role of ROLES) {
      const xs = recs.filter((r) => r.role === role).map((r) => r.fatigue);
      byRole[role] = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    }
    const xs = recs.map((r) => r.fatigue);
    staffFatigue = { mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0, max: xs.length ? Math.max(...xs) : 0, byRole };
  }

  const bedOcc = (lane: 'main' | 'fastTrack') => {
    const cap = c.beds[lane];
    return Number.isFinite(cap) && span > 0 ? sim.tw.bedsOccupied[lane].integral(end) / span / cap : null;
  };
  const boardSum = boardingHours.reduce((a, b) => a + b, 0);

  const staffMinutes = Object.fromEntries(ROLES.map((r) => [r, sim.tw.onDuty[r].integral(end)])) as Record<Role, number>;
  const bedMinutes = { main: sim.tw.bedsCosted.main.integral(end), fastTrack: sim.tw.bedsCosted.fastTrack.integral(end) };
  const callInMinutes = Object.fromEntries(ROLES.map((r) => [r, sim.tw.callIn[r].integral(end)])) as Record<Role, number>;
  const spent = actualCost(c, staffMinutes, bedMinutes, sim.tw.escalated.integral(end), span, { callInMinutes, diverted: sim.divertedMeasured });

  const m: Omit<Metrics, 'compositeScore' | 'scoreBreakdown'> = {
    configId: c.id,
    seed: sim.seed,
    simMinutes: end,
    window: { start, end },
    arrivals: inWindow.length,
    arrivalsBySource: sources,
    arrivalRatePerMinute: span > 0 ? inWindow.length / span : 0,
    seenByDoctor: inWindow.filter((p) => p.doctorStartTime !== undefined).length,
    treated,
    discharged,
    admitted,
    admissionRate: treated > 0 ? admitted / treated : null,
    lwbsCount: lwbs,
    lwbsRate: inWindow.length > 0 ? lwbs / inWindow.length : 0,
    lwbsRateByAcuity: Object.fromEntries(ACUITIES.map((a) => [`${a}`, lwbsBy[a][1] > 0 ? lwbsBy[a][0] / lwbsBy[a][1] : null])) as Record<
      `${Acuity}`,
      number | null
    >,
    inSystemAtEnd,
    doorToTriage: all((p) => (p.triageStartTime !== undefined ? p.triageStartTime - p.arrivalTime : undefined)),
    doorToDoctor: all(d2d),
    doorToDoctorByAcuity: by(acuityKeys, (p) => `${p.initialAcuity}`, d2d),
    doorToDoctorByGroup: by(groups, (p) => GROUP_OF[p.initialAcuity], d2d),
    doorToBed: all((p) => (p.bedTime !== undefined ? p.bedTime - p.arrivalTime : undefined)),
    lengthOfStay: all(los),
    lengthOfStayByAcuity: by(acuityKeys, (p) => `${p.initialAcuity}`, los),
    lengthOfStayByGroup: by(groups, (p) => GROUP_OF[p.initialAcuity], los),
    lengthOfStayDischarged: all((p) => (p.outcome === 'discharged' ? p.departureTime! - p.arrivalTime : undefined)),
    meanTimeInSystem: leftN > 0 ? leftSum / leftN : null,
    triage: {
      triaged,
      accuracy: triaged > 0 ? correct / triaged : null,
      underTriageRate: triaged > 0 ? under / triaged : null,
      overTriageRate: triaged > 0 ? over / triaged : null,
    },
    fastTrack: { treated: ftTreated, shareOfTreated: treated > 0 ? ftTreated / treated : null },
    deterioration: { events: detEvents, patients: detPatients, per100Arrivals: inWindow.length > 0 ? (100 * detEvents) / inWindow.length : 0, critical },
    live: {
      diverted: sim.divertedMeasured,
      diversionHours: sim.tw.diversion.integral(end) / 60,
      callIns: sim.callInsCalled,
      callInHours: ROLES.reduce((s, r) => s + callInMinutes[r], 0) / 60,
      hallwayPatients,
      hallwayHours: sim.tw.hallway.integral(end) / 60,
    },
    diagnostics: c.modules.diagnostics ? diagnosticsMetrics(c, inWindow, sim.serviceStats()!, span) : null,
    security: c.modules.security ? securityMetrics(sim.incidentLog.filter((x) => x.time >= start && x.time <= end), inWindow.length) : null,
    waits: Object.fromEntries(WAIT_CAUSES.map((k) => [k, waits[k] / 60])) as Record<WaitCause, number>,
    diagnosis: {
      misdiagnosisRate: c.modules.diagnosis && treated > 0 ? misdiagnosed / treated : null,
      bounceBacks72h: bounce,
      bounceBacksAfterRun: bounceLater,
      bounceBackRate72h: c.modules.diagnosis && discharged > 0 ? bounce / discharged : null,
    },
    boarding: {
      boarders: boardingHours.length,
      hours: boardSum,
      meanHours: boardingHours.length ? boardSum / boardingHours.length : null,
      medianHours: boardingHours.length ? summarize(boardingHours).median : null,
      maxHours: boardingHours.length ? Math.max(...boardingHours) : null,
      timeAverageBoarders: span > 0 ? sim.tw.boarding.integral(end) / span : 0,
      byUnit: c.modules.boarding && c.boarding.units ? unitMetrics(c.boarding.units, inWindow, end) : null,
    },
    bedOccupancy: { main: bedOcc('main'), fastTrack: bedOcc('fastTrack') },
    preemptions: sim.preemptions,
    timeAverageInSystem: span > 0 ? sim.tw.inSystem.integral(end) / span : 0,
    timeAverageWaiting: span > 0 ? sim.tw.waiting.integral(end) / span : 0,
    utilizationByRole,
    walking,
    staffHoursByRole,
    staffFatigue,
    cost: { ...spent, perDay: span > 0 ? (spent.total * 1440) / span : 0, perPatient: inWindow.length > 0 ? spent.total / inWindow.length : null },
    notYetModeled: NOT_YET_MODELED,
  };
  const score = compositeScore(m, c.scoreTerms);
  return { ...m, compositeScore: score.score, scoreBreakdown: score.terms };
}

function securityMetrics(log: readonly IncidentRecord[], visits: number): NonNullable<Metrics['security']> {
  const answered = log.filter((x) => x.responseMinutes !== null);
  return {
    incidents: log.length,
    violent: log.filter((x) => x.violent).length,
    staffInjuries: log.filter((x) => x.injury).length,
    incidentsPer1000Visits: visits > 0 ? (1000 * log.length) / visits : 0,
    bySecurity: log.filter((x) => x.responder === 'security').length,
    byClinician: log.filter((x) => x.responder === 'clinician').length,
    unanswered: log.filter((x) => x.responder === 'none').length,
    meanResponseMinutes: answered.length ? answered.reduce((s, x) => s + x.responseMinutes!, 0) / answered.length : null,
    clinicianHours: log.filter((x) => x.responder === 'clinician').reduce((s, x) => s + x.handleMinutes, 0) / 60,
    boarding: log.filter((x) => x.boarding).length,
  };
}

function unitMetrics(units: NonNullable<ResolvedConfig['boarding']['units']>, patients: readonly Patient[], end: number): NonNullable<Metrics['boarding']['byUnit']> {
  const out: NonNullable<Metrics['boarding']['byUnit']> = {};
  for (const u of UNIT_IDS) {
    const spec = units[u];
    if (!spec) continue;
    const mine = patients.filter((p) => p.admitUnit === u);
    const hours = mine.filter((p) => p.boardingStartTime !== undefined).map((p) => ((p.departureTime ?? end) - p.boardingStartTime!) / 60);
    const sum = hours.reduce((a, b) => a + b, 0);
    out[u] = { beds: spec.beds, admitted: mine.length, boarders: hours.length, hours: sum, meanHours: hours.length ? sum / hours.length : null, maxHours: hours.length ? Math.max(...hours) : null };
  }
  return out;
}

function diagnosticsMetrics(c: ResolvedConfig, patients: readonly Patient[], stats: Record<ServiceId, { busyMinutes: number; peakQueue: number; queued: number }>, span: number): NonNullable<Metrics['diagnostics']> {
  const out = {} as NonNullable<Metrics['diagnostics']>;
  for (const sv of SERVICE_IDS) {
    const orders = patients.flatMap((p) => (p.orders ?? []).filter((o) => o.service === sv));
    const queue = orders.filter((o) => o.startedAt !== undefined).map((o) => o.startedAt! - o.orderedAt);
    const turn = orders.filter((o) => o.resultAt !== undefined).map((o) => o.resultAt! - o.orderedAt);
    const servers = c.diagnostics.services[sv].servers;
    out[sv] = {
      servers,
      orders: orders.length,
      meanQueueMinutes: queue.length ? queue.reduce((a, b) => a + b, 0) / queue.length : null,
      meanTurnaroundMinutes: turn.length ? turn.reduce((a, b) => a + b, 0) / turn.length : null,
      p90TurnaroundMinutes: turn.length ? summarize(turn).p90 : null,
      utilization: servers > 0 && span > 0 ? stats[sv].busyMinutes / (servers * span) : null,
      peakQueue: stats[sv].peakQueue,
      queuedAtEnd: stats[sv].queued,
    };
  }
  return out;
}
