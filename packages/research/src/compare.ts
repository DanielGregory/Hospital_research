/**
 * Scenario comparison for planning: a baseline and variations on it, each run on the same
 * replications (common random numbers), so differences come from the change, not the dice.
 * Every number is reported as a range across replications, and every difference with a
 * confidence interval. Pure and deterministic: the same inputs give the same report.
 */
import { applySettings, checkSetup, ConfigError, getPath, resolveConfig, Simulation, type Metrics, type Settings, type TimedCommand } from '@er/sim';

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  /** Changes to the baseline config (dot paths), e.g. { "beds.main": 24 }. Empty = the baseline itself. */
  settings: Settings;
  /** Commands during each replication (e.g. an escalation at a set time). */
  commands?: TimedCommand[];
}

export interface Kpi {
  key: string;
  label: string;
  /** Metric dot path. */
  metric: string;
  unit: 'min' | 'hours' | 'share' | 'count' | 'money' | 'score';
  better: 'lower' | 'higher';
}

/** What planners look at first. */
export const PLANNER_KPIS: readonly Kpi[] = [
  { key: 'd2dMedian', label: 'Door to provider, median', metric: 'doorToDoctor.median', unit: 'min', better: 'lower' },
  { key: 'd2dP90', label: 'Door to provider, 90th percentile', metric: 'doorToDoctor.p90', unit: 'min', better: 'lower' },
  { key: 'urgentD2d', label: 'ESI 1–2 door to provider, median', metric: 'doorToDoctorByGroup.urgent.median', unit: 'min', better: 'lower' },
  { key: 'losMedian', label: 'Length of stay, median', metric: 'lengthOfStay.median', unit: 'min', better: 'lower' },
  { key: 'lwbs', label: 'Left without being seen', metric: 'lwbsRate', unit: 'share', better: 'lower' },
  { key: 'boarding', label: 'Boarding time per admitted patient', metric: 'boarding.meanHours', unit: 'hours', better: 'lower' },
  { key: 'critical', label: 'Patients who became critical while waiting', metric: 'deterioration.critical', unit: 'count', better: 'lower' },
  { key: 'doctorUtil', label: 'Provider utilisation', metric: 'utilizationByRole.doctor', unit: 'share', better: 'lower' },
  { key: 'costPerDay', label: 'Cost per day', metric: 'cost.perDay', unit: 'money', better: 'lower' },
  { key: 'incidents', label: 'Aggression incidents per 1,000 visits', metric: 'security.incidentsPer1000Visits', unit: 'count', better: 'lower' },
  { key: 'violent', label: 'Violent incidents', metric: 'security.violent', unit: 'count', better: 'lower' },
  { key: 'clinicianIncidentHours', label: 'Clinician hours lost to incidents', metric: 'security.clinicianHours', unit: 'hours', better: 'lower' },
];

export interface Range {
  /** Replications with a value (a metric can be missing, e.g. no admitted patients). */
  n: number;
  mean: number | null;
  median: number | null;
  /** 5th and 95th percentiles across replications: how much a typical run varies. */
  lo: number | null;
  hi: number | null;
}

export interface Difference {
  /** Paired replications (both sides have a value). */
  n: number;
  /** Mean of (scenario − baseline). */
  mean: number | null;
  /** 95% confidence interval for that mean (t distribution). */
  ciLo: number | null;
  ciHi: number | null;
  /** Share of paired replications where the scenario was better. */
  betterShare: number | null;
}

export interface ScenarioResult {
  scenario: Scenario;
  /** Setup problems (limits, budget, invalid config); the scenario did not run if non-empty. */
  problems: string[];
  kpis: Record<string, Range>;
  /** Versus the baseline (absent for the baseline itself). */
  diff?: Record<string, Difference>;
  /** Raw values per replication, by KPI (for charts and export). */
  values: Record<string, (number | null)[]>;
}

export interface Comparison {
  seeds: number[];
  kpis: readonly Kpi[];
  baseline: ScenarioResult;
  scenarios: ScenarioResult[];
}

export interface CompareOptions {
  /** Replication seeds (each is one full run of the config). */
  seeds: readonly number[];
  kpis?: readonly Kpi[];
  /** Called after each run: (runs done, runs total). */
  onProgress?: (done: number, total: number) => void;
}

