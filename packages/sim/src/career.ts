/**
 * Career mode rules: your own hospital, week after week. Pure and deterministic (no DOM): a
 * career is a seed plus the player's decisions, so any week can be replayed or simulated
 * headless. Each week is its own simulation built from the hospital as it stands, the week's
 * events (drawn from the career seed) and the reputation earned so far. Money and reputation
 * carry over; everything numeric lives in PARAMS.career (PLACEHOLDER).
 */
import { plannedDailyCost } from './budget.js';
import { resolveConfig, type ShockSpec, type SimConfig } from './config.js';
import type { Metrics } from './metrics.js';
import { PARAMS } from './params.js';
import { Rng } from './rng.js';
import { onDutyCount } from './schedule.js';
import { ACUITIES, type Acuity, type QueueDiscipline, type Role, type Shift } from './types.js';

export const WEEK_MINUTES = 7 * 1440;

export const UPGRADE_IDS = ['fastTrackArea', 'traumaRoom', 'pointOfCareLab', 'triageTraining', 'scribes', 'dischargeLounge', 'wardExpansion'] as const;
export type UpgradeId = (typeof UPGRADE_IDS)[number];

export interface Upgrade {
  id: UpgradeId;
  name: string;
  /** What it does, in a sentence. */
  effect: string;
  price: number;
  /** Running cost per week. */
  upkeep: number;
}

/** The shop. Prices are PLACEHOLDER, like everything else numeric. */
export const UPGRADES: readonly Upgrade[] = [
  { id: 'fastTrackArea', name: 'Fast-track area', effect: 'Four recliners for minor cases, and fast-track clinicians to staff them.', price: 60_000, upkeep: 1_000 }, // PLACEHOLDER
  { id: 'traumaRoom', name: 'Second trauma room', effect: 'One more trauma bay kept for the sickest patients.', price: 45_000, upkeep: 500 }, // PLACEHOLDER
  { id: 'pointOfCareLab', name: 'Point-of-care lab', effect: 'Test results come back 25% sooner, so beds free up sooner.', price: 80_000, upkeep: 2_000 }, // PLACEHOLDER
  { id: 'triageTraining', name: 'Triage training', effect: 'Triage nurses assign the right level more often (+6 points).', price: 25_000, upkeep: 300 }, // PLACEHOLDER
  { id: 'scribes', name: 'Scribes and better records', effect: 'Doctors spend 10% less time per patient.', price: 35_000, upkeep: 1_800 }, // PLACEHOLDER
  { id: 'dischargeLounge', name: 'Discharge lounge', effect: 'The wards free three more beds a day for your admissions.', price: 50_000, upkeep: 1_500 }, // PLACEHOLDER
  { id: 'wardExpansion', name: 'Ward expansion', effect: 'Ten more inpatient beds for your admissions.', price: 150_000, upkeep: 6_000 }, // PLACEHOLDER
];

export const upgrade = (id: UpgradeId): Upgrade => UPGRADES.find((u) => u.id === id)!;

export interface Hospital {
  name: string;
  beds: { main: number; fastTrack: number };
  schedule: Partial<Record<Role, Shift[]>>;
  discipline: QueueDiscipline;
  thoroughness: number;
  fastTrackOpen: boolean;
  fastTrackMinAcuity: Acuity;
  upgrades: UpgradeId[];
}

export type WeekEvent =
  | { kind: 'quiet' }
  | { kind: 'flu'; startDay: number; days: number; multiplier: number }
  | { kind: 'heatwave'; startDay: number; days: number; multiplier: number }
  | { kind: 'wardsFull'; factor: number }
  | { kind: 'incident'; atMinute: number; patients: number; overMinutes: number };

export interface LedgerLine {
  label: string;
  amount: number;
}

export interface WeekRecord {
  week: number;
  events: WeekEvent[];
  score: number;
  arrivals: number;
  treated: number;
  lwbsRate: number;
  doorToDoctorMedian: number | null;
  critical: number;
  bounceBacks: number;
  income: LedgerLine[];
  costs: LedgerLine[];
  net: number;
  /** Balance and reputation after the week. */
  money: number;
  reputation: number;
}

export const MILESTONES = {
  firstWeek: 'Survived your first week',
  noLwbsWeek: 'A week where nobody left unseen',
  score85: 'A week with a balanced score of 85 or more',
  incidentNoCritical: 'A major incident with nobody turning critical while waiting',
  fourGoodWeeks: 'Four weeks in a row scoring 70 or more',
  reputation80: 'Reputation of 80',
  millionaire: 'A balance of 1,000,000',
  fullyEquipped: 'Every upgrade bought',
} as const;
export type MilestoneId = keyof typeof MILESTONES;

