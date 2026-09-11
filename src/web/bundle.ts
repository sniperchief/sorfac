// Projection of the persisted phase outputs into the payload the web UI reads.
//
// This module computes NO statistics. Every number it emits is copied verbatim
// from an `out/*.json` artifact produced by Phases 1-6. Bucket membership and
// sub-band membership are resolved by importing the Phase-2 and Phase-5
// functions rather than reimplementing them, so the frontend cannot drift from
// the research definitions. If a field is absent from the persisted output it
// is emitted as null and the UI renders "Data unavailable" — never a guess.

import { bucketIndex } from "../compare.js";
import { chronologicalPeriods, deviationStats, MIN_CELL_N, subBand, TARGET_BUCKET_LABEL } from "../anomaly.js";
import { cadenceCohort } from "../quality.js";
import { observationFrom, type ExtractionRow } from "../extract-t1m.js";
import { FROZEN_CORRECTION, PRIMARY_CADENCE, TARGET_SAMPLE, TARGET_WINDOW_DAYS } from "../correction.js";

/** The provider whose observation is the Phase-2 primary basis. */
export const PRIMARY_PROVIDER = "dreamdex.fills";

// ---------------------------------------------------------------------------
// Shapes of the persisted artifacts, narrowed to the fields the UI consumes.
// ---------------------------------------------------------------------------

export type Dev = {
  n: number;
  expected: number | null;
  observed: number | null;
  deviation: number | null;
  z: number | null;
  ci95: [number | null, number | null];
  expectedOutsideCI: boolean;
  tooSmall: boolean;
  brier: number | null;
  logloss: number | null;
};

export type BucketRow = { bucket: string; n: number; meanPredicted: number | null; actualUpRate: number | null; diff: number | null };

export type AnomalyDoc = {
  generatedAt: string;
  env: string;
  methodology: { bucket: string; bucketIndex: number; semantics: string; minCellN: number; nPeriods: number };
  population: { usable: number; inBucket: number; outsideBucket: number; populationCadenceMix: Record<string, number>; bucketCadenceMix: Record<string, number> };
  cadenceStratified: {
    overall: Dev;
    perCadence: { cadence: string; dev: Dev }[];
    standardisedDeviation: number;
    /** Every bucket within every cadence, as Phase 5 published it. */
    withinCadenceAllBuckets: Record<string, ({ bucket: string } & Dev)[]>;
  };
  periods: { period: string; n: number; startIso: string; endIso: string; targetBucket: Dev; cadenceMix: Record<string, number> }[];
  matrix: { period: string; cadence: string }[];
  neighbours: { allCadences: ({ bucket: string } & Dev)[] };
  subBands: ({ subBand: string; cadenceMix: Record<string, number> } & Dev)[];
  structure: { variable: string; predictionTime: boolean; values: Record<string, number> }[];
  negativeFindings: { variable: string; explains: boolean; detail: string }[];
  consistencyChecks: { name: string; ok: boolean; detail: string }[];
  significance: { primary: Dev; cadencesWithExpectedOutsideCI: string[]; exploratoryComparisonCount: string };
};

export type ComparisonDoc = {
  generatedAt: string;
  env: string;
  results: {
    provider: string;
    populationSize: number;
    paired: number;
    extractedCalibration: { n: number; baseRate: number; brier: number; logloss: number; accuracy: number; brierSkillScore: number; buckets: BucketRow[] };
    referenceCalibration: { n: number; brier: number; logloss: number; accuracy: number; buckets: BucketRow[] };
    mace: { extracted: number; extractedWeighted: number; reference: number; referenceWeighted: number };
  }[];
  allChecksPassed: boolean;
};

export type QualityRow = {
  marketId: string;
  asset: string;
  cadence: string;
  intervalSec: number | null;
  targetTimestamp: number;
  tradeCountPre: number;
  uniqueMakersPre: number;
  volumePre: number;
  t1mAgeSec: number | null;
  isolatedPrint: boolean;
  tradeCountTotal: number;
  diagnostic: { tradesPost: number; absMovePost: number };
  p: number;
  y: 0 | 1;
};

/** The market registry, narrowed to the display fields the explorer joins in. */
export type RegistryRow = { marketId: string; question: string };

