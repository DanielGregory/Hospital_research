/**
 * Single source of truth for model numbers.
 *
 * Everything marked PLACEHOLDER is a plausible guess, not calibrated.
 * Calibration targets: MIMIC-IV-ED, CMS ED measures, NHS A&E statistics.
 * Configs (levels / sandbox presets) may override scenario-specific values;
 * anything they leave out comes from here.
 *
 * A fit to US national aggregates exists in configs/calibration/us-aggregates.fitted.json
 * but is NOT applied: its targets are unverified (see that folder). Once verified, fold the
 * fitted admission, patience and workup values in here and cite the sources.
 */

import type { Acuity, ConditionSpec, Lane, Role, ScoreTerm } from './types.js';

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
    /** Share of walk-in-stream patients who come by ambulance, by true acuity (diversion turns these away). */
    ambulanceShareByAcuity: { 1: 0.8, 2: 0.5, 3: 0.22, 4: 0.06, 5: 0.02 } as Record<Acuity, number>, // PLACEHOLDER
  },

  /** Career mode: money, reputation, upgrades and the weeks' events. */
  /**
   * Security module: agitation and incidents. A share of patients is at risk (intoxication, behavioural
   * crisis, long frustration); if still waiting when their tolerance runs out, there is an incident.
   * Crowding shortens tolerance. A free security officer responds; without one a clinician is pulled
   * off patient care, and incidents turn violent more often. All PLACEHOLDER.
   */
  security: {
    /** Share of patients at risk of an incident, plus an extra share for overdose presentations. */
    riskShare: 0.05, // PLACEHOLDER
    overdoseExtra: 0.35, // PLACEHOLDER
    /** Minutes an at-risk patient tolerates waiting (lognormal mean, cv), before crowding. */
    toleranceMeanMinutes: 75, // PLACEHOLDER
    toleranceCv: 0.8, // PLACEHOLDER
    /** Tolerance is divided by 1 + this × (people waiting ÷ 10). */
    crowdingEffect: 0.5, // PLACEHOLDER
    /** Share of incidents that turn violent with a security response; multiplied when nobody from security comes. */
    violentShare: 0.12, // PLACEHOLDER
    noSecurityViolentFactor: 2.2, // PLACEHOLDER
    /** Chance a violent incident injures staff: with and without security there. */
    injuryWithSecurity: 0.08, // PLACEHOLDER
    injuryWithoutSecurity: 0.3, // PLACEHOLDER
    /** Minutes for an officer to arrive (plus walking with the layout module). */
    responseMinutes: 3, // PLACEHOLDER
    /** Minutes to de-escalate (lognormal means; cv 0.6): verbal and violent incidents. */
    verbalMinutes: 15, // PLACEHOLDER
    violentMinutes: 40, // PLACEHOLDER
    /** After an incident: chance the patient leaves before being seen; at most this many incidents per patient. */
    leaveAfterIncident: 0.25, // PLACEHOLDER
    maxIncidentsPerPatient: 2, // PLACEHOLDER
  },

  career: {
    startMoney: 250_000, // PLACEHOLDER
    startReputation: 60, // PLACEHOLDER
    /** Paid per patient treated (discharged or admitted). */
    paymentPerPatient: 260, // PLACEHOLDER
    /** Penalties: someone left unseen, a missed diagnosis that comes back, a patient who became critical while waiting. */
    penaltyPerLwbs: 150, // PLACEHOLDER
    penaltyPerBounceBack: 600, // PLACEHOLDER
    penaltyPerCritical: 1_000, // PLACEHOLDER
    /** Quality bonus by balanced score for the week. */
    bonusAtScore: [
      [85, 12_000],
      [70, 5_000],
    ] as [number, number][], // PLACEHOLDER
    /** Reputation moves this far towards the week's balanced score. */
    reputationWeight: 0.3, // PLACEHOLDER
    /** Arrivals scale with reputation: at 0 → min, at 100 → max. */
    reputationArrivals: [0.85, 1.15] as [number, number], // PLACEHOLDER
    /** Population growth in arrivals per week. */
    growthPerWeek: 0.005, // PLACEHOLDER
    /** Capital cost of one more treatment space, and the refund for removing one. */
    bedPrice: { main: 15_000, fastTrack: 8_000 }, // PLACEHOLDER
    bedRefundShare: 0.5, // PLACEHOLDER
    maxBeds: { main: 40, fastTrack: 12 }, // PLACEHOLDER
    /** Below this balance the board steps in and the career ends. */
    bankruptAt: -150_000, // PLACEHOLDER
    /** Weekly chance of each event (flu is likelier in the flu season, weeks 9-14 of every 26). */
    eventChance: { flu: 0.08, fluSeason: 0.7, heatwave: 0.12, wardsFull: 0.18, incident: 0.15, quiet: 0.1 }, // PLACEHOLDER
    callInsPerWeek: 2, // PLACEHOLDER
  },

  /** Live decisions during a shift. */
  liveCalls: {
    /** On-call staff arrive this long after being called. */
    callInDelayMinutes: 45, // PLACEHOLDER
    /** And stay this long. */
    callInHours: 8, // PLACEHOLDER
    /** Call-in pay relative to the normal hourly wage. */
    callInWageMultiplier: 1.5, // PLACEHOLDER
    /** Call-ins allowed per run unless a config says otherwise. */
    maxCallIns: 2, // PLACEHOLDER
    /** On diversion, ambulances still bring patients at or below this ESI level (the most critical). */
    diversionSparesAcuity: 1, // PLACEHOLDER
    /** Cost per patient turned away (lost revenue, regional strain). */
    diversionCostPerPatient: 600, // PLACEHOLDER
    /** Most hallway spaces that can be opened. */
    maxHallwayBeds: 6, // PLACEHOLDER
    /** Care in a hallway space is slower (no cubicle, equipment brought over). */
    hallwayServiceFactor: 1.15, // PLACEHOLDER
    /** Mass-casualty incidents are announced this long before the first patient arrives. */
    incidentWarningMinutes: 20, // PLACEHOLDER
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
   * Profiles: age range [min, most common, max] (adults; triangular), share of women, and what
   * patients say brings them in (complaint keys; several conditions share one, so a complaint
   * never gives the diagnosis away). Ages and complaints are PLACEHOLDER like the rest.
   */
  conditions: [
    { id: 'cardiac-arrest', label: 'Cardiac arrest', acuity: 1, weight: 0.3, admit: 0.9, missRisk: 0.02, ages: [35, 68, 95], femaleShare: 0.35, complaints: ['collapsed'] }, // PLACEHOLDER
    { id: 'major-trauma', label: 'Major trauma', acuity: 1, weight: 0.4, admit: 0.85, missRisk: 0.05, ages: [16, 34, 90], femaleShare: 0.3, complaints: ['roadCollision', 'fallFromHeight', 'assault'] }, // PLACEHOLDER
    { id: 'septic-shock', label: 'Septic shock', acuity: 1, weight: 0.3, admit: 0.95, missRisk: 0.05, ages: [30, 74, 98], femaleShare: 0.45, complaints: ['confusedFever', 'collapsed'] }, // PLACEHOLDER
    { id: 'acs', label: 'Acute coronary syndrome', acuity: 2, weight: 0.25, admit: 0.75, missRisk: 0.12, ages: [38, 66, 95], femaleShare: 0.35, complaints: ['chestPain', 'breathless', 'unwell'] }, // PLACEHOLDER
    { id: 'stroke', label: 'Stroke', acuity: 2, weight: 0.15, admit: 0.8, missRisk: 0.08, ages: [40, 74, 98], femaleShare: 0.5, complaints: ['faceDroop', 'slurredSpeech', 'confused'] }, // PLACEHOLDER
    { id: 'sepsis', label: 'Sepsis', acuity: 2, weight: 0.2, admit: 0.7, missRisk: 0.1, ages: [18, 70, 98], femaleShare: 0.5, complaints: ['fever', 'confusedFever', 'unwell'] }, // PLACEHOLDER
    { id: 'overdose', label: 'Overdose', acuity: 2, weight: 0.15, admit: 0.4, missRisk: 0.05, ages: [15, 32, 80], femaleShare: 0.5, complaints: ['overdose', 'drowsy'] }, // PLACEHOLDER
    { id: 'chest-pain-benign', label: 'Chest pain, non-cardiac', acuity: 2, weight: 0.25, admit: 0.15, missRisk: 0.05, ages: [18, 42, 85], femaleShare: 0.5, complaints: ['chestPain', 'palpitations'] }, // PLACEHOLDER
    { id: 'abdominal-pain', label: 'Abdominal pain', acuity: 3, weight: 0.3, admit: 0.3, missRisk: 0.12, ages: [16, 40, 90], femaleShare: 0.6, complaints: ['abdominalPain', 'vomiting'] }, // PLACEHOLDER
    { id: 'pneumonia', label: 'Pneumonia', acuity: 3, weight: 0.15, admit: 0.45, missRisk: 0.08, ages: [18, 70, 98], femaleShare: 0.5, complaints: ['cough', 'breathless', 'fever'] }, // PLACEHOLDER
    { id: 'kidney-stone', label: 'Kidney stone', acuity: 3, weight: 0.12, admit: 0.15, missRisk: 0.05, ages: [20, 45, 80], femaleShare: 0.35, complaints: ['flankPain', 'abdominalPain'] }, // PLACEHOLDER
    { id: 'asthma', label: 'Asthma attack', acuity: 3, weight: 0.13, admit: 0.2, missRisk: 0.05, ages: [16, 28, 80], femaleShare: 0.55, complaints: ['breathless', 'wheeze'] }, // PLACEHOLDER
    { id: 'appendicitis', label: 'Appendicitis', acuity: 3, weight: 0.1, admit: 0.6, missRisk: 0.15, ages: [16, 26, 75], femaleShare: 0.5, complaints: ['abdominalPain', 'vomiting'] }, // PLACEHOLDER
    { id: 'influenza', label: 'Influenza', acuity: 3, weight: 0.2, admit: 0.1, missRisk: 0.04, ages: [16, 38, 92], femaleShare: 0.5, complaints: ['fever', 'cough', 'unwell'] }, // PLACEHOLDER
    { id: 'sprain', label: 'Sprain', acuity: 4, weight: 0.35, admit: 0.01, missRisk: 0.03, ages: [16, 30, 80], femaleShare: 0.5, complaints: ['ankleInjury', 'wristInjury'] }, // PLACEHOLDER
    { id: 'laceration', label: 'Laceration', acuity: 4, weight: 0.3, admit: 0.01, missRisk: 0.01, ages: [16, 33, 85], femaleShare: 0.35, complaints: ['cut'] }, // PLACEHOLDER
    { id: 'uti', label: 'Urinary tract infection', acuity: 4, weight: 0.2, admit: 0.05, missRisk: 0.06, ages: [18, 48, 95], femaleShare: 0.8, complaints: ['urinaryPain', 'abdominalPain', 'fever'] }, // PLACEHOLDER
    { id: 'minor-fracture', label: 'Minor fracture', acuity: 4, weight: 0.15, admit: 0.05, missRisk: 0.05, ages: [16, 45, 95], femaleShare: 0.55, complaints: ['wristInjury', 'ankleInjury', 'fall'] }, // PLACEHOLDER
    { id: 'rash', label: 'Rash', acuity: 5, weight: 0.4, admit: 0, missRisk: 0.02, ages: [16, 30, 85], femaleShare: 0.55, complaints: ['rash'] }, // PLACEHOLDER
    { id: 'sore-throat', label: 'Sore throat', acuity: 5, weight: 0.45, admit: 0, missRisk: 0.03, ages: [16, 27, 75], femaleShare: 0.55, complaints: ['soreThroat', 'fever'] }, // PLACEHOLDER
    { id: 'prescription', label: 'Prescription refill', acuity: 5, weight: 0.15, admit: 0, missRisk: 0.005, ages: [20, 55, 90], femaleShare: 0.5, complaints: ['prescription'] }, // PLACEHOLDER
  ] as readonly ConditionSpec[],

  beds: {
    /** Treatment spaces. null = unlimited. */
    main: 20, // PLACEHOLDER
    fastTrack: 6, // PLACEHOLDER
    /** How many of the main beds are trauma (resuscitation) bays. They go to the sickest patients first. */
    traumaBays: 2, // PLACEHOLDER
    /** Patients triaged at or below this ESI level take a free trauma bay before a regular bed. */
    traumaMaxAcuity: 2, // PLACEHOLDER
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
    /** Ward model by length of stay (boarding.inpatientStayHours): spread of inpatient stays. */
    inpatientStayCv: 0.8, // PLACEHOLDER
    /** Typical adult inpatient stay, hours: used when calibration switches to the ward model by length of stay. */
    typicalStayHours: 110, // PLACEHOLDER
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

  budget: {
    /** Cost per staffed hour, by role (currency units; think dollars). */
    hourlyWage: { doctor: 150, triageNurse: 55, fastTrackClinician: 90, nurse: 50, tech: 40, security: 38 } as Record<Role, number>, // PLACEHOLDER
    /** Running cost of one treatment space per day (equipment, cleaning, overhead). */
    bedPerDay: { main: 180, fastTrack: 90 } as Record<Lane, number>, // PLACEHOLDER
    /** Hospital full-capacity protocol, per hour in force (ward overtime, transport). */
    escalationPerHour: 400, // PLACEHOLDER
    /** Floor space per grid cell per day (layout module). */
    spacePerCellPerDay: 6, // PLACEHOLDER
  },

  /** Default composite score terms (a config or level can set its own). */
  score: {
    terms: [
      { metric: 'doorToDoctor.median', weight: 2, target: 10, worst: 60 }, // PLACEHOLDER
      { metric: 'doorToDoctorByGroup.urgent.median', weight: 2, target: 5, worst: 30 }, // PLACEHOLDER
      { metric: 'lwbsRate', weight: 2, target: 0.01, worst: 0.1 }, // PLACEHOLDER
      { metric: 'lengthOfStay.median', weight: 1, target: 120, worst: 360 }, // PLACEHOLDER
      { metric: 'deterioration.per100Arrivals', weight: 1, target: 0, worst: 5 }, // PLACEHOLDER
    ] as readonly ScoreTerm[],
  },

  queue: {
    /** ESI level at or above which a waiting patient interrupts a doctor (resuscitation). 0 = never. */
    preemptAcuity: 1, // PLACEHOLDER (policy choice; ESI 1 = immediate life-saving intervention)
  },

  staffing: {
    doctors: 4, // PLACEHOLDER (~60% busy at default arrivals incl. dispositions)
    triageNurses: 1, // PLACEHOLDER
    fastTrackClinicians: 0,
    /** Bedside nurses and techs: only used by custom process steps (Phase 5). */
    nurses: 0,
    techs: 0,
    /** Security officers (security module). */
    securityOfficers: 0,
  },

  run: {
    durationMinutes: 24 * 60,
    warmupMinutes: 0,
  },
} as const;
