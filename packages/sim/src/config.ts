/**
 * Run configuration: the JSON shape of levels and sandbox setups.
 *
 * `validateConfig` checks raw JSON; `resolveConfig` fills every gap from PARAMS
 * so the engine only ever sees a complete `ResolvedConfig`.
 */

import { PARAMS } from './params.js';
import { checkLevel, type LevelSpec } from './levels.js';
import { ACUITIES, ROLES, type Acuity, type QueueDiscipline, type Role, type Shift, type TimedCommand } from './types.js';

export const MODULES = [
  'layout',
  'staffing',
  'process',
  'diagnosis',
  'boarding',
  'budget',
  'shocks',
  'burnout',
] as const;
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
export const IMPLEMENTED_MODULES: readonly ModuleName[] = ['staffing'];

export type ServiceDistribution = 'exponential' | 'lognormal';

type AcuityMap = Partial<Record<`${Acuity}`, number>>;

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
  };
  staffing?: {
    doctors?: number;
    triageNurses?: number;
    fastTrackClinicians?: number;
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
    /** Off: patients go straight to the doctor queue with no assigned acuity. */
    enabled?: boolean;
    meanMinutes?: number;
    accuracy?: number;
    underTriageShare?: number;
  };
  queue?: {
    discipline?: QueueDiscipline;
  };
  fastTrack?: {
    enabled?: boolean;
    minAcuity?: Acuity;
    serviceFactor?: number;
    /** Main-ED doctors with an empty main queue take the next fast-track patient. Default true. */
    doctorsTakeOverflow?: boolean;
  };
  lwbs?: {
    enabled?: boolean;
    /** Use null for "never leaves" (JSON has no Infinity). */
    patienceMeanMinutesByAcuity?: Partial<Record<`${Acuity}`, number | null>>;
  };
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
  fastTrack: { enabled: boolean; minAcuity: Acuity; serviceFactor: number; doctorsTakeOverflow: boolean };
  lwbs: { enabled: boolean; patienceMeanByAcuity: Record<Acuity, number>; patienceCv: number };
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
const isAcuity = (x: unknown): x is Acuity => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 5;
const isRole = (x: unknown): x is Role => (ROLES as readonly unknown[]).includes(x);

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
  });

  section(c, 'staffing', p, (s) => {
    for (const k of ['doctors', 'triageNurses', 'fastTrackClinicians']) field(s, 'staffing', k, count, 'non-negative integer', p);
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
    field(t, 'triage', 'enabled', (x) => typeof x === 'boolean', 'true or false', p);
    field(t, 'triage', 'meanMinutes', positive, 'positive number', p);
    field(t, 'triage', 'accuracy', prob, 'probability in [0, 1]', p);
    field(t, 'triage', 'underTriageShare', prob, 'probability in [0, 1]', p);
  });

  section(c, 'queue', p, (q) => {
    field(q, 'queue', 'discipline', (x) => x === 'fifo' || x === 'acuity', "'fifo' or 'acuity'", p);
  });

  section(c, 'fastTrack', p, (f) => {
    field(f, 'fastTrack', 'enabled', (x) => typeof x === 'boolean', 'true or false', p);
    field(f, 'fastTrack', 'minAcuity', isAcuity, 'integer 1..5', p);
    field(f, 'fastTrack', 'serviceFactor', positive, 'positive number', p);
    field(f, 'fastTrack', 'doctorsTakeOverflow', (x) => typeof x === 'boolean', 'true or false', p);
    if (f.enabled === true && isObj(c.triage) && c.triage.enabled === false)
      p.push('fastTrack.enabled: fast track routes on triage acuity, so it needs triage enabled');
  });

  section(c, 'lwbs', p, (l) => {
    field(l, 'lwbs', 'enabled', (x) => typeof x === 'boolean', 'true or false', p);
    if (l.patienceMeanMinutesByAcuity !== undefined)
      p.push(...checkAcuityMap(l.patienceMeanMinutesByAcuity, 'lwbs.patienceMeanMinutesByAcuity', (x) => x === null || positive(x), 'positive number or null (never leaves)'));
  });

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
        ...(typeof cmd.enabled === 'boolean' ? [] : [`${path}.enabled: true or false`]),
        ...(cmd.minAcuity === undefined || isAcuity(cmd.minAcuity) ? [] : [`${path}.minAcuity: integer 1..5`]),
      ];
    default:
      return [`${path}.type: unknown command '${String(cmd.type)}'`];
  }
}

