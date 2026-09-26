import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/engine.js';
import { onDutyCount, scheduleBoundaries } from '../src/schedule.js';
import type { Shift } from '../src/types.js';

const H = 60;

describe('schedule helpers', () => {
  const shifts: Shift[] = [
    { startHour: 8, hours: 8, count: 2 },
    { startHour: 20, hours: 12, count: 1 }, // overnight
    { startHour: 10, hours: 4, count: 1, days: [0] }, // Monday only
  ];

  it('counts staff on duty, including overnight shifts from the day before', () => {
    expect(onDutyCount(shifts, 0, 0)).toBe(1); // Monday 00:00: Sunday night shift
    expect(onDutyCount(shifts, 0, 7 * H)).toBe(1);
    expect(onDutyCount(shifts, 0, 8 * H)).toBe(2); // 08:00 night shift ends, day starts
    expect(onDutyCount(shifts, 0, 11 * H)).toBe(3); // Monday extra
    expect(onDutyCount(shifts, 0, (24 + 11) * H)).toBe(2); // Tuesday: no extra
    expect(onDutyCount(shifts, 0, 16 * H)).toBe(0);
    expect(onDutyCount(shifts, 6 * H, 0)).toBe(1); // run starts 06:00
  });

  it('lists boundaries within the run', () => {
    expect(scheduleBoundaries(shifts, 0, 24 * H)).toEqual([8 * H, 10 * H, 14 * H, 16 * H, 20 * H]);
    expect(scheduleBoundaries(shifts, 6 * H, 4 * H)).toEqual([2 * H, 4 * H]); // sim time, run starting 06:00
  });
});

describe('staffing module', () => {
  const schedule = { doctor: [{ startHour: 8, hours: 12, count: 3 }, { startHour: 20, hours: 12, count: 1 }] };

  it('follows the schedule when on', () => {
    const sim = new Simulation({ id: 's', durationMinutes: 2 * 1440, modules: { staffing: true }, staffing: { schedule } }, 1);
    const onDuty = () => sim.snapshot().staff.filter((s) => s.role === 'doctor' && !s.retiring).length;
    expect(onDuty()).toBe(1);
    sim.runUntil(9 * H);
    expect(onDuty()).toBe(3);
    sim.runUntil(21 * H);
    expect(onDuty()).toBe(1);
    const { metrics } = sim.run();
    expect(metrics.staffHoursByRole.doctor).toBeGreaterThanOrEqual(2 * (3 * 12 + 12) - 1e-6);
  });

  it('ignores the schedule when off (fixed counts)', () => {
    const sim = new Simulation({ id: 's', durationMinutes: 1440, staffing: { doctors: 2, schedule } }, 1);
    const { metrics } = sim.run();
    expect(metrics.staffHoursByRole.doctor).toBeGreaterThanOrEqual(48 - 1e-6);
    expect(metrics.staffHoursByRole.doctor).toBeLessThan(50);
  });

  it('setStaff holds until the next shift boundary', () => {
    const sim = new Simulation({ id: 's', durationMinutes: 1440, modules: { staffing: true }, staffing: { schedule } }, 1);
    sim.runUntil(2 * H);
    sim.command({ type: 'setStaff', role: 'doctor', count: 4 });
    sim.runUntil(7 * H);
    expect(sim.snapshot().staff.filter((s) => s.role === 'doctor' && !s.retiring)).toHaveLength(4);
    sim.runUntil(9 * H);
    expect(sim.snapshot().staff.filter((s) => s.role === 'doctor' && !s.retiring)).toHaveLength(3);
  });

  it('setSchedule replaces future shifts', () => {
    const sim = new Simulation({ id: 's', durationMinutes: 1440, modules: { staffing: true }, staffing: { schedule } }, 1);
    sim.runUntil(2 * H);
    sim.command({ type: 'setSchedule', role: 'doctor', shifts: [{ startHour: 0, hours: 24, count: 2 }] });
    sim.runUntil(9 * H); // the old 08:00 boundary must not fire
    expect(sim.snapshot().staff.filter((s) => s.role === 'doctor' && !s.retiring)).toHaveLength(2);
  });

  it('a schedule matched to demand beats the same staff-hours put in the wrong place', () => {
    // 72 doctor-hours/day both ways; the mismatched one puts the extra doctor on nights.
    const matched = { doctor: [{ startHour: 0, hours: 24, count: 2 }, { startHour: 9, hours: 12, count: 2 }] };
    const flat = { doctor: [{ startHour: 0, hours: 24, count: 2 }, { startHour: 21, hours: 12, count: 2 }] };
    const cfg = (doctor: typeof matched.doctor) => ({
      id: 's',
      durationMinutes: 21 * 1440,
      warmupMinutes: 1440,
      modules: { staffing: true },
      staffing: { schedule: { doctor } },
    });
    let better = 0;
    for (const seed of [1, 2, 3]) {
      const a = new Simulation(cfg(matched.doctor), seed).run().metrics;
      const b = new Simulation(cfg(flat.doctor), seed).run().metrics;
      // Same rostered hours; worked hours differ slightly because staff finish their patient past shift end.
      expect(Math.abs(a.staffHoursByRole.doctor - b.staffHoursByRole.doctor) / b.staffHoursByRole.doctor).toBeLessThan(0.02);
      if (a.doorToDoctor.mean! < b.doorToDoctor.mean! && a.lwbsRate < b.lwbsRate) better++;
    }
    expect(better).toBe(3);
  });
});
