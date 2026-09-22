import { describe, expect, it } from 'vitest';
import { checkBudget, plannedDailyCost } from '../src/budget.js';
import { resolveConfig } from '../src/config.js';
import { Simulation } from '../src/engine.js';
import { PARAMS } from '../src/params.js';
import { compositeScore } from '../src/score.js';

const week = { id: 'p5', durationMinutes: 7 * 1440, warmupMinutes: 1440 };

/** A fuller process: vitals first, then labs and imaging in parallel with the doctor, disposition last. */
const detailed = {
  ...week,
  modules: { process: true },
  staffing: { doctors: 4, nurses: 3, techs: 2, fastTrackClinicians: 1 },
  process: {
    steps: [
      { id: 'triage', kind: 'triage', role: 'triageNurse', meanMinutes: 6 },
      { id: 'vitals', kind: 'vitals', role: 'nurse', meanMinutes: 8, after: ['triage'], inBed: true },
      { id: 'doctorEval', kind: 'doctorEval', role: 'doctor', meanMinutesByAcuity: { '1': 60, '2': 45, '3': 35, '4': 20, '5': 15 }, after: ['vitals'], inBed: true },
      { id: 'labs', kind: 'labs', role: 'tech', meanMinutes: 5, turnaroundMinutes: 50, after: ['vitals'], inBed: true, maxAcuity: 3 },
      { id: 'imaging', kind: 'imaging', role: 'tech', meanMinutes: 15, turnaroundMinutes: 25, after: ['vitals'], inBed: true, maxAcuity: 3 },
      { id: 'disposition', kind: 'disposition', role: 'doctor', meanMinutes: 5, after: ['doctorEval', 'labs', 'imaging'], inBed: true },
    ],
    routing: [{ minAcuity: 4, maxAcuity: 5, lane: 'fastTrack' }],
  },
};

