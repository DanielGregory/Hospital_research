/** Small, deterministic statistics helpers. */

export interface Summary {
  n: number;
  mean: number | null;
  median: number | null;
  p90: number | null;
  max: number | null;
}

/** Nearest-rank percentile on a sorted array, q in [0, 1]. */
export function percentileSorted(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1]!;
}

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { n: 0, mean: null, median: null, p90: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    n: sorted.length,
    mean: sum / sorted.length,
    median: percentileSorted(sorted, 0.5),
    p90: percentileSorted(sorted, 0.9),
    max: sorted[sorted.length - 1]!,
  };
}

/**
 * Time-weighted average of a piecewise-constant quantity over a window.
 * Call `set(t, value)` whenever the value changes; time outside [start, end] is ignored.
 */
export class TimeWeighted {
  private area = 0;
  private lastT: number;
  private value = 0;

  constructor(
    private readonly start: number,
    private readonly end: number,
  ) {
    this.lastT = 0;
  }

  set(t: number, value: number): void {
    this.advance(t);
    this.value = value;
  }

  advance(t: number): void {
    const a = Math.max(this.lastT, this.start);
    const b = Math.min(t, this.end);
    if (b > a) this.area += this.value * (b - a);
    this.lastT = Math.max(this.lastT, t);
  }

  get current(): number {
    return this.value;
  }

  /** Integral over the window up to `t`. */
  integral(t: number): number {
    this.advance(t);
    return this.area;
  }
}
