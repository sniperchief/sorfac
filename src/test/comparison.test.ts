// Unit tests for the calibration methodology and the comparison arithmetic.
//
// The calibration tests pin Phase-1 behaviour: if someone changes a bucket
// boundary, the eps, or the outcome mapping, these fail. That is the point —
// the comparison is only meaningful while the methodology is unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EPS, bucketize, calibrate, clamp, outcomeOf, validProbability, type CalibrationSample } from "../calibration.js";
import { bucketIndex, pair, providerBreakdown, qualityIssues } from "../compare.js";
import type { ExtractionRow } from "../extract-t1m.js";
import type { Observation } from "../providers/types.js";

const s = (p: number, y: 0 | 1, id = String(Math.random())): CalibrationSample => ({ marketId: id, p, y });

// ---------- Phase-1 methodology, pinned ----------

test("outcome mapping: winningOutcome 0 is Up=1, 1 is Down=0", () => {
  assert.equal(outcomeOf(0), 1);
  assert.equal(outcomeOf(1), 0);
  assert.equal(outcomeOf(null), null);
  assert.equal(outcomeOf(undefined), null);
});

test("validity is the open interval (0,1), matching Phase 1", () => {
  assert.equal(validProbability(0.5), true);
  assert.equal(validProbability(0), false);
  assert.equal(validProbability(1), false);
  assert.equal(validProbability(NaN), false);
  assert.equal(validProbability(null), false);
});

test("eps is 1e-6 and clamping never moves an in-range probability", () => {
  assert.equal(EPS, 1e-6);
  assert.equal(clamp(0.3), 0.3);
  assert.equal(clamp(0), EPS);
  assert.equal(clamp(1), 1 - EPS);
});

test("buckets are half-open except the top, which is closed", () => {
  assert.equal(bucketIndex(0.0), 0);
  assert.equal(bucketIndex(0.099), 0);
  assert.equal(bucketIndex(0.1), 1);
  assert.equal(bucketIndex(0.999), 9);
  assert.equal(bucketIndex(1), 9, "1.0 belongs to the top bucket, not an 11th");
  const b = bucketize([s(0.1, 1), s(0.2, 0)]);
  assert.equal(b[1].n, 1);
  assert.equal(b[2].n, 1);
});

test("bucket counts always sum to the sample size", () => {
  const samples = Array.from({ length: 200 }, (_, i) => s((i + 0.5) / 200, i % 2 as 0 | 1));
  assert.equal(bucketize(samples).reduce((a, x) => a + x.n, 0), 200);
});

test("empty buckets report n=0 with null statistics rather than NaN", () => {
  const b = bucketize([s(0.05, 1)]);
  assert.equal(b[0].n, 1);
  assert.equal(b[5].n, 0);
  assert.equal(b[5].meanPredicted, null);
  assert.equal(b[5].diff, null);
});

test("Brier is the mean squared error against the outcome", () => {
  // (0.8-1)^2 = 0.04 ; (0.2-0)^2 = 0.04 -> mean 0.04
  assert.ok(Math.abs(calibrate([s(0.8, 1), s(0.2, 0)]).brier - 0.04) < 1e-12);
});

test("a perfect forecaster scores 0 Brier and near-0 log loss", () => {
  const r = calibrate([s(1 - EPS, 1), s(EPS, 0)]);
  assert.ok(r.brier < 1e-10);
  assert.ok(r.logloss < 1e-5);
});

test("log loss stays finite at the probability extremes", () => {
  const r = calibrate([s(1e-9, 1), s(1 - 1e-9, 0)]);
  assert.ok(Number.isFinite(r.logloss), "eps clamp must prevent Infinity");
  assert.ok(!Number.isNaN(r.logloss));
  assert.equal(r.clampHits, 2);
});

test("log loss matches the closed form for a known case", () => {
  // Single sample p=0.5, y=1 -> -log(0.5) = 0.693147...
  assert.ok(Math.abs(calibrate([s(0.5, 1)]).logloss - Math.log(2)) < 1e-12);
});

test("accuracy uses a 0.5 threshold with >= going to Up", () => {
  assert.equal(calibrate([s(0.5, 1)]).accuracy, 1);
  assert.equal(calibrate([s(0.5, 0)]).accuracy, 0);
  assert.equal(calibrate([s(0.49, 0)]).accuracy, 1);
});

test("Brier skill score is 0 when the forecast equals the base rate", () => {
  const r = calibrate([s(0.5, 1), s(0.5, 0)]);
  assert.equal(r.baseRate, 0.5);
  assert.ok(Math.abs(r.brierSkillScore) < 1e-12);
});

