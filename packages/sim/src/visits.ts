/**
 * ED visit records: one row per visit, as a hospital would export from its EHR (de-identified
 * timestamps and codes, no names). Parse them, fit the simulation's inputs to them, summarise the
 * outcomes the simulation should reproduce, and write the same format from a simulation run.
 * Pure: no files, no network, so it can run in a browser on the hospital's own machine.
 */
import type { SimConfig } from './config.js';
import { PARAMS } from './params.js';
import type { Patient } from './types.js';

export type VisitDisposition = 'discharged' | 'admitted' | 'lwbs' | 'transferred' | 'other';

export interface Visit {
  /** Minutes since the first arrival's midnight (so hour of day and weekday are kept). */
  arrival: number;
  /** Day of week of arrival (0 = Monday) and hour of day (0–23.99). */
  dayOfWeek: number;
  hour: number;
  acuity: number | null;
  /** Minutes from arrival; null when not recorded. */
  toTriage: number | null;
  toProvider: number | null;
  toDecision: number | null;
  lengthOfStay: number | null;
  disposition: VisitDisposition;
  byAmbulance: boolean | null;
  age: number | null;
  sex: 'F' | 'M' | null;
}

/** Accepted column names (lower case), first match wins. */
export const VISIT_COLUMNS = {
  arrival: ['arrival_time', 'arrival', 'arrived', 'intime', 'arrival_datetime', 'checkin_time', 'registration_time'],
  triage: ['triage_time', 'triage', 'triage_start'],
  provider: ['provider_time', 'provider_seen_time', 'first_provider_time', 'doctor_time', 'seen_time', 'md_time'],
  decision: ['decision_time', 'disposition_time', 'dispo_time', 'admit_decision_time'],
  departure: ['departure_time', 'departure', 'outtime', 'discharge_time', 'left_time', 'depart_time'],
  acuity: ['acuity', 'esi', 'esi_level', 'triage_acuity', 'triage_level', 'ctas', 'ats'],
  disposition: ['disposition', 'dispo', 'outcome', 'discharge_disposition'],
  mode: ['arrival_mode', 'arrival_transport', 'mode_of_arrival', 'transport'],
  age: ['age', 'age_years', 'anchor_age'],
  sex: ['sex', 'gender'],
} as const;

/** Minimal CSV parser: commas, quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

/** "2024-03-05 14:07[:33]", "2024-03-05T14:07", "03/05/2024 14:07" → minutes since 1970 (clock time, no time zone). */
export function parseTime(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?/.exec(t);
  let y: number, mo: number, d: number, h: number, mi: number, sec: number;
  if (m) [y, mo, d, h, mi, sec] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, m[6] ? +m[6] : 0];
  else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t);
    if (!m) return null;
    [mo, d, y, h, mi, sec] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, m[6] ? +m[6] : 0];
  }
  const ms = Date.UTC(y, mo - 1, d, h, mi, sec);
  return Number.isFinite(ms) ? ms / 60000 : null;
}

function classifyDisposition(s: string): VisitDisposition {
  const t = s.trim().toUpperCase();
  if (!t) return 'other';
  if (/LWBS|LEFT WITHOUT|ELOPE|WALKED OUT|LEFT BEFORE|LWOT/.test(t)) return 'lwbs';
  if (/ADMIT|INPATIENT|OBSERVATION|ICU|WARD/.test(t)) return 'admitted';
  if (/TRANSFER/.test(t)) return 'transferred';
  if (/HOME|DISCHARG|RELEASE/.test(t)) return 'discharged';
  return 'other';
}

export interface VisitParse {
  visits: Visit[];
  /** Which input column each field came from (null = not found). */
  columns: Record<keyof typeof VISIT_COLUMNS, string | null>;
  /** Rows skipped, with the first few reasons. */
  skipped: number;
  problems: string[];
}

