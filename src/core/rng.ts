/**
 * Seedable PRNG (mulberry32 seeded via splitmix-style hashing).
 * Deterministic across platforms: pure 32-bit integer math.
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
}

export function createRng(seed: number): Rng {
  let s = hashSeed(seed);
  return {
    next() {
      s = (s + 0x6d2b79f5) | 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Derive an independent seed for run `index` from a master seed. */
export function deriveSeed(master: number, index: number): number {
  return hashSeed((hashSeed(master) ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
}

function hashSeed(n: number): number {
  let x = (Math.trunc(n) >>> 0) ^ 0x85ebca6b;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}
