// Comparison logic: T-1m extracted prices against the Phase-1 DreamDEX
// reference (`lastPrice`), using the Phase-1 calibration methodology unchanged.
//
// Pure functions only, so every number in the report is unit-testable.

import { calibrate, outcomeOf, validProbability, type CalibrationResult, type CalibrationSample } from "./calibration.js";
import { observationFrom, type ExtractionRow } from "./extract-t1m.js";

export type PairedSample = {
  marketId: string;
  asset: string;
  interval: string | null;
  tradeCount: number;
  y: 0 | 1;
  /** Phase-1 basis: lastPrice, scaled. */
  reference: number;
  /** Phase-2 basis: the provider's T-1m price. */
  extracted: number;
  absDiff: number;
  /** Signed percentage difference relative to the reference. */
  pctDiff: number;
  ageSec: number | null;
  stale: boolean;
};

export type ProviderBreakdown = {
  provider: string;
  attempted: number;
  ok: number;
  stale: number;
  missing: number;
  malformed: number;
  unavailable: number;
  /** Rows that produced a usable, in-range probability. */
  usable: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
};

export type ComparisonResult = {
  provider: string;
  /** Markets in the Phase-1 calibration population. */
  populationSize: number;
  /** Rows we attempted an extraction for. */
  attempted: number;
  /** Paired samples: both bases valid on the SAME market. */
  paired: number;
  /** Population members with no usable T-1m observation. */
  missingOrFailed: number;
  agreement: {
    meanAbsDiff: number;
    medianAbsDiff: number;
    p95AbsDiff: number;
    maxAbsDiff: number;
    meanPctDiff: number;
    medianAbsPctDiff: number;
    rmse: number;
    /** Fraction of pairs where both bases fall the same side of 0.5. */
    sameSideOf50: number;
    /** Fraction of pairs identical to within 1e-9. */
    identical: number;
    /** Fraction landing in the same Phase-1 10% bucket. */
    sameBucket: number;
  };
  /** Phase-1 methodology run on the T-1m prices, over the paired set. */
  extractedCalibration: CalibrationResult;
  /** Phase-1 methodology run on lastPrice, over the SAME paired set. */
  referenceCalibration: CalibrationResult;
  /** Deltas, extracted minus reference. */
  delta: { brier: number; logloss: number; accuracy: number; baseRate: number; meanPredicted: number; brierSkillScore: number; mace: number; maceWeighted: number };
  /** Mean absolute calibration error across the Phase-1 buckets. */
  mace: { extracted: number; extractedWeighted: number; reference: number; referenceWeighted: number };
  outliers: PairedSample[];
};

/**
 * Mean absolute calibration error: the average distance between a bucket's mean
 * predicted probability and its realised Up-rate. Read straight off the Phase-1
 * buckets — it summarises the existing curve rather than defining a new rule.
 * `weighted` weights each bucket by its sample count.
 */
export function mace(buckets: { n: number; diff: number | null }[]): { plain: number; weighted: number } {
  const filled = buckets.filter((b) => b.n > 0 && b.diff != null);
  if (!filled.length) return { plain: NaN, weighted: NaN };
  const total = filled.reduce((a, b) => a + b.n, 0);
  return {
    plain: filled.reduce((a, b) => a + Math.abs(b.diff!), 0) / filled.length,
    weighted: filled.reduce((a, b) => a + b.n * Math.abs(b.diff!), 0) / total,
  };
}

const quantile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN;

/** Phase-1 bucket index for a probability. Top bucket is closed on both ends. */
export const bucketIndex = (p: number) => Math.min(9, Math.floor(p * 10));

/**
 * Build paired samples for one provider. A pair requires the SAME market to
 * carry a valid outcome, a valid reference probability, and a valid extracted
 * probability. Validity is Phase-1's `validProbability`, unchanged.
 */
export function pair(rows: ExtractionRow[], provider: string): { paired: PairedSample[]; missing: ExtractionRow[] } {
  const paired: PairedSample[] = [];
  const missing: ExtractionRow[] = [];
  for (const r of rows) {
    const y = outcomeOf(r.winningOutcome);
    const obs = observationFrom(r, provider);
    const extracted = obs?.price ?? null;
    const reference = r.referenceLastPrice;
    if (y === null || !validProbability(reference) || !validProbability(extracted)) {
      missing.push(r);
      continue;
    }
    const absDiff = Math.abs(extracted - reference);
    paired.push({
      marketId: r.marketId,
      asset: r.asset,
      interval: r.interval,
      tradeCount: r.tradeCount,
      y,
      reference,
      extracted,
      absDiff,
      pctDiff: ((extracted - reference) / reference) * 100,
      ageSec: obs?.ageSec ?? null,
      stale: obs?.status === "stale",
    });
  }
  return { paired, missing };
}

export function providerBreakdown(rows: ExtractionRow[], provider: string): ProviderBreakdown {
  const obs = rows.map((r) => observationFrom(r, provider)).filter((o): o is NonNullable<typeof o> => o !== null);
  const count = (s: string) => obs.filter((o) => o.status === s).length;
  const lat = obs.map((o) => o.latencyMs).sort((a, b) => a - b);
  return {
    provider,
    attempted: rows.length,
    ok: count("ok"),
    stale: count("stale"),
    missing: count("missing"),
    malformed: count("malformed"),
    unavailable: count("unavailable"),
    usable: obs.filter((o) => validProbability(o.price)).length,
    meanLatencyMs: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : NaN,
    p95LatencyMs: quantile(lat, 0.95),
  };
}

