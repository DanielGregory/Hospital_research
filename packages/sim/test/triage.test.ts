import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/engine.js';

const flat = (perHour: number) => Array(24).fill(perHour);

describe('triage', () => {
  it('assigns the true acuity at the configured rate, errors off by one level', () => {
    const sim = new Simulation({ id: 't', durationMinutes: 20_000, staffing: { triageNurses: 3, doctors: 6 }, triage: { accuracy: 0.7 } }, 1);
    const { metrics } = sim.run();
    expect(metrics.triage.accuracy!).toBeGreaterThan(0.68);
    expect(metrics.triage.accuracy!).toBeLessThan(0.72);
    for (const p of sim.allPatients()) if (p.assignedAcuity !== undefined) expect(Math.abs(p.assignedAcuity - p.trueAcuity)).toBeLessThanOrEqual(1);
  });

  it('perfect triage never mistriages', () => {
    const { metrics } = new Simulation({ id: 't', durationMinutes: 3000, triage: { accuracy: 1 } }, 2).run();
    expect(metrics.triage.accuracy).toBe(1);
    expect(metrics.triage.underTriageRate).toBe(0);
  });

  it('with triage off, patients go straight to the doctor queue', () => {
    const sim = new Simulation({ id: 't', durationMinutes: 3000, triage: { enabled: false } }, 2);
    const { metrics } = sim.run();
    expect(metrics.triage.triaged).toBe(0);
    expect(metrics.utilizationByRole.triageNurse).toBe(0);
    expect(sim.allPatients().every((p) => p.triageStartTime === undefined)).toBe(true);
  });

  it('acuity ordering sees urgent patients faster than FIFO does', () => {
    const base = {
      id: 't',
      durationMinutes: 14 * 1440,
      warmupMinutes: 1440,
      staffing: { doctors: 3 },
      triage: { accuracy: 1 },
      lwbs: { enabled: false },
      deterioration: { enabled: false },
    };
    // Time from being ready for a doctor to seeing one, by true acuity group.
    const doctorWait = (discipline: 'fifo' | 'acuity', urgent: boolean) => {
      const sim = new Simulation({ ...base, queue: { discipline } }, 3);
      sim.run();
      const xs = sim
        .allPatients()
        .filter((p) => p.doctorStartTime !== undefined && (urgent ? p.initialAcuity <= 2 : p.initialAcuity >= 4))
        .map((p) => p.doctorStartTime! - p.doctorQueueTime!);
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    expect(doctorWait('acuity', true)).toBeLessThan(doctorWait('fifo', true) / 3);
    expect(doctorWait('acuity', false)).toBeGreaterThan(doctorWait('fifo', false));
  });

  it('the doctor queue serves assigned acuity 1 before 5, FIFO within a level', () => {
    const sim = new Simulation(
      { id: 't', durationMinutes: 3000, staffing: { doctors: 1, triageNurses: 4 }, arrivals: { hourlyRates: flat(10) }, beds: { main: null }, queue: { dispositionFirst: false } },
      5,
    );
    sim.runUntil(1500);
    const line = sim.queuedTasks('doctor').filter((t) => t.kind === 'doctorEval');
    expect(line.length).toBeGreaterThan(5);
    const P = sim.allPatients();
    for (let i = 1; i < line.length; i++) {
      const [a, b] = [P[line[i - 1]!.patientId]!, P[line[i]!.patientId]!];
      expect(a.assignedAcuity! <= b.assignedAcuity!).toBe(true);
      if (a.assignedAcuity === b.assignedAcuity) expect(a.doctorQueueTime!).toBeLessThanOrEqual(b.doctorQueueTime!);
    }
  });
});

describe('LWBS', () => {
  it('patients leave when overloaded, never while being seen, and urgent ones by default never leave', () => {
    const sim = new Simulation({ id: 't', durationMinutes: 5 * 1440, staffing: { doctors: 1 } }, 1);
    const { metrics } = sim.run();
    expect(metrics.lwbsRate).toBeGreaterThan(0.1);
    expect(metrics.lwbsRateByAcuity['1'] ?? 0).toBe(0);
    expect(metrics.lwbsRateByAcuity['2']).toBe(0);
    for (const p of sim.allPatients().filter((x) => x.outcome === 'lwbs')) {
      expect(p.departureTime! - p.arrivalTime).toBeGreaterThanOrEqual(p.patienceMinutes - 1e-9);
      expect(p.doctorStartTime).toBeUndefined();
    }
  });

  it('can be switched off', () => {
    const { metrics } = new Simulation({ id: 't', durationMinutes: 3 * 1440, staffing: { doctors: 1 }, lwbs: { enabled: false } }, 1).run();
    expect(metrics.lwbsCount).toBe(0);
  });

  it('null patience means that acuity never leaves', () => {
    const { metrics } = new Simulation(
      { id: 't', durationMinutes: 3 * 1440, staffing: { doctors: 1 }, lwbs: { patienceMeanMinutesByAcuity: { '3': null, '4': null, '5': null } } },
      1,
    ).run();
    expect(metrics.lwbsCount).toBe(0);
  });
});
