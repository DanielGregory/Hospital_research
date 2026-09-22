import { describe, expect, it } from 'vitest';
import { ArrivalProcess, arrivalRatePerMinute, type ArrivalPattern } from '../src/arrivals.js';
import { Rng } from '../src/rng.js';

const hourly = Array.from({ length: 24 }, (_, h) => (h < 12 ? 2 : 8));
const pattern: ArrivalPattern = {
  hourlyRates: hourly,
  dayOfWeekMultipliers: [1, 1, 1, 1, 1, 0.5, 0.5],
  startDayOfWeek: 0,
  startHour: 0,
};

describe('arrivals', () => {
  it('rate follows hour of day and day of week', () => {
    expect(arrivalRatePerMinute(pattern, 0)).toBeCloseTo(2 / 60);
    expect(arrivalRatePerMinute(pattern, 13 * 60)).toBeCloseTo(8 / 60);
    expect(arrivalRatePerMinute(pattern, (5 * 24 + 13) * 60)).toBeCloseTo(4 / 60); // Saturday afternoon
    expect(arrivalRatePerMinute(pattern, (7 * 24 + 13) * 60)).toBeCloseTo(8 / 60); // wraps to Monday
    expect(arrivalRatePerMinute({ ...pattern, startHour: 12 }, 0)).toBeCloseTo(8 / 60);
  });

  it('counts per hour match the rate function (thinning)', () => {
    const proc = new ArrivalProcess(pattern, new Rng(9));
    const weeks = 40;
    const until = weeks * 7 * 24 * 60;
    let morning = 0;
    let afternoonWeekday = 0;
    let t = 0;
    for (;;) {
      const next = proc.next(t, until);
      if (next === undefined) break;
      t = next;
      const hour = Math.floor(t / 60) % 24;
      const day = Math.floor(t / 1440) % 7;
      if (hour < 12) morning++;
      else if (day < 5) afternoonWeekday++;
    }
    // Expected: morning = 2/h * 12h * (5 + 0.5*2) days * weeks; weekday afternoons = 8 * 12 * 5 * weeks
    const expMorning = 2 * 12 * 6 * weeks;
    const expAfternoon = 8 * 12 * 5 * weeks;
    expect(Math.abs(morning - expMorning) / expMorning).toBeLessThan(0.03);
    expect(Math.abs(afternoonWeekday - expAfternoon) / expAfternoon).toBeLessThan(0.02);
  });

  it('produces nothing when all rates are zero', () => {
    const proc = new ArrivalProcess({ ...pattern, hourlyRates: Array(24).fill(0) }, new Rng(1));
    expect(proc.next(0, 1e6)).toBeUndefined();
  });
});