describe('process module', () => {
  it('runs parallel steps, skips steps that do not apply, and disposes last', () => {
    const sim = new Simulation(detailed, 1);
    sim.run();
    const done = sim.allPatients().filter((p) => p.outcome === 'discharged' || p.outcome === 'admitted');
    expect(done.length).toBeGreaterThan(300);
    let overlapped = 0;
    for (const p of done) {
      const s = p.steps;
      const last = Math.max(...Object.entries(s).filter(([k]) => k !== 'disposition').map(([, v]) => v.end!));
      expect(s.disposition!.start).toBeGreaterThanOrEqual(last);
      expect(s.doctorEval!.start).toBeGreaterThanOrEqual(s.vitals!.end!);
      if ((p.triageAssigned ?? 3) >= 4) expect(s.labs).toBeUndefined();
      if (s.labs && s.doctorEval && s.labs.start < s.doctorEval.end! && s.doctorEval.start < s.labs.end!) overlapped++;
    }
    expect(overlapped).toBeGreaterThan(50);
  });

  it('routes by rule to the fast track', () => {
    const sim = new Simulation(detailed, 2);
    const m = sim.run().metrics;
    expect(m.fastTrack.treated).toBeGreaterThan(50);
    for (const p of sim.allPatients()) if (p.lane === 'fastTrack') expect(p.triageAssigned!).toBeGreaterThanOrEqual(4);
  });

  it('needs staff for every role a step uses', () => {
    expect(() => resolveConfig({ ...detailed, staffing: { doctors: 4 } })).toThrow(/need a nurse/);
    expect(() => resolveConfig({ ...detailed, process: { steps: detailed.process.steps.slice(0, 5) } })).toThrow(/disposition/);
  });

  it('per-step thoroughness drives misdiagnosis', () => {
    const withT = (t: number) => ({
      ...detailed,
      modules: { process: true, diagnosis: true },
      process: { ...detailed.process, steps: detailed.process.steps.map((s) => (s.kind === 'doctorEval' ? { ...s, thoroughness: t } : s)) },
    });
    const miss = (t: number) => [1, 2, 3].reduce((a, s) => a + new Simulation(withT(t), s).run().metrics.diagnosis.misdiagnosisRate!, 0) / 3;
    expect(miss(1)).toBeLessThan(miss(0) * 0.7);
  });

  it('the default pipeline written out as a process gives identical results', () => {
    const plain = { ...week, id: 'same' };
    const steps = resolveConfig(plain).pipeline.map((s) => ({
      id: s.id,
      kind: s.kind,
      role: s.role,
      meanMinutesByAcuity: Object.fromEntries(Object.entries(s.meanMinutesByAcuity)),
      distribution: s.distribution,
      cv: s.cv,
      turnaroundMinutesByAcuity: Object.fromEntries(Object.entries(s.turnaroundMinutesByAcuity)),
      turnaroundCv: s.turnaroundCv,
      thoroughness: s.thoroughness,
      after: s.after,
      inBed: s.inBed,
    }));
    const a = new Simulation(plain, 5).run().metrics;
    const b = new Simulation({ ...plain, modules: { process: true }, process: { steps } }, 5).run().metrics;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('cost and budget', () => {
  it('plans daily cost from staffing, beds and escalation', () => {
    const c = resolveConfig({ id: 'b', staffing: { doctors: 2, triageNurses: 1 }, beds: { main: 10, fastTrack: 2 } });
    const w = PARAMS.budget.hourlyWage;
    const expected = 24 * (2 * w.doctor + w.triageNurse) + 10 * PARAMS.budget.bedPerDay.main + 2 * PARAMS.budget.bedPerDay.fastTrack;
    expect(plannedDailyCost(c).total).toBeCloseTo(expected);
    const esc = resolveConfig({ id: 'b', modules: { boarding: true }, boarding: { escalation: true } });
    expect(plannedDailyCost(esc).escalation).toBe(24 * PARAMS.budget.escalationPerHour);
  });

  it('the budget module blocks setups over the cap', () => {
    const cfg = { id: 'b', modules: { budget: true }, budget: { capPerDay: 15000 } }; // default setup plans ~19.9k/day
    expect(checkBudget(resolveConfig(cfg))[0]).toMatch(/exceeds the cap/);
    expect(checkBudget(resolveConfig({ ...cfg, budget: { capPerDay: 50000 } }))).toEqual([]);
    expect(checkBudget(resolveConfig({ ...cfg, modules: {} }))).toEqual([]);
  });

  it('actual cost matches the plan for fixed staffing, and escalation costs only while in force', () => {
    const cfg = { id: 'b', durationMinutes: 2 * 1440, staffing: { doctors: 3, triageNurses: 1 }, beds: { main: 12, fastTrack: 4 } };
    const m = new Simulation(cfg, 1).run().metrics;
    // Staff finish their last patient after handover only with schedules; fixed staff never leave.
    expect(m.cost.perDay).toBeCloseTo(plannedDailyCost(resolveConfig(cfg)).total, 0);
    const sim = new Simulation({ ...cfg, modules: { boarding: true } }, 1);
    sim.runUntil(600);
    sim.command({ type: 'setEscalation', enabled: true });
    sim.runUntil(720);
    sim.command({ type: 'setEscalation', enabled: false });
    expect(sim.run().metrics.cost.escalation).toBeCloseTo(2 * PARAMS.budget.escalationPerHour);
  });
});

describe('composite score', () => {
  it('is 100 at target, 0 at worst, linear between, and uses the config terms', () => {
    const terms = [
      { metric: 'a', weight: 1, target: 10, worst: 60 },
      { metric: 'b', weight: 3, target: 0.9, worst: 0.5 },
    ];
    expect(compositeScore({ a: 10, b: 0.95 }, terms).score).toBe(100);
    expect(compositeScore({ a: 60, b: 0.5 }, terms).score).toBe(0);
    expect(compositeScore({ a: 35, b: 0.9 }, terms).score).toBeCloseTo(100 * (0.5 + 3) / 4);
    expect(compositeScore({ b: 0.5 }, terms).score).toBeCloseTo(25); // missing metric counts as on target
    const m = new Simulation({ ...week, score: { terms: [{ metric: 'lwbsRate', weight: 1, target: 0, worst: 1 }] } }, 1).run().metrics;
    expect(m.compositeScore).toBeCloseTo(100 * (1 - m.lwbsRate));
  });

  it('a better-run ED scores higher', () => {
    const tight = new Simulation({ ...week, staffing: { doctors: 2 } }, 1).run().metrics;
    const good = new Simulation({ ...week, staffing: { doctors: 5 } }, 1).run().metrics;
    expect(good.compositeScore).toBeGreaterThan(tight.compositeScore + 20);
  });
});
