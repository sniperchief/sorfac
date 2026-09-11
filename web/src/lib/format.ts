// Formatting helpers.
//
// Every one of these returns the literal string "Data unavailable" (or a short
// dash for dense table cells) when the underlying value is missing. Nothing
// here substitutes a zero or a placeholder for an absent number: an unavailable
// figure has to look unavailable.

export const UNAVAILABLE = "Data unavailable";
export const DASH = "—";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A probability as a percentage. */
export const pct = (v: number | null | undefined, dp = 2, fallback = UNAVAILABLE) =>
  finite(v) ? `${(v * 100).toFixed(dp)}%` : fallback;

/** A probability-unit difference in percentage points, always signed. */
export const pp = (v: number | null | undefined, dp = 2, fallback = UNAVAILABLE) =>
  finite(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(dp)}pp` : fallback;

/** A signed number, using a real minus sign rather than a hyphen. */
export const signed = (v: number | null | undefined, dp = 2, fallback = UNAVAILABLE) =>
  finite(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(dp)}` : fallback;

export const num = (v: number | null | undefined, dp = 4, fallback = UNAVAILABLE) =>
  finite(v) ? v.toFixed(dp) : fallback;

export const int = (v: number | null | undefined, fallback = UNAVAILABLE) =>
  finite(v) ? Math.round(v).toLocaleString("en-US") : fallback;

/** Seconds as a compact duration: 45s, 7m 30s, 2h 05m. */
export function duration(sec: number | null | undefined, fallback = UNAVAILABLE): string {
  if (!finite(sec) || sec < 0) return fallback;
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Unix seconds as "10 Sep 2026, 18:20 UTC". Always UTC: the research is. */
export function stampUnix(sec: number | null | undefined, fallback = UNAVAILABLE): string {
  if (!finite(sec)) return fallback;
  return stampIso(new Date(sec * 1000).toISOString(), fallback);
}

export function stampIso(iso: string | null | undefined, fallback = UNAVAILABLE): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/** Date only: "10 Sep 2026". */
export function dayIso(iso: string | null | undefined, fallback = UNAVAILABLE): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export const dayUnix = (sec: number | null | undefined, fallback = UNAVAILABLE) =>
  finite(sec) ? dayIso(new Date(sec * 1000).toISOString(), fallback) : fallback;

/** A bytes32 marketId shortened for display, never for identity. */
export const shortId = (id: string | null | undefined) =>
  !id ? UNAVAILABLE : id.length <= 14 ? id : `${id.slice(0, 8)}…${id.slice(-6)}`;

export const outcomeLabel = (y: 0 | 1 | null | undefined) => (y === 1 ? "UP" : y === 0 ? "DOWN" : UNAVAILABLE);