/** Read a visit export. Unknown columns are ignored; only an arrival time is required. */
export function parseVisits(text: string): VisitParse {
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const columns = Object.fromEntries(
    (Object.keys(VISIT_COLUMNS) as (keyof typeof VISIT_COLUMNS)[]).map((k) => [k, (VISIT_COLUMNS[k] as readonly string[]).find((c) => header.includes(c)) ?? null]),
  ) as VisitParse['columns'];
  const problems: string[] = [];
  if (!columns.arrival) return { visits: [], columns, skipped: 0, problems: [`No arrival time column (one of: ${VISIT_COLUMNS.arrival.join(', ')})`] };
  const col = (k: keyof typeof VISIT_COLUMNS) => (columns[k] ? header.indexOf(columns[k]!) : -1);
  const idx = Object.fromEntries((Object.keys(VISIT_COLUMNS) as (keyof typeof VISIT_COLUMNS)[]).map((k) => [k, col(k)])) as Record<keyof typeof VISIT_COLUMNS, number>;
  const raw: { t: number; row: string[] }[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const t = parseTime(row[idx.arrival] ?? '');
    if (t === null) {
      if (skipped++ < 3) problems.push(`Unreadable arrival time: "${row[idx.arrival] ?? ''}"`);
      continue;
    }
    raw.push({ t, row });
  }
  if (!raw.length) return { visits: [], columns, skipped, problems: problems.length ? problems : ['No visits'] };
  raw.sort((a, b) => a.t - b.t);
  const day0 = Math.floor(raw[0]!.t / 1440) * 1440;
  const since = (row: string[], k: keyof typeof VISIT_COLUMNS, t: number) => {
    if (idx[k] < 0) return null;
    const v = parseTime(row[idx[k]] ?? '');
    return v === null || v < t ? null : v - t;
  };
  const visits = raw.map(({ t, row }): Visit => {
    const date = new Date(t * 60000);
    const acuityRaw = idx.acuity >= 0 ? Number.parseFloat(row[idx.acuity] ?? '') : NaN;
    const mode = idx.mode >= 0 ? (row[idx.mode] ?? '').trim().toUpperCase() : '';
    const ageRaw = idx.age >= 0 ? Number.parseFloat(row[idx.age] ?? '') : NaN;
    const sexRaw = idx.sex >= 0 ? (row[idx.sex] ?? '').trim().toUpperCase() : '';
    return {
      arrival: t - day0,
      dayOfWeek: (date.getUTCDay() + 6) % 7,
      hour: date.getUTCHours() + date.getUTCMinutes() / 60,
      acuity: Number.isInteger(acuityRaw) && acuityRaw >= 1 && acuityRaw <= 5 ? acuityRaw : null,
      toTriage: since(row, 'triage', t),
      toProvider: since(row, 'provider', t),
      toDecision: since(row, 'decision', t),
      lengthOfStay: since(row, 'departure', t),
      disposition: idx.disposition >= 0 ? classifyDisposition(row[idx.disposition] ?? '') : 'other',
      byAmbulance: mode && !/^(UNKNOWN|OTHER|UNK|NA|N\/A)$/.test(mode) ? /AMBUL|EMS|HELI|PARAMEDIC/.test(mode) : null,
      age: Number.isFinite(ageRaw) ? ageRaw : null,
      sex: sexRaw.startsWith('F') ? 'F' : sexRaw.startsWith('M') ? 'M' : null,
    };
  });
  return { visits, columns, skipped, problems };
}

export interface VisitSummary {
  visits: number;
  days: number;
  arrivalsPerDay: number;
  lwbsRate: number | null;
  admissionRate: number | null;
  doorToProvider: { median: number | null; p90: number | null };
  lengthOfStay: { median: number | null; p90: number | null };
  lengthOfStayByAcuity: Record<string, number | null>;
  /** Admitted patients: decision to departure, hours (median and mean). */
  boardingHoursMedian: number | null;
  boardingHoursMean: number | null;
  femaleShare: number | null;
  ambulanceShare: number | null;
}

const quantile = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
};
const share = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : null);

function boardingHours(admitted: readonly Visit[]): number[] {
  return admitted.filter((v) => v.toDecision !== null && v.lengthOfStay !== null).map((v) => (v.lengthOfStay! - v.toDecision!) / 60);
}

