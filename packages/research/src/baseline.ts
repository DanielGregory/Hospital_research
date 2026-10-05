/**
 * Calibrate a department from its own visit records and check the result: does the model,
 * run with the fitted inputs and the department's staffing and beds, reproduce what the data
 * shows? No what-if should be trusted until this check is close.
 */
import { applySettings, fitVisits, PARAMS, resolveConfig, Simulation, summarizeVisits, visitsFromPatients, type Metrics, type Visit, type VisitSummary } from '@er/sim';
import { range, type Range } from './compare.js';

export interface CheckRow {
  key: string;
  label: string;
  unit: 'perDay' | 'min' | 'share' | 'hours';
  data: number | null;
  /** Model value across replications. */
  model: Range;
  /** Relative gap (model median vs data), or null when either is missing. */
  gap: number | null;
  status: 'close' | 'off' | 'no data';
}

/** Gaps under this share count as close. */
export const CLOSE_WITHIN = 0.1;

function row(key: string, label: string, unit: CheckRow['unit'], data: number | null, values: (number | null)[], absSlack = 0): CheckRow {
  const model = range(values);
  if (data === null || model.median === null) return { key, label, unit, data, model, gap: null, status: 'no data' };
  const gap = data === 0 ? (model.median === 0 ? 0 : Infinity) : (model.median - data) / Math.abs(data);
  const close = Math.abs(model.median - data) <= Math.max(absSlack, CLOSE_WITHIN * Math.abs(data));
  return { key, label, unit, data, model, gap, status: close ? 'close' : 'off' };
}

function runs(config: unknown, seeds: readonly number[]): Metrics[] {
  return seeds.map((s) => new Simulation(config, s).run().metrics);
}

/**
 * Runs for checking and fitting are long enough for the wards to fill (boarding builds over weeks):
 * five weeks, the first discarded.
 */
export const CHECK_RUN = { days: 35, warmupDays: 7 };

function longRun(config: unknown): unknown {
  return applySettings(config as object, { durationMinutes: CHECK_RUN.days * 1440, warmupMinutes: CHECK_RUN.warmupDays * 1440 });
}

/** Model visits per seed (after warm-up), summarised with the same definitions as the data. */
function modelSummaries(base: unknown, seeds: readonly number[]): VisitSummary[] {
  const config = longRun(base);
  const r = resolveConfig(config);
  return seeds.map((seed) => {
    const sim = new Simulation(config, seed);
    sim.run();
    return summarizeVisits(visitsFromPatients(sim.allPatients(), { fromMinute: r.warmupMinutes, startDayOfWeek: r.startDayOfWeek, startHour: r.startHour }));
  });
}

/** Model vs data, side by side, with identical definitions on both sides. */
export function baselineCheck(config: unknown, data: VisitSummary, seeds: readonly number[]): CheckRow[] {
  const ms = modelSummaries(config, seeds);
  const rows = [
    row('arrivals', 'Visits per day', 'perDay', data.arrivalsPerDay, ms.map((m) => m.arrivalsPerDay)),
    row('d2d', 'Door to provider, median', 'min', data.doorToProvider.median, ms.map((m) => m.doorToProvider.median), 3),
    row('d2dP90', 'Door to provider, 90th percentile', 'min', data.doorToProvider.p90, ms.map((m) => m.doorToProvider.p90), 5),
    row('los', 'Length of stay, median', 'min', data.lengthOfStay.median, ms.map((m) => m.lengthOfStay.median), 10),
    row('lwbs', 'Left without being seen', 'share', data.lwbsRate, ms.map((m) => m.lwbsRate), 0.01),
    row('admitted', 'Admitted', 'share', data.admissionRate, ms.map((m) => m.admissionRate), 0.01),
    row('boarding', 'Decision to departure (admitted), average', 'hours', data.boardingHoursMean, ms.map((m) => m.boardingHoursMean), 0.25),
  ];
  for (const a of ['1', '2', '3', '4', '5'] as const)
    rows.push(row(`los${a}`, `Length of stay, ESI ${a}, median`, 'min', data.lengthOfStayByAcuity[a] ?? null, ms.map((m) => m.lengthOfStayByAcuity[a] ?? null), 15));
  return rows;
}

export interface Calibration {
  /** The department config with fitted inputs applied. */
  config: unknown;
  /** Settings the fit changed (dot path → value), for display and export. */
  fitted: Record<string, unknown>;
  notes: string[];
}

/**
 * Fit arrivals, acuity mix, admission and ambulance shares from the visits, then (optionally)
 * scale test-result times by acuity so median length of stay matches, a few rounds of
 * proportional correction on the given seeds.
 */