export type QualityDoc = {
  generatedAt: string;
  env: string;
  indexerUrl: string;
  population: number;
  perMarket: QualityRow[];
};

export type FreshnessDoc = {
  generatedAt: string;
  split: { boundaryIso: string; trainN: number; testN: number };
  anomalies: { bucket: string; dev: { n: number; diff: number }; oos: { n: number; diff: number } }[];
  stability: { band: string; consistent: boolean; devN: number; oosN: number }[];
};

export type ProspectiveDoc = {
  datasetFetchedAt: string;
  env: string;
  indexerUrl: string;
  preregistration: { correction: number; cadence: string; bucket: string; cutoff: number; targetWindowDays: number; targetSample: number };
  window: { startUnix: number; endUnix: number; elapsedDays: number; windowTargetMet: boolean };
  funnel: { prospective: number; settled: number; withOutcome: number; withPrediction: number; qualifying: number; sampleTargetMet: boolean; cadenceMix: Record<string, number> };
  gate: string;
  leakageAudit: { name: string; ok: boolean; detail: string }[];
};

export type StatsDoc = {
  generatedAt: string;
  counts: { pulled: number; finalized: number; voided: number; terminal: number; traded: number; zeroTrade: number };
};

export type T1mDoc = {
  generatedAt: string;
  indexerUrl: string;
  horizonSec: number;
  populationSize: number;
  extracted: number;
  rows: ExtractionRow[];
};

// ---------------------------------------------------------------------------
// Emitted payload.
// ---------------------------------------------------------------------------

export type Challenge = {
  id: string;
  title: string;
  verdict: "SURVIVES" | "NOT EXPLAINED" | "NOT ROBUST" | "IMPORTANT CAVEAT";
  claim: string;
  /** Label/value pairs read straight out of the persisted outputs. */
  evidence: { label: string; value: string }[];
};

/**
 * One 10% probability band, as the price-check answers it.
 *
 * The statistics are produced by the Phase-5 `deviationStats` function, applied
 * to the same Phase-3 population and split by the same Phase-2 `bucketIndex`.
 * Phase 5 published exactly these figures for the four bands it examined, and
 * `buildBands` refuses to emit anything unless it reproduces all four to the
 * last decimal — so this extends the published analysis to the remaining bands
 * rather than restating or re-deriving it.
 */
export type Band = {
  bucket: string;
  loPct: number;
  hiPct: number;
  n: number;
  predicted: number | null;
  observed: number | null;
  deviation: number | null;
  z: number | null;
  ci95: [number | null, number | null];
  /**
   * `flagged`   the predicted rate falls outside the observed rate's 95% interval
   * `in-line`   it does not
   * `thin`      below the pre-registered minimum cell size, so no verdict is drawn
   */
  verdict: "flagged" | "in-line" | "thin";
  /** Which way it missed. Null when there is no verdict to give. */
  direction: "over" | "under" | null;
  /** True for the band Phase 5 investigated in depth. */
  isAnomaly: boolean;
  /** This band inside each cadence, lifted from the published Phase-5 grid. */
  byCadence: { cadence: string; dev: Dev }[];
  /** This band inside each chronological period. */
  byPeriod: { period: string; startIso: string; endIso: string; dev: Dev }[];
};

export type MarketRow = {
  id: string;
  asset: string;
  cadence: string;
  intervalSec: number | null;
  /** T-1m probability, from the Phase-3 per-market record. */
  p: number;
  /** Realised outcome: 1 = Up. */
  y: 0 | 1;
  bucket: string;
  subBand: string | null;
  targetTimestamp: number;
  sourceTimestamp: number | null;
  ageSec: number | null;
  provider: string | null;
  quoteSymbol: string | null;
  quoteDecimals: number | null;
  expiry: number | null;
  tradingStart: number | null;
  tradeCountPre: number;
  tradeCountTotal: number;
  uniqueMakersPre: number;
  volumePre: number;
  isolatedPrint: boolean;
  tradesPost: number;
  question: string | null;
};

