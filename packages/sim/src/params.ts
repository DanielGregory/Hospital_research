/**
 * Single source of truth for model numbers.
 *
 * Everything marked PLACEHOLDER is a plausible guess, not calibrated.
 * Calibration targets: MIMIC-IV-ED, CMS ED measures, NHS A&E statistics.
 * Configs (levels / sandbox presets) may override scenario-specific values;
 * anything they leave out comes from here.
 */

import type { Acuity } from './types.js';

export const PARAMS = {
  arrivals: {
    /**
     * Patients per hour for hours 0..23 of the day (~105 visits/day).
     * Shape: overnight trough, late-morning rise, afternoon/evening peak.
     */
    hourlyRates: [
      3.0, 2.5, 2.0, 1.8, 1.6, 1.6, 2.0, 2.8, 3.8, 4.8, 5.5, 5.8, // PLACEHOLDER
      5.8, 5.6, 5.5, 5.4, 5.4, 5.5, 5.4, 5.2, 4.8, 4.4, 3.9, 3.4, // PLACEHOLDER
    ],
    /** Multiplier per day of week, index 0 = Monday. */
    dayOfWeekMultipliers: [1.12, 1.03, 1.0, 0.99, 0.98, 0.93, 0.95], // PLACEHOLDER
  },

  acuity: {
    /** Share of arrivals by true ESI level (1 = most critical). */
    mix: { 1: 0.01, 2: 0.12, 3: 0.45, 4: 0.32, 5: 0.1 } as Record<Acuity, number>, // PLACEHOLDER
  },

  service: {
    /** Mean doctor evaluation time in minutes, by true acuity. */
    doctorMeanMinutesByAcuity: { 1: 60, 2: 45, 3: 35, 4: 20, 5: 15 } as Record<Acuity, number>, // PLACEHOLDER
    /** Coefficient of variation used when the service distribution is lognormal. */
    lognormalCv: 0.8, // PLACEHOLDER
  },

  staffing: {
    doctors: 2, // PLACEHOLDER
  },

  run: {
    durationMinutes: 24 * 60,
    warmupMinutes: 0,
  },
} as const;
