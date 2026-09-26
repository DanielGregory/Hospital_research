/**
 * Expected demand vs. staffing by hour, from a config alone (no simulation).
 * Used by the game's schedule editor and by research tools.
 */

import { arrivalRatePerMinute } from '../arrivals.js';
import type { ResolvedConfig } from '../config.js';
import { onDutyCount } from '../schedule.js';
import { ACUITIES, type Role } from '../types.js';

export interface HourLoad {
  /** Sim hour index from the start of the run. */
  hour: number;
  /** Hour of day (0–23) and day of week (0 = Monday) of that hour. */
  hourOfDay: number;
  dayOfWeek: number;
  arrivalsPerHour: number;
  /** Doctor time arriving per hour, in doctors (erlangs), if every patient saw a main-ED doctor. */
  doctorLoad: number;
}

/** Mean doctor minutes per patient under the config's acuity mix. */
export function meanDoctorMinutes(c: ResolvedConfig): number {
  const total = ACUITIES.reduce((s, a) => s + c.acuityMix[a], 0);
  return ACUITIES.reduce((s, a) => s + (c.acuityMix[a] / total) * c.serviceMeanByAcuity[a], 0);
}

export function hourlyLoad(c: ResolvedConfig): HourLoad[] {
  const hours = Math.ceil(c.durationMinutes / 60);
  const perPatient = meanDoctorMinutes(c);
  const out: HourLoad[] = [];
  for (let h = 0; h < hours; h++) {
    // Average the rate over the hour (the pattern is piecewise constant per clock hour, runs may start mid-hour).
    let rate = 0;
    for (let k = 0; k < 4; k++) rate += arrivalRatePerMinute(c, h * 60 + k * 15 + 7.5) / 4;
    const cal = c.startDayOfWeek * 24 + c.startHour + h;
    out.push({
      hour: h,
      hourOfDay: Math.floor(cal) % 24,
      dayOfWeek: Math.floor(cal / 24) % 7,
      arrivalsPerHour: rate * 60,
      doctorLoad: rate * perPatient,
    });
  }
  return out;
}

/** Staff of a role on duty at the middle of each run hour. */
export function onDutyByHour(c: ResolvedConfig, role: Role): number[] {
  const hours = Math.ceil(c.durationMinutes / 60);
  const offset = (c.startDayOfWeek * 24 + c.startHour) * 60;
  const shifts = c.modules.staffing ? c.schedule[role] : undefined;
  return Array.from({ length: hours }, (_, h) => (shifts ? onDutyCount(shifts, offset, h * 60 + 30) : c.staff[role]));
}
