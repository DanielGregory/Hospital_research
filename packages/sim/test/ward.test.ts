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