/** Outcomes the simulation should reproduce (compare with its metrics). */
export function summarizeVisits(visits: readonly Visit[]): VisitSummary {
  const days = Math.max(1, Math.ceil((Math.max(...visits.map((v) => v.arrival)) + 1) / 1440));
  const known = visits.filter((v) => v.disposition !== 'other');
  const notLwbs = visits.filter((v) => v.disposition !== 'lwbs');
  const nums = (f: (v: Visit) => number | null, vs: readonly Visit[] = visits) => vs.map(f).filter((x): x is number => x !== null);
  const admitted = visits.filter((v) => v.disposition === 'admitted');
  return {
    visits: visits.length,
    days,
    arrivalsPerDay: visits.length / days,
    lwbsRate: share(known.map((v) => v.disposition === 'lwbs')),
    admissionRate: share(known.map((v) => v.disposition === 'admitted')),
    doorToProvider: { median: quantile(nums((v) => v.toProvider), 0.5), p90: quantile(nums((v) => v.toProvider), 0.9) },
    lengthOfStay: { median: quantile(nums((v) => v.lengthOfStay, notLwbs), 0.5), p90: quantile(nums((v) => v.lengthOfStay, notLwbs), 0.9) },
    lengthOfStayByAcuity: Object.fromEntries(
      [1, 2, 3, 4, 5].map((a) => [
        String(a),
        quantile(
          nums((v) => v.lengthOfStay, notLwbs.filter((v) => v.acuity === a)),
          0.5,
        ),
      ]),
    ),
    boardingHoursMedian: quantile(boardingHours(admitted), 0.5),
    boardingHoursMean: (() => {
      const b = boardingHours(admitted);
      return b.length ? b.reduce((x, y) => x + y, 0) / b.length : null;
    })(),
    femaleShare: share(visits.filter((v) => v.sex).map((v) => v.sex === 'F')),
    ambulanceShare: share(visits.filter((v) => v.byAmbulance !== null).map((v) => v.byAmbulance!)),
  };
}

