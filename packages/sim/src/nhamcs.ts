/**
 * NHAMCS (US National Hospital Ambulatory Medical Care Survey, NCHS/CDC), emergency department
 * public-use file: one fixed-width record per sampled visit, with a national weight (PATWT).
 * Field positions are from the year's documentation ("Record format", 1-based, inclusive) and
 * change between years, so each year's layout is listed separately and checked against the
 * record's own YEAR field. Pure: the caller unzips the file.
 *
 * Terms (NCHS): statistical reporting and analysis only; no attempt to identify anyone. Keep the
 * raw file out of the repository; publish aggregates only.
 */
import type { Visit, VisitDisposition } from './visits.js';
import type { UnitId } from './types.js';

type Field = readonly [start: number, length: number];

/** 2022 ED file layout (doc22-ed-508.pdf, Record format). */
const LAYOUT_2022 = {
  VMONTH: [1, 2],
  VDAYR: [3, 1],
  ARRTIME: [4, 4],
  WAITTIME: [8, 4],
  LOV: [12, 4],
  AGE: [16, 3],
  SEX: [25, 1],
  ARREMS: [33, 2],
  IMMEDR: [67, 2],
  LWBS: [491, 1],
  LBTC: [492, 1],
  LEFTAMA: [493, 1],
  DOA: [494, 1],
  DIEDED: [495, 1],
  TRANPSYC: [497, 1],
  TRANOTH: [498, 1],
  ADMITHOS: [499, 1],
  OBSHOS: [500, 1],
  OBSDIS: [501, 1],
  ADMIT: [503, 2],
  LOS: [507, 2],
  YEAR: [2341, 4],
  PATWT: [2359, 11],
  BOARDED: [2379, 4],
  SEEN72: [71, 2],
  DIAGSCRN: [177, 1],
  XRAY: [207, 1],
  CATSCAN: [208, 1],
  ULTRASND: [219, 1],
} as const satisfies Record<string, Field>;

/** Laboratory tests in the 2022 file: blood tests ABG … OTHERBLD (178–197) and HIVTEST … URINE (200–204). */
const LAB_2022: readonly number[] = [...Array.from({ length: 20 }, (_, i) => 178 + i), 200, 201, 202, 203, 204];

/**
 * 2019–2021 (doc19/20/21-ed-508.pdf): the same layout, except that the visit disposition block and
 * the fields at the end of the record sit two characters earlier.
 */
const shift = (names: readonly (keyof typeof LAYOUT_2022)[], by: number) =>
  Object.fromEntries(Object.entries(LAYOUT_2022).map(([k, [st, n]]) => [k, [names.includes(k as keyof typeof LAYOUT_2022) ? st + by : st, n]])) as unknown as typeof LAYOUT_2022;
const LAYOUT_2019_2021 = shift(
  ['LWBS', 'LBTC', 'LEFTAMA', 'DOA', 'DIEDED', 'TRANPSYC', 'TRANOTH', 'ADMITHOS', 'OBSHOS', 'OBSDIS', 'ADMIT', 'LOS', 'YEAR', 'PATWT', 'BOARDED'],
  -2,
);

export const NHAMCS_LAYOUTS: Record<number, { layout: typeof LAYOUT_2022; lab: readonly number[]; recordLength: number }> = {
  2019: { layout: LAYOUT_2019_2021, lab: LAB_2022, recordLength: 2380 },
  2020: { layout: LAYOUT_2019_2021, lab: LAB_2022, recordLength: 2380 },
  2021: { layout: LAYOUT_2019_2021, lab: LAB_2022, recordLength: 2380 },
  2022: { layout: LAYOUT_2022, lab: LAB_2022, recordLength: 2382 },
};

