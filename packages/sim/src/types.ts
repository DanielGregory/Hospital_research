/** ESI acuity: 1 = most critical, 5 = least. */
export type Acuity = 1 | 2 | 3 | 4 | 5;
export const ACUITIES: readonly Acuity[] = [1, 2, 3, 4, 5];

export interface Patient {
  id: number;
  trueAcuity: Acuity;
  /** Doctor time this patient will need, drawn at arrival (common random numbers). */
  serviceMinutes: number;
  arrivalTime: number;
  doctorStartTime?: number;
  departureTime?: number;
  doctorId?: number;
}

export interface Doctor {
  id: number;
  patientId: number | null;
  /** Leaves once the current patient is done (staff reduced while busy). */
  retiring: boolean;
}

/** Player / policy commands. The only way anything outside the engine changes sim state. */
export type Command = { type: 'setDoctors'; count: number };

export interface TimedCommand {
  atMinute: number;
  command: Command;
}