/** Config fragment fitted from visits: arrival pattern, acuity mix, admission and ambulance shares by acuity. */
export function fitVisits(visits: readonly Visit[]): { fragment: Partial<SimConfig>; notes: string[] } {
  const notes: string[] = [];
  const s = summarizeVisits(visits);
  // Arrivals by hour (all-days average), with weekday multipliers.
  const perDay = new Map<number, number>();
  for (const v of visits) perDay.set(Math.floor(v.arrival / 1440), (perDay.get(Math.floor(v.arrival / 1440)) ?? 0) + 1);
  const byHour = Array<number>(24).fill(0);
  for (const v of visits) byHour[Math.floor(v.hour)]!++;
  const dowCounts: number[][] = Array.from({ length: 7 }, () => []);
  for (let d = 0; d < s.days; d++) {
    // Day 0 is the first arrival's day.
    dowCounts[(visits[0]!.dayOfWeek + d) % 7]!.push(perDay.get(d) ?? 0);
  }
  const overall = s.arrivalsPerDay;
  const dow = dowCounts.map((c) => (c.length && overall > 0 ? round(c.reduce((a, b) => a + b, 0) / c.length / overall, 4) : 1));
  const meanMult = dow.reduce((a, b) => a + b, 0) / 7;
  const hourlyRates = byHour.map((n) => round(n / s.days / meanMult, 4));
  if (s.days < 28) notes.push(`Only ${s.days} days of data: hourly and weekday patterns will be noisy (8+ weeks is better).`);

  const triaged = visits.filter((v) => v.acuity !== null);
  const fragment: Record<string, unknown> = { arrivals: { hourlyRates, dayOfWeekMultipliers: dow } as Record<string, unknown> };
  const arrivals = fragment.arrivals as Record<string, unknown>;
  if (triaged.length) {
    arrivals.acuityMix = Object.fromEntries([1, 2, 3, 4, 5].map((a) => [String(a), round(triaged.filter((v) => v.acuity === a).length / triaged.length, 4)]));
    const byAcuity = (a: number) => triaged.filter((v) => v.acuity === a);
    const admit: Record<string, number> = {};
    for (const a of [1, 2, 3, 4, 5]) {
      const g = byAcuity(a).filter((v) => v.disposition !== 'other' && v.disposition !== 'lwbs');
      if (g.length >= 5) admit[String(a)] = round(g.filter((v) => v.disposition === 'admitted').length / g.length, 4);
    }
    if (Object.keys(admit).length) fragment.disposition = { admitProbabilityByAcuity: admit };
    const amb: Record<string, number> = {};
    for (const a of [1, 2, 3, 4, 5]) {
      const g = byAcuity(a).filter((v) => v.byAmbulance !== null);
      if (g.length >= 5) amb[String(a)] = round(g.filter((v) => v.byAmbulance).length / g.length, 4);
    }
    if (Object.keys(amb).length) arrivals.ambulanceShareByAcuity = amb;
  } else notes.push('No acuity column: the acuity mix, admission and ambulance shares keep their defaults.');
  if (triaged.length < visits.length * 0.9 && triaged.length) notes.push(`${visits.length - triaged.length} visits have no acuity and were left out of the acuity fits.`);
  return { fragment: fragment as never, notes };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

const pad = (n: number) => String(n).padStart(2, '0');
function stamp(minutes: number): string {
  const d = new Date(minutes * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * Visits from a simulation run, in the export format (for examples and round-trip tests).
 * `startDate` sets the calendar (default Monday 2024-01-01 00:00, matching startDayOfWeek 0).
 */
export function visitsCsv(patients: readonly Patient[], opts: { startDayOfWeek?: number; startHour?: number; startDate?: string; fromMinute?: number } = {}): string {
  const base = parseTime(opts.startDate ?? '2024-01-01 00:00')! + ((opts.startDayOfWeek ?? 0) * 24 + (opts.startHour ?? 0)) * 60;
  const t = (x: number | undefined) => (x === undefined ? '' : stamp(base + x));
  const rows = ['visit_id,arrival_time,triage_time,provider_time,decision_time,departure_time,acuity,disposition,arrival_mode,age,sex'];
  for (const p of patients) {
    if (p.departureTime === undefined || p.arrivalTime < (opts.fromMinute ?? 0)) continue;
    const dispo = p.outcome === 'lwbs' ? 'LEFT WITHOUT BEING SEEN' : p.outcome === 'admitted' ? 'ADMITTED' : 'HOME';
    rows.push(
      [
        p.id + 1,
        t(p.arrivalTime),
        t(p.triageEndTime),
        t(p.doctorStartTime),
        t(p.dispositionTime),
        t(p.departureTime),
        p.triageAssigned ?? '',
        dispo,
        p.byAmbulance ? 'AMBULANCE' : 'WALK IN',
        p.profile.age,
        p.profile.sex,
      ].join(','),
    );
  }
  return rows.join('\n') + '\n';
}

/**
 * Visits from simulated patients (arrivals from `fromMinute`), so model output can be summarised with
 * exactly the same definitions as the hospital's data. Patients still in the department at the end
 * have no length of stay, like an export taken mid-shift.
 */
export function visitsFromPatients(patients: readonly Patient[], opts: { fromMinute?: number; startDayOfWeek?: number; startHour?: number } = {}): Visit[] {
  const from = opts.fromMinute ?? 0;
  const offset = ((opts.startDayOfWeek ?? 0) * 24 + (opts.startHour ?? 0)) * 60;
  const since = (x: number | undefined, t: number) => (x === undefined ? null : x - t);
  return patients
    // Return visits are ordinary visits in a hospital's records, so they are included.
    .filter((p) => p.arrivalTime >= from)
    .map((p) => {
      const abs = offset + p.arrivalTime;
      return {
        arrival: p.arrivalTime - from,
        dayOfWeek: Math.floor(abs / 1440) % 7,
        hour: (abs % 1440) / 60,
        acuity: p.triageAssigned ?? null,
        toTriage: since(p.triageEndTime, p.arrivalTime),
        toProvider: since(p.doctorStartTime, p.arrivalTime),
        toDecision: since(p.dispositionTime, p.arrivalTime),
        lengthOfStay: since(p.departureTime, p.arrivalTime),
        disposition: p.outcome === 'lwbs' ? 'lwbs' : p.outcome === 'admitted' ? 'admitted' : p.outcome === 'discharged' ? 'discharged' : 'other',
        byAmbulance: p.byAmbulance === true,
        age: p.profile.age,
        sex: p.profile.sex,
      };
    });
}

/** Defaults the fit leaves alone, for display. */
export const FIT_DEFAULTS = { acuityMix: PARAMS.acuity.mix };