test("calibrate refuses an empty sample rather than returning NaN", () => {
  assert.throws(() => calibrate([]), /at least one sample/);
});

// ---------- pairing and comparison arithmetic ----------

const obs = (over: Partial<Observation> = {}): Observation => ({
  provider: "p", marketId: "0x1", asset: "BTC",
  quote: { token: "0xc", symbol: "USDso", decimals: 18 },
  targetTimestamp: 1840, price: 0.4, rawPrice: "4", sourceTimestamp: 1840,
  retrievalTimestamp: 1, latencyMs: 10, ageSec: 0, ageFraction: 0,
  status: "ok", ok: true, error: null, ...over,
});

const row = (over: Partial<ExtractionRow> = {}, o: Partial<Observation> = {}): ExtractionRow => ({
  marketId: "0x1", asset: "BTC", interval: "15m", intervalSec: 900,
  tradingStart: 1000, expiry: 1900, targetTimestamp: 1840, tradeCount: 3,
  winningOutcome: 0, referenceLastPrice: 0.5, referenceLastTradeAt: 1850,
  windowAdmitsHorizon: true, observations: [obs({ marketId: over.marketId ?? "0x1", ...o })], ...over,
});

test("pairing keeps only markets where both bases and the outcome are valid", () => {
  const rows = [
    row({ marketId: "a" }),
    row({ marketId: "b", winningOutcome: null }),
    row({ marketId: "c", referenceLastPrice: null }),
    row({ marketId: "d" }, { price: null, status: "missing", ok: false }),
  ];
  const { paired, missing } = pair(rows, "p");
  assert.deepEqual(paired.map((x) => x.marketId), ["a"]);
  assert.equal(missing.length, 3);
});

test("paired plus missing always accounts for every row", () => {
  const rows = [row({ marketId: "a" }), row({ marketId: "b", winningOutcome: null }), row({ marketId: "c" })];
  const { paired, missing } = pair(rows, "p");
  assert.equal(paired.length + missing.length, rows.length);
});

test("a stale observation is still paired, since staleness never filters", () => {
  const { paired } = pair([row({}, { status: "stale", ageSec: 400 })], "p");
  assert.equal(paired.length, 1);
  assert.equal(paired[0].stale, true);
});

test("absolute and percentage differences are computed against the reference", () => {
  const { paired } = pair([row({ referenceLastPrice: 0.5 }, { price: 0.4 })], "p");
  const s0 = paired[0];
  assert.ok(Math.abs(s0.absDiff - 0.1) < 1e-12);
  assert.ok(Math.abs(s0.pctDiff - -20) < 1e-12, "0.4 vs 0.5 is -20%");
});

test("percentage difference is signed and directionally correct", () => {
  const up = pair([row({ referenceLastPrice: 0.2 }, { price: 0.3 })], "p").paired[0];
  assert.ok(up.pctDiff > 0);
  assert.ok(Math.abs(up.pctDiff - 50) < 1e-12);
});

test("an unknown provider name pairs nothing rather than throwing", () => {
  const { paired, missing } = pair([row()], "nope");
  assert.equal(paired.length, 0);
  assert.equal(missing.length, 1);
});

test("provider breakdown counts every status class", () => {
  const rows = [
    row({ marketId: "a" }, { status: "ok" }),
    row({ marketId: "b" }, { status: "stale" }),
    row({ marketId: "c" }, { status: "missing", price: null, ok: false }),
    row({ marketId: "d" }, { status: "malformed", price: null, ok: false }),
    row({ marketId: "e" }, { status: "unavailable", price: null, ok: false }),
  ];
  const b = providerBreakdown(rows, "p");
  assert.equal(b.attempted, 5);
  assert.equal(b.ok, 1);
  assert.equal(b.stale, 1);
  assert.equal(b.missing, 1);
  assert.equal(b.malformed, 1);
  assert.equal(b.unavailable, 1);
  assert.equal(b.usable, 2, "ok + stale carry a usable price");
});

// ---------- data-quality gate ----------

test("quality gate flags a look-ahead source timestamp", () => {
  const issues = qualityIssues([row({}, { sourceTimestamp: 1841 })]);
  assert.ok(issues.some((i) => i.issue === "lookahead"));
});

test("quality gate flags a source from before the trading window", () => {
  const issues = qualityIssues([row({}, { sourceTimestamp: 900 })]);
  assert.ok(issues.some((i) => i.issue === "source-before-window"));
});

test("quality gate flags a horizon that is not expiry minus 60", () => {
  assert.ok(qualityIssues([row({ targetTimestamp: 1800 })]).some((i) => i.issue === "bad-horizon"));
});

test("a clean row raises no quality issues", () => {
  assert.deepEqual(qualityIssues([row()]), []);
});
