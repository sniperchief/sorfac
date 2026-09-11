// Tests for the presentation layer.
//
// The rule these enforce is that the web layer computes nothing. Every figure
// it shows must be traceable to a persisted phase output, and anything it
// cannot read must surface as "Data unavailable" rather than as a number. They
// use synthetic *documents* — the shapes the loaders read — which is not the
// same as synthetic market data: no test here asserts a research result.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import {
  buildBands,
  buildChallenges,
  buildMarketRows,
  buildResearchBundle,
  decodeMarketRows,
  encodeMarketRows,
  prospectiveStatusLabel,
  PRIMARY_PROVIDER,
  type AnomalyDoc,
  type ComparisonDoc,
  type Dev,
  type FreshnessDoc,
  type MarketRow,
  type ProspectiveDoc,
  type QualityDoc,
  type StatsDoc,
  type T1mDoc,
} from "../web/bundle.js";
import { createApp, listenFailureMessage, parseLiveLimit, projectLiveMarket, resolveStatic } from "../web/server.js";
import { FROZEN_CORRECTION } from "../correction.js";
import { UNAVAILABLE, duration, int, pct, pp, shortId, signed, stampUnix } from "../../web/src/lib/format.js";
import { ALL, EMPTY_FILTERS, filterMarkets, pageCount, pageOf } from "../../web/src/lib/filter.js";

// ---------------------------------------------------------------------------
// Fixtures: the SHAPES of the persisted documents, with recognisable sentinel
// numbers. If the projection ever recomputes a value instead of copying it, the
// sentinel stops coming through and these tests fail.
// ---------------------------------------------------------------------------

const dev = (over: Partial<Dev> = {}): Dev => ({
  n: 172,
  expected: 0.2454,
  observed: 0.1337,
  deviation: -0.1117,
  z: -3.4048,
  ci95: [0.0907, 0.1926],
  expectedOutsideCI: true,
  tooSmall: false,
  brier: 0.1285,
  logloss: 0.4314,
  ...over,
});

const anomalyDoc = (): AnomalyDoc => ({
  generatedAt: "2026-09-10T22:08:17.316Z",
  env: "mainnet",
  methodology: { bucket: "20-30%", bucketIndex: 2, semantics: "p in [0.20,0.30)", minCellN: 20, nPeriods: 4 },
  population: {
    usable: 2437,
    inBucket: 172,
    outsideBucket: 2265,
    populationCadenceMix: { "15m": 1765, "60m": 379, "5m": 293 },
    bucketCadenceMix: { "15m": 122, "60m": 29, "5m": 21 },
  },
  cadenceStratified: {
    overall: dev(),
    perCadence: [
      { cadence: "5m", dev: dev({ n: 21, deviation: -0.1006, tooSmall: false }) },
      { cadence: "15m", dev: dev({ n: 122, deviation: -0.1082 }) },
      { cadence: "60m", dev: dev({ n: 29, deviation: -0.1347 }) },
    ],
    standardisedDeviation: -0.11139,
    withinCadenceAllBuckets: {},
  },
  periods: [
    { period: "P1", n: 609, startIso: "2026-07-22T15:44:00.000Z", endIso: "2026-08-10T08:14:00.000Z", targetBucket: dev({ n: 25, deviation: 0.0349 }), cadenceMix: {} },
    { period: "P2", n: 609, startIso: "2026-08-10T08:59:00.000Z", endIso: "2026-08-25T06:14:00.000Z", targetBucket: dev({ n: 63, deviation: -0.1838 }), cadenceMix: {} },
    { period: "P3", n: 608, startIso: "2026-08-25T06:29:00.000Z", endIso: "2026-09-02T20:44:00.000Z", targetBucket: dev({ n: 37, deviation: -0.0591 }), cadenceMix: {} },
    { period: "P4", n: 611, startIso: "2026-09-02T20:59:00.000Z", endIso: "2026-09-10T18:04:00.000Z", targetBucket: dev({ n: 47, deviation: -0.1346 }), cadenceMix: {} },
  ],
  matrix: [],
  neighbours: { allCadences: [{ bucket: "20-30%", ...dev() }] },
  subBands: [{ subBand: "20-22.5%", cadenceMix: {}, ...dev({ n: 54, deviation: -0.0993 }) }],
  structure: [{ variable: "market duration (s)", predictionTime: true, values: { "20-30%": 900 } }],
  negativeFindings: [
    { variable: "cadence", explains: false, detail: "aggregate -11.17pp vs cadence-standardised -11.14pp" },
    { variable: "time regime", explains: true, detail: "deviation sign by period: + - - -" },
    { variable: "dust population", explains: false, detail: "dust share 3.49% in bucket vs 15.54% outside" },
    { variable: "T-1m freshness", explains: false, detail: "fresh -8.52pp (n=87) vs stale -13.89pp (n=85)" },
    { variable: "maker count", explains: false, detail: "multi-maker share 2.33% of bucket" },
    { variable: "trade count", explains: false, detail: "median pre-T-1m trades 1 in bucket vs 2 outside" },
    { variable: "volume", explains: false, detail: "median pre-T-1m volume 3.063 in bucket vs 3.682 outside" },
    { variable: "neighbouring buckets", explains: false, detail: "1 of the four 10-50% buckets deviate below -5pp" },
  ],
  consistencyChecks: [
    { name: "bucket and outside partition the population", ok: true, detail: "" },
    { name: "every outcome is 0 or 1", ok: true, detail: "" },
  ],
  significance: { primary: dev(), cadencesWithExpectedOutsideCI: ["15m"], exploratoryComparisonCount: "40+" },
});