function copyCommand(tc: TimedCommand): TimedCommand {
  return JSON.parse(JSON.stringify(tc)) as TimedCommand;
}

export function resolveConfig(raw: unknown): ResolvedConfig {
  const c = validateConfig(raw);

  const modules = Object.fromEntries(MODULES.map((m) => [m, c.modules?.[m] ?? false])) as Record<ModuleName, boolean>;

  const acuityMix = { ...PARAMS.acuity.mix } as Record<Acuity, number>;
  if (c.arrivals?.acuityMix) {
    // A partial mix replaces the default entirely; missing levels become 0.
    for (const a of ACUITIES) acuityMix[a] = c.arrivals.acuityMix[`${a}`] ?? 0;
  }
  if (!(ACUITIES.reduce((s, a) => s + acuityMix[a], 0) > 0))
    throw new ConfigError(['arrivals.acuityMix: at least one acuity must have positive weight']);

  const serviceMeanByAcuity = { ...PARAMS.service.doctorMeanMinutesByAcuity } as Record<Acuity, number>;
  const patienceMeanByAcuity = { ...PARAMS.lwbs.patienceMeanMinutesByAcuity } as Record<Acuity, number>;
  for (const a of ACUITIES) {
    const override = c.service?.meanMinutes ?? c.service?.meanMinutesByAcuity?.[`${a}`];
    if (override !== undefined) serviceMeanByAcuity[a] = override;
    const patience = c.lwbs?.patienceMeanMinutesByAcuity?.[`${a}`];
    if (patience !== undefined) patienceMeanByAcuity[a] = patience ?? Infinity;
  }

  const durationMinutes = c.durationMinutes ?? PARAMS.run.durationMinutes;
  const warmupMinutes = c.warmupMinutes ?? PARAMS.run.warmupMinutes;
  if (warmupMinutes >= durationMinutes) throw new ConfigError(['warmupMinutes: must be less than durationMinutes']);

  if (!modules.staffing && c.commands?.some((tc) => tc.command.type === 'setSchedule'))
    throw new ConfigError(['commands: setSchedule needs the staffing module on']);

  const mult = c.arrivals?.rateMultiplier ?? 1;
  const triageEnabled = c.triage?.enabled ?? true;

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
    },
    schedule: JSON.parse(JSON.stringify(c.staffing?.schedule ?? {})) as Partial<Record<Role, Shift[]>>,
    serviceDistribution: c.service?.distribution ?? 'exponential',
    serviceMeanByAcuity,
    lognormalCv: c.service?.lognormalCv ?? PARAMS.service.lognormalCv,
    triage: {
      enabled: triageEnabled,
      meanMinutes: c.triage?.meanMinutes ?? PARAMS.triage.meanMinutes,
      cv: PARAMS.triage.cv,
      accuracy: c.triage?.accuracy ?? PARAMS.triage.accuracy,
      underTriageShare: c.triage?.underTriageShare ?? PARAMS.triage.underTriageShare,
    },
    discipline: c.queue?.discipline ?? 'acuity',
    fastTrack: {
      enabled: c.fastTrack?.enabled ?? false,
      minAcuity: c.fastTrack?.minAcuity ?? PARAMS.fastTrack.minAcuity,
      serviceFactor: c.fastTrack?.serviceFactor ?? PARAMS.fastTrack.serviceFactor,
      doctorsTakeOverflow: c.fastTrack?.doctorsTakeOverflow ?? true,
    },
    lwbs: { enabled: c.lwbs?.enabled ?? true, patienceMeanByAcuity, patienceCv: PARAMS.lwbs.patienceCv },
    commands: (c.commands ?? []).map(copyCommand),
    level: c.level,
  };
}
