/**
 * Start from a real hospital's published figures (CMS Care Compare): set the department's volume
 * from its ED visits a year, size beds and shifts in proportion (an estimate until the hospital
 * enters its own), then fit test-result times and patience so the median time in the ED for
 * patients sent home and the share leaving unseen match what it reports. Pure and deterministic.
 */
import { applySettings, resolveConfig, Simulation, type CmsHospital, type Metrics, type Shift, type SimConfig } from '@er/sim';

export interface HospitalTargets {
  visitsPerDay: number;
  /** Median minutes in the ED for patients sent home (CMS OP_18b). */
  medianMinutesDischarged: number | null;
  lwbsRate: number | null;
}

export function hospitalTargets(h: CmsHospital): HospitalTargets | null {
  if (!h.visitsPerYear) return null;
  return { visitsPerDay: h.visitsPerYear / 365, medianMinutesDischarged: h.medianMinutesDischarged, lwbsRate: h.lwbsRate };
}

const ACUITY_KEYS = ['1', '2', '3', '4', '5'] as const;

/** Beds and shift counts scaled by `factor` (at least one of everything that was staffed). */
export function scaleDepartment(base: SimConfig, factor: number): SimConfig {
  const r = resolveConfig(base);
  const sched = base.staffing?.schedule ?? {};
  const scaled = Object.fromEntries(
    Object.entries(sched).map(([role, shifts]) => [role, (shifts as Shift[]).map((s) => ({ ...s, count: Math.max(1, Math.round(s.count * factor)) }))]),
  );
  const mainBeds = r.beds.main;
  const settings: Record<string, unknown> = { 'staffing.schedule': scaled };
  if (mainBeds !== null && !base.modules?.layout) settings['beds.main'] = Math.max(4, Math.round(mainBeds * factor));
  if (base.boarding?.inpatientBeds) {
    const beds = Math.max(4, Math.round(base.boarding.inpatientBeds * factor));
    settings['boarding.inpatientBeds'] = beds;
    if (base.boarding.initialOccupied !== undefined) settings['boarding.initialOccupied'] = Math.min(beds, Math.round(base.boarding.initialOccupied * factor));
  }
  return applySettings(base, settings) as SimConfig;
}

export interface HospitalFit {
  config: SimConfig;
  /** Model against the hospital's figures (means over the seeds). */
  check: { label: string; target: number | null; model: number | null; unit: 'perDay' | 'min' | 'share' }[];
  notes: string[];
}

const mean = (ms: Metrics[], f: (m: Metrics) => number | null) => {
  const xs = ms.map(f).filter((x): x is number => x !== null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};

/** Bisection on a positive scale (geometric), for an increasing or decreasing response. */
function bisect(f: (x: number) => number | null, target: number, lo: number, hi: number, increasing: boolean, steps = 9): number {
  for (let i = 0; i < steps; i++) {
    const mid = Math.sqrt(lo * hi);
    const v = f(mid);
    if (v === null) break;
    if (v < target === increasing) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

export function fitToHospital(base: SimConfig, t: HospitalTargets, seeds: readonly number[] = [1, 2, 3]): HospitalFit {
  const notes: string[] = [];
  const r0 = resolveConfig(base);
  const baseDaily = r0.hourlyRates.reduce((s, x) => s + x, 0);
  const factor = t.visitsPerDay / baseDaily;
  const mult = ((base.arrivals?.rateMultiplier ?? 1) as number) * factor;
  let config = applySettings(scaleDepartment(base, factor), { 'arrivals.rateMultiplier': Math.round(mult * 1000) / 1000 }) as SimConfig;
  notes.push(
    `Volume set to ${Math.round(t.visitsPerDay)} visits a day from the hospital's reported ED visits. Beds and shifts were scaled ×${factor.toFixed(2)} from the starting department: an estimate until the hospital enters its own.`,
  );

  const r = resolveConfig(config);
  const workup0 = r.workup.meanMinutesByAcuity;
  const patience0 = r.lwbs.patienceMeanByAcuity;
  const withScales = (w: number, p: number) =>
    applySettings(config, {
      'workup.enabled': true,
      'workup.meanMinutesByAcuity': Object.fromEntries(ACUITY_KEYS.map((a) => [a, Math.round((workup0[+a as 1] ?? 0) * w * 10) / 10])),
      'lwbs.patienceMeanMinutesByAcuity': Object.fromEntries(ACUITY_KEYS.map((a) => [a, Number.isFinite(patience0[+a as 1]) ? Math.round(patience0[+a as 1] * p * 10) / 10 : null])),
    }) as SimConfig;
  const run = (c: SimConfig) => seeds.map((s) => new Simulation(c, s).run().metrics);
  let w = 1;
  let p = 1;
  for (let round = 0; round < 2; round++) {
    if (t.medianMinutesDischarged !== null) w = bisect((x) => mean(run(withScales(x, p)), (m) => m.lengthOfStayDischarged.median), t.medianMinutesDischarged, 0.05, 6, true);
    if (t.lwbsRate !== null && t.lwbsRate > 0) p = bisect((x) => mean(run(withScales(w, x)), (m) => m.lwbsRate), t.lwbsRate, 0.05, 30, false);
  }
  config = withScales(w, p);
  const ms = run(config);
  const check: HospitalFit['check'] = [
    { label: 'Visits per day', target: t.visitsPerDay, model: mean(ms, (m) => m.arrivals / Math.max(1, (config.durationMinutes! - (config.warmupMinutes ?? 0)) / 1440)), unit: 'perDay' },
    { label: 'Median time in the ED, patients sent home', target: t.medianMinutesDischarged, model: mean(ms, (m) => m.lengthOfStayDischarged.median), unit: 'min' },
    { label: 'Left before being seen', target: t.lwbsRate, model: mean(ms, (m) => m.lwbsRate), unit: 'share' },
  ];
  const los = check[1]!;
  if (los.target !== null && los.model !== null && Math.abs(los.model - los.target) > Math.max(15, los.target * 0.15))
    notes.push(
      los.model > los.target
        ? 'The model stays slower than the hospital even with the quickest test times: the estimated beds or shifts are probably too few. Enter the real numbers.'
        : 'The model stays quicker than the hospital: the estimated beds or shifts are probably more than it has, or its delays are elsewhere (boarding, imaging). Enter the real numbers.',
    );
  notes.push(`Test-result times scaled ×${w.toFixed(2)} and patience ×${p.toFixed(2)} so the time in the ED and the share leaving unseen match.`);
  return { config, check, notes };
}
