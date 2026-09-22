import { applySettings } from '../src/settings.js';

/**
 * Reference solutions for story levels, shared by the balance tests and seed selection.
 * A reference is a reasonable (not "best found") answer a player could reach.
 */
export const REFERENCE_SOLUTIONS: Record<string, Record<string, unknown>> = {
  'level-01-quiet-night': { 'queue.discipline': 'acuity' },
  'level-02-monday-morning': {
    'staffing.schedule.doctor': [
      { startHour: 22, hours: 12, count: 2 },
      { startHour: 7, hours: 12, count: 2 },
      { startHour: 10, hours: 12, count: 2 },
      { startHour: 13, hours: 12, count: 1 },
    ],
  },
  'level-03-fast-track': {
    'fastTrack.enabled': true,
    'staffing.schedule.fastTrackClinician': [{ startHour: 10, hours: 12, count: 1 }],
  },
  'level-04-flu-season': {
    'staffing.schedule.doctor': [
      { startHour: 22, hours: 12, count: 2 },
      { startHour: 7, hours: 12, count: 2 },
      { startHour: 10, hours: 12, count: 3 },
      { startHour: 13, hours: 12, count: 1 },
    ],
    'staffing.schedule.triageNurse': [
      { startHour: 0, hours: 24, count: 1 },
      { startHour: 9, hours: 12, count: 1 },
    ],
    'staffing.schedule.fastTrackClinician': [
      { startHour: 9, hours: 12, count: 1 },
      { startHour: 12, hours: 12, count: 1 },
    ],
  },
};

/** Apply dot-path settings to a copy of a config. */
export function withSettings(config: unknown, settings: Record<string, unknown>): Record<string, unknown> {
  return applySettings(config as Record<string, unknown>, settings);
}

/** Minimum pass-rate gap (reference minus shipped) across random seeds. Level 1 is tied to its night (see its designNote). */
export const MIN_CROSS_SEED_GAP: Record<string, number> = {
  'level-01-quiet-night': 0,
};
