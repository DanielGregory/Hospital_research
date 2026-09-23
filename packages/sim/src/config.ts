/**
 * Run configuration: the JSON shape of levels and sandbox setups.
 *
 * `validateConfig` checks raw JSON; `resolveConfig` fills every gap from PARAMS
 * so the engine only ever sees a complete `ResolvedConfig`.
 */

import { PARAMS } from './params.js';
import { checkLevel, type LevelSpec } from './levels.js';
import { checkScoreTerms } from './score.js';
import { checkLayoutForSim, checkLayoutShape, resolveLayout, type LayoutSpec, type ResolvedLayout } from './layout.js';
import { checkPipeline, defaultPipeline, makeStep, STEP_KINDS, type RoutingRule, type StepDef } from './pipeline.js';
import {
  ACUITIES,
  ROLES,
  type Acuity,
  type ConditionSpec,
  type Lane,
  type QueueDiscipline,
  type Role,
  type ScoreTerm,
  type Shift,
  type TimedCommand,
} from './types.js';

export const MODULES = ['layout', 'staffing', 'process', 'diagnosis', 'boarding', 'budget', 'shocks', 'burnout'] as const;
export type ModuleName = (typeof MODULES)[number];

/** Build phase each module lands in. Enabling a module before it is built is a config error. */
export const MODULE_PHASE: Record<ModuleName, number> = {
  staffing: 2,
  shocks: 3,
  boarding: 3,
  diagnosis: 3,
  burnout: 3,
  layout: 4,
  process: 5,
  budget: 5,
};
export const IMPLEMENTED_MODULES: readonly ModuleName[] = ['staffing', 'shocks', 'boarding', 'diagnosis', 'burnout', 'layout', 'process', 'budget'];

export type ServiceDistribution = 'exponential' | 'lognormal';

type AcuityMap = Partial<Record<`${Acuity}`, number>>;

export type ShockSpec =
  | { type: 'surge'; startMinute: number; endMinute: number; multiplier: number }
  | {
      type: 'massCasualty';
      atMinute: number;
      patients: number;
      overMinutes: number;
      acuityMix?: AcuityMap;
      /** Casualties arrive with a field-triage tag and skip triage. Default true. */
      preTriaged?: boolean;
    };

/** A step as written in config JSON (acuity maps keyed "1".."5"; most fields optional). */
export interface StepInput {
  id: string;
  kind: StepDef['kind'];
  label?: string;
  role?: Role | null;
  meanMinutes?: number;
  meanMinutesByAcuity?: AcuityMap;
  distribution?: ServiceDistribution;
  cv?: number;
  turnaroundMinutes?: number;
  turnaroundMinutesByAcuity?: AcuityMap;
  turnaroundCv?: number;
  thoroughness?: number;
  after?: string[];
  inBed?: boolean;
  minAcuity?: Acuity;
  maxAcuity?: Acuity;
  lanes?: Lane[];
}

export interface SimConfig {
  id: string;
  name?: string;
  durationMinutes?: number;
  /** Stats ignore everything before this time. */
  warmupMinutes?: number;
  /** Day of week at t = 0 (0 = Monday) and hour of day at t = 0. */
  startDayOfWeek?: number;
  startHour?: number;
  modules?: Partial<Record<ModuleName, boolean>>;
  arrivals?: {
    hourlyRates?: number[];
    dayOfWeekMultipliers?: number[];
    /** Scales every rate (e.g. flu season). */
    rateMultiplier?: number;
    acuityMix?: AcuityMap;
    /** Share of walk-in-stream arrivals who come by ambulance, by true acuity (0–1). */
    ambulanceShareByAcuity?: AcuityMap;
  };
  staffing?: {
    doctors?: number;
    triageNurses?: number;
    fastTrackClinicians?: number;
    nurses?: number;
    techs?: number;
    /** Used only when the `staffing` module is on; roles left out keep their fixed count. */
    schedule?: Partial<Record<Role, Shift[]>>;
  };
  service?: {
    distribution?: ServiceDistribution;
    /** If set, every acuity uses this mean (handy for textbook queue checks). */
    meanMinutes?: number;
    meanMinutesByAcuity?: AcuityMap;
    lognormalCv?: number;
  };
  triage?: {
    /** Off: patients go straight on with no assigned acuity. */
    enabled?: boolean;
    meanMinutes?: number;
    accuracy?: number;
    underTriageShare?: number;
  };
  queue?: {
    discipline?: QueueDiscipline;
    /** Doctors finish dispositions (freeing beds) before starting new evaluations. Default true. */
    dispositionFirst?: boolean;
    /**
     * With acuity ordering, patients triaged at this level or more urgent interrupt a doctor
     * who is seeing someone less urgent (resuscitation cases). 0 = never. Default 1.
     */
    preemptAcuity?: number;
  };
  fastTrack?: {
    enabled?: boolean;
    minAcuity?: Acuity;
    serviceFactor?: number;
    /** Main-ED doctors with nothing in the main ED take the next fast-track task. Default true. */
    doctorsTakeOverflow?: boolean;
  };
  lwbs?: {
    enabled?: boolean;
    /** Use null for "never leaves" (JSON has no Infinity). */
    patienceMeanMinutesByAcuity?: Partial<Record<`${Acuity}`, number | null>>;
  };
  /** Treatment spaces by lane. null = unlimited. */
  /** traumaBays: how many main beds are trauma bays (the sickest patients get them first). */
  beds?: { main?: number | null; fastTrack?: number | null; traumaBays?: number };
  workup?: { enabled?: boolean; meanMinutesByAcuity?: AcuityMap };
  disposition?: {
    doctorMinutes?: number;
    /** Calibration override: chance of admission by true acuity at arrival (replaces the per-condition values). */
    admitProbabilityByAcuity?: AcuityMap;
  };
  deterioration?: { enabled?: boolean; scaleMinutesByAcuity?: AcuityMap };
  diagnosis?: { thoroughness?: number; bounceBackProbability?: number };
  boarding?: {
    inpatientBeds?: number;
    initialOccupied?: number;
    dischargesPerDay?: number;
    /** Hospital full-capacity protocol in force from the start (speeds up inpatient discharges). */
    escalation?: boolean;
  };
  shocks?: ShockSpec[];
  /** Budget module: cap on the planned cost per day of the starting setup. */
  budget?: { capPerDay?: number | null };
  /** Composite score terms (default: PARAMS.score.terms). */
  score?: { terms: ScoreTerm[] };
  /** Floor plan, used when the `layout` module is on (beds then come from its rooms). */
  layout?: LayoutSpec;
  /** Custom step graph, used when the `process` module is on. */
  process?: { steps: StepInput[]; routing?: RoutingRule[] };
  /** Live decisions: how many on-call staff may be called in (default PARAMS.liveCalls.maxCallIns). */
  liveCalls?: { maxCallIns?: number };
  commands?: TimedCommand[];
  /** Story-mode data: narrative, goals, player controls. The engine ignores it when simulating. */
  level?: LevelSpec;
}

