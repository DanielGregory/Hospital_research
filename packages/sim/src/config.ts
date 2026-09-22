/**
 * Run configuration: the JSON shape of levels and sandbox setups.
 *
 * `validateConfig` checks raw JSON; `resolveConfig` fills every gap from PARAMS
 * so the engine only ever sees a complete `ResolvedConfig`.
 */

import { PARAMS } from './params.js';
import { ACUITIES, type Acuity, type TimedCommand } from './types.js';

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

/** Build phase each module lands in. Enabling a module before then is a config error. */
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
export const IMPLEMENTED_MODULES: readonly ModuleName[] = [];

export type ServiceDistribution = 'exponential' | 'lognormal';

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
    acuityMix?: Partial<Record<`${Acuity}`, number>>;
  };
  staffing?: {
    doctors?: number;
  };
  service?: {
    distribution?: ServiceDistribution;
    /** If set, every acuity uses this mean (handy for textbook queue checks). */
    meanMinutes?: number;
    meanMinutesByAcuity?: Partial<Record<`${Acuity}`, number>>;
    lognormalCv?: number;
  };
  commands?: TimedCommand[];
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
  doctors: number;
  serviceDistribution: ServiceDistribution;
  serviceMeanByAcuity: Record<Acuity, number>;
  lognormalCv: number;
  commands: TimedCommand[];
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid config:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function nonNegNumber(x: unknown): boolean {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

/** Throws ConfigError listing every problem found. */
export function validateConfig(raw: unknown): SimConfig {
  const p: string[] = [];
  if (!isObj(raw)) throw new ConfigError(['config must be a JSON object']);
  const c = raw as Record<string, unknown>;

  if (typeof c.id !== 'string' || c.id.length === 0) p.push('id: required non-empty string');
  if (c.durationMinutes !== undefined && !(nonNegNumber(c.durationMinutes) && (c.durationMinutes as number) > 0))
    p.push('durationMinutes: must be a positive number');
  if (c.warmupMinutes !== undefined && !nonNegNumber(c.warmupMinutes)) p.push('warmupMinutes: must be >= 0');
  if (
    c.startDayOfWeek !== undefined &&
    !(Number.isInteger(c.startDayOfWeek) && (c.startDayOfWeek as number) >= 0 && (c.startDayOfWeek as number) <= 6)
  )
    p.push('startDayOfWeek: integer 0..6 (0 = Monday)');
  if (
    c.startHour !== undefined &&
    !(nonNegNumber(c.startHour) && (c.startHour as number) < 24)
  )
    p.push('startHour: number in [0, 24)');

  if (c.modules !== undefined) {
    if (!isObj(c.modules)) p.push('modules: must be an object of booleans');
    else
      for (const [name, on] of Object.entries(c.modules)) {
        if (!(MODULES as readonly string[]).includes(name)) {
          p.push(`modules.${name}: unknown module (known: ${MODULES.join(', ')})`);
          continue;
        }
        if (typeof on !== 'boolean') p.push(`modules.${name}: must be true or false`);
        else if (on && !IMPLEMENTED_MODULES.includes(name as ModuleName))
          p.push(`modules.${name}: not implemented yet (planned for Phase ${MODULE_PHASE[name as ModuleName]})`);
      }
  }

  if (c.arrivals !== undefined) {
    if (!isObj(c.arrivals)) p.push('arrivals: must be an object');
    else {
      const a = c.arrivals;
      if (a.hourlyRates !== undefined && !(Array.isArray(a.hourlyRates) && a.hourlyRates.length === 24 && a.hourlyRates.every(nonNegNumber)))
        p.push('arrivals.hourlyRates: array of 24 non-negative numbers (patients/hour)');
      if (
        a.dayOfWeekMultipliers !== undefined &&
        !(Array.isArray(a.dayOfWeekMultipliers) && a.dayOfWeekMultipliers.length === 7 && a.dayOfWeekMultipliers.every(nonNegNumber))
      )
        p.push('arrivals.dayOfWeekMultipliers: array of 7 non-negative numbers (Monday first)');
      if (a.acuityMix !== undefined) p.push(...checkAcuityMap(a.acuityMix, 'arrivals.acuityMix', false));
    }
  }

  if (c.staffing !== undefined) {
    if (!isObj(c.staffing)) p.push('staffing: must be an object');
    else if (c.staffing.doctors !== undefined && !(Number.isInteger(c.staffing.doctors) && (c.staffing.doctors as number) >= 0))
      p.push('staffing.doctors: non-negative integer');
  }

  if (c.service !== undefined) {
    if (!isObj(c.service)) p.push('service: must be an object');
    else {
      const s = c.service;
      if (s.distribution !== undefined && s.distribution !== 'exponential' && s.distribution !== 'lognormal')
        p.push("service.distribution: 'exponential' or 'lognormal'");
      if (s.meanMinutes !== undefined && !(nonNegNumber(s.meanMinutes) && (s.meanMinutes as number) > 0))
        p.push('service.meanMinutes: positive number');
      if (s.meanMinutesByAcuity !== undefined) p.push(...checkAcuityMap(s.meanMinutesByAcuity, 'service.meanMinutesByAcuity', true));
      if (s.lognormalCv !== undefined && !(nonNegNumber(s.lognormalCv) && (s.lognormalCv as number) > 0))
        p.push('service.lognormalCv: positive number');
    }
  }

  if (c.commands !== undefined) {
    if (!Array.isArray(c.commands)) p.push('commands: must be an array');
    else c.commands.forEach((tc, i) => p.push(...checkTimedCommand(tc, `commands[${i}]`)));
  }

  if (p.length > 0) throw new ConfigError(p);
  return raw as unknown as SimConfig;
}

function checkAcuityMap(x: unknown, path: string, positive: boolean): string[] {
  if (!isObj(x)) return [`${path}: must be an object keyed by acuity "1".."5"`];
  const out: string[] = [];
  for (const [k, v] of Object.entries(x)) {
    if (!['1', '2', '3', '4', '5'].includes(k)) out.push(`${path}.${k}: acuity keys are "1".."5"`);
    else if (!nonNegNumber(v) || (positive && v === 0)) out.push(`${path}.${k}: must be ${positive ? 'positive' : 'non-negative'}`);
  }
  return out;
}

export function checkTimedCommand(tc: unknown, path: string): string[] {
  if (!isObj(tc)) return [`${path}: must be { atMinute, command }`];
  const out: string[] = [];
  if (!nonNegNumber(tc.atMinute)) out.push(`${path}.atMinute: must be >= 0`);
  out.push(...checkCommand(tc.command, `${path}.command`));
  return out;
}

export function checkCommand(cmd: unknown, path: string): string[] {
  if (!isObj(cmd)) return [`${path}: must be an object`];
  switch (cmd.type) {
    case 'setDoctors':
      return Number.isInteger(cmd.count) && (cmd.count as number) >= 0 ? [] : [`${path}.count: non-negative integer`];
    default:
      return [`${path}.type: unknown command '${String(cmd.type)}'`];
  }
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
  for (const a of ACUITIES) {
    const override = c.service?.meanMinutes ?? c.service?.meanMinutesByAcuity?.[`${a}`];
    if (override !== undefined) serviceMeanByAcuity[a] = override;
  }

  const durationMinutes = c.durationMinutes ?? PARAMS.run.durationMinutes;
  const warmupMinutes = c.warmupMinutes ?? PARAMS.run.warmupMinutes;
  if (warmupMinutes >= durationMinutes) throw new ConfigError(['warmupMinutes: must be less than durationMinutes']);

  const commands = [...(c.commands ?? [])].map((tc) => ({ atMinute: tc.atMinute, command: { ...tc.command } }));

  return {
    id: c.id,
    name: c.name ?? c.id,
    durationMinutes,
    warmupMinutes,
    startDayOfWeek: c.startDayOfWeek ?? 0,
    startHour: c.startHour ?? 0,
    modules,
    hourlyRates: [...(c.arrivals?.hourlyRates ?? PARAMS.arrivals.hourlyRates)],
    dayOfWeekMultipliers: [...(c.arrivals?.dayOfWeekMultipliers ?? PARAMS.arrivals.dayOfWeekMultipliers)],
    acuityMix,
    doctors: c.staffing?.doctors ?? PARAMS.staffing.doctors,
    serviceDistribution: c.service?.distribution ?? 'exponential',
    serviceMeanByAcuity,
    lognormalCv: c.service?.lognormalCv ?? PARAMS.service.lognormalCv,
    commands,
  };
}