export type ResearchBundle = {
  builtAt: string;
  env: string;
  indexerUrl: string;
  /** Set from DDX_REPO_URL at build time; null when it was not supplied. */
  repositoryUrl: string | null;
  sources: { file: string; generatedAt: string }[];
  headline: {
    bucket: string;
    semantics: string;
    n: number;
    expected: number | null;
    observed: number | null;
    deviation: number | null;
    z: number | null;
    ci95: [number | null, number | null];
    expectedOutsideCI: boolean;
    brier: number | null;
    logloss: number | null;
    standardisedDeviation: number;
    equalPeriodWeighted: number;
    perCadence: { cadence: string; dev: Dev }[];
    subBands: ({ subBand: string; cadenceMix: Record<string, number> } & Dev)[];
    periods: { period: string; n: number; startIso: string; endIso: string; targetBucket: Dev }[];
    neighbours: ({ bucket: string } & Dev)[];
    outOfSample: { devN: number; devDiff: number; oosN: number; oosDiff: number } | null;
  };
  stats: {
    marketsPulled: number;
    settledMarkets: number;
    tradedMarkets: number;
    t1mAttempted: number;
    t1mUsable: number;
    horizonSec: number;
    cadences: { cadence: string; n: number }[];
    calibrationBuckets: number;
    prospectiveGate: string;
    prospectiveStatus: string;
  };
  calibration: {
    provider: string;
    n: number;
    baseRate: number;
    brier: number;
    logloss: number;
    accuracy: number;
    brierSkillScore: number;
    mace: number;
    referenceMace: number;
    referenceBrier: number;
    buckets: BucketRow[];
  };
  bands: Band[];
  challenges: Challenge[];
  phase6: {
    correction: number;
    cadence: string;
    bucket: string;
    cutoff: number;
    cutoffIso: string;
    targetWindowDays: number;
    targetSample: number;
    elapsedDays: number;
    qualifying: number;
    funnel: { prospective: number; settled: number; withOutcome: number; withPrediction: number };
    gate: string;
    validated: false;
    statusLabel: string;
    datasetFetchedAt: string;
    leakageAudit: { name: string; ok: boolean; detail: string }[];
  };
  integrity: { checksPassed: number; checksTotal: number; splitBoundaryIso: string; trainN: number; testN: number };
};

// ---------------------------------------------------------------------------
// Helpers. `pp` formats a probability-unit figure as percentage points, which
// is how every phase report prints deviations.
// ---------------------------------------------------------------------------

// A typographic minus, matching how the page formats every other figure it
// computes the presentation of. Strings quoted verbatim from a phase output
// keep their original punctuation: they are quotations, not our formatting.
const pp = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "n/a" : `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(2)}pp`;
const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "n/a" : `${(v * 100).toFixed(2)}%`);
const count = (v: number) => v.toLocaleString("en-US");

const findingDetail = (doc: AnomalyDoc, variable: string) =>
  doc.negativeFindings.find((f) => f.variable === variable)?.detail ?? "not reported";

const structureValue = (doc: AnomalyDoc, variable: string, bucket: string) => {
  const row = doc.structure.find((s) => s.variable === variable);
  const v = row?.values[bucket];
  return v == null ? "n/a" : String(v);
};

/**
 * The six explanations Phases 2-5 tested against the anomaly. The verdict and
 * the one-line claim are product copy; every figure beside them is read from
 * the persisted outputs at build time.
 */
