/**
 * Credibility checks from the spec: determinism, Erlang C, Little's Law, monotonicity.
 */
import { describe, expect, it } from 'vitest';
import basic from '../../../configs/examples/basic.json';
import mmcConfig from '../../../configs/validation/mmc.json';
import { mmc } from '../src/analytic/queueing.js';
import { Simulation } from '../src/engine.js';

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe('determinism', () => {
  it('same seed + config gives byte-identical metrics', () => {
    const a = JSON.stringify(new Simulation(basic, 42).run());
    const b = JSON.stringify(new Simulation(basic, 42).run());
    expect(a).toBe(b);
    expect(JSON.stringify(new Simulation(basic, 43).run())).not.toBe(a);
  });

  it('stepping in small increments matches one big run', () => {
    const whole = new Simulation(basic, 7).run().metrics;
    const stepped = new Simulation(basic, 7);
    for (let t = 0; !stepped.finished; t += 13.7) stepped.runUntil(t);
    expect(JSON.stringify(stepped.metrics())).toBe(JSON.stringify(whole));
  });

  it('live commands replay exactly from the command log', () => {
    const cfg = { ...basic, commands: [] };
    const live = new Simulation(cfg, 5);
    live.runUntil(2000);
    live.command({ type: 'setStaff', role: 'doctor', count: 4 });
    live.command({ type: 'setFastTrack', enabled: true });
    live.command({ type: 'setStaff', role: 'fastTrackClinician', count: 1 });
    live.runUntil(5000.5);
    live.command({ type: 'setStaff', role: 'doctor', count: 1 });
    live.command({ type: 'setQueueDiscipline', discipline: 'fifo' });
    const liveResult = live.run();

    const replay = new Simulation({ ...cfg, commands: liveResult.commandLog }, 5).run();
    expect(JSON.stringify(replay)).toBe(JSON.stringify(liveResult));
  });
});

describe('Erlang C (M/M/3, rho = 0.8)', () => {
  const lambda = 4.8 / 60;
  const theory = mmc(lambda, 30, 3);
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  const runs = seeds.map((s) => new Simulation(mmcConfig, s).run().metrics);
  const avg = (f: (m: (typeof runs)[number]) => number) => runs.reduce((s, m) => s + f(m), 0) / runs.length;

  it('mean wait matches the analytic value within 5%', () => {
    const simWait = avg((m) => m.doorToDoctor.mean!);
    expect(theory.probWait).toBeCloseTo(0.6472, 4); // textbook value for c=3, a=2.4
    expect(theory.meanWait).toBeCloseTo(32.36, 2);
    expect(rel(simWait, theory.meanWait)).toBeLessThan(0.05);
  });

  it('utilization and queue length match', () => {
    expect(rel(avg((m) => m.utilizationByRole.doctor!), theory.utilization)).toBeLessThan(0.01);
    expect(rel(avg((m) => m.timeAverageWaiting), theory.meanQueueLength)).toBeLessThan(0.06);
    expect(rel(avg((m) => m.lengthOfStay.mean!), theory.meanTimeInSystem)).toBeLessThan(0.03);
  });
});

describe("Little's Law", () => {
  it('L ≈ λW with time-varying arrivals, triage, fast track and LWBS', () => {
    const cfg = {
      ...basic,
      durationMinutes: 8 * 7 * 1440,
      commands: [],
      staffing: { doctors: 2, fastTrackClinicians: 1 },
      fastTrack: { enabled: true },
    };
    const m = new Simulation(cfg, 11).run().metrics;
    expect(m.lwbsCount).toBeGreaterThan(0);
    const L = m.timeAverageInSystem;
    const lambdaW = m.arrivalRatePerMinute * m.meanTimeInSystem!;
    expect(rel(lambdaW, L)).toBeLessThan(0.02);
  });

  it('holds for the queue alone (Lq = λWq) in M/M/c', () => {
    const m = new Simulation({ ...mmcConfig, durationMinutes: 300_000 }, 3).run().metrics;
    expect(rel(m.arrivalRatePerMinute * m.doorToDoctor.mean!, m.timeAverageWaiting)).toBeLessThan(0.02);
  });
});

describe('monotonicity', () => {
  it('more doctors never increase any patient’s wait (FIFO, no triage/LWBS; common random numbers)', () => {
    const base = { ...basic, commands: [], durationMinutes: 3 * 1440, triage: { enabled: false }, queue: { discipline: 'fifo' }, lwbs: { enabled: false } };
    for (const seed of [1, 2, 3]) {
      let prevWaits: number[] | undefined;
      let prevMean = Infinity;
      for (let doctors = 1; doctors <= 6; doctors++) {
        const sim = new Simulation({ ...base, staffing: { doctors } }, seed);
        const { metrics } = sim.run();
        const waits = sim.allPatients().map((p) => (p.doctorStartTime ?? sim.now) - p.arrivalTime);
        if (prevWaits) {
          expect(waits.length).toBe(prevWaits.length);
          waits.forEach((w, i) => expect(w).toBeLessThanOrEqual(prevWaits![i]! + 1e-9));
        }
        expect(metrics.doorToDoctor.mean!).toBeLessThanOrEqual(prevMean + 1e-9);
        prevWaits = waits;
        prevMean = metrics.doorToDoctor.mean!;
      }
    }
  });

  it('with the full default pipeline, more doctors lower mean wait and LWBS (averaged over seeds)', () => {
    const base = { ...basic, commands: [], durationMinutes: 14 * 1440 };
    const seeds = [1, 2, 3, 4];
    let prev = { wait: Infinity, lwbs: Infinity };
    for (let doctors = 2; doctors <= 6; doctors++) {
      const ms = seeds.map((s) => new Simulation({ ...base, staffing: { doctors } }, s).run().metrics);
      const wait = ms.reduce((a, m) => a + m.doorToDoctor.mean!, 0) / ms.length;
      const lwbs = ms.reduce((a, m) => a + m.lwbsRate, 0) / ms.length;
      expect(wait).toBeLessThanOrEqual(prev.wait);
      expect(lwbs).toBeLessThanOrEqual(prev.lwbs);
      prev = { wait, lwbs };
    }
  });
});
