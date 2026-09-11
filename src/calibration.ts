// Phase-1 calibration methodology, lifted VERBATIM from src/05-stats.ts so the
// Phase-2 numbers are directly comparable. Nothing here is new: same 10% buckets,
// same eps, same Brier / log-loss / accuracy definitions, same inclusion filters.
// If a threshold changes here, the comparison against the DreamDEX reference
// stops being valid — so it must not.

/** Fixed by Phase 1. Guards log(0) without altering any in-range probability. */
export const EPS = 1e-6;

/** Phase-1 clamp, applied only inside log loss. */
export const clamp = (v: number) => Math.min(1 - EPS, Math.max(EPS, v));

/** One market reduced to what calibration needs: a probability and an outcome. */
export type CalibrationSample = {
  marketId: string;
  /** Predicted P(Up) in (0,1). */
  p: number;
  /** Realised outcome: 1 = Up (winningOutcome 0 / YES), 0 = Down. */
  y: 0 | 1;
};

export type Bucket = {
  bucket: string;
  n: number;
  meanPredicted: number | null;
  actualUpRate: number | null;
  diff: number | null;
};

export type CalibrationResult = {
  n: number;
  baseRate: number;
  meanPredicted: number;
  brier: number;
  brierBase: number;
  brierSkillScore: number;
  logloss: number;
  loglossBase: number;
  accuracy: number;
  clampHits: number;
  buckets: Bucket[];
};

/**
 * Phase-1 inclusion test for a probability. Kept as its own function so the
 * extractor and the comparison cannot drift apart on what "valid" means.
 */
export const validProbability = (p: number | null | undefined): p is number =>
  p != null && Number.isFinite(p) && p > 0 && p < 1;

/** Phase-1 outcome mapping: winningOutcome 0 = YES = Up = 1. */
export const outcomeOf = (winningOutcome: number | null | undefined): 0 | 1 | null =>
  winningOutcome === 0 ? 1 : winningOutcome === 1 ? 0 : null;

/**
 * Ten fixed 10% buckets. The top bucket is closed on both ends, every other
 * bucket is half-open — exactly as Phase 1 computed them.
 */
export function bucketize(samples: CalibrationSample[]): Bucket[] {
  const out: Bucket[] = [];
  for (let b = 0; b < 10; b++) {
    const lo = b / 10;
    const hi = (b + 1) / 10;
    const label = `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`;
    const s = samples.filter((x) => (b === 9 ? x.p >= lo && x.p <= hi : x.p >= lo && x.p < hi));
    if (!s.length) {
      out.push({ bucket: label, n: 0, meanPredicted: null, actualUpRate: null, diff: null });
      continue;
    }
    const meanPredicted = s.reduce((a, x) => a + x.p, 0) / s.length;
    const actualUpRate = s.reduce((a, x) => a + x.y, 0) / s.length;
    out.push({ bucket: label, n: s.length, meanPredicted, actualUpRate, diff: actualUpRate - meanPredicted });
  }
  return out;
}

/** The Phase-1 score set, computed over an already-filtered sample. */
export function calibrate(samples: CalibrationSample[]): CalibrationResult {
  const n = samples.length;
  if (n === 0) throw new Error("calibrate() requires at least one sample");

  const baseRate = samples.reduce((a, x) => a + x.y, 0) / n;
  const meanPredicted = samples.reduce((a, x) => a + x.p, 0) / n;
  const brier = samples.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / n;
  const brierBase = samples.reduce((a, x) => a + (baseRate - x.y) ** 2, 0) / n;
  const logloss =
    -samples.reduce((a, x) => {
      const q = clamp(x.p);
      return a + (x.y * Math.log(q) + (1 - x.y) * Math.log(1 - q));
    }, 0) / n;
  const loglossBase = -(baseRate * Math.log(clamp(baseRate)) + (1 - baseRate) * Math.log(1 - clamp(baseRate)));
  const accuracy = samples.filter((x) => (x.p >= 0.5 ? 1 : 0) === x.y).length / n;

  return {
    n,
    baseRate,
    meanPredicted,
    brier,
    brierBase,
    brierSkillScore: 1 - brier / brierBase,
    logloss,
    loglossBase,
    accuracy,
    clampHits: samples.filter((x) => x.p !== clamp(x.p)).length,
    buckets: bucketize(samples),
  };
}
