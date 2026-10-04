/**
 * Open ED datasets, read into the visit format (`visits.ts`). Pure: the caller downloads and
 * decompresses the files; this joins and reshapes them.
 *
 * MIMIC-IV-ED (PhysioNet): `edstays` (stay_id, intime, outtime, gender, arrival_transport,
 * disposition) and `triage` (stay_id, acuity). Its dates are shifted per patient to protect
 * privacy, so visits from different patients are not on a real shared calendar: daily volume and
 * crowding cannot be read from it, but hour of day, weekday, acuity, admission, arrival mode and
 * length of stay can. `restackVisits` lays the visits out on a calendar at a chosen daily volume,
 * keeping each visit's weekday and time of day, so the usual fit and check work unchanged.
 */
import { parseCsv, parseVisits, type Visit, type VisitParse } from './visits.js';

export interface OpenSource {
  id: string;
  name: string;
  /** How to read the files. */
  format: 'mimic-ed' | 'nhamcs-ed' | 'cms-hospitals';
  /** Survey year (NHAMCS layouts differ by year). */
  year?: number;
  /** Files to fetch (or place in the data folder), by name, with their download URL. */
  files: { name: string; url: string }[];
  /** Whether the files can be downloaded without an account. */
  open: boolean;
  license: string;
  citation: string;
  page: string;
  /** Dates are shifted per patient: volume must be set, not fitted. */
  shiftedDates: boolean;
  /** What the sample is not representative of, if anything (shown with every fit). */
  caveat?: string;
}

const MIMIC_FILES = (base: string) => [
  { name: 'edstays.csv.gz', url: `${base}/ed/edstays.csv.gz` },
  { name: 'triage.csv.gz', url: `${base}/ed/triage.csv.gz` },
];

/** Check the license and citation on each dataset's page before publishing results. */
export const OPEN_SOURCES: Record<string, OpenSource> = {
  'mimic-ed-demo': {
    id: 'mimic-ed-demo',
    name: 'MIMIC-IV-ED Demo (v2.2)',
    format: 'mimic-ed',
    files: MIMIC_FILES('https://physionet.org/files/mimic-iv-ed-demo/2.2'),
    open: true,
    license: 'Open Data Commons Open Database License v1.0 (check the PhysioNet page)',
    citation: 'Johnson A, Bulgarelli L, Pollard T, Celi LA, Mark R, Horng S. MIMIC-IV-ED Demo (version 2.2). PhysioNet.',
    page: 'https://physionet.org/content/mimic-iv-ed-demo/2.2/',
    shiftedDates: true,
    caveat:
      'The demo is about 220 visits from 64 patients drawn from the hospital database (mostly admitted patients): about 70% admitted, 60% by ambulance and almost no ESI 4–5. It tests the pipeline; its shares are not representative of an ED population and should not replace the defaults.',
  },
  'mimic-ed': {
    id: 'mimic-ed',
    name: 'MIMIC-IV-ED (v2.2)',
    format: 'mimic-ed',
    files: MIMIC_FILES('https://physionet.org/files/mimic-iv-ed/2.2'),
    open: false,
    license: 'PhysioNet Credentialed Health Data License 1.5.0 (credentialed access; do not redistribute the data)',
    citation: 'Johnson A, Bulgarelli L, Pollard T, Celi LA, Mark R, Horng S. MIMIC-IV-ED (version 2.2). PhysioNet.',
    page: 'https://physionet.org/content/mimic-iv-ed/2.2/',
    shiftedDates: true,
  },
  'cms-ed': {
    id: 'cms-ed',
    name: 'CMS Care Compare: Timely and Effective Care - Hospital (emergency department measures)',
    format: 'cms-hospitals',
    // The file name changes with each release; the dataset's metadata gives the current one.
    files: [{ name: 'Timely_and_Effective_Care-Hospital.csv', url: 'https://data.cms.gov/provider-data/api/1/metastore/schemas/dataset/items/yv7e-xc69' }],
    open: true,
    license: 'US government work (public domain). Cite CMS and the reporting period.',
    citation: 'Centers for Medicare & Medicaid Services. Care Compare: Timely and Effective Care - Hospital. data.cms.gov, dataset yv7e-xc69.',
    page: 'https://data.cms.gov/provider-data/dataset/yv7e-xc69',
    shiftedDates: false,
  },
  'nhamcs-2022': {
    id: 'nhamcs-2022',
    name: 'NHAMCS 2022 Emergency Department public-use file (NCHS/CDC)',
    format: 'nhamcs-ed',
    year: 2022,
    files: [{ name: 'ed2022.zip', url: 'https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Datasets/NHAMCS/ed2022.zip' }],
    open: true,
    license:
      'US government public-use data (NCHS). Terms: statistical reporting and analysis only; no attempt to identify any person or establishment; no linking to identifiable data.',
    citation:
      'National Center for Health Statistics. National Hospital Ambulatory Medical Care Survey: 2022 Emergency Department public-use data file and documentation. Hyattsville, MD.',
    page: 'https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Datasets/NHAMCS/',
    // A national sample of visits across many EDs: no shared calendar, so volume is a setting.
    shiftedDates: true,
  },
};

