import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fitToHospital, scaleDepartment } from '@er/research';
import { applySettings, resolveConfig, type SimConfig } from '@er/sim';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const base0 = JSON.parse(readFileSync(resolve(root, 'configs/planner/example-baseline.json'), 'utf8')) as SimConfig;
const national = JSON.parse(readFileSync(resolve(root, 'configs/calibration/nhamcs-2022.fitted.json'), 'utf8')) as { fitted: Record<string, unknown> };
const base = applySettings({ ...base0, beds: { main: 32 } }, national.fitted) as SimConfig;

describe('starting from a hospital’s published figures', () => {
  it('scales beds and shifts with volume, never below one per staffed shift', () => {
    const half = resolveConfig(scaleDepartment(base, 0.5));
    expect(half.beds.main).toBe(16);
    const tiny = scaleDepartment(base, 0.05).staffing!.schedule!.doctor!;
    expect(tiny.every((s) => s.count >= 1)).toBe(true);
  });

  it('matches visits a day, median time in the ED for patients sent home, and leaving unseen', () => {
    const f = fitToHospital(base, { visitsPerDay: 60, medianMinutesDischarged: 150, lwbsRate: 0.02 }, [1]);
    const [visits, los, lwbs] = f.check;
    expect(visits!.model!).toBeGreaterThan(55);
    expect(visits!.model!).toBeLessThan(65);
    expect(Math.abs(los!.model! - 150)).toBeLessThan(15);
    expect(Math.abs(lwbs!.model! - 0.02)).toBeLessThan(0.01);
    expect(f.notes[0]).toMatch(/estimate/);
  }, 120_000);
});
