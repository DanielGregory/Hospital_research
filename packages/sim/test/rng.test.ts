import { describe, expect, it } from 'vitest';
import { Rng } from '../src/rng.js';

describe('Rng', () => {
  it('is reproducible for a seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('differs across seeds and streams', () => {
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
    const root = new Rng(7);
    expect(root.stream('arrivals').next()).not.toBe(root.stream('service').next());
    expect(new Rng(7).stream('arrivals').next()).toBe(new Rng(7).stream('arrivals').next());
  });

  it('stays in [0, 1)', () => {
    const r = new Rng(3);
    for (let i = 0; i < 100_000; i++) {
      const x = r.next();
      expect(x >= 0 && x < 1).toBe(true);
    }
  });

  it('exponential and lognormal have the requested mean', () => {
    const r = new Rng(11);
    const n = 200_000;
    let e = 0;
    let l = 0;
    for (let i = 0; i < n; i++) {
      e += r.exponential(30);
      l += r.lognormal(20, 0.8);
    }
    expect(e / n).toBeCloseTo(30, 0);
    expect(Math.abs(l / n - 20) / 20).toBeLessThan(0.01);
  });

  it('weightedIndex follows the weights', () => {
    const r = new Rng(5);
    const counts = [0, 0, 0];
    for (let i = 0; i < 100_000; i++) counts[r.weightedIndex([1, 0, 3])]!++;
    expect(counts[1]).toBe(0);
    expect(counts[2]! / counts[0]!).toBeGreaterThan(2.8);
    expect(counts[2]! / counts[0]!).toBeLessThan(3.2);
  });
});
