/**
 * Notable patients of a run, for the debrief ("patient stories"). Picks real cases from the run
 * and reports their facts; the game turns them into words. Reveals the hidden condition, so only
 * use it once the run is over.
 */
import { PARAMS } from './params.js';
import type { Acuity, Outcome, Patient, PatientProfile } from './types.js';

export const STORY_KINDS = ['missed', 'becameCritical', 'leftUnseen', 'longestWait', 'boardedLongest', 'quickResponse'] as const;
export type StoryKind = (typeof STORY_KINDS)[number];

export interface PatientStory {
  kind: StoryKind;
  patientId: number;
  profile: PatientProfile;
  /** The hidden condition, revealed. */
  condition: string;
  arrivalAcuity: Acuity;
  /** What triage said (undefined if never triaged). */
  triagedAs?: Acuity;
  byAmbulance: boolean;
  arrivalTime: number;
  /** Minutes from arrival to first doctor contact (or to leaving, or to the end of the run if still waiting). */
  waitMinutes: number;
  /** Not yet seen by a doctor when the run ended. */
  stillWaiting: boolean;
  boardingMinutes: number | null;
  outcome?: Outcome;
  /** Missed diagnoses: when they come back (may be after the run). */
  returnsAt?: number;
}

/** Up to `max` notable patients, one per kind, most serious kinds first. Warm-up patients are skipped. */
export function patientStories(patients: readonly Patient[], now: number, warmupMinutes = 0, max = 5): PatientStory[] {
  const label = new Map(PARAMS.conditions.map((c) => [c.id, c.label]));
  const ps = patients.filter((p) => p.arrivalTime >= warmupMinutes && p.source !== 'bounceBack');
  const wait = (p: Patient) => (p.doctorStartTime ?? p.departureTime ?? now) - p.arrivalTime;
  const board = (p: Patient) => (p.boardingStartTime === undefined ? null : (p.departureTime ?? now) - p.boardingStartTime);
  const by = <T>(xs: T[], key: (x: T) => number) => xs.reduce<T | undefined>((best, x) => (best === undefined || key(x) > key(best) ? x : best), undefined);

  const picks: [StoryKind, Patient | undefined][] = [
    ['missed', by(ps.filter((p) => p.misdiagnosed), (p) => -p.initialAcuity * 1000 - p.arrivalTime / 1e6)],
    ['becameCritical', by(ps.filter((p) => p.becameCritical), (p) => wait(p))],
    ['leftUnseen', by(ps.filter((p) => p.outcome === 'lwbs'), (p) => -p.initialAcuity * 1e6 + wait(p))],
    ['longestWait', by(ps.filter((p) => p.outcome !== 'lwbs'), (p) => wait(p))],
    ['boardedLongest', by(ps.filter((p) => board(p) !== null), (p) => board(p)!)],
    ['quickResponse', by(ps.filter((p) => p.initialAcuity <= 2 && p.doctorStartTime !== undefined), (p) => -wait(p) - p.initialAcuity * 1e6)],
  ];
  const used = new Set<number>();
  const out: PatientStory[] = [];
  for (const [kind, p] of picks) {
    if (!p || used.has(p.id) || out.length >= max) continue;
    used.add(p.id);
    out.push({
      kind,
      patientId: p.id,
      profile: p.profile,
      condition: label.get(p.conditionId) ?? p.conditionId,
      arrivalAcuity: p.initialAcuity,
      triagedAs: p.triageAssigned,
      byAmbulance: p.byAmbulance === true,
      arrivalTime: p.arrivalTime,
      waitMinutes: wait(p),
      stillWaiting: p.doctorStartTime === undefined && p.outcome === undefined,
      boardingMinutes: board(p),
      outcome: p.outcome,
      returnsAt: p.returnsAt,
    });
  }
  return out;
}