/** Join MIMIC-IV-ED `edstays` and `triage` (by stay_id) into visits. */
export function mimicEdVisits(edstaysCsv: string, triageCsv: string): VisitParse & { stays: number; withAcuity: number } {
  const tri = parseCsv(triageCsv);
  const th = (tri[0] ?? []).map((h) => h.trim().toLowerCase());
  const tStay = th.indexOf('stay_id');
  const tAcuity = th.indexOf('acuity');
  const acuity = new Map<string, string>();
  if (tStay >= 0 && tAcuity >= 0) for (const r of tri.slice(1)) acuity.set((r[tStay] ?? '').trim(), (r[tAcuity] ?? '').trim());

  const ed = parseCsv(edstaysCsv);
  const eh = (ed[0] ?? []).map((h) => h.trim().toLowerCase());
  const eStay = eh.indexOf('stay_id');
  if (eStay < 0 || !eh.includes('intime')) {
    return { visits: [], columns: parseVisits('').columns, skipped: 0, problems: ['edstays: expected stay_id and intime columns'], stays: 0, withAcuity: 0 };
  }
  // Re-emit as one visit table with an acuity column, then read it like any export.
  const quote = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [[...eh, 'acuity'].join(',')];
  let withAcuity = 0;
  for (const r of ed.slice(1)) {
    const a = acuity.get((r[eStay] ?? '').trim()) ?? '';
    if (a) withAcuity++;
    lines.push([...eh.map((_, i) => quote(r[i] ?? '')), a].join(','));
  }
  const parsed = parseVisits(lines.join('\n'));
  return { ...parsed, stays: ed.length - 1, withAcuity };
}

/**
 * Lay visits out on a calendar at `visitsPerDay`, keeping each visit's weekday and time of day
 * (for sources whose dates were shifted per patient). Deterministic: visits are dealt to the days
 * that share their weekday, in order of their original timestamps. A sample too small for a week
 * at that volume is reused in turn.
 */
export function restackVisits(visits: readonly Visit[], visitsPerDay: number): Visit[] {
  if (!visits.length) return [];
  const days = Math.max(7, Math.round(visits.length / Math.max(1e-9, visitsPerDay)));
  // Too few visits for a week at this volume: reuse them in turn (shares and medians are unchanged).
  const total = Math.max(visits.length, Math.round(days * visitsPerDay));
  const pool = Array.from({ length: total }, (_, i) => visits[i % visits.length]!);
  // Day d has weekday d % 7 (day 0 is a Monday).
  const daysByWeekday: number[][] = Array.from({ length: 7 }, () => []);
  for (let d = 0; d < days; d++) daysByWeekday[d % 7]!.push(d);
  const next = Array<number>(7).fill(0);
  const out = pool.map((v) => {
    const slots = daysByWeekday[v.dayOfWeek]!;
    const day = slots[next[v.dayOfWeek]!++ % slots.length]!;
    return { ...v, arrival: day * 1440 + Math.round(v.hour * 60 * 1000) / 1000 };
  });
  return out.sort((a, b) => a.arrival - b.arrival);
}
