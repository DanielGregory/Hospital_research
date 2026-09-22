import { Simulation } from '@er/sim';
import { describe, expect, it } from 'vitest';
import level5 from '../../../configs/levels/level-05-boarding-crisis.json';
import { escalateWhenBoarding, evaluate, optimize, runWithPolicy, Session, staticPolicy, surgeStaffing } from '../src/index.js';

const busyWeek = { id: 'r', durationMinutes: 4 * 1440, warmupMinutes: 1440, staffing: { doctors: 2 }, arrivals: { rateMultiplier: 1.1 } };

describe('baseline policies', () => {
  it('static policy equals a plain run', () => {
    expect(JSON.stringify(runWithPolicy(busyWeek, 1, staticPolicy).metrics)).toBe(JSON.stringify(new Simulation(busyWeek, 1).run().metrics));
  });

  it('surge staffing calls doctors in when it gets busy, and it helps', () => {
    const r = runWithPolicy(busyWeek, 1, surgeStaffing({ callAt: 3, max: 6 }));
    expect(r.commandLog.some((c) => c.command.type === 'setStaff')).toBe(true);
    expect(r.metrics.lwbsRate).toBeLessThan(new Simulation(busyWeek, 1).run().metrics.lwbsRate / 2);
    // Policies are just commands: the log replays exactly.
    expect(JSON.stringify(new Simulation({ ...busyWeek, commands: r.commandLog }, 1).run().metrics)).toBe(JSON.stringify(r.metrics));
  });

  it('escalating on boarders shortens boarding in the boarding crisis', () => {
    const a = runWithPolicy(level5, 3, staticPolicy).metrics;
    const b = runWithPolicy(level5, 3, escalateWhenBoarding({ declareAt: 2 })).metrics;
    expect(b.boarding.meanHours!).toBeLessThan(a.boarding.meanHours!);
    expect(b.cost.escalation).toBeGreaterThan(0);
  });
});

describe('optimizer', () => {
  const base = {
    id: 'o',
    durationMinutes: 3 * 1440,
    warmupMinutes: 1440,
    modules: { budget: true },
    budget: { capPerDay: 20000 },
    staffing: { doctors: 2 },
  };
  const space = {
    dims: [
      { path: 'staffing.doctors', values: [1, 2, 3, 4, 5, 6] },
      { path: 'beds.main', values: [8, 12, 16, 20, 24] },
    ],
  };

  it('marks setups over budget as infeasible', () => {
    const c = evaluate(base, { 'staffing.doctors': 6, 'beds.main': 24 }, [1]);
    expect(c.value).toBe(-Infinity);
    expect(c.problems[0]).toMatch(/budget/);
  });

  it('finds a better feasible setup than the start, deterministically', () => {
    const run = () => optimize({ base, space, seeds: [1, 2], iterations: 40, searchSeed: 7 });
    const r = run();
    expect(r.bestFound.value).toBeGreaterThan(r.start.value + 5);
    expect(r.bestFound.problems).toEqual([]);
    expect(Number(r.bestFound.settings['staffing.doctors'])).toBeGreaterThan(2);
    expect(JSON.stringify(run())).toBe(JSON.stringify(r));
    expect(r.evaluations).toBeLessThanOrEqual(30);
  });

  it('can minimise a metric', () => {
    const r = optimize({ base, space: { dims: [space.dims[0]!] }, objective: { metric: 'doorToDoctor.mean', direction: 'min' }, seeds: [1], iterations: 15 });
    expect(r.bestFound.value).toBeLessThan(r.start.value);
  });
});

describe('stdio session', () => {
  it('resets, steps with commands, reports metrics, and rejects bad input', () => {
    const s = new Session();
    expect(s.handle({ op: 'step' })).toMatchObject({ ok: false, error: /reset first/ });
    const r = s.handle({ op: 'reset', config: { id: 's', durationMinutes: 600 }, seed: 2 }) as { ok: boolean; obs: { now: number } };
    expect(r.ok).toBe(true);
    expect(r.obs.now).toBe(0);
    const st = s.handle({ op: 'step', commands: [{ type: 'setStaff', role: 'doctor', count: 6 }], minutes: 240 }) as { obs: { now: number; staff: Record<string, { onDuty: number }> }; done: boolean };
    expect(st.obs.now).toBe(240);
    expect(st.obs.staff.doctor!.onDuty).toBe(6);
    expect(st.done).toBe(false);
    const end = s.handle({ op: 'step', minutes: 1000 }) as { done: boolean };
    expect(end.done).toBe(true);
    expect((s.handle({ op: 'metrics' }) as { metrics: { arrivals: number } }).metrics.arrivals).toBeGreaterThan(0);
    expect(s.handle({ op: 'step', commands: [{ type: 'nope' }] })).toMatchObject({ ok: false });
    expect(s.handle({ op: 'fly' })).toMatchObject({ ok: false, error: /unknown op/ });
  });
});