const comparisonDoc = (): ComparisonDoc => ({
  generatedAt: "2026-09-10T22:08:01.677Z",
  env: "mainnet",
  results: [
    {
      provider: PRIMARY_PROVIDER,
      populationSize: 3198,
      paired: 2437,
      extractedCalibration: {
        n: 2437,
        baseRate: 0.4616,
        brier: 0.1216,
        logloss: 0.3839,
        accuracy: 0.8202,
        brierSkillScore: 0.5103,
        buckets: [
          { bucket: "10-20%", n: 326, meanPredicted: 0.1459, actualUpRate: 0.138, diff: -0.0079 },
          { bucket: "20-30%", n: 172, meanPredicted: 0.2454, actualUpRate: 0.1337, diff: -0.1117 },
        ],
      },
      referenceCalibration: { n: 2437, brier: 0.1076, logloss: 0.3471, accuracy: 0.8416, buckets: [] },
      mace: { extracted: 0.0393, extractedWeighted: 0.0327, reference: 0.0516, referenceWeighted: 0.0451 },
    },
  ],
  allChecksPassed: true,
});

const qualityRow = (over: Partial<QualityDoc["perMarket"][number]> = {}): QualityDoc["perMarket"][number] => ({
  marketId: "0x00000000000000000000000000000000000000000000000000000000000000e3",
  asset: "BTC",
  cadence: "15m",
  intervalSec: 900,
  targetTimestamp: 1784735040,
  tradeCountPre: 4,
  uniqueMakersPre: 2,
  volumePre: 0.000984,
  t1mAgeSec: 0,
  isolatedPrint: false,
  tradeCountTotal: 5,
  diagnostic: { tradesPost: 1, absMovePost: 0 },
  p: 0.245,
  y: 0,
  ...over,
});

const qualityDoc = (rows = [qualityRow()]): QualityDoc => ({
  generatedAt: "2026-09-10T22:08:07.454Z",
  env: "mainnet",
  indexerUrl: "https://prd.smk.somnia.host/v1/graphql",
  population: rows.length,
  perMarket: rows,
});

const t1mDoc = (): T1mDoc => ({
  generatedAt: "2026-09-10T19:53:00.000Z",
  indexerUrl: "https://prd.smk.somnia.host/v1/graphql",
  horizonSec: 60,
  populationSize: 3198,
  extracted: 3198,
  rows: [
    {
      marketId: "0x00000000000000000000000000000000000000000000000000000000000000e3",
      asset: "BTC",
      interval: "15m",
      intervalSec: 900,
      tradingStart: 1784734200,
      expiry: 1784735100,
      targetTimestamp: 1784735040,
      tradeCount: 5,
      winningOutcome: 1,
      referenceLastPrice: 0.005,
      referenceLastTradeAt: 1784735052,
      windowAdmitsHorizon: true,
      observations: [
        {
          provider: PRIMARY_PROVIDER,
          marketId: "0x00000000000000000000000000000000000000000000000000000000000000e3",
          asset: "BTC",
          quote: { token: "0xtoken", symbol: "USDso", decimals: 18 },
          targetTimestamp: 1784735040,
          price: 0.245,
          rawPrice: "245000000000000000",
          sourceTimestamp: 1784735000,
          retrievalTimestamp: 1789066318283,
          latencyMs: 832,
          ageSec: 40,
          ageFraction: 0.044,
          status: "ok",
          ok: true,
          error: null,
        },
      ],
    },
  ] as unknown as T1mDoc["rows"],
});

const freshnessDoc = (): FreshnessDoc => ({
  generatedAt: "2026-09-10T22:08:12.494Z",
  split: { boundaryIso: "2026-09-01T18:19:00.000Z", trainN: 1705, testN: 732 },
  anomalies: [{ bucket: "20-30%", dev: { n: 119, diff: -0.105 }, oos: { n: 53, diff: -0.1266 } }],
  stability: [
    { band: "0-60s", consistent: false, devN: 347, oosN: 257 },
    { band: "61-300s", consistent: true, devN: 645, oosN: 294 },
    { band: "301-900s", consistent: false, devN: 554, oosN: 155 },
    { band: "900s+", consistent: false, devN: 159, oosN: 26 },
  ],
});

