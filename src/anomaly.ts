// Phase 5: cadence-stratified investigation of the 20-30% calibration anomaly.
//
// Pure functions only. Phases 2-4 are locked: bucket semantics come from Phase
// 2's `bucketIndex`, cadence from Phase 3's `cadenceCohort`, and interval
// arithmetic from Phase 4's `wilsonCI`. This module defines no new bucket.

import { bucketIndex } from "./compare.js";
import { wilsonCI } from "./freshness.js";

/** The bucket under investigation, in Phase-2 terms. Index 2 is [0.20, 0.30). */
export const TARGET_BUCKET_INDEX = 2;
export const TARGET_BUCKET_LABEL = "20-30%";

/** Phase-2 membership test, reused rather than reimplemented. */
export const inTargetBucket = (p: number) => bucketIndex(p) === TARGET_BUCKET_INDEX;

/**
 * Diagnostic sub-bands inside 20-30%, fixed before any result was inspected:
 * four equal 2.5-point slices. They exist only to locate the deviation inside
 * the bucket and are never used as calibration buckets.
 */
export const SUB_BANDS = [
  { label: "20-22.5%", lo: 0.2, hi: 0.225 },
  { label: "22.5-25%", lo: 0.225, hi: 0.25 },
  { label: "25-27.5%", lo: 0.25, hi: 0.275 },
  { label: "27.5-30%", lo: 0.275, hi: 0.3 },
] as const;

/** Sub-band label for a probability, or null when outside 20-30%. */
export function subBand(p: number): string | null {
  if (!inTargetBucket(p)) return null;
  for (const b of SUB_BANDS) {
    // Half-open like Phase 2, except the last slice closes at the bucket top.
    if (b.hi === 0.3 ? p >= b.lo && p < b.hi : p >= b.lo && p < b.hi) return b.label;
  }
  return null;
}

/**
 * Minimum cell size for drawing any inference. Cells below this are reported
 * with their counts and explicitly marked as too small — never hidden, never
 * silently merged. Fixed in advance at 20.
 */
export const MIN_CELL_N = 20;

export type Deviation = {
  n: number;
  /** Mean predicted probability across the group — the expected Up rate. */
  expected: number;
  /** Realised Up rate. */
  observed: number;
  /** observed - expected, in probability units. */
  deviation: number;
  /** Normal-approximation z against the expected rate. NaN when n is 0. */
  z: number;
  /** Wilson 95% interval for the observed rate. */
  ci95: [number, number];
  /** True when the expected rate lies outside the observed rate's 95% interval. */
  expectedOutsideCI: boolean;
  /** Below MIN_CELL_N: report the numbers, draw no conclusion. */
  tooSmall: boolean;
  brier: number;
  logloss: number;
};

const EPS = 1e-6;
const clamp = (v: number) => Math.min(1 - EPS, Math.max(EPS, v));

/**
 * Deviation statistics for one group. The expected rate is the group's own mean
 * prediction, matching how Phase 2 and Phase 3 computed bucket diffs.
 */
export function deviationStats(rows: { p: number; y: 0 | 1 }[]): Deviation {
  const n = rows.length;
  if (n === 0) {
    return { n: 0, expected: NaN, observed: NaN, deviation: NaN, z: NaN, ci95: [NaN, NaN], expectedOutsideCI: false, tooSmall: true, brier: NaN, logloss: NaN };
  }
  const expected = rows.reduce((a, r) => a + r.p, 0) / n;
  const successes = rows.reduce((a, r) => a + r.y, 0);
  const observed = successes / n;
  const se = Math.sqrt((expected * (1 - expected)) / n);
  const ci95 = wilsonCI(successes, n);
  return {
    n,
    expected,
    observed,
    deviation: observed - expected,
    z: se > 0 ? (observed - expected) / se : NaN,
    ci95,
    expectedOutsideCI: Number.isFinite(ci95[0]) && (expected < ci95[0] || expected > ci95[1]),
    tooSmall: n < MIN_CELL_N,
    brier: rows.reduce((a, r) => a + (r.p - r.y) ** 2, 0) / n,
    logloss: -rows.reduce((a, r) => { const q = clamp(r.p); return a + (r.y * Math.log(q) + (1 - r.y) * Math.log(1 - q)); }, 0) / n,
  };
}

export type Period<T> = {
  index: number;
  label: string;
  startTimestamp: number;
  /** Exclusive upper bound; Infinity for the final period. */
  endTimestamp: number;
  startIso: string;
  endIso: string;
  items: T[];
};

/**
 * Deterministic chronological periods of approximately equal count.
 *
 * Like Phase 4's split, boundaries are placed on TIMESTAMPS rather than
 * indices, so markets sharing an instant always land in the same period. Counts
 * therefore come out approximately, not exactly, equal — which is reported.
 */
export function chronologicalPeriods<T>(
  items: T[],
  timestampOf: (x: T) => number,
  idOf: (x: T) => string,
  nPeriods: number,
): Period<T>[] {
  if (nPeriods < 1) throw new Error("chronologicalPeriods() needs at least one period");
  if (!items.length) throw new Error("chronologicalPeriods() requires at least one item");
  const sorted = [...items].sort((a, b) => timestampOf(a) - timestampOf(b) || idOf(a).localeCompare(idOf(b)));

  // Candidate cut timestamps at each 1/n quantile, deduplicated so a repeated
  // timestamp cannot create an empty period.
  const cuts: number[] = [];
  for (let k = 1; k < nPeriods; k++) {
    const ts = timestampOf(sorted[Math.floor((sorted.length * k) / nPeriods)]);
    if (!cuts.includes(ts)) cuts.push(ts);
  }
  const bounds = [-Infinity, ...cuts, Infinity];

  // Empty windows are dropped and the survivors renumbered: when timestamps are
  // heavily tied, a cut can land on the first distinct value and leave nothing
  // below it. An empty period would otherwise be reported as a real period.
  const out: Period<T>[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i], hi = bounds[i + 1];
    const group = sorted.filter((x) => timestampOf(x) >= lo && timestampOf(x) < hi);
    if (!group.length) continue;
    const stamps = group.map(timestampOf);
    out.push({
      index: out.length + 1,
      label: `P${out.length + 1}`,
      startTimestamp: Math.min(...stamps),
      endTimestamp: hi,
      startIso: new Date(Math.min(...stamps) * 1000).toISOString(),
      endIso: new Date(Math.max(...stamps) * 1000).toISOString(),
      items: group,
    });
  }
  return out;
}

/** Share of a group falling in each cadence, for composition reporting. */
export function cadenceMix(rows: { cadence: string }[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rows) m[r.cadence] = (m[r.cadence] ?? 0) + 1;
  return m;
}

/**
 * Weight each cadence's within-cadence deviation by that cadence's share of the
 * WHOLE population rather than of the bucket. If the aggregate deviation is a
 * composition artifact, this standardised figure collapses toward zero while
 * the raw aggregate does not.
 */
export function standardisedDeviation(
  perCadence: { cadence: string; dev: Deviation }[],
  populationMix: Record<string, number>,
): number {
  const usable = perCadence.filter((c) => c.dev.n > 0 && Number.isFinite(c.dev.deviation));
  const total = usable.reduce((a, c) => a + (populationMix[c.cadence] ?? 0), 0);
  if (!total) return NaN;
  return usable.reduce((a, c) => a + ((populationMix[c.cadence] ?? 0) / total) * c.dev.deviation, 0);
}