export function compare(rows: ExtractionRow[], provider: string, populationSize: number, topOutliers = 15): ComparisonResult {
  const { paired, missing } = pair(rows, provider);
  if (!paired.length) throw new Error(`no paired samples for provider ${provider}`);

  const abs = paired.map((s) => s.absDiff).sort((a, b) => a - b);
  const absPct = paired.map((s) => Math.abs(s.pctDiff)).sort((a, b) => a - b);

  const extractedSamples: CalibrationSample[] = paired.map((s) => ({ marketId: s.marketId, p: s.extracted, y: s.y }));
  const referenceSamples: CalibrationSample[] = paired.map((s) => ({ marketId: s.marketId, p: s.reference, y: s.y }));
  const extractedCalibration = calibrate(extractedSamples);
  const referenceCalibration = calibrate(referenceSamples);

  return {
    provider,
    populationSize,
    attempted: rows.length,
    paired: paired.length,
    missingOrFailed: missing.length,
    agreement: {
      meanAbsDiff: abs.reduce((a, b) => a + b, 0) / abs.length,
      medianAbsDiff: quantile(abs, 0.5),
      p95AbsDiff: quantile(abs, 0.95),
      maxAbsDiff: abs[abs.length - 1],
      meanPctDiff: paired.reduce((a, s) => a + s.pctDiff, 0) / paired.length,
      medianAbsPctDiff: quantile(absPct, 0.5),
      rmse: Math.sqrt(paired.reduce((a, s) => a + s.absDiff ** 2, 0) / paired.length),
      sameSideOf50: paired.filter((s) => s.extracted >= 0.5 === s.reference >= 0.5).length / paired.length,
      identical: paired.filter((s) => s.absDiff < 1e-9).length / paired.length,
      sameBucket: paired.filter((s) => bucketIndex(s.extracted) === bucketIndex(s.reference)).length / paired.length,
    },
    extractedCalibration,
    referenceCalibration,
    delta: {
      brier: extractedCalibration.brier - referenceCalibration.brier,
      logloss: extractedCalibration.logloss - referenceCalibration.logloss,
      accuracy: extractedCalibration.accuracy - referenceCalibration.accuracy,
      baseRate: extractedCalibration.baseRate - referenceCalibration.baseRate,
      meanPredicted: extractedCalibration.meanPredicted - referenceCalibration.meanPredicted,
      brierSkillScore: extractedCalibration.brierSkillScore - referenceCalibration.brierSkillScore,
      mace: mace(extractedCalibration.buckets).plain - mace(referenceCalibration.buckets).plain,
      maceWeighted: mace(extractedCalibration.buckets).weighted - mace(referenceCalibration.buckets).weighted,
    },
    mace: {
      extracted: mace(extractedCalibration.buckets).plain,
      extractedWeighted: mace(extractedCalibration.buckets).weighted,
      reference: mace(referenceCalibration.buckets).plain,
      referenceWeighted: mace(referenceCalibration.buckets).weighted,
    },
    outliers: [...paired].sort((a, b) => b.absDiff - a.absDiff).slice(0, topOutliers),
  };
}

/** Timestamp / data-quality checks that should hold on every extraction row. */
export type QualityIssue = { marketId: string; provider: string | null; issue: string; detail: string };

export function qualityIssues(rows: ExtractionRow[]): QualityIssue[] {
  const out: QualityIssue[] = [];
  for (const r of rows) {
    if (r.targetTimestamp !== r.expiry - 60) out.push({ marketId: r.marketId, provider: null, issue: "bad-horizon", detail: `target ${r.targetTimestamp} != expiry-60 ${r.expiry - 60}` });
    if (r.targetTimestamp < r.tradingStart) out.push({ marketId: r.marketId, provider: null, issue: "target-before-window", detail: `target ${r.targetTimestamp} < tradingStart ${r.tradingStart}` });
    if (r.referenceLastTradeAt != null && r.referenceLastTradeAt > r.expiry) out.push({ marketId: r.marketId, provider: null, issue: "trade-after-expiry", detail: `lastTradeAt ${r.referenceLastTradeAt} > expiry ${r.expiry}` });
    for (const o of r.observations) {
      if (o.sourceTimestamp != null && o.sourceTimestamp > o.targetTimestamp) out.push({ marketId: r.marketId, provider: o.provider, issue: "lookahead", detail: `source ${o.sourceTimestamp} > target ${o.targetTimestamp}` });
      if (o.sourceTimestamp != null && o.sourceTimestamp < r.tradingStart) out.push({ marketId: r.marketId, provider: o.provider, issue: "source-before-window", detail: `source ${o.sourceTimestamp} < tradingStart ${r.tradingStart}` });
      if (o.ageSec != null && o.ageSec < 0) out.push({ marketId: r.marketId, provider: o.provider, issue: "negative-age", detail: `ageSec ${o.ageSec}` });
      if (o.status === "malformed") out.push({ marketId: r.marketId, provider: o.provider, issue: "malformed-price", detail: o.error ?? "" });
      if (o.status === "unavailable") out.push({ marketId: r.marketId, provider: o.provider, issue: "source-unavailable", detail: o.error ?? "" });
    }
  }
  return out;
}