const prospectiveDoc = (over: Partial<ProspectiveDoc> = {}): ProspectiveDoc => ({
  datasetFetchedAt: "2026-09-10T19:55:22.000Z",
  env: "mainnet",
  indexerUrl: "https://prd.smk.somnia.host/v1/graphql",
  preregistration: { correction: FROZEN_CORRECTION, cadence: "15m", bucket: "[0.20,0.30)", cutoff: 1789064400, targetWindowDays: 30, targetSample: 270 },
  window: { startUnix: 1789064400, endUnix: 1789070100, elapsedDays: 0.0659, windowTargetMet: false },
  funnel: { prospective: 52, settled: 50, withOutcome: 50, withPrediction: 2, qualifying: 0, sampleTargetMet: false, cadenceMix: { "15m": 2 } },
  gate: "D",
  leakageAudit: [
    { name: "correction is exactly the pre-registered value", ok: true, detail: "0.0856" },
    { name: "eligibility does not read the outcome", ok: true, detail: "" },
  ],
  ...over,
});

const statsDoc = (): StatsDoc => ({
  generatedAt: "2026-09-10T18:26:39.616Z",
  counts: { pulled: 16418, finalized: 16397, voided: 19, terminal: 16416, traded: 3199, zeroTrade: 13217 },
});

/**
 * An anomaly document with no published rows to reproduce.
 *
 * `buildBands` cross-checks its output against the published Phase-5 bands and
 * periods, and throws on any mismatch — which is the point of it. These
 * fixtures pair a tiny population with a document describing 172 markets over
 * four periods, so there is nothing for it to reproduce and both sets of
 * published rows are dropped. The guards themselves are exercised directly in
 * the band suite below.
 */
const anomalyDocNoBands = (): AnomalyDoc => {
  const a = anomalyDoc();
  a.neighbours.allCadences = [];
  a.periods = [];
  return a;
};

const bundle = (over: { prospective?: ProspectiveDoc } = {}) =>
  buildResearchBundle({
    anomaly: anomalyDocNoBands(),
    comparison: comparisonDoc(),
    quality: qualityDoc(),
    freshness: freshnessDoc(),
    prospective: over.prospective ?? prospectiveDoc(),
    stats: statsDoc(),
    t1m: t1mDoc(),
    builtAt: "2026-09-10T23:00:00.000Z",
  });

// ---------------------------------------------------------------------------

describe("research bundle: values are copied, never recomputed", () => {
  test("the headline is the Phase-5 aggregate, field for field", () => {
    const a = anomalyDoc();
    const h = bundle().headline;
    assert.equal(h.n, a.cadenceStratified.overall.n);
    assert.equal(h.expected, a.cadenceStratified.overall.expected);
    assert.equal(h.observed, a.cadenceStratified.overall.observed);
    assert.equal(h.deviation, a.cadenceStratified.overall.deviation);
    assert.equal(h.z, a.cadenceStratified.overall.z);
    assert.deepEqual(h.ci95, a.cadenceStratified.overall.ci95);
    assert.equal(h.standardisedDeviation, a.cadenceStratified.overall.deviation === null ? null : -0.11139);
  });

  test("changing the persisted deviation changes the displayed one", () => {
    const a = anomalyDocNoBands();
    a.cadenceStratified.overall = dev({ deviation: -0.0421, z: -1.2 });
    const b = buildResearchBundle({
      anomaly: a,
      comparison: comparisonDoc(),
      quality: qualityDoc(),
      freshness: freshnessDoc(),
      prospective: prospectiveDoc(),
      stats: statsDoc(),
      t1m: t1mDoc(),
      builtAt: "x",
    });
    assert.equal(b.headline.deviation, -0.0421);
    assert.equal(b.headline.z, -1.2);
  });

  test("the calibration curve is the Phase-2 bucket list unchanged", () => {
    const c = comparisonDoc();
    assert.deepEqual(bundle().calibration.buckets, c.results[0].extractedCalibration.buckets);
  });

  test("population statistics come from the phase outputs, not from a count of rows", () => {
    const s = bundle().stats;
    assert.equal(s.marketsPulled, 16418);
    assert.equal(s.tradedMarkets, 3199);
    assert.equal(s.t1mUsable, 2437);
    assert.equal(s.horizonSec, 60);
    assert.deepEqual(
      s.cadences.map((c) => c.cadence),
      ["15m", "60m", "5m"],
    );
  });

  test("every source file is listed with the timestamp it was generated at", () => {
    const b = bundle();
    assert.equal(b.sources.length, 7);
    for (const s of b.sources) {
      assert.match(s.file, /^out\/.+\.json$/);
      assert.ok(!Number.isNaN(Date.parse(s.generatedAt)), `${s.file} has an unparseable timestamp`);
    }
  });

  test("a comparison output without the primary provider is fatal, not silently defaulted", () => {
    const c = comparisonDoc();
    c.results = [];
    assert.throws(
      () =>
        buildResearchBundle({
          anomaly: anomalyDocNoBands(),
          comparison: c,
          quality: qualityDoc(),
          freshness: freshnessDoc(),
          prospective: prospectiveDoc(),
          stats: statsDoc(),
          t1m: t1mDoc(),
          builtAt: "x",
        }),
      /dreamdex\.fills/,
    );
  });
});

