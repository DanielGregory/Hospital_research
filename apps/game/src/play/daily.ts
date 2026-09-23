/**
 * The daily challenge: one level and one day's arrivals for everyone, chosen from the date. The
 * engine is deterministic, so the same seed means everyone plays exactly the same shift.
 */
import type { LevelConfig } from '../levels';

export interface Daily {
  /** YYYY-MM-DD (UTC). */
  date: string;
  level: LevelConfig;
  seed: number;
}

export function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** FNV-1a: a stable seed from the date. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Levels 2 onwards take turns (level 1 is the tutorial). */
export function dailyChallenge(levels: readonly LevelConfig[], date: string): Daily {
  const pool = levels.filter((l) => l.level.number >= 2);
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  return { date, level: pool[((day % pool.length) + pool.length) % pool.length]!, seed: hash(`er-shift:${date}`) };
}

export function shareText(d: Daily, stars: number, score: number, url: string): string {
  return `ER Shift daily ${d.date} · ${d.level.level.title}: ${'★'.repeat(stars)}${'☆'.repeat(3 - stars)} score ${Math.round(score)}/100\n${url}?daily=${d.date}`;
}