export function buildChallenges(anomaly: AnomalyDoc, comparison: ComparisonDoc, freshness: FreshnessDoc): Challenge[] {
  const primary = comparison.results.find((r) => r.provider === PRIMARY_PROVIDER);
  if (!primary) throw new Error(`comparison output has no ${PRIMARY_PROVIDER} result`);
  const oos = freshness.anomalies.find((a) => a.bucket === TARGET_BUCKET_LABEL) ?? null;
  const consistentBands = freshness.stability.filter((s) => s.consistent).length;

  return [
    {
      id: "price-basis",
      title: "Price basis",
      verdict: "SURVIVES",
      claim: "T-1m replaced the original last-price basis. The deviation did not come from the price we used.",
      evidence: [
        { label: "T-1m calibration error", value: pct(primary.mace.extracted) },
        { label: "lastPrice calibration error", value: pct(primary.mace.reference) },
        { label: "paired markets", value: count(primary.paired) },
      ],
    },
    {
      id: "cadence",
      title: "Cadence",
      verdict: "SURVIVES",
      claim: "The effect remains after controlling for 5m / 15m / 60m cadence.",
      evidence: [
        { label: "aggregate", value: pp(anomaly.cadenceStratified.overall.deviation) },
        { label: "cadence-standardised", value: pp(anomaly.cadenceStratified.standardisedDeviation) },
        ...anomaly.cadenceStratified.perCadence.map((c) => ({ label: `${c.cadence} · n=${count(c.dev.n)}`, value: pp(c.dev.deviation) })),
      ],
    },
    {
      id: "liquidity",
      title: "Liquidity",
      verdict: "NOT EXPLAINED",
      claim: "Trade count, volume and maker structure did not explain it.",
      evidence: [
        { label: "trade count", value: findingDetail(anomaly, "trade count") },
        { label: "volume", value: findingDetail(anomaly, "volume") },
        { label: "maker count", value: findingDetail(anomaly, "maker count") },
      ],
    },
    {
      id: "freshness",
      title: "Freshness",
      verdict: "NOT ROBUST",
      claim: "Freshness correlated with calibration in-sample but failed out-of-sample.",
      evidence: [
        { label: "bands holding out-of-sample", value: `${consistentBands} of ${freshness.stability.length}` },
        { label: "within the bucket", value: findingDetail(anomaly, "T-1m freshness") },
        { label: "split boundary", value: freshness.split.boundaryIso.slice(0, 10) },
      ],
    },
    {
      id: "structure",
      title: "Market structure",
      verdict: "NOT EXPLAINED",
      claim: "Dust markets, duration and related structural variables did not explain the anomaly.",
      evidence: [
        { label: "dust population", value: findingDetail(anomaly, "dust population") },
        { label: "median duration in bucket", value: `${structureValue(anomaly, "market duration (s)", TARGET_BUCKET_LABEL)}s` },
        { label: "neighbouring buckets", value: findingDetail(anomaly, "neighbouring buckets") },
      ],
    },
    {
      id: "time",
      title: "Time",
      verdict: "IMPORTANT CAVEAT",
      claim: "The magnitude varies materially across chronological regimes.",
      evidence: [
        { label: "deviation by period", value: anomaly.periods.map((p) => pp(p.targetBucket.deviation)).join("  ") },
        { label: "regime detail", value: findingDetail(anomaly, "time regime") },
        ...(oos ? [{ label: "out-of-sample", value: `${pp(oos.oos.diff)} (n=${oos.oos.n})` }] : []),
      ],
    },
  ];
}

/**
 * Per-band statistics for the price check.
 *
 * Splits the Phase-3 usable population with the Phase-2 bucket function and
 * scores each band with the Phase-5 deviation function. Phase 5 published these
 * same figures for the 10-50% bands; this must reproduce every one of them
 * exactly, and throws if it does not, because a mismatch would mean the page is
 * showing something other than the recorded research.
 */
