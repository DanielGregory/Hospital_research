import type { StepInput } from './config.js';

/** ESI acuity: 1 = most critical, 5 = least. */
export type Acuity = 1 | 2 | 3 | 4 | 5;
export const ACUITIES: readonly Acuity[] = [1, 2, 3, 4, 5];

export type Role = 'triageNurse' | 'doctor' | 'fastTrackClinician' | 'nurse' | 'tech' | 'security';
export const ROLES: readonly Role[] = ['triageNurse', 'doctor', 'fastTrackClinician', 'nurse', 'tech', 'security'];

/**
 * One part of a composite score: 1 at or better than `target`, 0 at or worse than `worst`,
 * linear between. Works for lower-is-better (target < worst) and higher-is-better (target > worst).
 */
export interface ScoreTerm {
  /** Dot path into Metrics. */
  metric: string;
  weight: number;
  target: number;
  worst: number;
}

export interface ConditionSpec {
  id: string;
  label: string;
  acuity: Acuity;
  /** Relative frequency among conditions at this acuity. */
  weight: number;
  /** Probability of admission when correctly diagnosed. */
  admit: number;
  /** Probability of misdiagnosis at default thoroughness, before fatigue. */
  missRisk: number;
  /** Age range [min, most common, max] (triangular). */
  ages?: readonly [number, number, number];
  /** Share of patients who are women. Default 0.5. */
  femaleShare?: number;
  /** Presenting complaints (what the patient says), chosen uniformly. */
  complaints?: readonly string[];
}

/** Who the patient is and what they say brings them in. Visible to the player (unlike the condition). */
export interface PatientProfile {
  age: number;
  sex: 'F' | 'M';
  /** Complaint key (see PARAMS.conditions[].complaints). */
  complaint: string;
}

export type Lane = 'main' | 'fastTrack';

/** Inpatient units an ED admission can go to (boarding.units). */
export const UNIT_IDS = ['icu', 'stepdown', 'ward'] as const;
export type UnitId = (typeof UNIT_IDS)[number];

export type Outcome = 'discharged' | 'admitted' | 'lwbs';
export type ArrivalSource = 'walkIn' | 'massCasualty' | 'bounceBack';

/** A patient's record. Timestamps are sim minutes; fields are filled as the visit progresses. */
export interface Patient {
  id: number;
  source: ArrivalSource;
  /** For bounce-backs: the visit they are returning from. */
  bounceOf?: number;
  /** Hidden condition (see PARAMS.conditions). */
  conditionId: string;
  /** Age, sex and presenting complaint (from their own `profile:` stream; bounce-backs keep theirs). */
  profile: PatientProfile;
  /** True acuity at arrival (metrics group by this). */
  initialAcuity: Acuity;
  /** Current true acuity; can worsen while waiting. */
  trueAcuity: Acuity;
  /** Set by triage (and updated when a deterioration is noticed). Undefined if not triaged. */
  assignedAcuity?: Acuity;
  /** What triage assigned, and the true acuity at that moment (for triage accuracy). */
  triageAssigned?: Acuity;
  acuityAtTriage?: Acuity;
  lane?: Lane;
  /** Treatment space index within the lane while in a bed. */
  bed?: number;
  /** How long they will wait before leaving without being seen. Infinity = never. */
  patienceMinutes: number;
  deteriorations: number;

  arrivalTime: number;
  triageStartTime?: number;
  triageEndTime?: number;
  bedRequestTime?: number;
  bedTime?: number;
  /** When the first doctor evaluation became ready to start. */
  doctorQueueTime?: number;
  /** First doctor contact ("seen"). */
  doctorStartTime?: number;
  /** Doctor (or fast-track clinician) who first saw them. */
  providerId?: number;
  dispositionTime?: number;
  /** Admitted but waiting for an inpatient bed, holding an ED bed. */
  boardingStartTime?: number;
  departureTime?: number;
  outcome?: Outcome;
  /** Per step id: when its work started (staff arrived, or the wait began) and when it finished. */
  steps: Record<string, { kind?: string; start: number; end?: number }>;
  misdiagnosed?: boolean;
  /** Minute the misdiagnosed patient will return (may be after the run ends). */
  returnsAt?: number;
  /** Came by ambulance (walk-in stream: drawn from their own stream; mass casualties: always). */
  byAmbulance?: boolean;
  /** Treated in a hallway space (opened with setHallwayBeds). */
  hallway?: boolean;
  /** Worsened to ESI 1 while waiting for a doctor. */
  becameCritical?: boolean;
  /** Security module: at risk of agitation (intoxication, behavioural crisis, frustration), and incidents they caused. */
  atRisk?: boolean;
  incidents?: number;
  lastIncidentAt?: number;
  /** Admitted: the inpatient unit they need (boarding.units). */
  admitUnit?: UnitId;
}

export interface Shift {
  /** Hour of day the shift starts (may be fractional). */
  startHour: number;
  /** Length in hours; may run past midnight. */
  hours: number;
  count: number;
  /** Days of week the shift starts on (0 = Monday). Default: every day. */
  days?: number[];
}

export type QueueDiscipline = 'fifo' | 'acuity';

/** Player / policy commands. The only way anything outside the engine changes sim state. */
export type Command =
  | { type: 'setStaff'; role: Role; count: number }
  | { type: 'setSchedule'; role: Role; shifts: Shift[] }
  | { type: 'setQueueDiscipline'; discipline: QueueDiscipline }
  | { type: 'setFastTrack'; enabled: boolean; minAcuity?: Acuity }
  | { type: 'setBeds'; lane: Lane; count: number | null }
  | { type: 'setEscalation'; enabled: boolean }
  /** New patient process (process module): applies to patients arriving from now on. */
  | { type: 'setProcess'; steps: StepInput[]; routing?: { minAcuity: Acuity; maxAcuity: Acuity; lane: Lane }[] }
  /** How thorough diagnostic steps are (0-1), for patients arriving from now on. */
  | { type: 'setThoroughness'; value: number }
  /** Call in an on-call member of staff: they arrive after a delay and stay a few hours, at a premium. */
  | { type: 'callIn'; role: Role }
  /** Ambulance diversion: ambulances take all but the most critical patients elsewhere. */
  | { type: 'setDiversion'; enabled: boolean }
  /** Open extra care spaces in the corridor (main ED): slower care, used only when the beds are full. */
  | { type: 'setHallwayBeds'; count: number }
  /** Move one member of staff to another role (e.g. a fast-track clinician into the main ED). */
  | { type: 'moveStaff'; from: Role; to: Role };


export interface TimedCommand {
  atMinute: number;
  command: Command;
}