export function calibrate(base: unknown, visits: readonly Visit[], data: VisitSummary, o: { seeds?: readonly number[]; fitLengthOfStay?: boolean; rounds?: number } = {}): Calibration {
  const { fragment, notes } = fitVisits(visits);
  const fitted: Record<string, unknown> = {};
  const flatten = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && !/Rates|Multipliers|Mix|ByAcuity/.test(k)) flatten(v as Record<string, unknown>, path);
      else fitted[path] = v;
    }
  };
  flatten(fragment as Record<string, unknown>, '');
  let config = applySettings(base as object, fitted);
  if (o.fitLengthOfStay !== false) {
    const seeds = o.seeds ?? [1, 2, 3];
    const r = resolveConfig(config);
    const workup: Record<string, number> = Object.fromEntries(([1, 2, 3, 4, 5] as const).map((a) => [String(a), r.workup.meanMinutesByAcuity[a] ?? PARAMS.workup.meanMinutesByAcuity[a]]));
    // Patience: one scale on every finite mean, so the share who leave unseen matches.
    const patience0 = r.lwbs.patienceMeanByAcuity;
    let scale = 1;
    const patience = () =>
      Object.fromEntries(([1, 2, 3, 4, 5] as const).map((a) => [String(a), Number.isFinite(patience0[a]) ? Math.round(patience0[a] * scale * 10) / 10 : null]));
    // Volume: the model adds its own return visits on top of the fitted arrivals, which already
    // include the department's returns; scale arrivals so total visits match.
    // Wards by length of stay (discharges follow occupancy, so boarding settles instead of drifting).
    // The fit finds how many ward beds the ED's admissions effectively have.
    const boardingOn = r.modules.boarding && data.boardingHoursMean !== null;
    const stay = r.boarding.inpatientStayHours ?? PARAMS.boarding.typicalStayHours;
    const admitsPerDay = (data.admissionRate ?? 0) * data.arrivalsPerDay;
    // Beds that would be ~100% busy: admissions a day × stay in days.
    let wardBeds = Math.max(1, Math.round((admitsPerDay * stay) / 24));
    let bLo = Math.round(wardBeds * 0.85);
    let bHi = Math.round(wardBeds * 1.4) + 2;
    // Start the wards at their expected steady occupancy (admissions a day × stay), not full: with
    // multi-day stays an over-full start takes weeks to drain and shows up as boarding.
    const steady = Math.round((admitsPerDay * stay) / 24);
    const ward = () => ({ 'boarding.inpatientStayHours': stay, 'boarding.inpatientBeds': wardBeds, 'boarding.initialOccupied': Math.max(0, Math.min(wardBeds, steady)) });
    let volume = ((config as { arrivals?: { rateMultiplier?: number } }).arrivals?.rateMultiplier ?? 1) as number;
    const trial = () =>
      applySettings(config, { 'workup.enabled': true, 'workup.meanMinutesByAcuity': workup, 'lwbs.patienceMeanMinutesByAcuity': patience(), 'arrivals.rateMultiplier': volume, ...(boardingOn ? ward() : {}) });
    let fittedLos = false;
    let fittedLwbs = false;
    const mean = (ms: VisitSummary[], f: (m: VisitSummary) => number | null) => range(ms.map(f)).mean;
    // Stage 1: visit volume (stable, and everything else depends on it).
    for (let i = 0; i < 2; i++) {
      const perDay = mean(modelSummaries(trial(), seeds), (m) => m.arrivalsPerDay);
      if (perDay) volume = Math.round(volume * (data.arrivalsPerDay / perDay) * 1000) / 1000;
    }
    // Stage 2 and 4: ward beds, by bisection (fewer beds, longer boarding).
    const fitWard = () => {
      while (bHi - bLo > 1) {
        wardBeds = Math.round((bLo + bHi) / 2);
        const b = mean(modelSummaries(trial(), seeds), (m) => m.boardingHoursMean) ?? 0;
        if (b > data.boardingHoursMean!) bLo = wardBeds;
        else bHi = wardBeds;
      }
      wardBeds = bHi;
    };
    if (boardingOn) fitWard();
    // Stage 3: test-result times (length of stay by acuity) and patience (share leaving unseen).
    for (let round = 0; round < (o.rounds ?? 4); round++) {
      const ms = modelSummaries(trial(), seeds);
      for (const a of ['1', '2', '3', '4', '5'] as const) {
        const target = data.lengthOfStayByAcuity[a];
        const model = range(ms.map((m) => m.lengthOfStayByAcuity[a] ?? null)).median;
        if (target === null || target === undefined || model === null) continue;
        workup[a] = Math.max(0, Math.round((workup[a]! + 0.7 * (target - model)) * 10) / 10);
        fittedLos = true;
      }
      const lw = mean(ms, (m) => m.lwbsRate);
      if (data.lwbsRate !== null && data.lwbsRate > 0 && lw !== null && lw > 0) {
        // More leaving in the model than the data: people are too impatient, so raise patience.
        scale = Math.min(10, Math.max(0.1, scale * (lw / data.lwbsRate) ** 0.5));
        fittedLwbs = true;
      }
    }
    if (boardingOn) {
      // Re-open the bracket around the current value and refine.
      bLo = wardBeds - 4;
      bHi = wardBeds + 4;
      fitWard();
    }
    fitted['arrivals.rateMultiplier'] = volume;
    if (boardingOn) {
      Object.assign(fitted, ward());
      notes.push(
        `Wards modelled by length of stay (${Math.round(stay)} h on average, a placeholder until ward data is available): ${wardBeds} ward beds for ED admissions reproduce the wait for a ward bed.`,
      );
    }
    if (fittedLos) {
      fitted['workup.enabled'] = true;
      fitted['workup.meanMinutesByAcuity'] = workup;
      notes.push('Test-result times were scaled by acuity so median length of stay matches the data.');
    }
    if (fittedLwbs) {
      fitted['lwbs.patienceMeanMinutesByAcuity'] = patience();
      notes.push(`Patience before leaving unseen was scaled ×${scale.toFixed(2)} so the share who leave matches the data.`);
    }
    config = applySettings(config, Object.fromEntries(Object.entries(fitted).filter(([k]) => k.startsWith('workup') || k.startsWith('lwbs') || k.startsWith('boarding.') || k === 'arrivals.rateMultiplier')));
  }
  return { config, fitted, notes };
}