/** Percentile of sorted values (linear interpolation). */
function pct(sorted: readonly number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

export function range(values: readonly (number | null)[]): Range {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return { n: 0, mean: null, median: null, lo: null, hi: null };
  return { n: xs.length, mean: xs.reduce((s, x) => s + x, 0) / xs.length, median: pct(xs, 0.5), lo: pct(xs, 0.05), hi: pct(xs, 0.95) };
}

/** Two-sided 95% t quantile for `df` degrees of freedom. */
export function t95(df: number): number {
  const table: [number, number][] = [
    [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447], [7, 2.365], [8, 2.306], [9, 2.262], [10, 2.228],
    [12, 2.179], [15, 2.131], [20, 2.086], [25, 2.06], [30, 2.042], [40, 2.021], [60, 2.0], [120, 1.98],
  ];
  if (df < 1) return Infinity;
  for (const [d, t] of table) if (df <= d) return t;
  return 1.96;
}

export function difference(scenario: readonly (number | null)[], base: readonly (number | null)[], better: Kpi['better']): Difference {
  const d: number[] = [];
  for (let i = 0; i < Math.min(scenario.length, base.length); i++) {
    const a = scenario[i];
    const b = base[i];
    if (a !== null && a !== undefined && b !== null && b !== undefined && Number.isFinite(a) && Number.isFinite(b)) d.push(a - b);
  }
  if (!d.length) return { n: 0, mean: null, ciLo: null, ciHi: null, betterShare: null };
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  const sd = d.length > 1 ? Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (d.length - 1)) : 0;
  const half = d.length > 1 ? t95(d.length - 1) * (sd / Math.sqrt(d.length)) : 0;
  const betterShare = d.filter((x) => (better === 'lower' ? x < -1e-9 : x > 1e-9)).length / d.length;
  return { n: d.length, mean, ciLo: mean - half, ciHi: mean + half, betterShare };
}

/** The config a scenario runs (baseline plus its settings). */
export function scenarioConfig(base: unknown, s: Scenario): unknown {
  const cfg = applySettings(base as object, s.settings) as Record<string, unknown>;
  return s.commands?.length ? { ...cfg, commands: [...((cfg.commands as TimedCommand[]) ?? []), ...s.commands] } : cfg;
}

function setupProblems(config: unknown): string[] {
  try {
    return checkSetup(resolveConfig(config));
  } catch (e) {
    return e instanceof ConfigError ? e.problems : [String(e)];
  }
}

function kpiValues(m: Metrics, kpis: readonly Kpi[]): Record<string, number | null> {
  return Object.fromEntries(
    kpis.map((k) => {
      const v = getPath(m, k.metric);
      return [k.key, typeof v === 'number' && Number.isFinite(v) ? v : null];
    }),
  );
}

/** Run the baseline and each scenario on the same seeds and compare them. */
export function compareScenarios(base: unknown, scenarios: readonly Scenario[], o: CompareOptions): Comparison {
  const kpis = o.kpis ?? PLANNER_KPIS;
  const seeds = [...o.seeds];
  const all: Scenario[] = [{ id: 'baseline', name: 'Baseline', settings: {} }, ...scenarios];
  const total = all.length * seeds.length;
  let done = 0;
  const results = all.map((scenario): ScenarioResult => {
    const config = scenarioConfig(base, scenario);
    const problems = setupProblems(config);
    const values: Record<string, (number | null)[]> = Object.fromEntries(kpis.map((k) => [k.key, []]));
    if (!problems.length)
      for (const seed of seeds) {
        const v = kpiValues(new Simulation(config, seed).run().metrics, kpis);
        for (const k of kpis) values[k.key]!.push(v[k.key]!);
        o.onProgress?.(++done, total);
      }
    else done += seeds.length;
    return { scenario, problems, values, kpis: Object.fromEntries(kpis.map((k) => [k.key, range(values[k.key]!)])) };
  });
  const [baseline, ...rest] = results;
  for (const r of rest)
    if (!r.problems.length) r.diff = Object.fromEntries(kpis.map((k) => [k.key, difference(r.values[k.key]!, baseline!.values[k.key]!, k.better)]));
  return { seeds, kpis, baseline: baseline!, scenarios: rest };
}
