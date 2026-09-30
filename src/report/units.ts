/** Shared human-readable formatting for text reports, inspect output and the HTML dashboard. */

export function fmtMin(m: number): string {
  if (!Number.isFinite(m)) return String(m);
  if (m < 0) return `-${fmtMin(-m)}`;
  if (m < 60) return `${num(m)}m`;
  const h = Math.floor(m / 60);
  const mm = Math.round(m - h * 60);
  if (h < 24) return `${h}h${mm ? String(mm).padStart(2, "0") + "m" : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

/** Fraction (0..1) -> "12.3%". */
export function pct(x: number): string {
  return `${Math.round(x * 1000) / 10}%`;
}

/** Signed percent value (already in %) -> "+12.3%". */
export function signedPct(p: number | null): string {
  if (p === null) return "n/a";
  return `${p > 0 ? "+" : ""}${Math.round(p * 10) / 10}%`;
}

export function num(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(Math.abs(x) >= 100 ? 0 : 2);
}
