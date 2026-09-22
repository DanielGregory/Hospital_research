/** ESI acuity: 1 = most critical, 5 = least. */
export type Acuity = 1 | 2 | 3 | 4 | 5;
export const ACUITIES: readonly Acuity[] = [1, 2, 3, 4, 5];

export type Role = 'triageNurse' | 'doctor' | 'fastTrackClinician';
export const ROLES: readonly Role[] = ['triageNurse', 'doctor', 'fastTrackClinician'];

export type Lane = 'main' | 'fastTrack';

export type PatientState = 'waitingTriage' | 'inTriage' | 'waitingDoctor' | 'withDoctor' | 'departed';
export type Outcome = 'treated' | 'lwbs';

export interface Patient {
  id: number;
  trueAcuity: Acuity;
  /** Set by triage; may differ from trueAcuity. Undefined if not triaged. */
  assignedAcuity?: Acuity;
  state: PatientState;
  outcome?: Outcome;
  lane?: Lane;

  // Pre-drawn at arrival from separate streams (common random numbers across configs).
  /** Doctor time needed in the main ED (fast track scales it). */
  serviceMinutes: number;
  triageMinutes: number;
  /** Acuity triage would assign. */
  triageResult: Acuity;
  /** How long they will wait before leaving without being seen. Infinity = never. */
  patienceMinutes: number;

  arrivalTime: number;
  triageStartTime?: number;
  triageEndTime?: number;
  doctorQueueTime?: number;
  doctorStartTime?: number;
  departureTime?: number;
  providerId?: number;
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
  | { type: 'setFastTrack'; enabled: boolean; minAcuity?: Acuity };

export interface TimedCommand {
  atMinute: number;
  command: Command;
}