export interface ResolvedConfig {
  id: string;
  name: string;
  durationMinutes: number;
  warmupMinutes: number;
  startDayOfWeek: number;
  startHour: number;
  modules: Record<ModuleName, boolean>;
  hourlyRates: number[];
  dayOfWeekMultipliers: number[];
  acuityMix: Record<Acuity, number>;
  staff: Record<Role, number>;
  schedule: Partial<Record<Role, Shift[]>>;
  serviceDistribution: ServiceDistribution;
  serviceMeanByAcuity: Record<Acuity, number>;
  lognormalCv: number;
  triage: { enabled: boolean; meanMinutes: number; cv: number; accuracy: number; underTriageShare: number };
  discipline: QueueDiscipline;
  dispositionFirst: boolean;
  preemptAcuity: number;
  fastTrack: { enabled: boolean; minAcuity: Acuity; serviceFactor: number; doctorsTakeOverflow: boolean };
  lwbs: { enabled: boolean; patienceMeanByAcuity: Record<Acuity, number>; patienceCv: number };
  beds: Record<Lane, number>;
  /** The first this-many main beds are trauma bays (with the layout module: the beds in trauma rooms). */
  traumaBays: number;
  traumaMaxAcuity: number;
  workup: { enabled: boolean; meanMinutesByAcuity: Record<Acuity, number>; cv: number };
  disposition: { doctorMinutes: number; cv: number; admitProbabilityByAcuity: Partial<Record<Acuity, number>> };
  deterioration: { enabled: boolean; scaleMinutesByAcuity: Record<Acuity, number>; shape: number };
  diagnosis: {
    thoroughness: number;
    /** Thoroughness at which service times are as given in params (the time factor is 1). */
    baselineThoroughness: number;
    timeFactorRange: readonly [number, number];
    missFactorRange: readonly [number, number];
    bounceBackProbability: number;
    returnWithinHours: number;
  };
  boarding: {
    inpatientBeds: number;
    initialOccupied: number;
    dischargesPerDay: number;
    escalation: boolean;
    escalationExtraDischargesPerDay: number;
    dischargeHourlyWeights: number[];
  };
  burnout: typeof PARAMS.burnout;
  shocks: ShockSpec[];
  conditions: readonly ConditionSpec[];
  budgetCapPerDay: number | null;
  budgetRates: typeof PARAMS.budget;
  scoreTerms: ScoreTerm[];
  /** Floor plan in use (layout module on), else null. */
  layout: ResolvedLayout | null;
  walking: { minutesPerCell: number; disabledTransferMinutes: number };
  /** The step graph in use (default pipeline unless the process module is on). */
  pipeline: StepDef[];
  /** Routing rules from the process module; empty = fast-track settings decide. */
  routing: RoutingRule[];
  ambulanceShareByAcuity: Record<Acuity, number>;
  liveCalls: { -readonly [K in keyof typeof PARAMS.liveCalls]: number };
  commands: TimedCommand[];
  level?: LevelSpec;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid config:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const nonNeg = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const positive = (x: unknown): x is number => nonNeg(x) && x > 0;
const prob = (x: unknown): x is number => nonNeg(x) && x <= 1;
const count = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;
const bool = (x: unknown) => typeof x === 'boolean';
const isAcuity = (x: unknown): x is Acuity => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 5;
const isRole = (x: unknown): x is Role => (ROLES as readonly unknown[]).includes(x);
const isLane = (x: unknown): x is Lane => x === 'main' || x === 'fastTrack';

/** Collects problems for an optional object section. */
function section(c: Record<string, unknown>, key: string, p: string[], fn: (s: Record<string, unknown>) => void) {
  const s = c[key];
  if (s === undefined) return;
  if (!isObj(s)) p.push(`${key}: must be an object`);
  else fn(s);
}

function field(s: Record<string, unknown>, path: string, key: string, ok: (x: unknown) => boolean, msg: string, p: string[]) {
  if (s[key] !== undefined && !ok(s[key])) p.push(`${path}.${key}: ${msg}`);
}

/** Throws ConfigError listing every problem found. */
export function validateConfig(raw: unknown): SimConfig {
  const p: string[] = [];
  if (!isObj(raw)) throw new ConfigError(['config must be a JSON object']);
  const c = raw;

  if (typeof c.id !== 'string' || c.id.length === 0) p.push('id: required non-empty string');
  field(c, 'config', 'durationMinutes', positive, 'must be a positive number', p);
  field(c, 'config', 'warmupMinutes', nonNeg, 'must be >= 0', p);
  field(c, 'config', 'startDayOfWeek', (x) => Number.isInteger(x) && (x as number) <= 6 && (x as number) >= 0, 'integer 0..6 (0 = Monday)', p);
  field(c, 'config', 'startHour', (x) => nonNeg(x) && x < 24, 'number in [0, 24)', p);

  section(c, 'modules', p, (m) => {
    for (const [name, on] of Object.entries(m)) {
      if (!(MODULES as readonly string[]).includes(name)) p.push(`modules.${name}: unknown module (known: ${MODULES.join(', ')})`);
      else if (typeof on !== 'boolean') p.push(`modules.${name}: must be true or false`);
      else if (on && !IMPLEMENTED_MODULES.includes(name as ModuleName))
        p.push(`modules.${name}: not implemented yet (planned for Phase ${MODULE_PHASE[name as ModuleName]})`);
    }
  });

  section(c, 'arrivals', p, (a) => {
    field(a, 'arrivals', 'hourlyRates', (x) => Array.isArray(x) && x.length === 24 && x.every(nonNeg), 'array of 24 non-negative numbers (patients/hour)', p);
    field(a, 'arrivals', 'dayOfWeekMultipliers', (x) => Array.isArray(x) && x.length === 7 && x.every(nonNeg), 'array of 7 non-negative numbers (Monday first)', p);
    field(a, 'arrivals', 'rateMultiplier', nonNeg, 'non-negative number', p);
    if (a.acuityMix !== undefined) p.push(...checkAcuityMap(a.acuityMix, 'arrivals.acuityMix', nonNeg, 'non-negative'));
    if (a.ambulanceShareByAcuity !== undefined) p.push(...checkAcuityMap(a.ambulanceShareByAcuity, 'arrivals.ambulanceShareByAcuity', prob, 'between 0 and 1'));
  });

  section(c, 'staffing', p, (s) => {
    for (const k of ['doctors', 'triageNurses', 'fastTrackClinicians', 'nurses', 'techs']) field(s, 'staffing', k, count, 'non-negative integer', p);
    section(s, 'schedule', p, (sch) => {
      for (const [role, shifts] of Object.entries(sch)) {
        if (!isRole(role)) p.push(`staffing.schedule.${role}: unknown role (known: ${ROLES.join(', ')})`);
        else p.push(...checkShifts(shifts, `staffing.schedule.${role}`));
      }
    });
  });

  section(c, 'service', p, (s) => {
    field(s, 'service', 'distribution', (x) => x === 'exponential' || x === 'lognormal', "'exponential' or 'lognormal'", p);
    field(s, 'service', 'meanMinutes', positive, 'positive number', p);
    field(s, 'service', 'lognormalCv', positive, 'positive number', p);
    if (s.meanMinutesByAcuity !== undefined) p.push(...checkAcuityMap(s.meanMinutesByAcuity, 'service.meanMinutesByAcuity', positive, 'positive'));
  });

  section(c, 'triage', p, (t) => {
    field(t, 'triage', 'enabled', bool, 'true or false', p);
    field(t, 'triage', 'meanMinutes', positive, 'positive number', p);
    field(t, 'triage', 'accuracy', prob, 'probability in [0, 1]', p);
    field(t, 'triage', 'underTriageShare', prob, 'probability in [0, 1]', p);
  });

  section(c, 'queue', p, (q) => {
    field(q, 'queue', 'discipline', (x) => x === 'fifo' || x === 'acuity', "'fifo' or 'acuity'", p);
    field(q, 'queue', 'dispositionFirst', bool, 'true or false', p);
    field(q, 'queue', 'preemptAcuity', (x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 5, 'integer 0..5 (0 = never)', p);
  });

  section(c, 'fastTrack', p, (f) => {
    field(f, 'fastTrack', 'enabled', bool, 'true or false', p);
    field(f, 'fastTrack', 'minAcuity', isAcuity, 'integer 1..5', p);
    field(f, 'fastTrack', 'serviceFactor', positive, 'positive number', p);
    field(f, 'fastTrack', 'doctorsTakeOverflow', bool, 'true or false', p);
    if (f.enabled === true && isObj(c.triage) && c.triage.enabled === false)
      p.push('fastTrack.enabled: fast track routes on triage acuity, so it needs triage enabled');
  });

  section(c, 'lwbs', p, (l) => {
    field(l, 'lwbs', 'enabled', bool, 'true or false', p);
    if (l.patienceMeanMinutesByAcuity !== undefined)
      p.push(...checkAcuityMap(l.patienceMeanMinutesByAcuity, 'lwbs.patienceMeanMinutesByAcuity', (x) => x === null || positive(x), 'positive number or null (never leaves)'));
  });

  section(c, 'liveCalls', p, (l) => field(l, 'liveCalls', 'maxCallIns', count, 'non-negative integer', p));
  section(c, 'beds', p, (b) => {
    for (const k of ['main', 'fastTrack']) field(b, 'beds', k, (x) => x === null || (count(x) && (x as number) > 0), 'positive integer or null (unlimited)', p);
    field(b, 'beds', 'traumaBays', count, 'non-negative integer', p);
  });
  section(c, 'workup', p, (w) => {
    field(w, 'workup', 'enabled', bool, 'true or false', p);
    if (w.meanMinutesByAcuity !== undefined) p.push(...checkAcuityMap(w.meanMinutesByAcuity, 'workup.meanMinutesByAcuity', nonNeg, 'non-negative'));
  });
  section(c, 'disposition', p, (d) => {
    field(d, 'disposition', 'doctorMinutes', nonNeg, 'non-negative number', p);
    if (d.admitProbabilityByAcuity !== undefined) p.push(...checkAcuityMap(d.admitProbabilityByAcuity, 'disposition.admitProbabilityByAcuity', prob, 'a probability'));
  });
  section(c, 'deterioration', p, (d) => {
    field(d, 'deterioration', 'enabled', bool, 'true or false', p);
    if (d.scaleMinutesByAcuity !== undefined) p.push(...checkAcuityMap(d.scaleMinutesByAcuity, 'deterioration.scaleMinutesByAcuity', positive, 'positive'));
  });
  section(c, 'diagnosis', p, (d) => {
    field(d, 'diagnosis', 'thoroughness', prob, 'number in [0, 1]', p);
    field(d, 'diagnosis', 'bounceBackProbability', prob, 'probability in [0, 1]', p);
  });
  section(c, 'boarding', p, (b) => {
    field(b, 'boarding', 'inpatientBeds', count, 'non-negative integer', p);
    field(b, 'boarding', 'initialOccupied', count, 'non-negative integer', p);
    field(b, 'boarding', 'dischargesPerDay', nonNeg, 'non-negative number', p);
    field(b, 'boarding', 'escalation', bool, 'true or false', p);
    if (count(b.inpatientBeds) && count(b.initialOccupied) && b.initialOccupied > b.inpatientBeds) p.push('boarding.initialOccupied: more than inpatientBeds');
  });

  if (c.shocks !== undefined) {
    if (!Array.isArray(c.shocks)) p.push('shocks: must be an array');
    else c.shocks.forEach((s, i) => p.push(...checkShock(s, `shocks[${i}]`)));
  }

  if (c.process !== undefined) {
    if (!isObj(c.process) || !Array.isArray(c.process.steps)) p.push('process: must be { steps: [...], routing?: [...] }');
    else {
      c.process.steps.forEach((s, i) => p.push(...checkStepInput(s, `process.steps[${i}]`)));
      if (c.process.routing !== undefined) {
        if (!Array.isArray(c.process.routing)) p.push('process.routing: must be an array');
        else
          c.process.routing.forEach((r, i) => {
            if (!isObj(r) || !isAcuity(r.minAcuity) || !isAcuity(r.maxAcuity) || !isLane(r.lane))
              p.push(`process.routing[${i}]: { minAcuity, maxAcuity, lane: 'main' | 'fastTrack' }`);
          });
      }
    }
  }

  if (c.layout !== undefined) p.push(...checkLayoutShape(c.layout));
  section(c, 'budget', p, (b) => field(b, 'budget', 'capPerDay', (x) => x === null || nonNeg(x), 'non-negative number or null', p));
  if (c.score !== undefined) {
    if (!isObj(c.score)) p.push('score: { terms: [...] }');
    else p.push(...checkScoreTerms(c.score.terms, 'score.terms'));
  }

  if (c.commands !== undefined) {
    if (!Array.isArray(c.commands)) p.push('commands: must be an array');
    else c.commands.forEach((tc, i) => p.push(...checkTimedCommand(tc, `commands[${i}]`)));
  }

  if (c.level !== undefined) p.push(...checkLevel(c.level));

  if (p.length > 0) throw new ConfigError(p);
  return raw as unknown as SimConfig;
}

function checkAcuityMap(x: unknown, path: string, ok: (v: unknown) => boolean, what: string): string[] {
  if (!isObj(x)) return [`${path}: must be an object keyed by acuity "1".."5"`];
  const out: string[] = [];
  for (const [k, v] of Object.entries(x)) {
    if (!['1', '2', '3', '4', '5'].includes(k)) out.push(`${path}.${k}: acuity keys are "1".."5"`);
    else if (!ok(v)) out.push(`${path}.${k}: must be ${what}`);
  }
  return out;
}

function checkShock(s: unknown, path: string): string[] {
  if (!isObj(s)) return [`${path}: must be an object`];
  if (s.type === 'surge') {
    const out: string[] = [];
    if (!nonNeg(s.startMinute) || !nonNeg(s.endMinute) || (s.endMinute as number) <= (s.startMinute as number)) out.push(`${path}: surge needs 0 <= startMinute < endMinute`);
    if (!nonNeg(s.multiplier)) out.push(`${path}.multiplier: non-negative number`);
    return out;
  }
  if (s.type === 'massCasualty') {
    const out: string[] = [];
    if (!nonNeg(s.atMinute)) out.push(`${path}.atMinute: >= 0`);
    if (!(count(s.patients) && (s.patients as number) > 0)) out.push(`${path}.patients: positive integer`);
    if (!nonNeg(s.overMinutes)) out.push(`${path}.overMinutes: >= 0`);
    if (s.acuityMix !== undefined) out.push(...checkAcuityMap(s.acuityMix, `${path}.acuityMix`, nonNeg, 'non-negative'));
    field(s, path, 'preTriaged', bool, 'true or false', out);
    return out;
  }
  return [`${path}.type: 'surge' or 'massCasualty'`];
}

function checkStepInput(s: unknown, path: string): string[] {
  if (!isObj(s)) return [`${path}: must be an object`];
  const out: string[] = [];
  if (typeof s.id !== 'string' || !s.id) out.push(`${path}.id: required string`);
  if (!(STEP_KINDS as readonly unknown[]).includes(s.kind)) out.push(`${path}.kind: one of ${STEP_KINDS.join(', ')}`);
  field(s, path, 'role', (x) => x === null || isRole(x), `one of ${ROLES.join(', ')} or null`, out);
  field(s, path, 'meanMinutes', nonNeg, 'non-negative number', out);
  field(s, path, 'turnaroundMinutes', nonNeg, 'non-negative number', out);
  field(s, path, 'cv', nonNeg, 'non-negative number', out);
  field(s, path, 'turnaroundCv', nonNeg, 'non-negative number', out);
  field(s, path, 'thoroughness', prob, 'number in [0, 1]', out);
  field(s, path, 'distribution', (x) => x === 'exponential' || x === 'lognormal', "'exponential' or 'lognormal'", out);
  field(s, path, 'after', (x) => Array.isArray(x) && x.every((a) => typeof a === 'string'), 'array of step ids', out);
  field(s, path, 'inBed', bool, 'true or false', out);
  field(s, path, 'minAcuity', isAcuity, 'integer 1..5', out);
  field(s, path, 'maxAcuity', isAcuity, 'integer 1..5', out);
  field(s, path, 'lanes', (x) => Array.isArray(x) && x.length > 0 && x.every(isLane), "non-empty array of 'main' | 'fastTrack'", out);
  if (s.meanMinutesByAcuity !== undefined) out.push(...checkAcuityMap(s.meanMinutesByAcuity, `${path}.meanMinutesByAcuity`, nonNeg, 'non-negative'));
  if (s.turnaroundMinutesByAcuity !== undefined) out.push(...checkAcuityMap(s.turnaroundMinutesByAcuity, `${path}.turnaroundMinutesByAcuity`, nonNeg, 'non-negative'));
  return out;
}

export function checkShifts(shifts: unknown, path: string): string[] {
  if (!Array.isArray(shifts)) return [`${path}: must be an array of shifts`];
  const out: string[] = [];
  shifts.forEach((s, i) => {
    const sp = `${path}[${i}]`;
    if (!isObj(s)) return out.push(`${sp}: must be { startHour, hours, count, days? }`);
    if (!(nonNeg(s.startHour) && s.startHour < 24)) out.push(`${sp}.startHour: number in [0, 24)`);
    if (!(positive(s.hours) && s.hours <= 7 * 24)) out.push(`${sp}.hours: positive number of hours (at most a week)`);
    if (!count(s.count)) out.push(`${sp}.count: non-negative integer`);
    if (s.days !== undefined && !(Array.isArray(s.days) && s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)))
      out.push(`${sp}.days: array of day indexes 0..6 (0 = Monday)`);
  });
  return out;
}

export function checkTimedCommand(tc: unknown, path: string): string[] {
  if (!isObj(tc)) return [`${path}: must be { atMinute, command }`];
  const out: string[] = [];
  if (!nonNeg(tc.atMinute)) out.push(`${path}.atMinute: must be >= 0`);
  out.push(...checkCommand(tc.command, `${path}.command`));
  return out;
}

export function checkCommand(cmd: unknown, path: string): string[] {
  if (!isObj(cmd)) return [`${path}: must be an object`];
  switch (cmd.type) {
    case 'setStaff':
      return [
        ...(isRole(cmd.role) ? [] : [`${path}.role: one of ${ROLES.join(', ')}`]),
        ...(count(cmd.count) ? [] : [`${path}.count: non-negative integer`]),
      ];
    case 'setSchedule':
      return [...(isRole(cmd.role) ? [] : [`${path}.role: one of ${ROLES.join(', ')}`]), ...checkShifts(cmd.shifts, `${path}.shifts`)];
    case 'setQueueDiscipline':
      return cmd.discipline === 'fifo' || cmd.discipline === 'acuity' ? [] : [`${path}.discipline: 'fifo' or 'acuity'`];
    case 'setFastTrack':
      return [
        ...(bool(cmd.enabled) ? [] : [`${path}.enabled: true or false`]),
        ...(cmd.minAcuity === undefined || isAcuity(cmd.minAcuity) ? [] : [`${path}.minAcuity: integer 1..5`]),
      ];
    case 'setEscalation':
      return bool(cmd.enabled) ? [] : [`${path}.enabled: true or false`];
    case 'setBeds':
      return [
        ...(isLane(cmd.lane) ? [] : [`${path}.lane: 'main' or 'fastTrack'`]),
        ...(cmd.count === null || (count(cmd.count) && (cmd.count as number) > 0) ? [] : [`${path}.count: positive integer or null`]),
      ];
    case 'setProcess': {
      if (!Array.isArray(cmd.steps) || cmd.steps.length === 0) return [`${path}.steps: a non-empty array of steps`];
      const out = cmd.steps.flatMap((s, i) => checkStepInput(s, `${path}.steps[${i}]`));
      if (out.length === 0) out.push(...checkPipeline(cmd.steps.map((s) => resolveStep(s as StepInput)), `${path}.steps`));
      if (cmd.routing !== undefined && (!Array.isArray(cmd.routing) || cmd.routing.some((r) => !isObj(r) || !isAcuity(r.minAcuity) || !isAcuity(r.maxAcuity) || !isLane(r.lane))))
        out.push(`${path}.routing: [{ minAcuity, maxAcuity, lane }]`);
      return out;
    }
    case 'setThoroughness':
      return typeof cmd.value === 'number' && cmd.value >= 0 && cmd.value <= 1 ? [] : [`${path}.value: number 0..1`];
    case 'callIn':
      return isRole(cmd.role) ? [] : [`${path}.role: one of ${ROLES.join(', ')}`];
    case 'setDiversion':
      return bool(cmd.enabled) ? [] : [`${path}.enabled: true or false`];
    case 'setHallwayBeds':
      return count(cmd.count) && (cmd.count as number) <= PARAMS.liveCalls.maxHallwayBeds ? [] : [`${path}.count: integer 0..${PARAMS.liveCalls.maxHallwayBeds}`];
    case 'moveStaff':
      return [
        ...(isRole(cmd.from) ? [] : [`${path}.from: one of ${ROLES.join(', ')}`]),
        ...(isRole(cmd.to) ? [] : [`${path}.to: one of ${ROLES.join(', ')}`]),
        ...(cmd.from !== cmd.to ? [] : [`${path}: from and to must differ`]),
      ];
    default:
      return [`${path}.type: unknown command '${String(cmd.type)}'`];
  }
}

function copy<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function acuityMapOr(base: Record<Acuity, number>, override?: AcuityMap, all?: number): Record<Acuity, number> {
  const out = { ...base };
  for (const a of ACUITIES) {
    const v = all ?? override?.[`${a}`];
    if (v !== undefined) out[a] = v;
  }
  return out;
}

/** A resolved step graph written back out as process steps (resolving them gives the same graph). */
export function pipelineAsSteps(steps: readonly StepDef[]): StepInput[] {
  return steps.map((s) => ({
    id: s.id,
    kind: s.kind,
    label: s.label,
    role: s.role,
    meanMinutesByAcuity: Object.fromEntries(Object.entries(s.meanMinutesByAcuity)) as AcuityMap,
    distribution: s.distribution,
    cv: s.cv,
    turnaroundMinutesByAcuity: Object.fromEntries(Object.entries(s.turnaroundMinutesByAcuity)) as AcuityMap,
    turnaroundCv: s.turnaroundCv,
    thoroughness: s.thoroughness,
    after: [...s.after],
    inBed: s.inBed,
    minAcuity: s.minAcuity,
    maxAcuity: s.maxAcuity,
    lanes: [...s.lanes],
  }));
}

export function resolveStep(s: StepInput): StepDef {
  const zero: Record<Acuity, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  return makeStep({
    id: s.id,
    kind: s.kind,
    label: s.label ?? s.kind,
    role: s.role ?? null,
    meanMinutesByAcuity: acuityMapOr(zero, s.meanMinutesByAcuity, s.meanMinutes),
    distribution: s.distribution ?? 'lognormal',
    cv: s.cv ?? 0.5,
    turnaroundMinutesByAcuity: acuityMapOr(zero, s.turnaroundMinutesByAcuity, s.turnaroundMinutes),
    turnaroundCv: s.turnaroundCv ?? 0.6,
    thoroughness: s.thoroughness ?? PARAMS.diagnosis.thoroughness,
    after: s.after ?? [],
    inBed: s.inBed ?? false,
    minAcuity: s.minAcuity ?? 1,
    maxAcuity: s.maxAcuity ?? 5,
    lanes: s.lanes ?? ['main', 'fastTrack'],
  });
}

export function resolveConfig(raw: unknown): ResolvedConfig {
  const c = validateConfig(raw);
  const problems: string[] = [];

  const modules = Object.fromEntries(MODULES.map((m) => [m, c.modules?.[m] ?? false])) as Record<ModuleName, boolean>;

  const acuityMix = { ...PARAMS.acuity.mix } as Record<Acuity, number>;
  if (c.arrivals?.acuityMix) {
    // A partial mix replaces the default entirely; missing levels become 0.
    for (const a of ACUITIES) acuityMix[a] = c.arrivals.acuityMix[`${a}`] ?? 0;
  }
  if (!(ACUITIES.reduce((s, a) => s + acuityMix[a], 0) > 0)) problems.push('arrivals.acuityMix: at least one acuity must have positive weight');

  const serviceMeanByAcuity = acuityMapOr({ ...PARAMS.service.doctorMeanMinutesByAcuity }, c.service?.meanMinutesByAcuity, c.service?.meanMinutes);
  const patienceMeanByAcuity = { ...PARAMS.lwbs.patienceMeanMinutesByAcuity } as Record<Acuity, number>;
  for (const a of ACUITIES) {
    const patience = c.lwbs?.patienceMeanMinutesByAcuity?.[`${a}`];
    if (patience !== undefined) patienceMeanByAcuity[a] = patience ?? Infinity;
  }

  const durationMinutes = c.durationMinutes ?? PARAMS.run.durationMinutes;
  const warmupMinutes = c.warmupMinutes ?? PARAMS.run.warmupMinutes;
  if (warmupMinutes >= durationMinutes) problems.push('warmupMinutes: must be less than durationMinutes');
  if (!modules.staffing && c.commands?.some((tc) => tc.command.type === 'setSchedule')) problems.push('commands: setSchedule needs the staffing module on');

  const mult = c.arrivals?.rateMultiplier ?? 1;
  const triage = {
    enabled: c.triage?.enabled ?? true,
    meanMinutes: c.triage?.meanMinutes ?? PARAMS.triage.meanMinutes,
    cv: PARAMS.triage.cv,
    accuracy: c.triage?.accuracy ?? PARAMS.triage.accuracy,
    underTriageShare: c.triage?.underTriageShare ?? PARAMS.triage.underTriageShare,
  };
  const workup = {
    enabled: c.workup?.enabled ?? true,
    meanMinutesByAcuity: acuityMapOr({ ...PARAMS.workup.meanMinutesByAcuity }, c.workup?.meanMinutesByAcuity),
    cv: PARAMS.workup.cv,
  };
  const disposition = {
    doctorMinutes: c.disposition?.doctorMinutes ?? PARAMS.disposition.doctorMinutes,
    cv: PARAMS.disposition.cv,
    admitProbabilityByAcuity: Object.fromEntries(
      Object.entries(c.disposition?.admitProbabilityByAcuity ?? {}).map(([k, v]) => [Number(k), v]),
    ) as Partial<Record<Acuity, number>>,
  };
  const diagnosis = {
    thoroughness: c.diagnosis?.thoroughness ?? PARAMS.diagnosis.thoroughness,
    baselineThoroughness: PARAMS.diagnosis.thoroughness,
    timeFactorRange: PARAMS.diagnosis.timeFactorRange,
    missFactorRange: PARAMS.diagnosis.missFactorRange,
    bounceBackProbability: c.diagnosis?.bounceBackProbability ?? PARAMS.diagnosis.bounceBackProbability,
    returnWithinHours: PARAMS.diagnosis.returnWithinHours,
  };
  const serviceDistribution = c.service?.distribution ?? 'exponential';
  const lognormalCv = c.service?.lognormalCv ?? PARAMS.service.lognormalCv;

  let pipeline: StepDef[];
  let routing: RoutingRule[] = [];
  if (modules.process && c.process) {
    pipeline = c.process.steps.map(resolveStep);
    routing = copy(c.process.routing ?? []);
    problems.push(...checkPipeline(pipeline));
  } else {
    if (modules.process) problems.push('modules.process: needs a process section with steps');
    pipeline = defaultPipeline({ triage, serviceMeanByAcuity, serviceDistribution, lognormalCv, thoroughness: diagnosis.thoroughness, workup, disposition });
  }

  const initialOccupied = c.boarding?.initialOccupied ?? PARAMS.boarding.initialOccupied;
  const inpatientBeds = c.boarding?.inpatientBeds ?? PARAMS.boarding.inpatientBeds;
  if (initialOccupied > inpatientBeds) problems.push('boarding.initialOccupied: more than inpatientBeds');

  let layout: ResolvedLayout | null = null;
  if (modules.layout) {
    if (!c.layout) problems.push('modules.layout: needs a layout section');
    else {
      const r = resolveLayout(c.layout);
      problems.push(...r.problems);
      if (r.layout) {
        layout = r.layout;
        problems.push(...checkLayoutForSim(layout, pipeline.some((s) => s.kind === 'triage')));
      }
    }
    if (c.commands?.some((tc) => tc.command.type === 'setBeds')) problems.push('commands: setBeds is not available with the layout module (beds come from rooms)');
    if (c.beds?.traumaBays !== undefined) problems.push('beds.traumaBays: not used with the layout module (draw trauma rooms instead)');
  }

  // Every role a step needs must have someone to do it (or the patient waits forever).
  const staffFor = (role: Role) => {
    const fixed = { doctor: c.staffing?.doctors, triageNurse: c.staffing?.triageNurses, fastTrackClinician: c.staffing?.fastTrackClinicians, nurse: c.staffing?.nurses, tech: c.staffing?.techs }[role];
    const count = fixed ?? { doctor: PARAMS.staffing.doctors, triageNurse: PARAMS.staffing.triageNurses, fastTrackClinician: PARAMS.staffing.fastTrackClinicians, nurse: PARAMS.staffing.nurses, tech: PARAMS.staffing.techs }[role];
    return count > 0 || (modules.staffing && (c.staffing?.schedule?.[role]?.length ?? 0) > 0);
  };
  if (modules.process)
    for (const role of new Set(pipeline.map((s) => s.role).filter((r): r is Role => r !== null && r !== 'fastTrackClinician')))
      if (!staffFor(role)) problems.push(`process: steps need a ${role} but staffing has none`);

  if (problems.length > 0) throw new ConfigError(problems);

  const roomBeds = (type: 'acute' | 'fastTrack' | 'trauma') => layout!.rooms.filter((r) => r.type === type).reduce((s, r) => s + r.capacity, 0);
  const bedCount = (v: number | null | undefined, d: number | null) => (v === undefined ? d : v) ?? Infinity;

  return {
    id: c.id,
    name: c.name ?? c.id,
    durationMinutes,
    warmupMinutes,
    startDayOfWeek: c.startDayOfWeek ?? 0,
    startHour: c.startHour ?? 0,
    modules,
    hourlyRates: (c.arrivals?.hourlyRates ?? PARAMS.arrivals.hourlyRates).map((r) => r * mult),
    dayOfWeekMultipliers: [...(c.arrivals?.dayOfWeekMultipliers ?? PARAMS.arrivals.dayOfWeekMultipliers)],
    acuityMix,
    staff: {
      doctor: c.staffing?.doctors ?? PARAMS.staffing.doctors,
      triageNurse: c.staffing?.triageNurses ?? PARAMS.staffing.triageNurses,
      fastTrackClinician: c.staffing?.fastTrackClinicians ?? PARAMS.staffing.fastTrackClinicians,
      nurse: c.staffing?.nurses ?? PARAMS.staffing.nurses,
      tech: c.staffing?.techs ?? PARAMS.staffing.techs,
    },
    schedule: copy(c.staffing?.schedule ?? {}),
    serviceDistribution,
    serviceMeanByAcuity,
    lognormalCv,
    triage,
    discipline: c.queue?.discipline ?? 'acuity',
    dispositionFirst: c.queue?.dispositionFirst ?? true,
    preemptAcuity: c.queue?.preemptAcuity ?? PARAMS.queue.preemptAcuity,
    fastTrack: {
      enabled: c.fastTrack?.enabled ?? false,
      minAcuity: c.fastTrack?.minAcuity ?? PARAMS.fastTrack.minAcuity,
      serviceFactor: c.fastTrack?.serviceFactor ?? PARAMS.fastTrack.serviceFactor,
      doctorsTakeOverflow: c.fastTrack?.doctorsTakeOverflow ?? true,
    },
    lwbs: { enabled: c.lwbs?.enabled ?? true, patienceMeanByAcuity, patienceCv: PARAMS.lwbs.patienceCv },
    beds: layout
      ? { main: roomBeds('acute') + roomBeds('trauma'), fastTrack: roomBeds('fastTrack') }
      : { main: bedCount(c.beds?.main, PARAMS.beds.main), fastTrack: bedCount(c.beds?.fastTrack, PARAMS.beds.fastTrack) },
    traumaBays: layout ? roomBeds('trauma') : Math.min(c.beds?.traumaBays ?? PARAMS.beds.traumaBays, bedCount(c.beds?.main, PARAMS.beds.main)),
    traumaMaxAcuity: PARAMS.beds.traumaMaxAcuity,
    layout,
    walking: { ...PARAMS.layout },
    budgetCapPerDay: modules.budget ? (c.budget?.capPerDay ?? null) : null,
    budgetRates: PARAMS.budget,
    scoreTerms: copy(c.score?.terms ?? [...PARAMS.score.terms]),
    workup,
    disposition,
    deterioration: {
      enabled: c.deterioration?.enabled ?? true,
      scaleMinutesByAcuity: acuityMapOr({ ...PARAMS.deterioration.scaleMinutesByAcuity }, c.deterioration?.scaleMinutesByAcuity),
      shape: PARAMS.deterioration.shape,
    },
    diagnosis,
    boarding: {
      inpatientBeds,
      initialOccupied,
      dischargesPerDay: c.boarding?.dischargesPerDay ?? PARAMS.boarding.dischargesPerDay,
      escalation: c.boarding?.escalation ?? false,
      escalationExtraDischargesPerDay: PARAMS.boarding.escalationExtraDischargesPerDay,
      dischargeHourlyWeights: [...PARAMS.boarding.dischargeHourlyWeights],
    },
    burnout: PARAMS.burnout,
    shocks: modules.shocks ? copy(c.shocks ?? []) : [],
    conditions: PARAMS.conditions,
    pipeline,
    routing,
    ambulanceShareByAcuity: Object.fromEntries(
      ACUITIES.map((a) => [a, c.arrivals?.ambulanceShareByAcuity?.[`${a}`] ?? PARAMS.arrivals.ambulanceShareByAcuity[a]]),
    ) as Record<Acuity, number>,
    liveCalls: { ...PARAMS.liveCalls, maxCallIns: c.liveCalls?.maxCallIns ?? PARAMS.liveCalls.maxCallIns },
    commands: (c.commands ?? []).map(copy),
    level: c.level,
  };
}
