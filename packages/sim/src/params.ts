/**
 * Single source of truth for model numbers.
 *
 * Everything marked PLACEHOLDER is a plausible guess, not calibrated.
 * Calibration targets: MIMIC-IV-ED, CMS ED measures, NHS A&E statistics.
 * Configs (levels / sandbox presets) may override scenario-specific values;
 * anything they leave out comes from here.
 */

import type { Acuity, ConditionSpec } from './types.js';

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

  /**
   * Hidden true conditions by ESI level: relative weight, chance of admission,
   * and how easy they are to miss (misdiagnosis probability at default thoroughness).
   */
  conditions: [
    { id: 'cardiac-arrest', label: 'Cardiac arrest', acuity: 1, weight: 0.3, admit: 0.9, missRisk: 0.02 }, // PLACEHOLDER
    { id: 'major-trauma', label: 'Major trauma', acuity: 1, weight: 0.4, admit: 0.85, missRisk: 0.05 }, // PLACEHOLDER
    { id: 'septic-shock', label: 'Septic shock', acuity: 1, weight: 0.3, admit: 0.95, missRisk: 0.05 }, // PLACEHOLDER
    { id: 'acs', label: 'Acute coronary syndrome', acuity: 2, weight: 0.25, admit: 0.75, missRisk: 0.12 }, // PLACEHOLDER
    { id: 'stroke', label: 'Stroke', acuity: 2, weight: 0.15, admit: 0.8, missRisk: 0.08 }, // PLACEHOLDER
    { id: 'sepsis', label: 'Sepsis', acuity: 2, weight: 0.2, admit: 0.7, missRisk: 0.1 }, // PLACEHOLDER
    { id: 'overdose', label: 'Overdose', acuity: 2, weight: 0.15, admit: 0.4, missRisk: 0.05 }, // PLACEHOLDER
    { id: 'chest-pain-benign', label: 'Chest pain, non-cardiac', acuity: 2, weight: 0.25, admit: 0.15, missRisk: 0.05 }, // PLACEHOLDER
    { id: 'abdominal-pain', label: 'Abdominal pain', acuity: 3, weight: 0.3, admit: 0.3, missRisk: 0.12 }, // PLACEHOLDER
    { id: 'pneumonia', label: 'Pneumonia', acuity: 3, weight: 0.15, admit: 0.45, missRisk: 0.08 }, // PLACEHOLDER
    { id: 'kidney-stone', label: 'Kidney stone', acuity: 3, weight: 0.12, admit: 0.15, missRisk: 0.05 }, // PLACEHOLDER
    { id: 'asthma', label: 'Asthma attack', acuity: 3, weight: 0.13, admit: 0.2, missRisk: 0.05 }, // PLACEHOLDER
    { id: 'appendicitis', label: 'Appendicitis', acuity: 3, weight: 0.1, admit: 0.6, missRisk: 0.15 }, // PLACEHOLDER
    { id: 'influenza', label: 'Influenza', acuity: 3, weight: 0.2, admit: 0.1, missRisk: 0.04 }, // PLACEHOLDER
    { id: 'sprain', label: 'Sprain', acuity: 4, weight: 0.35, admit: 0.01, missRisk: 0.03 }, // PLACEHOLDER
    { id: 'laceration', label: 'Laceration', acuity: 4, weight: 0.3, admit: 0.01, missRisk: 0.01 }, // PLACEHOLDER
    { id: 'uti', label: 'Urinary tract infection', acuity: 4, weight: 0.2, admit: 0.05, missRisk: 0.06 }, // PLACEHOLDER
    { id: 'minor-fracture', label: 'Minor fracture', acuity: 4, weight: 0.15, admit: 0.05, missRisk: 0.05 }, // PLACEHOLDER
    { id: 'rash', label: 'Rash', acuity: 5, weight: 0.4, admit: 0, missRisk: 0.02 }, // PLACEHOLDER
    { id: 'sore-throat', label: 'Sore throat', acuity: 5, weight: 0.45, admit: 0, missRisk: 0.03 }, // PLACEHOLDER
    { id: 'prescription', label: 'Prescription refill', acuity: 5, weight: 0.15, admit: 0, missRisk: 0.005 }, // PLACEHOLDER
  ] as readonly ConditionSpec[],

  beds: {
    /** Treatment spaces. null = unlimited. */
    main: 20, // PLACEHOLDER
    fastTrack: 6, // PLACEHOLDER
  },

  workup: {
    /** Waiting for test results after the first doctor evaluation (bed held, no staff), by true acuity. */
    meanMinutesByAcuity: { 1: 90, 2: 90, 3: 75, 4: 20, 5: 0 } as Record<Acuity, number>, // PLACEHOLDER
    cv: 0.6, // PLACEHOLDER
  },

  disposition: {
    /** Second, short doctor contact to decide admit/discharge. */
    doctorMinutes: 5, // PLACEHOLDER
    cv: 0.5, // PLACEHOLDER
  },

  deterioration: {
    /**
     * Time from arrival to deteriorating one ESI level if still not seen: Weibull with this
     * scale (minutes, by current true acuity) and shape > 1, so risk rises the longer they wait.
     */
    scaleMinutesByAcuity: { 1: 90, 2: 240, 3: 600, 4: 1800, 5: 3600 } as Record<Acuity, number>, // PLACEHOLDER
    shape: 1.6, // PLACEHOLDER
  },

  diagnosis: {
    /** Default thoroughness of doctor evaluation, 0..1. */
    thoroughness: 0.5, // PLACEHOLDER
    /** Service time multiplier at thoroughness 0 and 1 (linear between). */
    timeFactorRange: [0.7, 1.4] as const, // PLACEHOLDER
    /** Miss-risk multiplier at thoroughness 0 and 1 (linear between). 1.0 at 0.5 thoroughness. */
    missFactorRange: [1.8, 0.2] as const, // PLACEHOLDER
    /** A misdiagnosed discharged patient returns within 72 h with this probability. */
    bounceBackProbability: 0.6, // PLACEHOLDER
    /** Return time after discharge, uniform over this window (hours). */
    returnWithinHours: 72,
  },

  boarding: {
    /** Inpatient beds available to ED admissions. */
    inpatientBeds: 40, // PLACEHOLDER
    /** Occupied at t = 0. */
    initialOccupied: 34, // PLACEHOLDER
    /** Inpatient discharges per day that free a bed. */
    dischargesPerDay: 26, // PLACEHOLDER
    /** Relative discharge rate by hour of day (discharges cluster late morning to afternoon). */
    /** Hospital full-capacity protocol: extra inpatient discharges per day while escalated. */
    escalationExtraDischargesPerDay: 8, // PLACEHOLDER
    dischargeHourlyWeights: [
      0.2, 0.1, 0.1, 0.1, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 1.6, 2.0, // PLACEHOLDER
      2.2, 2.2, 2.0, 1.8, 1.5, 1.2, 0.9, 0.7, 0.5, 0.4, 0.3, 0.3, // PLACEHOLDER
    ],
  },

  burnout: {
    /** Fatigue gained per hour of busy time on a shift. */
    perBusyHour: 0.03, // PLACEHOLDER
    /** Fatigue gained per hour on shift regardless of workload. */
    perShiftHour: 0.005, // PLACEHOLDER
    /** Service time multiplier = 1 + timeEffect × fatigue. */
    timeEffect: 0.5, // PLACEHOLDER
    /** Error multiplier (triage and diagnosis) = 1 + errorEffect × fatigue. */
    errorEffect: 2.0, // PLACEHOLDER
    /** With fixed (unscheduled) staffing, fatigue resets at this handover interval. */
    handoverHours: 12,
  },

  layout: {
    /** Walking time per grid cell (about 2.5 m at ~1 m/s including stops). */
    minutesPerCell: 0.04, // PLACEHOLDER
    /** Waiting room to bed when the layout module is off. Zero keeps earlier phases' results unchanged. */
    disabledTransferMinutes: 0, // PLACEHOLDER
  },

  staffing: {
    doctors: 4, // PLACEHOLDER (~60% busy at default arrivals incl. dispositions)
    triageNurses: 1, // PLACEHOLDER
    fastTrackClinicians: 0,
    /** Bedside nurses and techs: only used by custom process steps (Phase 5). */
    nurses: 0,
    techs: 0,
  },

  run: {
    durationMinutes: 24 * 60,
    warmupMinutes: 0,
  },
} as const;