describe("Phase 6 is never presented as validated", () => {
  test("validated is false and the correction is the frozen constant", () => {
    const p = bundle().phase6;
    assert.equal(p.validated, false);
    assert.equal(p.correction, FROZEN_CORRECTION);
    // Rendered, not stored, so no float artifact reaches the page.
    assert.equal(pp(-p.correction), "−8.56pp");
  });

  test("gate D with no qualifying markets reads as collecting data", () => {
    assert.equal(bundle().phase6.statusLabel, "COLLECTING DATA");
    assert.equal(prospectiveStatusLabel("D", 0), "COLLECTING DATA");
    assert.equal(prospectiveStatusLabel("D", 12), "INSUFFICIENT EVIDENCE");
  });

  test("other gates get their own label and none of them says validated", () => {
    for (const g of ["A", "B", "C", "D", "Z"]) {
      const label = prospectiveStatusLabel(g, 300);
      assert.doesNotMatch(label, /valid/i, `gate ${g} label claims validation`);
    }
  });

  test("the window and funnel are the persisted ones, including a zero", () => {
    const p = bundle({ prospective: prospectiveDoc() }).phase6;
    assert.equal(p.qualifying, 0);
    assert.equal(p.targetWindowDays, 30);
    assert.equal(p.targetSample, 270);
    assert.equal(p.funnel.prospective, 52);
    assert.equal(p.funnel.withPrediction, 2);
  });

  test("a different persisted window is reflected rather than hardcoded", () => {
    const d = prospectiveDoc();
    d.preregistration.targetWindowDays = 90;
    d.funnel.qualifying = 41;
    assert.equal(bundle({ prospective: d }).phase6.targetWindowDays, 90);
    assert.equal(bundle({ prospective: d }).phase6.qualifying, 41);
  });
});

