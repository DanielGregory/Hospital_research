/**
 * Player setup: which settings a level unlocks, their current values, and
 * whether a proposed setup fits the level's limits. Reads the sim; never simulates.
 */
import {
  applySettings,
  checkLimits,
  getPath,
  resolveConfig,
  type PlayerControl,
  type ResolvedConfig,
  type Role,
  type Shift,
} from '@er/sim';
import type { LevelConfig } from './levels';

export type SetupValues = Partial<Record<PlayerControl, unknown>>;

/** Current value of each unlocked control, falling back to the resolved default. */
export function initialValues(level: LevelConfig): SetupValues {
  const resolved = resolveConfig(level);
  const out: SetupValues = {};
  for (const ctl of level.level.playerControls) out[ctl] = getPath(level, ctl) ?? defaultFor(ctl, resolved);
  return out;
}

function defaultFor(ctl: PlayerControl, r: ResolvedConfig): unknown {
  switch (ctl) {
    case 'queue.discipline':
      return r.discipline;
    case 'staffing.doctors':
      return r.staff.doctor;
    case 'staffing.triageNurses':
      return r.staff.triageNurse;
    case 'staffing.fastTrackClinicians':
      return r.staff.fastTrackClinician;
    case 'fastTrack.enabled':
      return r.fastTrack.enabled;
    case 'fastTrack.minAcuity':
      return r.fastTrack.minAcuity;
    case 'beds.main':
      return Number.isFinite(r.beds.main) ? r.beds.main : 20;
    case 'beds.fastTrack':
      return Number.isFinite(r.beds.fastTrack) ? r.beds.fastTrack : 6;
    case 'boarding.escalation':
      return r.boarding.escalation;
    case 'diagnosis.thoroughness':
      return r.diagnosis.thoroughness;
    default:
      return [] as Shift[]; // schedules
  }
}

/** The level config with the player's setup applied. Only unlocked controls are honoured. */
export function buildConfig(level: LevelConfig, values: SetupValues): LevelConfig {
  const allowed = Object.entries(values).filter(([k]) => level.level.playerControls.includes(k as PlayerControl));
  return applySettings(level, allowed);
}

/** Problems that stop the shift from starting (limits, invalid settings). */
export function setupProblems(level: LevelConfig, values: SetupValues): string[] {
  try {
    return checkLimits(resolveConfig(buildConfig(level, values)));
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
}

export const ROLE_LABEL: Record<Role, string> = {
  doctor: 'Doctors',
  triageNurse: 'Triage nurses',
  fastTrackClinician: 'Fast-track clinicians',
  nurse: 'Nurses',
  tech: 'Technicians',
};

export function scheduleRole(ctl: PlayerControl): Role | undefined {
  const m = /^staffing\.schedule\.(\w+)$/.exec(ctl);
  return m ? (m[1] as Role) : undefined;
}
