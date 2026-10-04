import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { openData } from '../src/opendata';
import { parseArgs } from '../src/cli';

const root = resolve(import.meta.dirname, '../../..');
const base = JSON.parse(readFileSync(resolve(root, 'configs/planner/example-baseline.json'), 'utf8'));

/** Synthetic files in MIMIC-IV-ED's format (not real data), with per-patient shifted dates. */
function writeFakeMimic(dir: string, n: number) {
  const ed = ['subject_id,hadm_id,stay_id,intime,outtime,gender,race,arrival_transport,disposition'];
  const tri = ['subject_id,stay_id,acuity,chiefcomplaint'];
  const pad = (x: number) => String(x).padStart(2, '0');
  const stamp = (ms: number) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
  };
  for (let i = 0; i < n; i++) {
    const hour = [3, 9, 11, 13, 15, 17, 19, 21][i % 8]!;
    const t = Date.UTC(2110 + (i % 97), (i * 5) % 12, 1 + ((i * 7) % 28), hour, (i * 13) % 60);
    const acuity = [3, 2, 3, 4, 3, 2, 5, 3, 1, 4][i % 10]!;
    const los = [400, 330, 260, 160, 120][acuity - 1]! + ((i * 37) % 90);
    ed.push(`${i},,${10 + i},${stamp(t)},${stamp(t + los * 60000)},${i % 2 ? 'F' : 'M'},X,${acuity <= 2 ? 'AMBULANCE' : 'WALK IN'},${acuity <= 2 && i % 3 ? 'ADMITTED' : 'HOME'}`);
    tri.push(`${i},${10 + i},${acuity},"pain, chest"`);
  }
  writeFileSync(join(dir, 'edstays.csv.gz'), gzipSync(ed.join('\n')));
  writeFileSync(join(dir, 'triage.csv.gz'), gzipSync(tri.join('\n')));
}

describe('open-data command', () => {
  it('parses its options', () => {
    const a = parseArgs(['open-data', '--source', 'mimic-ed-demo', '--fetch', '--visits-per-day', '80']);
    expect(a).toMatchObject({ command: 'open-data', source: 'mimic-ed-demo', fetch: true, visitsPerDay: 80, config: 'configs/planner/example-baseline.json' });
    expect(() => parseArgs(['open-data'])).toThrow(/--source/);
  });

  it('says what to do when the files are missing, without downloading unless asked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'er-open-'));
    const r = openData({ cwd: root, config: base, source: 'mimic-ed-demo', dir, fetch: false, seeds: [1] });
    expect(r.result).toBeNull();
    expect(r.log[0]).toMatch(/--fetch/);
    const full = openData({ cwd: root, config: base, source: 'mimic-ed', dir, fetch: true, seeds: [1] });
    expect(full.log[0]).toMatch(/credentialed/);
  });

  it('fits the model to MIMIC-format files and cites the source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'er-open-'));
    writeFakeMimic(dir, 1400);
    const r = openData({ cwd: root, config: base, source: 'mimic-ed-demo', dir, fetch: false, visitsPerDay: 90, seeds: [1, 2] });
    expect(r.result).not.toBeNull();
    const res = r.result!;
    expect(res.source.citation).toMatch(/MIMIC-IV-ED/);
    expect(res.visitsUsed).toBe(1400);
    expect(res.visitsPerDay).toBe(90);
    expect(res.data.arrivalsPerDay).toBeCloseTo(90, -1);
    expect(res.fitted['arrivals.acuityMix']).toBeDefined();
    expect(res.fitted['disposition.admitProbabilityByAcuity']).toBeDefined();
    expect(res.notes.some((n) => /not from the data/.test(n))).toBe(true);
    expect(res.check.find((c) => c.key === 'los')?.status).toBe('close');
  }, 120_000);
});