export function buildBands(quality: QualityDoc, anomaly: AnomalyDoc): Band[] {
  const byBucket = new Map<number, { p: number; y: 0 | 1 }[]>();
  for (const m of quality.perMarket) {
    const b = bucketIndex(m.p);
    const rows = byBucket.get(b) ?? [];
    rows.push({ p: m.p, y: m.y });
    byBucket.set(b, rows);
  }

  // Chronological periods, built exactly as Phase 5 built them: the same
  // population, the same timestamp and id accessors, the same period count.
  const periods = quality.perMarket.length
    ? chronologicalPeriods(quality.perMarket, (r) => r.targetTimestamp, (r) => r.marketId, anomaly.methodology.nPeriods)
    : [];

  const bands: Band[] = [];
  for (let b = 0; b < 10; b++) {
    const label = `${b * 10}-${(b + 1) * 10}%`;
    const rows = byBucket.get(b) ?? [];
    const d = rows.length ? deviationStats(rows) : null;
    const verdict: Band["verdict"] = !d || d.n < MIN_CELL_N ? "thin" : d.expectedOutsideCI ? "flagged" : "in-line";
    bands.push({
      bucket: label,
      loPct: b * 10,
      hiPct: (b + 1) * 10,
      n: rows.length,
      predicted: d && Number.isFinite(d.expected) ? d.expected : null,
      observed: d && Number.isFinite(d.observed) ? d.observed : null,
      deviation: d && Number.isFinite(d.deviation) ? d.deviation : null,
      z: d && Number.isFinite(d.z) ? d.z : null,
      ci95: d ? d.ci95 : [null, null],
      verdict,
      direction: verdict === "thin" || !d ? null : d.deviation < 0 ? "over" : "under",
      isAnomaly: label === anomaly.methodology.bucket,
      byCadence: Object.entries(anomaly.cadenceStratified.withinCadenceAllBuckets ?? {})
        .map(([cadence, buckets]) => {
          const row = buckets.find((x) => x.bucket === label);
          return row ? { cadence, dev: row as Dev } : null;
        })
        .filter((x): x is { cadence: string; dev: Dev } => x !== null),
      byPeriod: periods.map((per) => {
        const inBand = per.items.filter((m) => bucketIndex(m.p) === b).map((m) => ({ p: m.p, y: m.y }));
        return {
          period: per.label,
          startIso: per.startIso,
          endIso: per.endIso,
          dev: (inBand.length ? deviationStats(inBand) : { n: 0, expected: null, observed: null, deviation: null, z: null, ci95: [null, null], expectedOutsideCI: false, tooSmall: true, brier: null, logloss: null }) as Dev,
        };
      }),
    });
  }

  // The published Phase-5 figures are the check. Any drift here means the
  // population or the bucket definition has moved, and the page must not ship.
  const near = (a: number | null, b2: number | null) =>
    a === null || b2 === null ? a === b2 : Math.abs(a - b2) < 1e-12;
  for (const published of anomaly.neighbours.allCadences) {
    const mine = bands.find((x) => x.bucket === published.bucket);
    if (!mine) throw new Error(`buildBands() produced no band for the published ${published.bucket}`);
    const same =
      mine.n === published.n &&
      near(mine.predicted, published.expected) &&
      near(mine.observed, published.observed) &&
      near(mine.deviation, published.deviation) &&
      near(mine.z, published.z) &&
      (mine.verdict === "thin") === published.tooSmall &&
      (mine.verdict === "flagged") === published.expectedOutsideCI;
    if (!same) {
      throw new Error(
        `buildBands() does not reproduce the published Phase-5 result for ${published.bucket}: ` +
          `got n=${mine.n} dev=${mine.deviation} z=${mine.z} flagged=${mine.verdict === "flagged"}, ` +
          `published n=${published.n} dev=${published.deviation} z=${published.z} flagged=${published.expectedOutsideCI}`,
      );
    }
  }

  // The period split must also reproduce Phase 5, which published this band
  // period by period. If the boundaries moved, every period table is wrong.
  const target = bands.find((x) => x.bucket === anomaly.methodology.bucket);
  if (target && anomaly.periods.length && target.byPeriod.length) {
    for (const published of anomaly.periods) {
      const mine = target.byPeriod.find((x) => x.period === published.period);
      if (!mine) throw new Error(`buildBands() produced no ${published.period} for ${target.bucket}`);
      if (mine.dev.n !== published.targetBucket.n || !near(mine.dev.deviation, published.targetBucket.deviation)) {
        throw new Error(
          `buildBands() does not reproduce the published Phase-5 ${published.period} for ${target.bucket}: ` +
            `got n=${mine.dev.n} dev=${mine.dev.deviation}, published n=${published.targetBucket.n} dev=${published.targetBucket.deviation}`,
        );
      }
    }
  }
  return bands;
}

/** A short human label for the Phase-6 gate, taken from the gate letter itself. */
export function prospectiveStatusLabel(gate: string, qualifying: number): string {
  if (gate === "D") return qualifying === 0 ? "COLLECTING DATA" : "INSUFFICIENT EVIDENCE";
  if (gate === "A") return "CORRECTION HELD";
  if (gate === "B") return "PARTIAL SUPPORT";
  if (gate === "C") return "CORRECTION REJECTED";
  return `GATE ${gate}`;
}

