import { describe, expect, it } from 'vitest';
import { hourlyLoad, meanDoctorMinutes, onDutyByHour } from '../src/analytic/load.js';
import { resolveConfig } from '../src/config.js';

describe('hourly load', () => {
  it('matches arrival rate × mean doctor time', () => {
    const c = resolveConfig({ id: 'x', durationMinutes: 180, arrivals: { hourlyRates: Array(24).fill(6), dayOfWeekMultipliers: [1, 1, 1, 1, 1, 1, 1] }, service: { meanMinutes: 30 } });
    expect(meanDoctorMinutes(c)).toBeCloseTo(30);
    const l = hourlyLoad(c);
    expect(l).toHaveLength(3);
    expect(l[0]!.arrivalsPerHour).toBeCloseTo(6);
    expect(l[0]!.doctorLoad).toBeCloseTo(3);
  });

  it('labels hours from the run start and reads schedules', () => {
    const c = resolveConfig({
      id: 'x',
      durationMinutes: 600,
      startDayOfWeek: 6,
      startHour: 22,
      modules: { staffing: true },
      staffing: { schedule: { doctor: [{ startHour: 0, hours: 8, count: 2 }] } },
    });
    const l = hourlyLoad(c);
    expect([l[0]!.dayOfWeek, l[0]!.hourOfDay, l[2]!.dayOfWeek, l[2]!.hourOfDay]).toEqual([6, 22, 0, 0]);
    expect(onDutyByHour(c, 'doctor').slice(0, 4)).toEqual([0, 0, 2, 2]);
  });
});
