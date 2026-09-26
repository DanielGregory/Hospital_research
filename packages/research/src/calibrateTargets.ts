/**
 * Fit a few free parameters so the simulation matches published aggregate statistics
 * (e.g. national survey tables) when patient-level data is not available.
 *
 * Directly set: acuity mix, the shape of the hourly arrival curve.
 * Fitted by bisection (each monotone in its parameter, all on the same seeds):
 *   admission scale  -> overall admission rate
 *   patience scale   -> LWBS rate
 *   workup scale     -> median length of stay of discharged patients
 * The three interact a little, so the fit loops over them a few times.
 */
import { applySettings, PARAMS, resolveConfig, Simulation, type Acuity, type Metrics } from '@er/sim';

export interface AggregateTargets {
  /** Share of triaged visits by ESI level. */
  acuityMix?: Partial<Record<'1' | '2' | '3' | '4' | '5', number>>;
  /** Relative arrivals by hour of day (any scale; total daily volume is kept). */
  hourlyShape?: number[];
  admissionRate?: number;
  lwbsRate?: number;
  losMedianDischargedMinutes?: number;
}

export interface FitResult {
  fragment: Record<string, unknown>;
  achieved: { admissionRate: number; lwbsRate: number; losMedianDischargedMinutes: number | null };
  scales: { admission: number; patience: number; workup: number };
}

const ACUITIES: Acuity[] = [1, 2, 3, 4, 5];

/** Mean admission probability per ESI level under the params' condition catalogue. */
export function defaultAdmitByAcuity(): Record<Acuity, number> {
  const out = {} as Record<Acuity, number>;
  for (const a of ACUITIES) {
    const cs = PARAMS.conditions.filter((c) => c.acuity === a);
    const w = cs.reduce((s, c) => s + c.weight, 0);
    out[a] = cs.reduce((s, c) => s + (c.weight / w) * c.admit, 0);
  }
  return out;
}

function fragmentFor(t: AggregateTargets, base: unknown, s: FitResult['scales']): Record<string, unknown> {
  const admit = defaultAdmitByAcuity();
  const patience = PARAMS.lwbs.patienceMeanMinutesByAcuity;
  const workup = PARAMS.workup.meanMinutesByAcuity;
  const frag: Record<string, unknown> = {
    'disposition.admitProbabilityByAcuity': Object.fromEntries(ACUITIES.map((a) => [`${a}`, Math.min(1, admit[a] * s.admission)])),
    'lwbs.patienceMeanMinutesByAcuity': Object.fromEntries(ACUITIES.map((a) => [`${a}`, Number.isFinite(patience[a]) ? patience[a] * s.patience : null])),
    'workup.meanMinutesByAcuity': Object.fromEntries(ACUITIES.map((a) => [`${a}`, workup[a] * s.workup])),
  };
  if (t.acuityMix) frag['arrivals.acuityMix'] = t.acuityMix;
  if (t.hourlyShape) {
    const current = resolveConfig(base).hourlyRates;
    const total = current.reduce((a, b) => a + b, 0);
    const shapeTotal = t.hourlyShape.reduce((a, b) => a + b, 0);
    frag['arrivals.hourlyRates'] = t.hourlyShape.map((x) => (x / shapeTotal) * total);
    frag['arrivals.rateMultiplier'] = 1;
  }
  return frag;
}

function measure(base: unknown, frag: Record<string, unknown>, seeds: number[]) {
  const ms: Metrics[] = seeds.map((s) => new Simulation(applySettings(base as object, frag), s).run().metrics);
  const mean = (f: (m: Metrics) => number | null) => {
    const xs = ms.map(f).filter((x): x is number => x !== null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  return {
    admissionRate: mean((m) => (m.arrivals ? m.admitted / m.arrivals : null)) ?? 0,
    lwbsRate: mean((m) => m.lwbsRate) ?? 0,
    losMedianDischargedMinutes: mean((m) => m.lengthOfStayDischarged.median),
  };
}

/** Bisection on a scale in [lo, hi] for an increasing (or decreasing) response. */
function bisect(f: (x: number) => number, target: number, lo: number, hi: number, increasing: boolean, steps = 12): number {
  for (let i = 0; i < steps; i++) {
    const mid = Math.sqrt(lo * hi); // geometric: scales are ratios
    const v = f(mid);
    if (v < target === increasing) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

export function fitToTargets(base: unknown, targets: AggregateTargets, seeds: number[] = [1, 2, 3], rounds = 2): FitResult {
  const scales = { admission: 1, patience: 1, workup: 1 };
  for (let r = 0; r < rounds; r++) {
    if (targets.admissionRate !== undefined)
      scales.admission = bisect((x) => measure(base, fragmentFor(targets, base, { ...scales, admission: x }), seeds).admissionRate, targets.admissionRate, 0.05, 8, true);
    if (targets.lwbsRate !== undefined)
      scales.patience = bisect((x) => measure(base, fragmentFor(targets, base, { ...scales, patience: x }), seeds).lwbsRate, targets.lwbsRate, 0.05, 50, false);
    if (targets.losMedianDischargedMinutes !== undefined)
      scales.workup = bisect(
        (x) => measure(base, fragmentFor(targets, base, { ...scales, workup: x }), seeds).losMedianDischargedMinutes ?? 0,
        targets.losMedianDischargedMinutes,
        0.02,
        20,
        true,
      );
  }
  const fragment = fragmentFor(targets, base, scales);
  return { fragment, achieved: measure(base, fragment, seeds), scales };
}
