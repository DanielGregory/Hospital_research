import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { baselineCheck, calibrate } from '@er/research';
import { parseVisits, summarizeVisits } from '@er/sim';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const base = JSON.parse(readFileSync(resolve(root, 'configs/planner/example-baseline.json'), 'utf8'));

describe('calibration from the sample visit file', () => {
  // configs/planner/sample-visits.csv: synthetic records from a department that differs from the defaults
  // (busier evenings, sicker mix, slower results, wards near capacity). Regenerate with scripts/sample-visits.ts.
  const parsed = parseVisits(readFileSync(resolve(root, 'configs/planner/sample-visits.csv'), 'utf8'));
  const data = summarizeVisits(parsed.visits);

  it('reads the export format and recognises its columns', () => {
    expect(parsed.problems).toEqual([]);
    expect(parsed.columns.arrival).toBe('arrival_time');
    expect(parsed.columns.acuity).toBe('acuity');
    expect(parsed.visits.length).toBeGreaterThan(3000);
    expect(data.doorToProvider.median).not.toBeNull();
  });

  it('fitted from defaults, the model reproduces the department', () => {
    const cal = calibrate(base, parsed.visits, data, { seeds: [1, 2, 3] });
    const check = baselineCheck(cal.config, data, [1, 2, 3, 4, 5]);
    const get = (k: string) => check.find((r) => r.key === k)!;
    for (const k of ['arrivals', 'd2d', 'los', 'admitted', 'los3', 'los4', 'los5']) expect(get(k).status, k).toBe('close');
    expect(Math.abs(get('boarding').model.median! - data.boardingHoursMean!)).toBeLessThan(1);
    // Before calibration, the default model misses length of stay by more.
    const before = baselineCheck(base, data, [1, 2, 3, 4, 5]);
    expect(Math.abs(before.find((r) => r.key === 'los')!.gap!)).toBeGreaterThan(Math.abs(get('los').gap!));
    expect(cal.fitted['arrivals.acuityMix']).toBeDefined();
    expect(cal.fitted['boarding.inpatientStayHours']).toBeDefined();
  }, 120_000);
});
