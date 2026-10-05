/**
 * `open-data`: fit the model to an open ED dataset. Downloads the open files when asked (with curl,
 * so the environment's proxy settings apply), reads them from a data folder, joins and reshapes
 * them (`@er/sim` opendata), then runs the same fit and model-vs-data check as `fit-visits`.
 * Raw data stays in `data/open/` (git-ignored); only the fitted settings and the check are written.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { baselineCheck, calibrate, type CheckRow } from '@er/research';
import { inflateRawSync } from 'node:zlib';
import { applySettings, Simulation, parseCmsTimelyCare, mimicEdVisits, nhamcsVisits, OPEN_SOURCES, parseNhamcs, resolveConfig, restackVisits, summarizeNhamcs, summarizeVisits, type NhamcsSummary, type NhamcsVisit, type OpenSource, type Visit, type VisitSummary } from '@er/sim';

export interface OpenDataResult {
  source: { id: string; name: string; page: string; license: string; citation: string; caveat?: string };
  retrieved: string;
  stays: number;
  visitsUsed: number;
  withAcuity: number;
  /** Visits per day used to lay out the shifted dates (not from the data). */
  visitsPerDay: number | null;
  data: VisitSummary;
  fitted: Record<string, unknown>;
  notes: string[];
  check: CheckRow[];
  /** National estimates from the survey weights (NHAMCS only). */
  national?: NhamcsSummary;
  /** More national checks (NHAMCS only): waits and tests by level, returns within 72 hours. */
  nationalCheck?: { label: string; data: number | null; model: number | null; unit: 'min' | 'share'; note?: string }[];
  /** The department gridlocked at this volume, so only the case mix was fitted. */
  overloaded: boolean;
}

/** The first file in a zip archive (stored or deflated), read from its central directory. */
export function unzipFirst(zip: Buffer): Buffer {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const cd = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(cd) !== 0x02014b50) throw new Error('zip: no central directory');
  const method = zip.readUInt16LE(cd + 10);
  const size = zip.readUInt32LE(cd + 20);
  const local = zip.readUInt32LE(cd + 42);
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const data = zip.subarray(start, start + size);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return inflateRawSync(data);
  throw new Error(`zip: compression method ${method} not supported`);
}

const read = (path: string) => {
  const buf = readFileSync(path);
  // NHAMCS files are plain ASCII; latin1 keeps every byte position.
  return path.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : path.endsWith('.zip') ? unzipFirst(buf).toString('latin1') : buf.toString('utf8');
};

/** Read a source's files into visits (arrival times still to be laid out). */
function loadVisits(src: OpenSource, dir: string): { visits: Visit[]; problems: string[]; described: string; national?: NhamcsSummary } {
  const files = src.files.map((f) => read(resolve(dir, f.name)));
  if (src.format === 'nhamcs-ed') {
    const years = src.years ?? [];
    const all: NhamcsVisit[] = [];
    const problems: string[] = [];
    years.forEach((y, i) => {
      const parsed = parseNhamcs(files[i]!, y);
      problems.push(...parsed.problems.map((p) => `${y}: ${p}`));
      // Average over the years: each year's weights stand for that year's visits.
      for (const v of parsed.visits) all.push({ ...v, weight: v.weight / years.length });
    });
    const national = summarizeNhamcs(all);
    return {
      visits: nhamcsVisits(all),
      problems,
      national,
      described: `${src.name}: ${all.length} sampled visits standing for ${(national.weightedVisits / 1e6).toFixed(1)} million US ED visits a year; drawn by weight`,
    };
  }
  const j = mimicEdVisits(files[0]!, files[1]!);
  return { visits: j.visits, problems: j.problems, described: `${src.name}: ${j.stays} stays, ${j.withAcuity} with a triage acuity` };
}

/** Download one file with curl; returns an error message naming the host when it fails. */
function download(url: string, to: string): string | null {
  // Into a .part file first, so a failed download never looks like data.
  const part = `${to}.part`;
  const r = spawnSync('curl', ['-fsSL', '--max-time', '300', '-o', part, url], { encoding: 'utf8' });
  if (r.error) return `curl is not available: ${r.error.message}`;
  if (r.status === 0) {
    renameSync(part, to);
    return null;
  }
  rmSync(part, { force: true });
  const host = new URL(url).host;
  const blocked = /403|CONNECT tunnel failed/.test(r.stderr ?? '');
  return blocked
    ? `${host} is blocked by this environment's network policy. Allow it (environment settings → Network access → add ${host}), or download ${url} yourself and put it in the data folder.`
    : `Download failed for ${url}: ${(r.stderr ?? '').trim() || `curl exit ${r.status}`}`;
}

