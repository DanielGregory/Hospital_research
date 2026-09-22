import { describe, expect, it } from 'vitest';
import level2 from '../../../configs/levels/level-02-monday-morning.json';
import level3 from '../../../configs/levels/level-03-fast-track.json';
import level4 from '../../../configs/levels/level-04-flu-season.json';
import { resolveConfig, validateConfig } from '../src/config.js';
import { Simulation } from '../src/engine.js';
import { checkLimits, evaluateGoals, getMetric, staffingSummary } from '../src/levels.js';
import { REFERENCE_SOLUTIONS, withSettings } from './levelBalance.js';

const LEVELS = [level2, level3, level4] as const;

describe('goal evaluation', () => {
  const metrics = new Simulation({ id: 'x', durationMinutes: 600 }, 1).run().metrics;

  it('reads dot paths', () => {
    expect(getMetric(metrics, 'doorToDoctor.median')).toBe(metrics.doorToDoctor.median);
    expect(getMetric(metrics, 'lwbsRate')).toBe(metrics.lwbsRate);
    expect(getMetric(metrics, 'nope.nothing')).toBeUndefined();
    expect(getMetric(metrics, 'doorToDoctor')).toBeUndefined(); // not a number
  });

  it('applies max/min, flags unknown metrics, and handles missing data', () => {
    const r = evaluateGoals(metrics, [
      { metric: 'lwbsRate', max: 1, label: 'a' },
      { metric: 'arrivals', min: 1e9, label: 'b' },
      { metric: 'typo', max: 1, label: 'c' },
    ]);
    expect(r.results.map((x) => x.passed)).toEqual([true, false, false]);
    expect(r.results[2]!.error).toMatch(/unknown metric/);
    expect(r.passed).toBe(false);
    const empty = new Simulation({ id: 'x', durationMinutes: 600, arrivals: { acuityMix: { '5': 1 } } }, 1).run().metrics;
    const g = { metric: 'doorToDoctorByGroup.urgent.median', max: 10, label: 'u' };
    expect(evaluateGoals(empty, [g]).passed).toBe(false);
    expect(evaluateGoals(empty, [{ ...g, passIfNoData: true }]).passed).toBe(true);
  });

  it('rejects malformed level blocks', () => {
    expect(() => validateConfig({ id: 'x', level: { number: 1, title: 't', briefing: [], debrief: { pass: [], fail: [] }, goals: [{ metric: 'a', label: 'b' }], playerControls: ['teleport'] } })).toThrow(
      /needs max or min[\s\S]*unknown control/,
    );
  });
});

describe('limits', () => {
  it('sums staff-hours and peak on-duty from schedules', () => {
    const c = resolveConfig({
      id: 'x',
      modules: { staffing: true },
      staffing: { schedule: { doctor: [{ startHour: 8, hours: 12, count: 3 }, { startHour: 20, hours: 12, count: 1 }, { startHour: 10, hours: 8, count: 1, days: [0] }] } },
      level: { number: 1, title: 't', briefing: [], debrief: { pass: [], fail: [] }, goals: [], playerControls: [], limits: { staffHoursPerDay: { doctor: 48 }, maxOnDuty: { doctor: 3 } } },
    });
    const s = staffingSummary(c).doctor;
    expect(s.hoursPerDay).toBeCloseTo(48 + 8 / 7);
    expect(s.maxOnDuty).toBe(4);
    expect(checkLimits(c)).toHaveLength(2);
  });
});

describe.each(LEVELS.map((l) => [l.id, l] as const))('%s', (id, level) => {
  const goals = level.level.goals;
  const ref = withSettings(level, REFERENCE_SOLUTIONS[id]!);
  const seed = level.level.seed;

  it('is valid, within its limits, and every goal metric exists', () => {
    const c = resolveConfig(level);
    expect(checkLimits(c)).toEqual([]);
    expect(checkLimits(resolveConfig(ref))).toEqual([]);
    const m = new Simulation(level, seed).run().metrics;
    for (const g of goals) expect(getMetric(m, g.metric), g.metric).not.toBeUndefined();
  });

  it('the shipped setup fails and the reference solution passes on the level seed', () => {
    expect(evaluateGoals(new Simulation(level, seed).run().metrics, goals).passed).toBe(false);
    expect(evaluateGoals(new Simulation(ref, seed).run().metrics, goals).passed).toBe(true);
  });

  it('the reference beats the shipped setup across other days too', () => {
    const seeds = Array.from({ length: 12 }, (_, i) => 100 + i);
    const rate = (cfg: unknown) => seeds.filter((s) => evaluateGoals(new Simulation(cfg, s).run().metrics, goals).passed).length / seeds.length;
    expect(rate(ref) - rate(level)).toBeGreaterThanOrEqual(0.25);
  });
});
