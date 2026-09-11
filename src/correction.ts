// Phase 6: pre-registered prospective test of a FROZEN calibration correction.
//
// Every constant in this file is pre-registered. None may be fitted, tuned, or
// re-estimated from prospective data. Phases 2-5 are locked; calibration
// definitions come from src/calibration.ts and bucket membership from
// src/anomaly.ts, both unchanged.

import { EPS } from "./calibration.js";
import { inTargetBucket } from "./anomaly.js";

// ---------------------------------------------------------------------------
// PRE-REGISTERED PARAMETERS — frozen before any prospective observation.
// ---------------------------------------------------------------------------

/**
 * The correction under test, in probability units. Taken from Phase 5's
 * equal-period-weighted estimate of -8.56pp, chosen there as the conservative
 * of the two historical figures (the pooled estimate was -11.17pp).
 *
 * This value is FIXED. It must not be re-estimated from prospective data,
 * and no alternative magnitude may be evaluated in this phase.
 */
export const FROZEN_CORRECTION = 0.0856;

/**
 * Prospective cutoff: the maximum expiry in the locked Phase-1 market pull.
 * Any market expiring at or before this instant was visible to Phases 1-5 and
 * is therefore ineligible for the prospective test.
 */
export const PROSPECTIVE_CUTOFF = 1789064400; // 2026-09-10T18:20:00Z

/** The primary hypothesis is scoped to this cadence alone. */
export const PRIMARY_CADENCE = "15m";

/** Pre-registered stopping rule. Both were set before any evaluation. */
export const TARGET_WINDOW_DAYS = 30;
export const TARGET_SAMPLE = 270;

/** Bootstrap settings. Seeded so repeated runs are byte-identical. */
export const BOOTSTRAP_ITERATIONS = 10_000;
export const BOOTSTRAP_SEED = 20260910;

// ---------------------------------------------------------------------------

/**
 * Apply the frozen correction, bounded to remain a valid probability.
 * Bounds use Phase 2's EPS so a corrected value can never produce an infinite
 * log loss. Within the pre-registered 20-30% population the bound never binds,
 * since the lowest possible result is 0.20 - 0.0856 = 0.1144.
 */
export const applyCorrection = (raw: number, correction = FROZEN_CORRECTION) =>
  Math.min(1 - EPS, Math.max(EPS, raw - correction));

/** Pre-registered eligibility for the PRIMARY hypothesis test. */
export function isPrimaryEligible(m: { cadence: string; expiry: number; rawP: number | null }): boolean {
  return (
    m.expiry > PROSPECTIVE_CUTOFF &&
    m.cadence === PRIMARY_CADENCE &&
    m.rawP != null &&
    Number.isFinite(m.rawP) &&
    m.rawP > 0 &&
    m.rawP < 1 &&
    inTargetBucket(m.rawP)
  );
}

/** A market that is genuinely new relative to every prior phase. */
export const isProspective = (expiry: number) => expiry > PROSPECTIVE_CUTOFF;

// ---------------------------------------------------------------------------
// Paired comparison. Every market carries BOTH predictions, so the comparison
// is paired by construction and the baseline is never replaced.
// ---------------------------------------------------------------------------

export type Paired = {
  marketId: string;
  raw: number;
  adjusted: number;
  y: 0 | 1;
  /** Per-market squared error of each prediction. */
  brierRaw: number;
  brierAdj: number;
  loglossRaw: number;
  loglossAdj: number;
};

const clamp = (v: number) => Math.min(1 - EPS, Math.max(EPS, v));
const ll = (p: number, y: 0 | 1) => {
  const q = clamp(p);
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
};

export function pairMarket(marketId: string, raw: number, y: 0 | 1, correction = FROZEN_CORRECTION): Paired {
  const adjusted = applyCorrection(raw, correction);
  return {
    marketId, raw, adjusted, y,
    brierRaw: (raw - y) ** 2,
    brierAdj: (adjusted - y) ** 2,
    loglossRaw: ll(raw, y),
    loglossAdj: ll(adjusted, y),
  };
}

/** Deterministic PRNG so bootstrap intervals reproduce byte-for-byte. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/**
 * Percentile bootstrap CI for the mean of a paired-difference series.
 * Returns NaN bounds below three observations, where a bootstrap is meaningless.
 */
export function bootstrapMeanCI(
  diffs: number[],
  iterations = BOOTSTRAP_ITERATIONS,
  seed = BOOTSTRAP_SEED,
): [number, number] {
  if (diffs.length < 3) return [NaN, NaN];
  const rnd = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (let j = 0; j < diffs.length; j++) s += diffs[(rnd() * diffs.length) | 0];
    means.push(s / diffs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iterations * 0.025)], means[Math.floor(iterations * 0.975)]];
}

export type PairedComparison = {
  n: number;
  brierRaw: number;
  brierAdj: number;
  brierDiff: number;
  brierDiffCI: [number, number];
  loglossRaw: number;
  loglossAdj: number;
  loglossDiff: number;
  loglossDiffCI: [number, number];
  /** Markets where the adjusted prediction scored better on Brier. */
  adjustedBetterCount: number;
};

/** Negative diffs mean the adjusted prediction scored better. */
export function comparePaired(rows: Paired[]): PairedComparison {
  const brierDiffs = rows.map((r) => r.brierAdj - r.brierRaw);
  const loglossDiffs = rows.map((r) => r.loglossAdj - r.loglossRaw);
  return {
    n: rows.length,
    brierRaw: mean(rows.map((r) => r.brierRaw)),
    brierAdj: mean(rows.map((r) => r.brierAdj)),
    brierDiff: mean(brierDiffs),
    brierDiffCI: bootstrapMeanCI(brierDiffs),
    loglossRaw: mean(rows.map((r) => r.loglossRaw)),
    loglossAdj: mean(rows.map((r) => r.loglossAdj)),
    loglossDiff: mean(loglossDiffs),
    loglossDiffCI: bootstrapMeanCI(loglossDiffs),
    adjustedBetterCount: rows.filter((r) => r.brierAdj < r.brierRaw).length,
  };
}

/** Deterministic equal-count temporal thirds, ordered by expiry. */
export function temporalSegments<T>(items: T[], expiryOf: (x: T) => number, idOf: (x: T) => string, n = 3): T[][] {
  const sorted = [...items].sort((a, b) => expiryOf(a) - expiryOf(b) || idOf(a).localeCompare(idOf(b)));
  const out: T[][] = [];
  for (let i = 0; i < n; i++) {
    out.push(sorted.slice(Math.floor((sorted.length * i) / n), Math.floor((sorted.length * (i + 1)) / n)));
  }
  return out;
}
