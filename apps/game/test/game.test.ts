import { Simulation } from '@er/sim';
import { describe, expect, it } from 'vitest';
import { buildConfig, initialValues, setupProblems } from '../src/controls';
import { clockLabel, metricValue } from '../src/format';
import { LEVELS } from '../src/levels';
import { layoutFloor } from '../src/render/floorPlan';
import { GameRunner, SIM_MINUTES_PER_SECOND } from '../src/runner';

describe('levels', () => {
  it('loads every story level in order', () => {
    expect(LEVELS.map((l) => l.level.number)).toEqual([...LEVELS.keys()].map((i) => i + 1));
    expect(LEVELS[0]!.level.title).toBe('Quiet Night');
  });
});

describe('setup controls', () => {
  const level2 = LEVELS.find((l) => l.level.number === 2)!;

  it('starts from the level config', () => {
    const v = initialValues(level2);
    expect(Object.keys(v)).toEqual(['staffing.schedule.doctor']);
    expect(v['staffing.schedule.doctor']).toEqual(level2.staffing!.schedule!.doctor);
    expect(setupProblems(level2, v)).toEqual([]);
  });

  it('flags setups over the limits and ignores locked settings', () => {
    const over = { 'staffing.schedule.doctor': [{ startHour: 0, hours: 24, count: 5 }] };
    expect(setupProblems(level2, over)[0]).toMatch(/exceeds/);
    const sneaky = { 'staffing.triageNurses': 9 } as never;
    expect(buildConfig(level2, sneaky).staffing!.triageNurses).toBe(1);
  });
});

describe('runner', () => {
  it('advances by real time × speed, not while paused, and caps long frames', () => {
    const r = new GameRunner(LEVELS[1]!, 1);
    for (let i = 0; i < 5; i++) r.advance(200);
    expect(r.sim.now).toBeCloseTo(SIM_MINUTES_PER_SECOND);
    r.speed = 8;
    r.advance(100);
    expect(r.sim.now).toBeCloseTo(SIM_MINUTES_PER_SECOND * 1.8);
    r.speed = 0;
    r.advance(200);
    expect(r.sim.now).toBeCloseTo(SIM_MINUTES_PER_SECOND * 1.8);
    r.speed = 1;
    r.advance(60_000); // tab was in the background: capped at 250 ms
    expect(r.sim.now).toBeCloseTo(SIM_MINUTES_PER_SECOND * 2.05);
  });

  it('a game played in real time matches a headless run of the same commands', () => {
    const level = LEVELS[0]!;
    const r = new GameRunner(level, 24);
    for (let i = 0; i < 20; i++) r.advance(50);
    r.command({ type: 'setQueueDiscipline', discipline: 'acuity' });
    r.skipToEnd();
    const replay = new Simulation({ ...level, commands: r.sim.commandLog() }, 24).run();
    expect(JSON.stringify(replay.metrics)).toBe(JSON.stringify(r.sim.metrics()));
  });
});

describe('floor plan', () => {
  it('places every patient and staff member inside the canvas', () => {
    const sim = new Simulation({ ...LEVELS[2]!, fastTrack: { enabled: true } }, 1);
    sim.runUntil(15 * 60);
    const s = sim.snapshot();
    const plan = layoutFloor(s, 800, 500, true);
    expect(plan.patients).toHaveLength(s.patients.length);
    expect(plan.staff).toHaveLength(s.staff.length);
    for (const p of [...plan.patients, ...plan.staff]) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(800);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(500);
    }
  });

  it('never shows the player true acuity', () => {
    const sim = new Simulation(LEVELS[1]!, 1);
    sim.runUntil(600);
    const plan = layoutFloor(sim.snapshot(), 800, 500, false);
    const byId = new Map(sim.snapshot().patients.map((p) => [p.id, p]));
    for (const d of plan.patients) expect(d.acuity).toBe(byId.get(d.id)!.assignedAcuity);
  });
});

describe('format', () => {
  it('labels clock and metrics', () => {
    expect(clockLabel(1, 23, 90)).toBe('Wednesday 00:30');
    expect(metricValue('lwbsRate', 0.034)).toBe('3.4%');
    expect(metricValue('doorToDoctor.median', 12.4)).toBe('12 min');
  });
});
