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

  triage: {
    meanMinutes: 6, // PLACEHOLDER
    /** Triage time is lognormal with this CV. */
    cv: 0.5, // PLACEHOLDER
    /** Probability triage assigns the true ESI level. Published ESI accuracy is roughly 60–80%. */
    accuracy: 0.72, // PLACEHOLDER
    /** Of mistriaged patients, share assigned a less urgent level (under-triage); the rest are over-triaged. */
    underTriageShare: 0.5, // PLACEHOLDER
  },

  fastTrack: {
    /** Assigned acuity at or above this goes to fast track when it is open. */
    minAcuity: 4 as Acuity, // PLACEHOLDER
    /** Fast-track treatment time relative to the main ED (focused lane, simpler workups). */
    serviceFactor: 0.85, // PLACEHOLDER
  },

  lwbs: {
    /** Mean patience before leaving without being seen, by true acuity. Infinity = never leaves. */
    patienceMeanMinutesByAcuity: { 1: Infinity, 2: Infinity, 3: 240, 4: 180, 5: 150 } as Record<Acuity, number>, // PLACEHOLDER
    /** Patience is lognormal with this CV, so few leave after short waits. */
    patienceCv: 0.6, // PLACEHOLDER
  },

  staffing: {
    doctors: 3, // PLACEHOLDER (~72% utilisation at default arrivals)
    triageNurses: 1, // PLACEHOLDER
    fastTrackClinicians: 0,
  },

  run: {
    durationMinutes: 24 * 60,
    warmupMinutes: 0,
  },
} as const;