export interface CareerState {
  version: 1;
  seed: number;
  /** The next week to play (1-based). */
  week: number;
  money: number;
  reputation: number;
  hospital: Hospital;
  history: WeekRecord[];
  milestones: MilestoneId[];
  /** The board has replaced you (balance fell below PARAMS.career.bankruptAt). */
  over: boolean;
}

export function newCareer(name: string, seed: number): CareerState {
  const c = PARAMS.career;
  return {
    version: 1,
    seed: seed >>> 0,
    week: 1,
    money: c.startMoney,
    reputation: c.startReputation,
    hospital: {
      name,
      beds: { main: 18, fastTrack: 0 },
      schedule: {
        doctor: [
          { startHour: 8, hours: 12, count: 3 },
          { startHour: 12, hours: 12, count: 1 },
          { startHour: 20, hours: 12, count: 2 },
        ],
        triageNurse: [
          { startHour: 0, hours: 24, count: 1 },
          { startHour: 10, hours: 12, count: 1 },
        ],
      },
      discipline: 'acuity',
      thoroughness: 0.5,
      fastTrackOpen: false,
      fastTrackMinAcuity: 4,
      upgrades: [],
    },
    history: [],
    milestones: [],
    over: false,
  };
}

/** Seed for a week's simulation: stable for the career, different every week. */
export function weekSeed(state: CareerState, week = state.week): number {
  let h = (state.seed ^ Math.imul(week, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** What happens this week, drawn from the career seed (the same every time the week is played). */
export function weekEvents(state: CareerState, week = state.week): WeekEvent[] {
  const rng = new Rng(state.seed).stream(`week:${week}`);
  const p = PARAMS.career.eventChance;
  const events: WeekEvent[] = [];
  const fluSeason = (week - 1) % 26 >= 8 && (week - 1) % 26 <= 13;
  const u = () => rng.next();
  const day = (lo: number, hi: number) => lo + Math.floor(u() * (hi - lo + 1));
  if (u() < (fluSeason ? p.fluSeason : p.flu)) events.push({ kind: 'flu', startDay: day(0, 3), days: day(3, 4), multiplier: 1.3 + 0.1 * u() });
  if (u() < p.heatwave) events.push({ kind: 'heatwave', startDay: day(0, 4), days: 3, multiplier: 1.2 });
  if (u() < p.wardsFull) events.push({ kind: 'wardsFull', factor: 0.6 });
  if (u() < p.incident) events.push({ kind: 'incident', atMinute: Math.round(1440 + u() * 5 * 1440), patients: day(12, 30), overMinutes: day(30, 60) });
  if (events.length === 0 && u() < p.quiet) events.push({ kind: 'quiet' });
  return events;
}

/** What the player is told before the week starts. Incidents are never announced in advance. */
export function forecast(events: readonly WeekEvent[]): string[] {
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const out: string[] = [];
  for (const e of events) {
    if (e.kind === 'flu') out.push(`Public health warns of a flu surge from ${DAYS[e.startDay]} for about ${e.days} days.`);
    if (e.kind === 'heatwave') out.push(`A heatwave is forecast from ${DAYS[e.startDay]}: expect more patients.`);
    if (e.kind === 'wardsFull') out.push('The wards are nearly full this week: admitted patients will wait longer for a bed.');
    if (e.kind === 'quiet') out.push('A quiet week is expected.');
  }
  if (out.length === 0) out.push('Nothing unusual is expected.');
  out.push('Major incidents come without warning.');
  return out;
}

/** Arrival multiplier from reputation and population growth. */
export function demandMultiplier(state: CareerState, week = state.week): number {
  const [lo, hi] = PARAMS.career.reputationArrivals;
  return (lo + ((hi - lo) * state.reputation) / 100) * (1 + PARAMS.career.growthPerWeek * (week - 1));
}

/** The simulation config for the coming week. */
export function weekConfig(state: CareerState, week = state.week): SimConfig {
  const h = state.hospital;
  const has = (id: UpgradeId) => h.upgrades.includes(id);
  const events = weekEvents(state, week);
  const shocks: ShockSpec[] = [];
  let rate = demandMultiplier(state, week);
  let discharges = PARAMS.boarding.dischargesPerDay + (has('dischargeLounge') ? 3 : 0);
  for (const e of events) {
    if (e.kind === 'quiet') rate *= 0.93;
    if (e.kind === 'flu' || e.kind === 'heatwave') shocks.push({ type: 'surge', startMinute: e.startDay * 1440, endMinute: (e.startDay + e.days) * 1440, multiplier: e.multiplier });
    if (e.kind === 'wardsFull') discharges *= e.factor;
    if (e.kind === 'incident') shocks.push({ type: 'massCasualty', atMinute: e.atMinute, patients: e.patients, overMinutes: e.overMinutes });
  }
  const scale = (m: Record<Acuity, number>, f: number) => Object.fromEntries(ACUITIES.map((a) => [`${a}`, m[a] * f]));
  const ft = has('fastTrackArea');
  return {
    id: `career-week-${week}`,
    name: `${h.name}, week ${week}`,
    durationMinutes: WEEK_MINUTES,
    startDayOfWeek: 0,
    startHour: 0,
    modules: { staffing: true, boarding: true, diagnosis: true, shocks: shocks.length > 0, burnout: true },
    arrivals: { rateMultiplier: rate },
    staffing: { doctors: 0, triageNurses: 0, fastTrackClinicians: 0, schedule: { ...h.schedule, ...(ft ? {} : { fastTrackClinician: [] }) } },
    beds: { main: h.beds.main, fastTrack: ft ? h.beds.fastTrack : null, traumaBays: has('traumaRoom') ? 2 : 1 },
    queue: { discipline: h.discipline },
    fastTrack: { enabled: ft && h.fastTrackOpen, minAcuity: h.fastTrackMinAcuity },
    triage: { accuracy: Math.min(0.97, PARAMS.triage.accuracy + (has('triageTraining') ? 0.06 : 0)) },
    diagnosis: { thoroughness: h.thoroughness },
    ...(has('scribes') ? { service: { meanMinutesByAcuity: scale(PARAMS.service.doctorMeanMinutesByAcuity, 0.9) } } : {}),
    ...(has('pointOfCareLab') ? { workup: { meanMinutesByAcuity: scale(PARAMS.workup.meanMinutesByAcuity, 0.75) } } : {}),
    boarding: {
      inpatientBeds: PARAMS.boarding.inpatientBeds + (has('wardExpansion') ? 10 : 0),
      initialOccupied: PARAMS.boarding.initialOccupied,
      dischargesPerDay: discharges,
    },
    shocks,
    liveCalls: { maxCallIns: PARAMS.career.callInsPerWeek },
  };
}

export function upkeepPerWeek(h: Hospital): number {
  return h.upgrades.reduce((s, id) => s + upgrade(id).upkeep, 0);
}

/** Planned running cost of the coming week: staff, beds, upkeep (before any live calls). */
export function plannedWeekCost(state: CareerState): number {
  return plannedDailyCost(resolveConfig(weekConfig(state))).total * 7 + upkeepPerWeek(state.hospital);
}

// ---- Changes between weeks (each returns a new state, or a reason it can't be done).

export type Change<T = CareerState> = { ok: true; state: T } | { ok: false; reason: string };

export function buyUpgrade(state: CareerState, id: UpgradeId): Change {
  const u = upgrade(id);
  if (state.hospital.upgrades.includes(id)) return { ok: false, reason: `${u.name}: already built` };
  if (state.money < u.price) return { ok: false, reason: `${u.name}: costs ${u.price.toLocaleString('en-US')}, you have ${Math.floor(state.money).toLocaleString('en-US')}` };
  const beds = id === 'fastTrackArea' ? { ...state.hospital.beds, fastTrack: Math.max(4, state.hospital.beds.fastTrack) } : state.hospital.beds;
  return {
    ok: true,
    state: {
      ...state,
      money: state.money - u.price,
      hospital: { ...state.hospital, beds, upgrades: [...state.hospital.upgrades, id], fastTrackOpen: id === 'fastTrackArea' ? true : state.hospital.fastTrackOpen },
    },
  };
}

/** Add or remove treatment spaces: buying costs money, removing refunds part of it. */
export function setBeds(state: CareerState, lane: 'main' | 'fastTrack', count: number): Change {
  const c = PARAMS.career;
  if (lane === 'fastTrack' && !state.hospital.upgrades.includes('fastTrackArea')) return { ok: false, reason: 'Build the fast-track area first' };
  const min = lane === 'main' ? 4 : 2;
  if (count < min || count > c.maxBeds[lane]) return { ok: false, reason: `Between ${min} and ${c.maxBeds[lane]} spaces` };
  const diff = count - state.hospital.beds[lane];
  const cost = diff > 0 ? diff * c.bedPrice[lane] : diff * c.bedPrice[lane] * c.bedRefundShare;
  if (cost > state.money) return { ok: false, reason: `Costs ${cost.toLocaleString('en-US')}, you have ${Math.floor(state.money).toLocaleString('en-US')}` };
  return { ok: true, state: { ...state, money: state.money - cost, hospital: { ...state.hospital, beds: { ...state.hospital.beds, [lane]: count } } } };
}

/** Shift patterns, queue order, thoroughness, fast-track routing: free to change between weeks. */
export function setPolicy(state: CareerState, patch: Partial<Pick<Hospital, 'schedule' | 'discipline' | 'thoroughness' | 'fastTrackOpen' | 'fastTrackMinAcuity'>>): Change {
  const hospital = { ...state.hospital, ...patch };
  const next = { ...state, hospital };
  const gap = coverageGap(hospital);
  if (gap) return { ok: false, reason: gap };
  try {
    resolveConfig(weekConfig(next));
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, state: next };
}

/** A department is never left without a doctor or a triage nurse; returns the first gap found. */
export function coverageGap(h: Hospital): string | null {
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const need: [Role, string][] = [
    ['doctor', 'doctor'],
    ['triageNurse', 'triage nurse'],
  ];
  for (const [role, name] of need)
    for (let hour = 0; hour < 7 * 24; hour++)
      if (onDutyCount(h.schedule[role] ?? [], 0, hour * 60 + 30) === 0) return `No ${name} on duty ${DAYS[Math.floor(hour / 24)]} at ${String(hour % 24).padStart(2, '0')}:00`;
  return null;
}

// ---- After a week.

export interface Settlement {
  state: CareerState;
  record: WeekRecord;
  /** Milestones reached this week. */
  newMilestones: MilestoneId[];
}

/** Money, reputation, history and milestones after a week, from its metrics. */
export function settleWeek(state: CareerState, m: Metrics): Settlement {
  const c = PARAMS.career;
  const events = weekEvents(state);
  const bonus = c.bonusAtScore.find(([at]) => m.compositeScore >= at)?.[1] ?? 0;
  const income: LedgerLine[] = [{ label: `Payments for ${m.treated} patients treated`, amount: m.treated * c.paymentPerPatient }];
  if (bonus) income.push({ label: `Quality bonus (score ${Math.round(m.compositeScore)})`, amount: bonus });
  const costs: LedgerLine[] = [
    { label: 'Staff', amount: m.cost.staff },
    { label: 'Treatment spaces', amount: m.cost.beds },
  ];
  if (m.cost.escalation) costs.push({ label: 'Full-capacity protocol', amount: m.cost.escalation });
  if (m.cost.calls) costs.push({ label: 'Call-ins and diverted ambulances', amount: m.cost.calls });
  const upkeep = upkeepPerWeek(state.hospital);
  if (upkeep) costs.push({ label: 'Upkeep of upgrades', amount: upkeep });
  if (m.lwbsCount) costs.push({ label: `${m.lwbsCount} left without being seen`, amount: m.lwbsCount * c.penaltyPerLwbs });
  if (m.diagnosis.bounceBacks72h) costs.push({ label: `${m.diagnosis.bounceBacks72h} missed diagnoses coming back`, amount: m.diagnosis.bounceBacks72h * c.penaltyPerBounceBack });
  if (m.deterioration.critical) costs.push({ label: `${m.deterioration.critical} became critical while waiting (reviews)`, amount: m.deterioration.critical * c.penaltyPerCritical });
  const net = income.reduce((s, l) => s + l.amount, 0) - costs.reduce((s, l) => s + l.amount, 0);
  const money = state.money + net;
  const reputation = Math.max(0, Math.min(100, state.reputation + (m.compositeScore - state.reputation) * c.reputationWeight));
  const record: WeekRecord = {
    week: state.week,
    events,
    score: m.compositeScore,
    arrivals: m.arrivals,
    treated: m.treated,
    lwbsRate: m.lwbsRate,
    doorToDoctorMedian: m.doorToDoctor.median,
    critical: m.deterioration.critical,
    bounceBacks: m.diagnosis.bounceBacks72h,
    income,
    costs,
    net,
    money,
    reputation,
  };
  const history = [...state.history, record];
  const next: CareerState = { ...state, week: state.week + 1, money, reputation, history, over: money < c.bankruptAt };
  const reached = checkMilestones(next, record);
  const newMilestones = reached.filter((id) => !state.milestones.includes(id));
  next.milestones = [...state.milestones, ...newMilestones];
  return { state: next, record, newMilestones };
}

function checkMilestones(s: CareerState, r: WeekRecord): MilestoneId[] {
  const out: MilestoneId[] = ['firstWeek'];
  if (r.lwbsRate === 0 && r.arrivals > 0) out.push('noLwbsWeek');
  if (r.score >= 85) out.push('score85');
  if (r.events.some((e) => e.kind === 'incident') && r.critical === 0) out.push('incidentNoCritical');
  if (s.history.length >= 4 && s.history.slice(-4).every((w) => w.score >= 70)) out.push('fourGoodWeeks');
  if (s.reputation >= 80) out.push('reputation80');
  if (s.money >= 1_000_000) out.push('millionaire');
  if (UPGRADE_IDS.every((id) => s.hospital.upgrades.includes(id))) out.push('fullyEquipped');
  return out;
}
