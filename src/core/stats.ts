export interface Summary {
  count: number;
  mean: number;
  min: number;
  p10: number;
  median: number;
  p90: number;
  max: number;
}

/** Percentile with linear interpolation (same as numpy's default). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export function summarize(values: number[]): Summary | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    count: s.length,
    mean: round(mean),
    min: round(s[0]!),
    p10: round(percentile(s, 0.1)),
    median: round(percentile(s, 0.5)),
    p90: round(percentile(s, 0.9)),
    max: round(s[s.length - 1]!),
  };
}

/** Round to 6 significant decimals to keep reports stable and readable. */
export function round(n: number, digits = 6): number {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
