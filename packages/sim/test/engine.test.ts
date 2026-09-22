import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/engine.js';

const flat = (perHour: number) => Array(24).fill(perHour);

describe('Simulation', () => {
  it('conserves patients', () => {
    const sim = new Simulation({ id: 't', durationMinutes: 3000 }, 1);
    const { metrics } = sim.run();
    const snap = sim.snapshot();
    expect(snap.totals.arrived).toBe(snap.totals.departed + snap.waiting.length + snap.inService.length);
    expect(metrics.inSystemAtEnd).toBe(snap.waiting.length + snap.inService.length);
    expect(snap.finished).toBe(true);
  });

  it('never has more patients in service than doctors', () => {
    const sim = new Simulation({ id: 't', durationMinutes: 5000, staffing: { doctors: 2 } }, 3);
    for (let t = 0; t <= 5000; t += 7) {
      sim.runUntil(t);
      const s = sim.snapshot();
      expect(s.inService.length).toBeLessThanOrEqual(s.doctors.length);
      if (s.waiting.length > 0) expect(s.doctors.every((d) => d.busy || d.retiring)).toBe(true);
    }
  });

  it('with no doctors nobody is seen', () => {
    const { metrics } = new Simulation({ id: 't', durationMinutes: 600, staffing: { doctors: 0 } }, 1).run();
    expect(metrics.arrivals).toBeGreaterThan(0);
    expect(metrics.seenByDoctor).toBe(0);
    expect(metrics.doctorUtilization).toBeNull();
  });

  it('setDoctors: idle doctors leave at once, busy ones finish first', () => {
    const sim = new Simulation(
      { id: 't', durationMinutes: 10_000, staffing: { doctors: 3 }, arrivals: { hourlyRates: flat(20) } },
      2,
    );
    sim.runUntil(500);
    expect(sim.snapshot().doctors.every((d) => d.busy)).toBe(true);
    sim.command({ type: 'setDoctors', count: 1 });
    let s = sim.snapshot();
    expect(s.doctors.filter((d) => !d.retiring)).toHaveLength(1);
    expect(s.doctors).toHaveLength(3); // the retiring two are still with patients
    sim.runUntil(1000);
    s = sim.snapshot();
    expect(s.doctors).toHaveLength(1);
    sim.command({ type: 'setDoctors', count: 4 });
    expect(sim.snapshot().doctors).toHaveLength(4);
    expect(sim.snapshot().inService).toHaveLength(4);
  });

  it('raising doctors cancels pending departures before hiring', () => {
    const sim = new Simulation({ id: 't', durationMinutes: 5000, staffing: { doctors: 2 }, arrivals: { hourlyRates: flat(20) } }, 4);
    sim.runUntil(300);
    const ids = sim.snapshot().doctors.map((d) => d.id);
    sim.command({ type: 'setDoctors', count: 0 });
    sim.command({ type: 'setDoctors', count: 2 });
    expect(sim.snapshot().doctors.map((d) => d.id)).toEqual(ids);
    expect(sim.snapshot().doctors.every((d) => !d.retiring)).toBe(true);
  });

  it('snapshot is a copy', () => {
    const sim = new Simulation({ id: 't', durationMinutes: 600 }, 1);
    sim.runUntil(300);
    const s = sim.snapshot();
    s.waiting.length = 0;
    s.doctors.length = 0;
    expect(sim.snapshot().doctors.length).toBeGreaterThan(0);
  });

  it('warmup excludes early arrivals from stats', () => {
    const cfg = { id: 't', durationMinutes: 2000, arrivals: { hourlyRates: flat(6) } };
    const all = new Simulation(cfg, 8).run().metrics;
    const late = new Simulation({ ...cfg, warmupMinutes: 1000 }, 8).run().metrics;
    expect(late.arrivals).toBeLessThan(all.arrivals);
    expect(late.window).toEqual({ start: 1000, end: 2000 });
  });
});
