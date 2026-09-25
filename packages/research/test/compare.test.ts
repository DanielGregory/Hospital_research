import { describe, expect, it } from 'vitest';
import base from '../../../configs/planner/example-baseline.json';
import { compareScenarios, difference, range, t95 } from '../src/index.js';

const short = { ...base, durationMinutes: 2 * 1440, warmupMinutes: 360 };

describe('scenario comparison', () => {
  const scenarios = [
    { id: 'same', name: 'No change', settings: {} },
    { id: 'more', name: 'Two more doctors all day', settings: { 'staffing.schedule.doctor': [...base.staffing.schedule.doctor, { startHour: 0, hours: 24, count: 2 }] } },
    { id: 'bad', name: 'Invalid', settings: { 'beds.main': -1 } },
  ];
  const c = compareScenarios(short, scenarios, { seeds: [1, 2, 3, 4, 5, 6] });

  it('is deterministic', () => {
    expect(JSON.stringify(compareScenarios(short, scenarios, { seeds: [1, 2, 3, 4, 5, 6] }))).toBe(JSON.stringify(c));
  });

  it('the unchanged scenario matches the baseline exactly (common random numbers)', () => {
    const same = c.scenarios[0]!;
    expect(same.values).toEqual(c.baseline.values);
    expect(same.diff!.d2dMedian!.mean).toBe(0);
    expect(same.diff!.d2dMedian!.ciLo).toBe(0);
  });

  it('more doctors: shorter waits, with an interval that excludes no change', () => {
    const d = c.scenarios[1]!.diff!.d2dMedian!;
    expect(d.mean!).toBeLessThan(0);
    expect(d.ciHi!).toBeLessThan(0);
    expect(d.betterShare!).toBeGreaterThan(0.8);
    expect(c.scenarios[1]!.diff!.costPerDay!.mean!).toBeGreaterThan(0);
  });

  it('reports why a scenario could not run', () => {
    const bad = c.scenarios[2]!;
    expect(bad.problems.length).toBeGreaterThan(0);
    expect(bad.diff).toBeUndefined();
  });
});

describe('statistics', () => {
  it('ranges ignore missing values', () => {
    expect(range([null, 1, 2, 3, null])).toMatchObject({ n: 3, median: 2, mean: 2 });
    expect(range([null]).median).toBeNull();
  });
  it('differences are paired and use the t distribution', () => {
    const d = difference([2, 3, 4, 5], [1, 1, 1, 1], 'lower');
    expect(d.mean).toBe(2.5);
    expect(d.ciHi! - d.mean!).toBeCloseTo(t95(3) * (Math.sqrt(5 / 3) / 2), 6);
    expect(d.betterShare).toBe(0);
    expect(t95(1000)).toBe(1.96);
  });
});
