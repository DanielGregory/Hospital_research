/** Stars for a level run, and the player's best per level (kept in the browser). */
import { evaluateGoals, type LevelSpec, type Metrics } from '@er/sim';

export const DEFAULT_STARS = { two: 80, three: 92 };

/** 0 if the goals were missed; 1 for meeting them; 2 and 3 for a high enough balanced score. */
export function starsFor(level: LevelSpec, m: Metrics): number {
  if (!evaluateGoals(m, level.goals).passed) return 0;
  const t = level.stars ?? DEFAULT_STARS;
  return 1 + Number(m.compositeScore >= t.two) + Number(m.compositeScore >= t.three);
}

export interface Best {
  stars: number;
  score: number;
}

const KEY = 'er-shift-best';

export function loadBest(): Record<string, Best> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Best>;
  } catch {
    return {};
  }
}

/** Record a run; returns the updated table. */
export function recordBest(table: Record<string, Best>, id: string, run: Best): Record<string, Best> {
  const old = table[id];
  const next = { ...table, [id]: old ? { stars: Math.max(old.stars, run.stars), score: Math.max(old.score, run.score) } : run };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: best results just aren't remembered.
  }
  return next;
}