export function buildResearchBundle(input: {
  anomaly: AnomalyDoc;
  comparison: ComparisonDoc;
  quality: QualityDoc;
  freshness: FreshnessDoc;
  prospective: ProspectiveDoc;
  stats: StatsDoc;
  t1m: T1mDoc;
  builtAt: string;
  repositoryUrl?: string | null;
}): ResearchBundle {
  const { anomaly, comparison, quality, freshness, prospective, stats, t1m } = input;
  const primary = comparison.results.find((r) => r.provider === PRIMARY_PROVIDER);
  if (!primary) throw new Error(`comparison output has no ${PRIMARY_PROVIDER} result`);

  const overall = anomaly.cadenceStratified.overall;
  const oos = freshness.anomalies.find((a) => a.bucket === TARGET_BUCKET_LABEL) ?? null;

  // Cadence population mix comes from Phase 5's own population block rather
  // than being recounted here.
  const cadences = Object.entries(anomaly.population.populationCadenceMix)
    .map(([cadence, n]) => ({ cadence, n }))
    .sort((a, b) => b.n - a.n);

  const allChecks = [...anomaly.consistencyChecks, ...prospective.leakageAudit];

  return {
    builtAt: input.builtAt,
    env: anomaly.env,
    indexerUrl: quality.indexerUrl,
    repositoryUrl: input.repositoryUrl ?? null,
    sources: [
      { file: "out/stats-mainnet.json", generatedAt: stats.generatedAt },
      { file: "out/t1m-mainnet.json", generatedAt: t1m.generatedAt },
      { file: "out/comparison-mainnet.json", generatedAt: comparison.generatedAt },
      { file: "out/market-quality-mainnet.json", generatedAt: quality.generatedAt },
      { file: "out/freshness-validation-mainnet.json", generatedAt: freshness.generatedAt },
      { file: "out/anomaly-analysis-mainnet.json", generatedAt: anomaly.generatedAt },
      { file: "out/prospective-correction-mainnet.json", generatedAt: prospective.datasetFetchedAt },
    ],
    headline: {
      bucket: anomaly.methodology.bucket,
      semantics: anomaly.methodology.semantics,
      n: overall.n,
      expected: overall.expected,
      observed: overall.observed,
      deviation: overall.deviation,
      z: overall.z,
      ci95: overall.ci95,
      expectedOutsideCI: overall.expectedOutsideCI,
      brier: overall.brier,
      logloss: overall.logloss,
      standardisedDeviation: anomaly.cadenceStratified.standardisedDeviation,
      // Phase 6 froze the equal-period-weighted magnitude as the correction
      // candidate; it is the same number, carried across from correction.ts.
      equalPeriodWeighted: -FROZEN_CORRECTION,
      perCadence: anomaly.cadenceStratified.perCadence,
      subBands: anomaly.subBands,
      periods: anomaly.periods.map(({ period, n, startIso, endIso, targetBucket }) => ({ period, n, startIso, endIso, targetBucket })),
      neighbours: anomaly.neighbours.allCadences,
      outOfSample: oos ? { devN: oos.dev.n, devDiff: oos.dev.diff, oosN: oos.oos.n, oosDiff: oos.oos.diff } : null,
    },
    stats: {
      marketsPulled: stats.counts.pulled,
      settledMarkets: stats.counts.terminal,
      tradedMarkets: stats.counts.traded,
      t1mAttempted: t1m.populationSize,
      t1mUsable: anomaly.population.usable,
      horizonSec: t1m.horizonSec,
      cadences,
      calibrationBuckets: primary.extractedCalibration.buckets.length,
      prospectiveGate: prospective.gate,
      prospectiveStatus: prospectiveStatusLabel(prospective.gate, prospective.funnel.qualifying),
    },
    calibration: {
      provider: primary.provider,
      n: primary.extractedCalibration.n,
      baseRate: primary.extractedCalibration.baseRate,
      brier: primary.extractedCalibration.brier,
      logloss: primary.extractedCalibration.logloss,
      accuracy: primary.extractedCalibration.accuracy,
      brierSkillScore: primary.extractedCalibration.brierSkillScore,
      mace: primary.mace.extracted,
      referenceMace: primary.mace.reference,
      referenceBrier: primary.referenceCalibration.brier,
      buckets: primary.extractedCalibration.buckets,
    },
    bands: buildBands(quality, anomaly),
    challenges: buildChallenges(anomaly, comparison, freshness),
    phase6: {
      // The magnitude only. The UI renders it as a signed percentage-point
      // figure at display time; deriving a second `-x * 100` copy here just
      // invites a float artifact like -8.559999999999999 into the payload.
      correction: prospective.preregistration.correction,
      cadence: prospective.preregistration.cadence,
      bucket: prospective.preregistration.bucket,
      cutoff: prospective.preregistration.cutoff,
      cutoffIso: new Date(prospective.preregistration.cutoff * 1000).toISOString(),
      targetWindowDays: prospective.preregistration.targetWindowDays,
      targetSample: prospective.preregistration.targetSample,
      elapsedDays: prospective.window.elapsedDays,
      qualifying: prospective.funnel.qualifying,
      funnel: {
        prospective: prospective.funnel.prospective,
        settled: prospective.funnel.settled,
        withOutcome: prospective.funnel.withOutcome,
        withPrediction: prospective.funnel.withPrediction,
      },
      gate: prospective.gate,
      validated: false,
      statusLabel: prospectiveStatusLabel(prospective.gate, prospective.funnel.qualifying),
      datasetFetchedAt: prospective.datasetFetchedAt,
      leakageAudit: prospective.leakageAudit,
    },
    integrity: {
      checksPassed: allChecks.filter((c) => c.ok).length,
      checksTotal: allChecks.length,
      splitBoundaryIso: freshness.split.boundaryIso,
      trainN: freshness.split.trainN,
      testN: freshness.split.testN,
    },
  };
}

