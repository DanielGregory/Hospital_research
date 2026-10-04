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
} as const satisfies Record<string, Field>;

export const NHAMCS_LAYOUTS: Record<number, { layout: typeof LAYOUT_2022; recordLength: number }> = {
  2022: { layout: LAYOUT_2022, recordLength: 2382 },
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
