/** Composite score (0–100) from weighted terms; weights are set per level or config. */
import { getPath } from './settings.js';
import type { ScoreTerm } from './types.js';

export interface ScoreBreakdown {
  score: number;
  terms: { metric: string; weight: number; value: number | null; subscore: number }[];
}

export function compositeScore(metrics: unknown, terms: readonly ScoreTerm[]): ScoreBreakdown {
  let sum = 0;
  let weights = 0;
  const out: ScoreBreakdown['terms'] = [];
  for (const t of terms) {
    const v = getPath(metrics, t.metric);
    const value = typeof v === 'number' ? v : null;
    // Missing data (e.g. no urgent patients) counts as meeting the target.
    const sub = value === null || t.target === t.worst ? 1 : Math.min(1, Math.max(0, (t.worst - value) / (t.worst - t.target)));
    out.push({ metric: t.metric, weight: t.weight, value, subscore: sub });
    sum += t.weight * sub;
    weights += t.weight;
  }
  return { score: weights > 0 ? (100 * sum) / weights : 100, terms: out };
}

export function checkScoreTerms(x: unknown, path: string): string[] {
  if (!Array.isArray(x)) return [`${path}: array of { metric, weight, target, worst }`];
  const out: string[] = [];
  x.forEach((t, i) => {
    const ok =
      typeof t === 'object' &&
      t !== null &&
      typeof (t as ScoreTerm).metric === 'string' &&
      [(t as ScoreTerm).weight, (t as ScoreTerm).target, (t as ScoreTerm).worst].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
      (t as ScoreTerm).weight >= 0;
    if (!ok) out.push(`${path}[${i}]: { metric, weight >= 0, target, worst }`);
  });
  return out;
}