describe("the robustness cards", () => {
  test("all six explanations are present with the recorded verdicts", () => {
    const cs = buildChallenges(anomalyDoc(), comparisonDoc(), freshnessDoc());
    assert.deepEqual(
      cs.map((c) => [c.id, c.verdict]),
      [
        ["price-basis", "SURVIVES"],
        ["cadence", "SURVIVES"],
        ["liquidity", "NOT EXPLAINED"],
        ["freshness", "NOT ROBUST"],
        ["structure", "NOT EXPLAINED"],
        ["time", "IMPORTANT CAVEAT"],
      ],
    );
  });

  test("every card carries evidence, and none of it is empty or a placeholder", () => {
    for (const c of buildChallenges(anomalyDoc(), comparisonDoc(), freshnessDoc())) {
      assert.ok(c.evidence.length >= 3, `${c.id} has too little evidence`);
      for (const e of c.evidence) {
        assert.ok(e.value.length > 0, `${c.id}/${e.label} is empty`);
        assert.doesNotMatch(e.value, /undefined|NaN|\[object/, `${c.id}/${e.label} leaked a placeholder`);
      }
    }
  });

  test("figures the page formats itself use a typographic minus", () => {
    const card = buildChallenges(anomalyDoc(), comparisonDoc(), freshnessDoc()).find((c) => c.id === "cadence")!;
    assert.equal(card.evidence[0].value, "−11.17pp");
    assert.equal(card.evidence[1].value, "−11.14pp");
  });

  test("the freshness card counts the bands that actually held out-of-sample", () => {
    const card = buildChallenges(anomalyDoc(), comparisonDoc(), freshnessDoc()).find((c) => c.id === "freshness")!;
    assert.equal(card.evidence[0].value, "1 of 4");
  });

  test("a missing negative finding degrades to a stated absence, not a number", () => {
    const a = anomalyDoc();
    a.negativeFindings = [];
    const card = buildChallenges(a, comparisonDoc(), freshnessDoc()).find((c) => c.id === "liquidity")!;
    for (const e of card.evidence) assert.equal(e.value, "not reported");
  });
});

describe("price-check bands", () => {
  // A population with known contents, so the band statistics are checkable.
  const pop = (spec: { p: number; y: 0 | 1 }[]) =>
    qualityDoc(spec.map((x, i) => qualityRow({ marketId: `0x${i}`, p: x.p, y: x.y })));

  test("there is exactly one band per fixed 10% bucket, in order", () => {
    const bands = buildBands(pop([{ p: 0.25, y: 0 }]), anomalyDocNoBands());
    assert.equal(bands.length, 10);
    assert.deepEqual(
      bands.map((b) => b.bucket),
      ["0-10%", "10-20%", "20-30%", "30-40%", "40-50%", "50-60%", "60-70%", "70-80%", "80-90%", "90-100%"],
    );
  });

  test("a band below the pre-registered minimum draws no verdict", () => {
    const a = anomalyDocNoBands();
    // Nineteen markets is one short of the minimum cell size of twenty.
    const rows = Array.from({ length: 19 }, () => ({ p: 0.25, y: 0 as const }));
    const band = buildBands(pop(rows), a).find((b) => b.bucket === "20-30%")!;
    assert.equal(band.n, 19);
    assert.equal(band.verdict, "thin");
    assert.equal(band.direction, null, "a thin band must not imply a direction");
  });

  test("an empty band reports zero and no verdict rather than a neutral-looking result", () => {
    const band = buildBands(pop([{ p: 0.25, y: 0 }]), anomalyDocNoBands()).find((b) => b.bucket === "80-90%")!;
    assert.equal(band.n, 0);
    assert.equal(band.verdict, "thin");
    assert.equal(band.predicted, null);
    assert.equal(band.observed, null);
    assert.equal(band.deviation, null);
  });

  test("a band that delivers what it promised is in line, in either direction", () => {
    const a = anomalyDocNoBands();
    // Twenty-five markets at 0.24, of which six resolve Up: 24% observed.
    const rows = Array.from({ length: 25 }, (_, i) => ({ p: 0.24, y: (i < 6 ? 1 : 0) as 0 | 1 }));
    const band = buildBands(pop(rows), a).find((b) => b.bucket === "20-30%")!;
    assert.equal(band.verdict, "in-line");
    assert.equal(band.observed, 6 / 25);
  });

  test("a band that badly misses its own prediction is flagged", () => {
    const a = anomalyDocNoBands();
    // Sixty markets priced at 0.25 that never once resolve Up.
    const rows = Array.from({ length: 60 }, () => ({ p: 0.25, y: 0 as const }));
    const band = buildBands(pop(rows), a).find((b) => b.bucket === "20-30%")!;
    assert.equal(band.verdict, "flagged");
    assert.equal(band.direction, "over", "paying more than it was worth is an over-priced band");
  });

  test("direction is under when outcomes beat the price", () => {
    const a = anomalyDocNoBands();
    const rows = Array.from({ length: 60 }, () => ({ p: 0.25, y: 1 as const }));
    const band = buildBands(pop(rows), a).find((b) => b.bucket === "20-30%")!;
    assert.equal(band.verdict, "flagged");
    assert.equal(band.direction, "under");
  });

  test("it refuses to ship if it cannot reproduce a published Phase-5 band", () => {
    const a = anomalyDoc();
    // The published row claims a result this population cannot produce.
    a.neighbours.allCadences = [{ bucket: "20-30%", ...dev({ n: 999, deviation: -0.5 }) }];
    assert.throws(() => buildBands(pop([{ p: 0.25, y: 0 }]), a), /does not reproduce the published Phase-5 result/);
  });

  test("it refuses to ship if the period split no longer reproduces Phase 5", () => {
    const a = anomalyDocNoBands();
    a.periods = [
      { period: "P1", n: 609, startIso: "2026-07-22T15:44:00.000Z", endIso: "2026-08-10T08:14:00.000Z", targetBucket: dev({ n: 25, deviation: 0.0349 }), cadenceMix: {} },
    ];
    assert.throws(() => buildBands(pop([{ p: 0.25, y: 0 }]), a), /does not reproduce the published Phase-5 P1/);
  });

  test("the anomaly band is marked as the one Phase 5 investigated", () => {
    const bands = buildBands(pop([{ p: 0.25, y: 0 }]), anomalyDocNoBands());
    assert.deepEqual(bands.filter((b) => b.isAnomaly).map((b) => b.bucket), ["20-30%"]);
  });
});

describe("market projection", () => {
  test("one row per per-market record, joined to its own T-1m observation", () => {
    const rows = buildMarketRows(qualityDoc(), t1mDoc());
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.p, 0.245);
    assert.equal(r.y, 0);
    assert.equal(r.bucket, "20-30%");
    assert.equal(r.subBand, "22.5-25%");
    assert.equal(r.provider, PRIMARY_PROVIDER);
    assert.equal(r.sourceTimestamp, 1784735000);
    assert.equal(r.quoteSymbol, "USDso");
    assert.equal(r.expiry, 1784735100);
  });

  test("the bucket label comes from the Phase-2 bucket function", () => {
    const rows = buildMarketRows(
      qualityDoc([qualityRow({ p: 0.2999, marketId: "0xa" }), qualityRow({ p: 0.3, marketId: "0xb" }), qualityRow({ p: 1, marketId: "0xc" })]),
      t1mDoc(),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get("0xa")!.bucket, "20-30%");
    assert.equal(byId.get("0xb")!.bucket, "30-40%");
    assert.equal(byId.get("0xc")!.bucket, "90-100%");
    assert.equal(byId.get("0xb")!.subBand, null);
  });

  test("a market with no matching T-1m row keeps null provenance rather than inventing it", () => {
    const rows = buildMarketRows(qualityDoc([qualityRow({ marketId: "0xdeadbeef" })]), t1mDoc());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, null);
    assert.equal(rows[0].sourceTimestamp, null);
    assert.equal(rows[0].expiry, null);
    assert.equal(rows[0].quoteSymbol, null);
  });

  test("the question text is joined from the registry and is null when absent", () => {
    const q = qualityDoc();
    const withQ = buildMarketRows(q, t1mDoc(), [{ marketId: q.perMarket[0].marketId.toUpperCase(), question: "BTC closes at or above its opening price" }]);
    assert.equal(withQ[0].question, "BTC closes at or above its opening price");
    assert.equal(buildMarketRows(q, t1mDoc(), [])[0].question, null);
  });

  test("an empty population projects to an empty list, never to a sample row", () => {
    assert.deepEqual(buildMarketRows(qualityDoc([]), t1mDoc()), []);
  });

  test("rows come back newest first", () => {
    const rows = buildMarketRows(
      qualityDoc([
        qualityRow({ marketId: "0x1", targetTimestamp: 100 }),
        qualityRow({ marketId: "0x2", targetTimestamp: 300 }),
        qualityRow({ marketId: "0x3", targetTimestamp: 200 }),
      ]),
      t1mDoc(),
    );
    assert.deepEqual(rows.map((r) => r.id), ["0x2", "0x3", "0x1"]);
  });
});

