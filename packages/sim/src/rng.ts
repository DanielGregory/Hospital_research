/**
 * Seeded pseudo-random number generation.
 *
 * All randomness in the simulation must come from here — never Math.random().
 * Generator: sfc32 (small, fast, passes PractRand), seeded through splitmix32.
 *
 * Independent streams: `rng.stream('arrivals')` derives a new generator from
 * the root seed and the stream name. Giving each process its own stream keeps
 * them independent of one another (common random numbers): e.g. changing the
 * number of doctors does not shift the arrival sequence.
 */

function splitmix32(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** FNV-1a 32-bit hash, used to turn stream names into seeds. */
function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private readonly seed: number;

  constructor(seed: number) {
    if (!Number.isFinite(seed)) throw new Error(`Rng seed must be a finite number, got ${seed}`);
    this.seed = seed >>> 0;
    const sm = splitmix32(this.seed);
    this.a = sm();
    this.b = sm();
    this.c = sm();
    this.d = sm();
    // Discard early outputs so nearby seeds diverge quickly.
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  /** Derive an independent generator for a named stream. */
  stream(name: string): Rng {
    return new Rng((this.seed ^ Math.imul(hashString(name), 0x9e3779b1)) >>> 0);
  }

  nextUint32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Exponential with the given mean. */
  exponential(mean: number): number {
    // 1 - next() is in (0, 1], so the log is finite.
    return -mean * Math.log(1 - this.next());
  }

  /** Standard normal via Box–Muller (no cached spare, so the draw count per call is fixed). */
  normal(): number {
    const u1 = 1 - this.next();
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Lognormal parameterised by its own mean and coefficient of variation. */
  lognormal(mean: number, cv: number): number {
    const sigma2 = Math.log(1 + cv * cv);
    const mu = Math.log(mean) - sigma2 / 2;
    return Math.exp(mu + Math.sqrt(sigma2) * this.normal());
  }

  /** Pick an index with probability proportional to its weight. */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    if (!(total > 0)) throw new Error('weightedIndex needs at least one positive weight');
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i]!;
      if (r < 0) return i;
    }
    return weights.length - 1;
  }
}