export interface NhamcsVisit {
  month: number;
  /** 0 = Monday. */
  dayOfWeek: number;
  /** Hour of arrival, 0–23.99 (null when blank). */
  hour: number | null;
  /** Minutes to first provider (physician/APRN/PA); null when blank or not seen. */
  wait: number | null;
  /** Length of visit, minutes. */
  lengthOfVisit: number | null;
  age: number | null;
  sex: 'F' | 'M' | null;
  ambulance: boolean | null;
  /** Triage level 1–5 (immediate … nonurgent); null when blank, unknown, or no triage. */
  acuity: number | null;
  disposition: VisitDisposition;
  /** Unit for admitted patients: critical care → icu, step-down → stepdown, any other → ward. */
  unit: UnitId | null;
  /** Hospital stay in days (admitted). */
  hospitalDays: number | null;
  /** Admit order to leaving the ED, minutes. */
  boarded: number | null;
  /** Seen in this ED within the previous 72 hours (null when unknown). */
  seen72: boolean | null;
  /** Tests ordered or provided (null when the diagnostic-services item was left blank). */
  tests: { lab: boolean; xray: boolean; ct: boolean; ultrasound: boolean } | null;
  /** National visit weight. */
  weight: number;
}

/** Read an NHAMCS ED file for a year with a known layout. Rejects records whose YEAR differs. */
export function parseNhamcs(text: string, year: number): { visits: NhamcsVisit[]; problems: string[] } {
  const spec = NHAMCS_LAYOUTS[year];
  if (!spec) return { visits: [], problems: [`No record layout for ${year} (known: ${Object.keys(NHAMCS_LAYOUTS).join(', ')})`] };
  const L = spec.layout;
  const problems: string[] = [];
  const visits: NhamcsVisit[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let bad = 0;
  for (const line of lines) {
    const get = ([s, n]: Field) => line.slice(s - 1, s - 1 + n);
    const num = (f: Field) => {
      const v = Number.parseFloat(get(f).trim());
      return Number.isFinite(v) ? v : null;
    };
    const pos = (f: Field) => {
      const v = num(f);
      return v !== null && v >= 0 ? v : null;
    };
    const flag = (f: Field) => num(f) === 1;
    if (line.length < spec.recordLength || num(L.YEAR) !== year) {
      if (bad++ < 3) problems.push(`Record ${visits.length + bad} is not a ${year} record of ${spec.recordLength} characters`);
      continue;
    }
    const arr = num(L.ARRTIME);
    const immed = num(L.IMMEDR);
    const ems = num(L.ARREMS);
    const sex = num(L.SEX);
    const admitUnit = num(L.ADMIT);
    const disposition: VisitDisposition = flag(L.LWBS)
      ? 'lwbs'
      : flag(L.ADMITHOS) || flag(L.OBSHOS)
        ? 'admitted'
        : flag(L.TRANPSYC) || flag(L.TRANOTH)
          ? 'transferred'
          : flag(L.DOA) || flag(L.DIEDED) || flag(L.LBTC) || flag(L.LEFTAMA)
            ? 'other'
            : 'discharged';
    visits.push({
      month: num(L.VMONTH) ?? 0,
      dayOfWeek: ((num(L.VDAYR) ?? 1) + 5) % 7, // 1 = Sunday → 6, 2 = Monday → 0
      hour: arr !== null && arr >= 0 ? Math.floor(arr / 100) + (arr % 100) / 60 : null,
      wait: pos(L.WAITTIME),
      lengthOfVisit: pos(L.LOV),
      age: pos(L.AGE),
      sex: sex === 1 ? 'F' : sex === 2 ? 'M' : null,
      ambulance: ems === 1 ? true : ems === 2 ? false : null,
      acuity: immed !== null && immed >= 1 && immed <= 5 ? immed : null,
      disposition,
      unit: disposition === 'admitted' ? (admitUnit === 1 ? 'icu' : admitUnit === 2 ? 'stepdown' : 'ward') : null,
      hospitalDays: disposition === 'admitted' ? pos(L.LOS) : null,
      boarded: pos(L.BOARDED),
      seen72: num(L.SEEN72) === 1 ? true : num(L.SEEN72) === 2 ? false : null,
      tests:
        num(L.DIAGSCRN) === 0
          ? { lab: false, xray: false, ct: false, ultrasound: false }
          : num(L.DIAGSCRN) === 1
            ? { lab: spec.lab.some((c) => line[c - 1] === '1'), xray: flag(L.XRAY), ct: flag(L.CATSCAN), ultrasound: flag(L.ULTRASND) }
            : null,
      weight: num(L.PATWT) ?? 0,
    });
  }
  if (bad > 3) problems.push(`${bad} records skipped in all`);
  return { visits, problems };
}

/** Weighted quantile (weights need not sum to 1). */
export function weightedQuantile(xs: readonly { v: number; w: number }[], q: number): number | null {
  const s = xs.filter((x) => x.w > 0).sort((a, b) => a.v - b.v);
  const total = s.reduce((a, x) => a + x.w, 0);
  if (!total) return null;
  let acc = 0;
  for (const x of s) {
    acc += x.w;
    if (acc >= q * total) return x.v;
  }
  return s.at(-1)!.v;
}

/** National estimates from the weights: what the model's defaults should reproduce. */
export interface NhamcsSummary {
  records: number;
  weightedVisits: number;
  acuityMix: Record<string, number>;
  /** Share with a known triage level. */
  triagedShare: number;
  admissionRate: number;
  admitByAcuity: Record<string, number>;
  ambulanceByAcuity: Record<string, number>;
  lwbsRate: number;
  waitMedian: number | null;
  waitP90: number | null;
  waitMedianByAcuity: Record<string, number | null>;
  lengthOfVisitMedian: number | null;
  lengthOfVisitMedianByAcuity: Record<string, number | null>;
  boardedMedian: number | null;
  /** Admitted patients, by unit: share, and median hospital stay in days. */
  units: Record<UnitId, { share: number; hospitalDaysMedian: number | null }>;
  /** Unit shares among admitted patients, by triage level. */
  unitShareByAcuity: Record<string, Record<UnitId, number>>;
  /** Share of visits with each kind of test, by triage level (visits with the item answered). */
  testsByAcuity: Record<string, { lab: number; xray: number; ct: number; ultrasound: number }>;
  tests: { lab: number; xray: number; ct: number; ultrasound: number };
  /** Share of visits by someone seen in the same ED in the previous 72 hours. */
  seen72Rate: number;
  seen72ByAcuity: Record<string, number>;
  /** Admitted patients: mean hospital stay in days, by unit (whole stay, not just that unit). */
  hospitalDaysMean: Record<UnitId, number | null>;
  ageMedianByAcuity: Record<string, number | null>;
  femaleShare: number;
  /** Share of visits under 16 (the simulator's patient profiles are adults). */
  under16Share: number;
}

export function summarizeNhamcs(vs: readonly NhamcsVisit[]): NhamcsSummary {
  const W = (xs: readonly NhamcsVisit[]) => xs.reduce((s, v) => s + v.weight, 0);
  const share = (xs: readonly NhamcsVisit[], f: (v: NhamcsVisit) => boolean) => (W(xs) ? W(xs.filter(f)) / W(xs) : 0);
  const q = (xs: readonly NhamcsVisit[], f: (v: NhamcsVisit) => number | null, p: number) =>
    weightedQuantile(
      xs.flatMap((v) => (f(v) === null ? [] : [{ v: f(v)!, w: v.weight }])),
      p,
    );
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  const levels = ['1', '2', '3', '4', '5'];
  const triaged = vs.filter((v) => v.acuity !== null);
  const byAcuity = (a: string) => triaged.filter((v) => v.acuity === +a);
  const known = vs.filter((v) => v.disposition !== 'other');
  const admitted = vs.filter((v) => v.disposition === 'admitted');
  const unitIds: UnitId[] = ['icu', 'stepdown', 'ward'];
  return {
    records: vs.length,
    weightedVisits: Math.round(W(vs)),
    acuityMix: Object.fromEntries(levels.map((a) => [a, r4(share(triaged, (v) => v.acuity === +a))])),
    triagedShare: r4(triaged.length ? W(triaged) / W(vs) : 0),
    admissionRate: r4(share(known, (v) => v.disposition === 'admitted')),
    admitByAcuity: Object.fromEntries(
      levels.map((a) => [a, r4(share(byAcuity(a).filter((v) => v.disposition !== 'other' && v.disposition !== 'lwbs'), (v) => v.disposition === 'admitted'))]),
    ),
    ambulanceByAcuity: Object.fromEntries(levels.map((a) => [a, r4(share(byAcuity(a).filter((v) => v.ambulance !== null), (v) => v.ambulance === true))])),
    lwbsRate: r4(share(known, (v) => v.disposition === 'lwbs')),
    waitMedian: q(vs, (v) => v.wait, 0.5),
    waitP90: q(vs, (v) => v.wait, 0.9),
    waitMedianByAcuity: Object.fromEntries(levels.map((a) => [a, q(byAcuity(a), (v) => v.wait, 0.5)])),
    lengthOfVisitMedian: q(
      vs.filter((v) => v.disposition !== 'lwbs'),
      (v) => v.lengthOfVisit,
      0.5,
    ),
    lengthOfVisitMedianByAcuity: Object.fromEntries(
      levels.map((a) => [
        a,
        q(
          byAcuity(a).filter((v) => v.disposition !== 'lwbs'),
          (v) => v.lengthOfVisit,
          0.5,
        ),
      ]),
    ),
    boardedMedian: q(admitted, (v) => v.boarded, 0.5),
    units: Object.fromEntries(
      unitIds.map((u) => [u, { share: r4(share(admitted, (v) => v.unit === u)), hospitalDaysMedian: q(admitted.filter((v) => v.unit === u), (v) => v.hospitalDays, 0.5) }]),
    ) as NhamcsSummary['units'],
    testsByAcuity: Object.fromEntries(
      levels.map((a) => {
        const t = byAcuity(a).filter((v) => v.tests);
        return [a, { lab: r4(share(t, (v) => v.tests!.lab)), xray: r4(share(t, (v) => v.tests!.xray)), ct: r4(share(t, (v) => v.tests!.ct)), ultrasound: r4(share(t, (v) => v.tests!.ultrasound)) }];
      }),
    ),
    tests: (() => {
      const t = vs.filter((v) => v.tests);
      return { lab: r4(share(t, (v) => v.tests!.lab)), xray: r4(share(t, (v) => v.tests!.xray)), ct: r4(share(t, (v) => v.tests!.ct)), ultrasound: r4(share(t, (v) => v.tests!.ultrasound)) };
    })(),
    seen72Rate: r4(share(vs.filter((v) => v.seen72 !== null), (v) => v.seen72 === true)),
    seen72ByAcuity: Object.fromEntries(levels.map((a) => [a, r4(share(byAcuity(a).filter((v) => v.seen72 !== null), (v) => v.seen72 === true))])),
    hospitalDaysMean: Object.fromEntries(
      unitIds.map((u) => {
        const xs = admitted.filter((v) => v.unit === u && v.hospitalDays !== null);
        return [u, W(xs) ? Math.round((xs.reduce((s, v) => s + v.hospitalDays! * v.weight, 0) / W(xs)) * 100) / 100 : null];
      }),
    ) as Record<UnitId, number | null>,
    ageMedianByAcuity: Object.fromEntries(levels.map((a) => [a, q(byAcuity(a), (v) => v.age, 0.5)])),
    femaleShare: r4(share(vs.filter((v) => v.sex), (v) => v.sex === 'F')),
    under16Share: r4(share(vs.filter((v) => v.age !== null), (v) => v.age! < 16)),
    unitShareByAcuity: Object.fromEntries(
      levels.map((a) => {
        const adm = admitted.filter((v) => v.acuity === +a);
        return [a, Object.fromEntries(unitIds.map((u) => [u, r4(share(adm, (v) => v.unit === u))])) as Record<UnitId, number>];
      }),
    ),
  };
}

/**
 * Visits in the planner's format, drawn in proportion to the national weights (systematic
 * resampling: deterministic, every record at its weighted share). Arrival times are placeholders;
 * lay them out with `restackVisits`. Visits with no arrival hour are left out.
 */
export function nhamcsVisits(vs: readonly NhamcsVisit[], n = 20000): Visit[] {
  const usable = vs.filter((v) => v.hour !== null && v.weight > 0);
  const total = usable.reduce((s, v) => s + v.weight, 0);
  if (!total) return [];
  const step = total / n;
  const out: Visit[] = [];
  let acc = 0;
  let next = step / 2;
  for (const v of usable) {
    acc += v.weight;
    while (next <= acc && out.length < n) {
      out.push({
        arrival: 0,
        dayOfWeek: v.dayOfWeek,
        hour: v.hour!,
        acuity: v.acuity,
        toTriage: null,
        toProvider: v.wait,
        toDecision: v.disposition === 'admitted' && v.lengthOfVisit !== null && v.boarded !== null ? Math.max(0, v.lengthOfVisit - v.boarded) : null,
        lengthOfStay: v.lengthOfVisit,
        disposition: v.disposition,
        byAmbulance: v.ambulance,
        age: v.age,
        sex: v.sex,
      });
      next += step;
    }
  }
  return out;
}

type Service = 'lab' | 'xray' | 'ct' | 'ultrasound';
const SERVICES: readonly Service[] = ['lab', 'xray', 'ct', 'ultrasound'];

/**
 * Rescale each condition's chance of each test so that, weighted by how common the conditions are,
 * every triage level orders each test at the target rate. Conditions keep their differences (a
 * stroke still gets a CT far more often than abdominal pain); a level with no condition ordering a
 * test gets the target rate spread over its conditions that order any test (never to one that
 * needs none, like a prescription refill). Chances are capped at 1, and the shortfall is moved to the
 * conditions with room left, a few times over.
 */
export function fitOrderRates(
  orders: Record<string, Partial<Record<Service, number>>>,
  conditions: readonly { id: string; acuity: number; weight: number }[],
  target: Record<string, Record<Service, number>>,
): Record<string, Partial<Record<Service, number>>> {
  const out: Record<string, Partial<Record<Service, number>>> = Object.fromEntries(conditions.map((c) => [c.id, { ...(orders[c.id] ?? {}) }]));
  for (const [a, t] of Object.entries(target)) {
    const group = conditions.filter((c) => c.acuity === +a);
    const total = group.reduce((s, c) => s + c.weight, 0);
    if (!total) continue;
    // Conditions that order no test at all (a prescription refill) never get one spread to them.
    const testable = group.filter((c) => Object.values(orders[c.id] ?? {}).some((x) => (x ?? 0) > 0));
    const spreadTo = testable.length ? testable : group;
    const spreadWeight = spreadTo.reduce((s, c) => s + c.weight, 0);
    for (const sv of SERVICES) {
      const avg = () => group.reduce((s, c) => s + c.weight * (out[c.id]![sv] ?? 0), 0) / total;
      if (avg() === 0) for (const c of spreadTo) out[c.id]![sv] = Math.min(1, (t[sv] * total) / spreadWeight);
      for (let i = 0; i < 6 && Math.abs(avg() - t[sv]) > 1e-4; i++) {
        const room = group.filter((c) => (out[c.id]![sv] ?? 0) < 1 && (out[c.id]![sv] ?? 0) > 0);
        if (!room.length) break;
        const fixed = group.filter((c) => !room.includes(c)).reduce((s, c) => s + c.weight * (out[c.id]![sv] ?? 0), 0);
        const moving = room.reduce((s, c) => s + c.weight * (out[c.id]![sv] ?? 0), 0);
        const f = (t[sv] * total - fixed) / moving;
        for (const c of room) out[c.id]![sv] = Math.min(1, (out[c.id]![sv] ?? 0) * f);
      }
      // Still short (the conditions that order it are all at 1): spread the rest over the others.
      const short = t[sv] * total - avg() * total;
      if (short > 1e-6) {
        const open = spreadTo.filter((c) => (out[c.id]![sv] ?? 0) < 1);
        const w = open.reduce((s, c) => s + c.weight, 0);
        for (const c of open) out[c.id]![sv] = Math.min(1, (out[c.id]![sv] ?? 0) + short / w);
      }
      for (const c of group) out[c.id]![sv] = Math.round((out[c.id]![sv] ?? 0) * 1000) / 1000;
    }
  }
  // Drop zeros, so the table reads like the original.
  for (const id of Object.keys(out)) for (const sv of SERVICES) if (!out[id]![sv]) delete out[id]![sv];
  return out;
}