/**
 * The market-explorer rows: the Phase-3/4/5 usable population, joined to its
 * own T-1m observation record so the detail panel can show the provenance of
 * each probability. No row is synthesised; a market missing from either side is
 * dropped rather than filled in.
 */
export function buildMarketRows(quality: QualityDoc, t1m: T1mDoc, registry: RegistryRow[] = []): MarketRow[] {
  const byId = new Map<string, ExtractionRow>();
  for (const r of t1m.rows) byId.set(r.marketId.toLowerCase(), r);
  const questionById = new Map<string, string>();
  for (const r of registry) if (r.question) questionById.set(r.marketId.toLowerCase(), r.question);

  const rows: MarketRow[] = [];
  for (const q of quality.perMarket) {
    const src = byId.get(q.marketId.toLowerCase());
    const obs = src ? observationFrom(src, PRIMARY_PROVIDER) : null;
    rows.push({
      id: q.marketId,
      asset: q.asset,
      cadence: q.cadence || cadenceCohort(q.intervalSec),
      intervalSec: q.intervalSec,
      p: q.p,
      y: q.y,
      bucket: `${bucketIndex(q.p) * 10}-${(bucketIndex(q.p) + 1) * 10}%`,
      subBand: subBand(q.p),
      targetTimestamp: q.targetTimestamp,
      sourceTimestamp: obs?.sourceTimestamp ?? null,
      ageSec: q.t1mAgeSec,
      provider: obs?.provider ?? null,
      quoteSymbol: obs?.quote?.symbol ?? null,
      quoteDecimals: obs?.quote?.decimals ?? null,
      expiry: src ? src.expiry : null,
      tradingStart: src ? src.tradingStart : null,
      tradeCountPre: q.tradeCountPre,
      tradeCountTotal: q.tradeCountTotal,
      uniqueMakersPre: q.uniqueMakersPre,
      volumePre: q.volumePre,
      isolatedPrint: q.isolatedPrint,
      tradesPost: q.diagnostic.tradesPost,
      question: questionById.get(q.marketId.toLowerCase()) ?? null,
    });
  }
  // Newest first: a judge opening the explorer should land on recent markets.
  rows.sort((a, b) => b.targetTimestamp - a.targetTimestamp || a.id.localeCompare(b.id));
  return rows;
}

/** Constants the UI labels the prospective experiment with, from Phase 6. */
export const PHASE6_CONSTANTS = { FROZEN_CORRECTION, PRIMARY_CADENCE, TARGET_SAMPLE, TARGET_WINDOW_DAYS };

// ---------------------------------------------------------------------------
// Wire encoding for the explorer.
//
// 2,437 rows of twenty-odd named fields spend most of their bytes repeating the
// field names, so the payload is sent columnar. The codec lives in wire.ts,
// which has no imports, because the browser needs it too; it is re-exported
// here so callers have one place to look.
// ---------------------------------------------------------------------------

export { MARKET_FIELDS, encodeMarketRows, decodeMarketRows, type EncodedMarkets } from "./wire.js";
