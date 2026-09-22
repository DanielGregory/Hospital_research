import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/engine.js';

const flat = (perHour: number) => Array(24).fill(perHour);
const doctors = (sim: Simulation) => sim.snapshot().staff.filter((s) => s.role === 'doctor');

describe('Simulation', () => {
  it('conserves patients and tracks every state', () => {
    const sim = new Simulation({ id: 't', durationMinutes: 3000 }, 1);
    const { metrics } = sim.run();
    const s = sim.snapshot();
    const inside = s.waitingTriage.length + s.inTriage.length + s.waitingDoctor.main.length + s.waitingDoctor.fastTrack.length + s.withDoctor.length;
    expect(s.totals.arrived).toBe(s.totals.treated + s.totals.lwbs + inside);
    expect(metrics.inSystemAtEnd).toBe(inside);
    expect(s.finished).toBe(true);
    for (const p of sim.allPatients()) {
      if (p.triageStartTime !== undefined) expect(p.triageStartTime).toBeGreaterThanOrEqual(p.arrivalTime);
      if (p.doctorStartTime !== undefined) expect(p.doctorStartTime).toBeGreaterThanOrEqual(p.triageEndTime!);
      if (p.outcome === 'lwbs') expect(p.doctorStartTime).toBeUndefined();
    }
  });

  it('never lets waiting patients sit next to an idle, on-duty provider', () => {
    const sim = new Simulation({ id: 't', durationMinutes: 5000, staffing: { doctors: 2, triageNurses: 1 } }, 3);
    for (let t = 0; t <= 5000; t += 7) {
      sim.runUntil(t);
      const s = sim.snapshot();
      const free = (role: string) => s.staff.some((x) => x.role === role && !x.busy && !x.retiring);
      if (s.waitingDoctor.main.length > 0) expect(free('doctor')).toBe(false);
      if (s.waitingTriage.length > 0) expect(free('triageNurse')).toBe(false);
      expect(s.withDoctor.length).toBeLessThanOrEqual(s.staff.filter((x) => x.role !== 'triageNurse').length);
    }
  });

  it('with no doctors nobody is seen', () => {
    const { metrics } = new Simulation({ id: 't', durationMinutes: 600, staffing: { doctors: 0 } }, 1).run();
    expect(metrics.arrivals).toBeGreaterThan(0);
    expect(metrics.seenByDoctor).toBe(0);
    expect(metrics.utilizationByRole.doctor).toBeNull();
  });

  it('setStaff: idle staff leave at once, busy ones finish first', () => {
    const sim = new Simulation(
      { id: 't', durationMinutes: 10_000, staffing: { doctors: 3, triageNurses: 3 }, arrivals: { hourlyRates: flat(20) } },
      2,
    );
    sim.runUntil(500);
    expect(doctors(sim).every((d) => d.busy)).toBe(true);
    sim.command({ type: 'setStaff', role: 'doctor', count: 1 });
    expect(doctors(sim).filter((d) => !d.retiring)).toHaveLength(1);
    expect(doctors(sim)).toHaveLength(3); // the retiring two are still with patients
    sim.runUntil(1000);
    expect(doctors(sim)).toHaveLength(1);
    sim.command({ type: 'setStaff', role: 'doctor', count: 4 });
    expect(doctors(sim)).toHaveLength(4);
    expect(sim.snapshot().withDoctor).toHaveLength(4);
  });

  it('raising staff cancels pending departures before hiring', () => {
    const sim = new Simulation({ id: 't', durationMinutes: 5000, staffing: { doctors: 2 }, arrivals: { hourlyRates: flat(20) } }, 4);
    sim.runUntil(300);
    const ids = doctors(sim).map((d) => d.id);
    sim.command({ type: 'setStaff', role: 'doctor', count: 0 });
    sim.command({ type: 'setStaff', role: 'doctor', count: 2 });
    expect(doctors(sim).map((d) => d.id)).toEqual(ids);
    expect(doctors(sim).every((d) => !d.retiring)).toBe(true);
  });

  it('rejects invalid live commands', () => {
    const sim = new Simulation({ id: 't' }, 1);
    expect(() => sim.command({ type: 'setStaff', role: 'janitor' as never, count: 1 })).toThrow(/role/);
    expect(() => sim.command({ type: 'setSchedule', role: 'doctor', shifts: [] })).toThrow(/staffing module/);
  });

  it('snapshot is a copy', () => {
    const sim = new Simulation({ id: 't', durationMinutes: 600 }, 1);
    sim.runUntil(300);
    const s = sim.snapshot();
    s.staff.length = 0;
    expect(sim.snapshot().staff.length).toBeGreaterThan(0);
  });

  it('warmup excludes early arrivals from stats', () => {
    const cfg = { id: 't', durationMinutes: 2000, arrivals: { hourlyRates: flat(6) } };
    const all = new Simulation(cfg, 8).run().metrics;
    const late = new Simulation({ ...cfg, warmupMinutes: 1000 }, 8).run().metrics;
    expect(late.arrivals).toBeLessThan(all.arrivals);
    expect(late.window).toEqual({ start: 1000, end: 2000 });
  });
});