describe("wire codec", () => {
  test("a decoded payload equals what was encoded", () => {
    const rows = buildMarketRows(
      qualityDoc([qualityRow({ marketId: "0x1" }), qualityRow({ marketId: "0x2", p: 0.81, y: 1, t1mAgeSec: null })]),
      t1mDoc(),
    );
    assert.deepEqual(decodeMarketRows<MarketRow>(encodeMarketRows(rows)), rows);
  });

  test("null fields survive the round trip as null, not as zero or absent", () => {
    const rows = buildMarketRows(qualityDoc([qualityRow({ marketId: "0xzz", t1mAgeSec: null })]), t1mDoc());
    const back = decodeMarketRows<MarketRow>(encodeMarketRows(rows))[0];
    assert.equal(back.ageSec, null);
    assert.equal(back.provider, null);
    assert.ok("expiry" in back);
  });
});

describe("live market projection", () => {
  const raw = (over: Record<string, unknown> = {}) =>
    ({
      marketId: "0x40ab",
      asset: "BTC",
      question: "BTC closes at or above its opening price",
      interval: "15m",
      intervalSec: "900",
      tradingStart: "1789078500",
      expiry: "1789079400",
      status: "Trading",
      tradeCount: "2",
      lastPrice: "680000000000000000",
      lastTradeAt: "1789079012",
      collateral: "0xcollateral",
      quoteDecimals: 18,
      ...over,
    }) as never;

  test("price is scaled by the market's own decimals", () => {
    assert.equal(projectLiveMarket(raw()).impliedProbability, 0.68);
    assert.equal(projectLiveMarket(raw({ lastPrice: "680000", quoteDecimals: 6 })).impliedProbability, 0.68);
  });

  test("an untraded market has no implied probability rather than a default", () => {
    assert.equal(projectLiveMarket(raw({ lastPrice: null, lastTradeAt: null, tradeCount: "0" })).impliedProbability, null);
  });

  test("a price outside (0,1) is rejected rather than clamped", () => {
    assert.equal(projectLiveMarket(raw({ lastPrice: "0" })).impliedProbability, null);
    assert.equal(projectLiveMarket(raw({ lastPrice: "1000000000000000000" })).impliedProbability, null);
  });

  test("cadence falls back to the Phase-3 cohort when the indexer omits the label", () => {
    assert.equal(projectLiveMarket(raw({ interval: null })).cadence, "15m");
    assert.equal(projectLiveMarket(raw({ interval: null, intervalSec: "300" })).cadence, "5m");
  });

  test("the limit is bounded and a bad value falls back to the default", () => {
    assert.equal(parseLiveLimit("10"), 10);
    assert.equal(parseLiveLimit("100000"), 50);
    assert.equal(parseLiveLimit("abc"), 24);
    assert.equal(parseLiveLimit(null), 24);
    assert.equal(parseLiveLimit("-3"), 24);
  });
});