export function openData(o: {
  cwd: string;
  config: unknown;
  source: string;
  dir?: string;
  fetch: boolean;
  visitsPerDay?: number;
  seeds: number[];
}): { log: string[]; result: OpenDataResult | null; extract?: CompactCms } {
  const log: string[] = [];
  const src = OPEN_SOURCES[o.source];
  if (!src) return { log: [`Unknown source '${o.source}' (one of: ${Object.keys(OPEN_SOURCES).join(', ')})`], result: null };
  const dir = resolve(o.cwd, o.dir ?? `data/open/${src.id}`);
  mkdirSync(dir, { recursive: true });

  for (const f of src.files) {
    const path = resolve(dir, f.name);
    if (existsSync(path)) continue;
    if (!o.fetch || !src.open) {
      log.push(
        src.open
          ? `Missing ${path}. Run again with --fetch to download it from ${f.url}, or put the file there yourself.`
          : `Missing ${path}. ${src.name} needs a PhysioNet account with credentialed access: sign in at ${src.page}, download ${f.name}, and put it there.`,
      );
      return { log, result: null };
    }
    let url = f.url;
    if (src.format === 'cms-hospitals') {
      // The metadata names the current CSV.
      const meta = resolve(dir, 'metadata.json');
      const e = download(url, meta);
      if (e) return { log: [...log, e], result: null };
      url = (JSON.parse(readFileSync(meta, 'utf8')) as { distribution: { downloadURL: string }[] }).distribution[0]!.downloadURL;
    }
    log.push(`Downloading ${url}`);
    const err = download(url, path);
    if (err) return { log: [...log, err], result: null };
  }
  if (src.format === 'cms-hospitals') return { log, result: null, extract: cmsExtract(readFileSync(resolve(dir, src.files[0]!.name), 'utf8')) };

  const loaded = loadVisits(src, dir);
  log.push(...loaded.problems);
  if (!loaded.visits.length) return { log: [...log, 'No usable visits.'], result: null };

  // No shared calendar (shifted dates, or a sample across many EDs): lay the visits out at a daily volume we choose.
  const visitsPerDay = src.shiftedDates ? (o.visitsPerDay ?? Math.round(resolveConfig(o.config).hourlyRates.reduce((s: number, r: number) => s + r, 0))) : null;
  const visits = visitsPerDay ? restackVisits(loaded.visits, visitsPerDay) : loaded.visits;
  const data = summarizeVisits(visits);
  log.push(`${loaded.described}${visitsPerDay ? `; laid out at ${visitsPerDay} visits a day (set with --visits-per-day).` : '.'}`);
  // Fit on the same weeks as the check: near full wards, boarding swings a lot from week to week.
  let cal = calibrate(o.config, visits, data, { seeds: o.seeds });
  let check = baselineCheck(cal.config, data, o.seeds);
  // A department that cannot carry this case mix at this volume gridlocks: time fits would be nonsense.
  const los = check.find((c) => c.key === 'los');
  const overloaded = los?.data != null && los.model.median != null && los.model.median > 3 * los.data;
  if (overloaded) {
    cal = calibrate(o.config, visits, data, { seeds: o.seeds, fitLengthOfStay: false });
    check = baselineCheck(cal.config, data, o.seeds);
  }
  // Which inpatient unit admitted patients need, by acuity (NHAMCS records it).
  if (loaded.national) cal.fitted['boarding.unitShareByAcuity'] = loaded.national.unitShareByAcuity;
  const notes = [...(src.caveat ? [`Not representative: ${src.caveat}`] : []), ...cal.notes];
  if (overloaded)
    notes.push(
      `The department in --config cannot carry this case mix at ${visitsPerDay ?? Math.round(data.arrivalsPerDay)} visits a day: in the model, patients pile up (median stay ${Math.round(los!.model.median! / 60)} h against ${Math.round(los!.data! / 60)} h in the data). Only the case mix was fitted; times were not. Use a lower --visits-per-day or a bigger department.`,
    );
  if (visits.length > loaded.visits.length) notes.push(`The ${loaded.visits.length} visits were reused in turn to fill a week at ${visitsPerDay} a day.`);
  if (visitsPerDay)
    notes.push(
      `Volume (${visitsPerDay} a day) is a setting, not from the data: ${src.format === 'nhamcs-ed' ? 'NHAMCS samples visits across many EDs and days' : `${src.name} shifts each patient's dates`}, so one department's daily volume and crowding are not in it.`,
    );
  if (loaded.visits.length < 1000)
    notes.push(`Only ${loaded.visits.length} visits: shares by acuity and hourly patterns are rough. The full dataset (credentialed) has several hundred thousand.`);
  if (data.doorToProvider.median === null) notes.push('No provider-seen time in this dataset: door to provider is not checked against data.');
  for (const n of notes) log.push(`note: ${n}`);
  for (const r of check) log.push(`${r.status.padEnd(8)} ${r.label.padEnd(42)} data ${fmt(r.data)}  model ${fmt(r.model.median)}`);
  return {
    log,
    result: {
      source: { id: src.id, name: src.name, page: src.page, license: src.license, citation: src.citation, ...(src.caveat ? { caveat: src.caveat } : {}) },
      retrieved: new Date().toISOString().slice(0, 10),
      stays: loaded.national?.records ?? loaded.visits.length,
      visitsUsed: loaded.visits.length,
      withAcuity: loaded.visits.filter((v) => v.acuity !== null).length,
      visitsPerDay,
      data,
      fitted: cal.fitted,
      notes,
      check,
      overloaded,
      ...(loaded.national ? { national: loaded.national, nationalCheck: nationalChecks(cal.config, loaded.national, o.seeds.slice(0, 3)) } : {}),
    },
  };
}

/**
 * Model against national figures the visit check does not cover: wait to provider by triage level,
 * share of visits with each kind of test (labs and imaging module on), and visits that are returns
 * within 72 hours (diagnosis module on).
 */
export function nationalChecks(config: unknown, n: NhamcsSummary, seeds: number[]): NonNullable<OpenDataResult['nationalCheck']> {
  // Waits on the department as fitted; tests and returns with the labs-and-imaging and missed-diagnosis models on.
  const runAll = (c: object) =>
    seeds.map((s) => {
      const sim = new Simulation(c, s);
      return { m: sim.run().metrics, ps: sim.allPatients().filter((p) => p.arrivalTime >= (sim.config.warmupMinutes ?? 0)) };
    });
  const asFitted = runAll(config as object);
  const runs = runAll(applySettings(config as object, { 'modules.diagnostics': true, 'modules.diagnosis': true }));
  const avg = (f: (r: (typeof runs)[number]) => number | null, rs = runs) => {
    const xs = rs.map(f).filter((x): x is number => x !== null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const rows: NonNullable<OpenDataResult['nationalCheck']> = [];
  for (const a of ['1', '2', '3', '4', '5'] as const)
    rows.push({ label: `Wait to provider, ESI ${a}, median`, data: n.waitMedianByAcuity[a] ?? null, model: avg((r) => r.m.doorToDoctorByAcuity[a].median, asFitted), unit: 'min' });
  const SV = { lab: 'Lab test', xray: 'X-ray', ct: 'CT', ultrasound: 'Ultrasound' } as const;
  for (const sv of Object.keys(SV) as (keyof typeof SV)[])
    rows.push({ label: `Visits with ${SV[sv].toLowerCase().replace('ct', 'CT').replace('x-ray', 'X-ray')}`, data: n.tests[sv], model: avg((r) => (r.ps.length ? r.ps.filter((p) => p.orders?.some((o) => o.service === sv)).length / r.ps.length : null)), unit: 'share' });
  rows.push({
    label: 'Visits that are returns within 72 hours',
    data: n.seen72Rate,
    model: avg((r) => (r.ps.length ? r.ps.filter((p) => p.source === 'bounceBack').length / r.ps.length : null)),
    unit: 'share',
    note: 'National returns are for any reason; the model only returns patients whose problem was missed, so it should sit below this.',
  });
  return rows;
}

/** Hospital ED measures as compact rows (the app loads this on demand). */
export interface CompactCms {
  source: string;
  periods: Record<string, string>;
  retrieved: string;
  columns: string[];
  rows: (string | number | null)[][];
}

const CMS_COLUMNS = ['id', 'name', 'city', 'state', 'volumeBand', 'medianMinutesDischarged', 'medianMinutesAll', 'medianMinutesPsych', 'medianMinutesTransfer', 'lwbsRate', 'visitsPerYear'] as const;

export function cmsExtract(csv: string): CompactCms {
  const x = parseCmsTimelyCare(csv);
  return {
    source: x.source,
    periods: x.periods,
    retrieved: new Date().toISOString().slice(0, 10),
    columns: [...CMS_COLUMNS],
    rows: x.hospitals.map((h) => CMS_COLUMNS.map((c) => h[c])),
  };
}

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Math.abs(v) < 1 ? v.toFixed(3) : v.toFixed(1));
