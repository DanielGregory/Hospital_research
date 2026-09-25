import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/index';

const week = (boarding: object) => ({ id: 'ward', durationMinutes: 14 * 1440, warmupMinutes: 1440, modules: { boarding: true }, boarding });

describe('wards by length of stay', () => {
  const byStay = (beds: number, escalation = false) => new Simulation(week({ inpatientStayHours: 110, inpatientBeds: beds, initialOccupied: Math.round(beds * 0.9), escalation }), 3).run().metrics;

  it('boarding shrinks as ward beds grow, and settles instead of drifting', () => {
    const tight = byStay(90);
    const roomy = byStay(160);
    expect(tight.boarding.meanHours!).toBeGreaterThan(roomy.boarding.meanHours ?? 0);
    // Discharges follow occupancy: the ward drains at beds ÷ stay, so the queue stays bounded.
    expect(tight.boarding.maxHours!).toBeLessThan(48);
  });

  it('escalation still frees beds early', () => {
    expect(byStay(100, true).boarding.meanHours ?? 0).toBeLessThan(byStay(100).boarding.meanHours!);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(byStay(110))).toBe(JSON.stringify(byStay(110)));
  });
});

describe('separate inpatient units (ICU, step-down, ward)', () => {
  const cfg = (icu: number) => ({
    id: 'units',
    durationMinutes: 21 * 1440,
    warmupMinutes: 7 * 1440,
    modules: { boarding: true },
    boarding: { units: { icu: { beds: icu }, stepdown: { beds: 14 }, ward: { beds: 120 } } },
  });
  const run = (icu: number, seed = 2) => new Simulation(cfg(icu), seed).run().metrics;

  it('patients board for the unit they need; ICU beds only change ICU boarding', () => {
    const tight = run(6);
    const roomy = run(14);
    expect(tight.boarding.byUnit!.icu!.hours).toBeGreaterThan(roomy.boarding.byUnit!.icu!.hours);
    expect(tight.boarding.byUnit!.icu!.admitted).toBe(roomy.boarding.byUnit!.icu!.admitted);
    expect(tight.boarding.byUnit!.ward!.boarders).toBe(0);
  });

  it('the sickest admissions go to the ICU more often', () => {
    const sim = new Simulation(cfg(12), 3);
    sim.run();
    const admitted = sim.allPatients().filter((p) => p.admitUnit);
    const icuShare = (a: number) => {
      const g = admitted.filter((p) => p.initialAcuity === a);
      return g.filter((p) => p.admitUnit === 'icu').length / Math.max(1, g.length);
    };
    expect(icuShare(2)).toBeGreaterThan(icuShare(3));
  });

  it('without units, nothing changes', () => {
    const plain = { id: 'u', durationMinutes: 3 * 1440, modules: { boarding: true } };
    expect(new Simulation(plain, 1).run().metrics.boarding.byUnit).toBeNull();
  });

  it('rejects unknown units', () => {
    expect(() => new Simulation({ ...cfg(8), boarding: { units: { morgue: { beds: 2 } } } }, 1)).toThrow(/boarding.units.morgue/);
  });
});