describe("the server", () => {
  test("static paths cannot escape the root", () => {
    const root = process.platform === "win32" ? "C:\\app\\dist" : "/app/dist";
    assert.ok(resolveStatic(root, "/data/research.json")?.includes("research.json"));

    // The guarantee is containment: whatever the input, the answer is either a
    // path inside the root or nothing at all.
    const attempts = [
      "/../../secret.json",
      "/..%2f..%2fsecret.json",
      "/data/../../../secret.json",
      "/a/../b",
      "/./index.html",
      "/%2e%2e/secret.json",
      "/....//secret.json",
    ];
    for (const p of attempts) {
      const r = resolveStatic(root, p);
      if (r === null) continue;
      assert.ok(r === root || r.startsWith(root + (process.platform === "win32" ? "\\" : "/")), `${p} escaped to ${r}`);
    }
  });

  test("it starts, serves the API, and refuses an unknown endpoint", async () => {
    const app = createApp();
    await new Promise<void>((r) => app.listen(0, r));
    const port = (app.address() as AddressInfo).port;
    try {
      const missing = await fetch(`http://127.0.0.1:${port}/api/does-not-exist`);
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).ok, false);

      const bad = await fetch(`http://127.0.0.1:${port}/api/live/status`, { method: "POST" });
      assert.equal(bad.status, 405);

      const page = await fetch(`http://127.0.0.1:${port}/`);
      if (existsSync("web/dist/index.html")) {
        assert.equal(page.status, 200);
        assert.match(await page.text(), /<div id="root">/);
        const data = await fetch(`http://127.0.0.1:${port}/data/research.json`);
        assert.equal(data.status, 200);
        const doc = (await data.json()) as { phase6: { validated: boolean } };
        assert.equal(doc.phase6.validated, false);
      } else {
        // Not built: it must say so rather than serve a blank page.
        assert.equal(page.status, 503);
        assert.match(await page.text(), /npm run web:build/);
      }
    } finally {
      await new Promise<void>((r) => app.close(() => r()));
    }
  });

  test("a taken port produces an instruction, not a stack trace", () => {
    const msg = listenFailureMessage(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }), 5173);
    assert.match(msg, /port 5173 is already in use/);
    assert.match(msg, /PORT=5174/);
    assert.doesNotMatch(msg, /at Server|node:net/);
  });

  test("other listen failures still say which port and why", () => {
    assert.match(listenFailureMessage(Object.assign(new Error("x"), { code: "EACCES" }), 80), /elevated privileges/);
    assert.match(listenFailureMessage(Object.assign(new Error("boom"), { code: "EOTHER" }), 5173), /could not start listening on port 5173: boom/);
  });

  test("textual assets are compressed for clients that accept it, and only for them", async () => {
    if (!existsSync("web/dist/index.html")) return; // nothing built to serve
    const app = createApp();
    await new Promise<void>((r) => app.listen(0, r));
    const port = (app.address() as AddressInfo).port;
    try {
      const on = await fetch(`http://127.0.0.1:${port}/data/research.json`, { headers: { "accept-encoding": "gzip" } });
      assert.equal(on.headers.get("content-encoding"), "gzip");
      assert.equal(on.headers.get("vary"), "accept-encoding");
      // The body must still decode to the real payload, not to a truncated one.
      assert.equal(((await on.json()) as { phase6: { validated: boolean } }).phase6.validated, false);

      const off = await fetch(`http://127.0.0.1:${port}/data/research.json`, { headers: { "accept-encoding": "identity" } });
      assert.equal(off.headers.get("content-encoding"), null);
      assert.equal(((await off.json()) as { env: string }).env.length > 0, true);
    } finally {
      await new Promise<void>((r) => app.close(() => r()));
    }
  });
});

