import { beatsBenchmark, Simulation } from '@er/sim';
import { describe, expect, it } from 'vitest';
import level5 from '../../../configs/levels/level-05-boarding-crisis.json';
import { benchmarkLevel, escalateWhenBoarding, levelObjective, evaluate, optimize, runWithPolicy, Session, staticPolicy, surgeStaffing } from '../src/index.js';

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

describe('fit to aggregate targets', () => {
  it('recovers known admission, patience and workup scales from their aggregates', async () => {
    const { fitToTargets, defaultAdmitByAcuity } = await import('../src/calibrateTargets.js');
    const { PARAMS, applySettings } = await import('@er/sim');
    const base = { id: 'fit', durationMinutes: 10 * 1440, warmupMinutes: 1440, staffing: { doctors: 3 } };
    // "Truth": admission ×1.4, patience ×0.5, workup ×1.6. Measure its aggregates, then fit from scratch.
    const admit = defaultAdmitByAcuity();
    const truth = applySettings(base, {
      'disposition.admitProbabilityByAcuity': Object.fromEntries([1, 2, 3, 4, 5].map((a) => [`${a}`, Math.min(1, admit[a as 1] * 1.4)])),
      'lwbs.patienceMeanMinutesByAcuity': Object.fromEntries([1, 2, 3, 4, 5].map((a) => { const v = PARAMS.lwbs.patienceMeanMinutesByAcuity[a as 1]; return [`${a}`, Number.isFinite(v) ? v * 0.5 : null]; })),
      'workup.meanMinutesByAcuity': Object.fromEntries([1, 2, 3, 4, 5].map((a) => [`${a}`, PARAMS.workup.meanMinutesByAcuity[a as 1] * 1.6])),
    });
    const ms = [1, 2, 3].map((s) => new Simulation(truth, s).run().metrics);
    const avg = (f: (m: (typeof ms)[number]) => number) => ms.reduce((a, m) => a + f(m), 0) / ms.length;
    const targets = {
      admissionRate: avg((m) => m.admitted / m.arrivals),
      lwbsRate: avg((m) => m.lwbsRate),
      losMedianDischargedMinutes: avg((m) => m.lengthOfStayDischarged.median!),
    };
    const fit = fitToTargets(base, targets, [1, 2, 3]);
    expect(fit.achieved.admissionRate).toBeCloseTo(targets.admissionRate, 2);
    expect(Math.abs(fit.achieved.lwbsRate - targets.lwbsRate)).toBeLessThan(0.01);
    expect(Math.abs(fit.achieved.losMedianDischargedMinutes! - targets.losMedianDischargedMinutes) / targets.losMedianDischargedMinutes).toBeLessThan(0.05);
    expect(fit.scales.admission).toBeGreaterThan(1.2);
    expect(fit.scales.patience).toBeLessThan(0.7);
    expect(fit.scales.workup).toBeGreaterThan(1.3);
  }, 60_000);
});

describe('level benchmark', () => {
  const level = {
    id: 'bench',
    durationMinutes: 600,
    startHour: 22,
    staffing: { doctors: 1, triageNurses: 1 },
    queue: { discipline: 'fifo' },
    level: {
      number: 1,
      title: 'Bench',
      seed: 13,
      briefing: [],
      debrief: { pass: [], fail: [] },
      goals: [{ metric: 'lwbsRate', max: 0.2, label: 'few leave' }],
      playerControls: ['queue.discipline', 'staffing.doctors'],
    },
  } as never;
  const space = { dims: [{ path: 'queue.discipline', values: ['fifo', 'acuity'] }] };

  it('tries a small space in full, is deterministic, and lists the controls it did not vary', () => {
    const a = benchmarkLevel(level, space);
    expect(a.searched).toBe('exhaustive');
    expect(a.evaluated).toBe(2);
    expect(a.fixed).toEqual(['staffing.doctors']);
    expect(benchmarkLevel(level, space)).toEqual(a);
  });

  it('ranks setups that meet the goals above ones that do not', () => {
    const obj = levelObjective((level as { level: never }).level);
    const base = { compositeScore: 90, lwbsRate: 0.5 } as never;
    const ok = { compositeScore: 40, lwbsRate: 0.1 } as never;
    expect(obj.fn(ok)).toBeGreaterThan(obj.fn(base));
  });

  it('refuses controls the level does not unlock', () => {
    expect(() => benchmarkLevel(level, { dims: [{ path: 'beds.main', values: [10] }] })).toThrow(/not a player control/);
  });

  it('beating needs the goals met and a higher score', () => {
    const b = { score: 80, goalsMet: true };
    expect(beatsBenchmark(b, 81, true)).toBe(true);
    expect(beatsBenchmark(b, 80, true)).toBe(false);
    expect(beatsBenchmark(b, 95, false)).toBe(false);
  });
});
