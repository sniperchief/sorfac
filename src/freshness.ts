// Phase 4: chronological validation of the Phase-3 freshness relationship.
//
// Pure functions only. Phases 2 and 3 are locked: the calibration definitions
// come from src/calibration.ts unchanged, and the freshness bands come from
// Phase 3's own `ageCohort` — this module never redefines either.

import { calibrate, type CalibrationSample } from "./calibration.js";
import { mace } from "./compare.js";
import { ageCohort } from "./quality.js";

/** Phase-3 freshness bands, in order. `ageCohort` remains the classifier. */
export const FRESHNESS_BANDS = ["0-60s", "61-300s", "301-900s", "900s+"] as const;
export type FreshnessBand = (typeof FRESHNESS_BANDS)[number];

/** Re-exported so callers cannot accidentally introduce a second classifier. */
export const freshnessBand = ageCohort;

/**
 * Operational thresholds to evaluate, fixed in advance. Five candidates only —
 * a wide search over thresholds would be selection on noise.
 */
export const THRESHOLDS = [60, 120, 300, 600, 900] as const;

/** Fraction of the timeline used for development. Fixed before any results. */
export const TRAIN_FRACTION = 0.7;

export type Split<T> = {
  train: T[];
  test: T[];
  /** Markets with a timestamp strictly below this are development. */
  boundaryTimestamp: number;
  boundaryIso: string;
  /** Actual fraction landing in train, which can differ slightly from the target. */
  actualTrainFraction: number;
};

/**
 * Deterministic chronological split.
 *
 * Sorts by timestamp with the id as tiebreak, takes the timestamp at the target
 * index, then splits on that TIMESTAMP rather than on the index. Splitting on
 * the timestamp means no two markets sharing an instant can land on opposite
 * sides, so the boundary cannot leak a moment across the divide. The cost is
 * that the realised fraction drifts slightly from the target, which is reported.
 */
export function chronologicalSplit<T>(
  items: T[],
  timestampOf: (x: T) => number,
  idOf: (x: T) => string,
  trainFraction = TRAIN_FRACTION,
): Split<T> {
  if (!items.length) throw new Error("chronologicalSplit() requires at least one item");
  const sorted = [...items].sort((a, b) => timestampOf(a) - timestampOf(b) || idOf(a).localeCompare(idOf(b)));
  const idx = Math.floor(sorted.length * trainFraction);
  const boundaryTimestamp = timestampOf(sorted[Math.min(idx, sorted.length - 1)]);
  const train = sorted.filter((x) => timestampOf(x) < boundaryTimestamp);
  const test = sorted.filter((x) => timestampOf(x) >= boundaryTimestamp);
  return {
    train,
    test,
    boundaryTimestamp,
    boundaryIso: new Date(boundaryTimestamp * 1000).toISOString(),
    actualTrainFraction: train.length / sorted.length,
  };
}

/** A scored observation: a probability, an outcome, and its freshness. */
export type Scored = { marketId: string; p: number; y: 0 | 1; ageSec: number };

export type BandMetrics = {
  band: string;
  n: number;
  brier: number;
  /** 95% interval for the Brier score, from the SE of the mean squared error. */
  brierCI: [number, number];
  logloss: number;
  accuracy: number;
  accuracyCI: [number, number];
  meanPredicted: number;
  baseRate: number;
  mace: number;
  maceWeighted: number;
  meanAge: number;
  medianAge: number;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function medianOf(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 95% CI for a mean, via the standard error. Degenerate at n<2. */
export function meanCI(xs: number[], z = 1.96): [number, number] {
  const n = xs.length;
  if (n < 2) return [NaN, NaN];
  const m = mean(xs);
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  return [m - z * se, m + z * se];
}

/**
 * Wilson score interval for a proportion. Preferred over the Wald interval
 * because it stays inside [0,1] and behaves at small n, which matters here:
 * several segments below are genuinely thin.
 */
export function wilsonCI(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [NaN, NaN];
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - half) / d), Math.min(1, (centre + half) / d)];
}

/** Phase-2 calibration plus freshness descriptives for one group. */
export function bandMetrics(band: string, rows: Scored[]): BandMetrics | null {
  if (!rows.length) return null;
  const samples: CalibrationSample[] = rows.map((r) => ({ marketId: r.marketId, p: r.p, y: r.y }));
  const c = calibrate(samples);
  const m = mace(c.buckets);
  const sqErr = rows.map((r) => (r.p - r.y) ** 2);
  const correct = rows.filter((r) => (r.p >= 0.5 ? 1 : 0) === r.y).length;
  const ages = rows.map((r) => r.ageSec);
  return {
    band,
    n: rows.length,
    brier: c.brier,
    brierCI: meanCI(sqErr),
    logloss: c.logloss,
    accuracy: c.accuracy,
    accuracyCI: wilsonCI(correct, rows.length),
    meanPredicted: c.meanPredicted,
    baseRate: c.baseRate,
    mace: m.plain,
    maceWeighted: m.weighted,
    meanAge: mean(ages),
    medianAge: medianOf(ages),
  };
}

/** Group rows by freshness band, in the fixed band order. */
export function byBand(rows: Scored[]): BandMetrics[] {
  const g = new Map<string, Scored[]>();
  for (const r of rows) {
    const b = freshnessBand(r.ageSec);
    g.set(b, [...(g.get(b) ?? []), r]);
  }
  return FRESHNESS_BANDS.map((b) => bandMetrics(b, g.get(b) ?? [])).filter((x): x is BandMetrics => x !== null);
}

/** Does the metric rise across the ordered bands (older = worse)? */
export function isMonotonicIncreasing(xs: number[], tolerance = 0): boolean {
  for (let i = 1; i < xs.length; i++) if (xs[i] < xs[i - 1] - tolerance) return false;
  return true;
}

/** Does the metric fall across the ordered bands (older = worse for accuracy)? */
export function isMonotonicDecreasing(xs: number[], tolerance = 0): boolean {
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[i - 1] + tolerance) return false;
  return true;
}

/** True when two 95% intervals do not overlap. */
export function disjoint(a: [number, number], b: [number, number]): boolean {
  if (!Number.isFinite(a[0]) || !Number.isFinite(b[0])) return false;
  return a[1] < b[0] || b[1] < a[0];
}

export type ThresholdResult = {
  thresholdSec: number;
  /** Share of the population at or under the threshold. */
  coverage: number;
  nPass: number;
  nFail: number;
  pass: BandMetrics | null;
  fail: BandMetrics | null;
  /** Brier of the excluded group minus the retained group. Positive = threshold helps. */
  brierSeparation: number;
};

export function evaluateThreshold(rows: Scored[], thresholdSec: number): ThresholdResult {
  const pass = rows.filter((r) => r.ageSec <= thresholdSec);
  const fail = rows.filter((r) => r.ageSec > thresholdSec);
  const p = bandMetrics(`<=${thresholdSec}s`, pass);
  const f = bandMetrics(`>${thresholdSec}s`, fail);
  return {
    thresholdSec,
    coverage: rows.length ? pass.length / rows.length : NaN,
    nPass: pass.length,
    nFail: fail.length,
    pass: p,
    fail: f,
    brierSeparation: p && f ? f.brier - p.brier : NaN,
  };
}