describe("the payload cross-check", () => {
  const PAYLOAD = "web/public/data/research.json";
  const BACKUP = "web/public/data/research.json.testbak";

  const run = () => {
    try {
      execFileSync("npx", ["tsx", "src/web/check-payload.ts"], { encoding: "utf8", stdio: "pipe", shell: process.platform === "win32" });
      return { code: 0, out: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  test("it fails when the shipped payload no longer matches the phase outputs", { timeout: 120_000 }, () => {
    if (!existsSync(PAYLOAD)) return; // nothing built to check

    copyFileSync(PAYLOAD, BACKUP);
    try {
      const doc = JSON.parse(readFileSync(PAYLOAD, "utf8")) as { phase6: { validated: boolean } };
      // The single most damaging drift this guards against.
      doc.phase6.validated = true;
      writeFileSync(PAYLOAD, JSON.stringify(doc));

      const tampered = run();
      assert.equal(tampered.code, 1, "a tampered payload must exit non-zero");
      assert.match(tampered.out, /phase6\.validated/);
    } finally {
      copyFileSync(BACKUP, PAYLOAD);
      rmSync(BACKUP, { force: true });
    }

    assert.equal(run().code, 0, "the restored payload must pass again");
  });
});

describe("formatting refuses to invent a value", () => {
  test("a missing number renders as Data unavailable", () => {
    for (const f of [pct, pp, signed, int]) assert.equal(f(null), UNAVAILABLE);
    assert.equal(pct(undefined), UNAVAILABLE);
    assert.equal(pct(Number.NaN), UNAVAILABLE);
    assert.equal(pp(Number.POSITIVE_INFINITY), UNAVAILABLE);
    assert.equal(duration(null), UNAVAILABLE);
    assert.equal(stampUnix(null), UNAVAILABLE);
    assert.equal(shortId(null), UNAVAILABLE);
  });

  test("zero is a real value and is shown as one", () => {
    assert.equal(pct(0), "0.00%");
    assert.equal(int(0), "0");
    assert.equal(duration(0), "0s");
    assert.equal(pp(0), "+0.00pp");
  });

  test("deviations are signed with a real minus sign", () => {
    assert.equal(pp(-0.1117), "−11.17pp");
    assert.equal(pp(0.0349), "+3.49pp");
    assert.equal(signed(-3.4048), "−3.40");
  });

  test("timestamps render in UTC because the research is recorded in UTC", () => {
    assert.equal(stampUnix(1789064400), "10 Sep 2026, 18:20 UTC");
  });

  test("durations stay readable across scales", () => {
    assert.equal(duration(45), "45s");
    assert.equal(duration(450), "7m 30s");
    assert.equal(duration(7500), "2h 05m");
  });
});

describe("explorer filtering", () => {
  const rows = buildMarketRows(
    qualityDoc([
      qualityRow({ marketId: "0xaaa1", asset: "BTC", cadence: "15m", p: 0.245, targetTimestamp: 400 }),
      qualityRow({ marketId: "0xbbb2", asset: "ETH", cadence: "5m", p: 0.91, targetTimestamp: 300 }),
      qualityRow({ marketId: "0xccc3", asset: "ETH", cadence: "60m", p: 0.05, targetTimestamp: 200 }),
    ]),
    t1mDoc(),
  );

  test("no filters returns the whole population untouched", () => {
    assert.deepEqual(filterMarkets(rows, EMPTY_FILTERS), rows);
  });

  test("search matches the asset symbol and the market id", () => {
    assert.equal(filterMarkets(rows, { ...EMPTY_FILTERS, query: "eth" }).length, 2);
    assert.equal(filterMarkets(rows, { ...EMPTY_FILTERS, query: "BTC" }).length, 1);
    assert.equal(filterMarkets(rows, { ...EMPTY_FILTERS, query: "0xccc3" }).length, 1);
    assert.equal(filterMarkets(rows, { ...EMPTY_FILTERS, query: "  bbb2 " }).length, 1);
  });

  test("cadence and bucket filters narrow, and combine", () => {
    assert.equal(filterMarkets(rows, { ...EMPTY_FILTERS, cadence: "5m" }).length, 1);
    assert.equal(filterMarkets(rows, { ...EMPTY_FILTERS, bucket: "20-30%" }).length, 1);
    assert.equal(filterMarkets(rows, { query: "eth", cadence: "5m", bucket: "90-100%" }).length, 1);
    assert.equal(filterMarkets(rows, { query: "eth", cadence: "15m", bucket: ALL }).length, 0);
  });

  test("a filter that matches nothing returns nothing rather than falling back", () => {
    assert.deepEqual(filterMarkets(rows, { ...EMPTY_FILTERS, query: "no-such-market" }), []);
  });

  test("paging never invents or drops a row", () => {
    assert.equal(pageCount(0, 25), 1);
    assert.equal(pageCount(50, 25), 2);
    assert.equal(pageCount(51, 25), 3);
    assert.deepEqual(pageOf(rows, 0, 2), rows.slice(0, 2));
    assert.deepEqual(pageOf(rows, 1, 2), rows.slice(2));
    // A page beyond the end clamps to the last page instead of showing blanks.
    assert.deepEqual(pageOf(rows, 99, 2), rows.slice(2));
    assert.deepEqual(pageOf([], 0, 25), []);
  });
});
