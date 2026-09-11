// Phase 3 tests: cohort classification, quality derivation, and the descriptive
// statistics the analysis depends on. Phase-2 tests are untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NEAR_SEC, TRADE_COHORTS, VOLUME_COHORTS, ageCohort, cadenceCohort, deriveQuality,
  makerCohort, mean, median, ranks, spearman, supportCohort, tradeCohort, volumeCohort,
  type Fill,
} from "../quality.js";
import { calibrate, type CalibrationSample } from "../calibration.js";
import { mace } from "../compare.js";

// ---------- cohort classification ----------

test("trade cohorts match the documented boundaries exactly", () => {
  assert.equal(tradeCohort(1), "1");
  assert.equal(tradeCohort(2), "2-3");
  assert.equal(tradeCohort(3), "2-3");
  assert.equal(tradeCohort(4), "4-5");
  assert.equal(tradeCohort(5), "4-5");
  assert.equal(tradeCohort(6), "6-10");
  assert.equal(tradeCohort(10), "6-10");
  assert.equal(tradeCohort(11), "11+");
  assert.equal(tradeCohort(9999), "11+");
});

test("trade cohorts cover every positive integer with no gap or overlap", () => {
  const seen = new Set<string>();
  for (let n = 1; n <= 60; n++) {
    const c = tradeCohort(n);
    assert.notEqual(c, null, `n=${n} fell outside every cohort`);
    seen.add(c!);
  }
  assert.deepEqual([...seen].sort(), [...TRADE_COHORTS].sort());
});

test("trade cohorts reject non-counts rather than silently bucketing them", () => {
  assert.equal(tradeCohort(0), null);
  assert.equal(tradeCohort(-1), null);
  assert.equal(tradeCohort(NaN), null);
});

test("volume cohorts match the documented decade boundaries", () => {
  assert.equal(volumeCohort(0), "<0.01");
  assert.equal(volumeCohort(0.009), "<0.01");
  assert.equal(volumeCohort(0.01), "0.01-1");
  assert.equal(volumeCohort(0.999), "0.01-1");
  assert.equal(volumeCohort(1), "1-10");
  assert.equal(volumeCohort(10), "10-100");
  assert.equal(volumeCohort(100), "100+");
  assert.equal(volumeCohort(NaN), "unknown");
});

test("volume cohorts partition any finite volume", () => {
  const seen = new Set(VOLUME_COHORTS.map(() => ""));
  seen.clear();
  for (const v of [0, 0.005, 0.5, 5, 50, 500, 1486.97]) seen.add(volumeCohort(v));
  for (const c of seen) assert.ok((VOLUME_COHORTS as readonly string[]).includes(c), `${c} is not a declared cohort`);
});

test("age cohorts follow the Phase-1 staleness rungs", () => {
  assert.equal(ageCohort(0), "0-60s");
  assert.equal(ageCohort(60), "0-60s");
  assert.equal(ageCohort(61), "61-300s");
  assert.equal(ageCohort(300), "61-300s");
  assert.equal(ageCohort(301), "301-900s");
  assert.equal(ageCohort(900), "301-900s");
  assert.equal(ageCohort(901), "900s+");
  assert.equal(ageCohort(null), "unknown");
});

test("cadence cohorts snap to the ladder with the Phase-1 tolerance", () => {
  assert.equal(cadenceCohort(300), "5m");
  assert.equal(cadenceCohort(298), "5m", "a late-opening roll still belongs to its rung");
  assert.equal(cadenceCohort(900), "15m");
  assert.equal(cadenceCohort(3600), "60m");
  assert.equal(cadenceCohort(47), "other");
  assert.equal(cadenceCohort(null), "unknown");
});

// ---------- single / multi maker classification ----------

test("maker cohort splits on exactly one distinct maker", () => {
  assert.equal(makerCohort(1), "single-maker");
  assert.equal(makerCohort(2), "multi-maker");
  assert.equal(makerCohort(50), "multi-maker");
});

test("maker cohort reports unknown rather than guessing when no maker is named", () => {
  assert.equal(makerCohort(0), "unknown");
  assert.equal(makerCohort(NaN), "unknown");
});

test("a tape whose makers are all null yields zero unique makers, not one", () => {
  const tape: Fill[] = [
    { t: 100, price: 0.4, maker: null, taker: null, quote: 1 },
    { t: 110, price: 0.4, maker: null, taker: null, quote: 1 },
  ];
  const q = derive(tape, 200);
  assert.equal(q.uniqueMakersTotal, 0);
  assert.equal(makerCohort(q.uniqueMakersTotal), "unknown", "unnamed makers must not be counted as a single maker");
});

// ---------- quality derivation ----------

const derive = (tape: Fill[], target = 200) =>
  deriveQuality(
    { marketId: "0x1", asset: "BTC", cadence: "15m", intervalSec: 900, tradingStart: 0, expiry: target + 60, targetTimestamp: target, tradeCountTotal: tape.length },
    tape,
  );

const fill = (t: number, price: number, maker: string | null = "0xm", taker: string | null = "0xt", quote = 1): Fill =>
  ({ t, price, maker, taker, quote });

test("pre-T-1m fields exclude everything after the target", () => {
  const q = derive([fill(100, 0.3), fill(190, 0.4), fill(210, 0.9), fill(250, 0.95)]);
  assert.equal(q.tradeCountPre, 2, "only the two prints at or before T-1m count");
  assert.equal(q.volumePre, 2);
  assert.equal(q.t1mPrice, 0.4);
  assert.equal(q.diagnostic.tradesPost, 2);
});

test("a print exactly at the target is pre-T-1m, not post", () => {
  const q = derive([fill(200, 0.42)]);
  assert.equal(q.tradeCountPre, 1);
  assert.equal(q.diagnostic.tradesPost, 0);
  assert.equal(q.t1mAgeSec, 0);
});

test("the T-1m price matches Phase-2 selection on the same tape", () => {
  const q = derive([fill(100, 0.1), fill(150, 0.2), fill(199, 0.3), fill(201, 0.9)]);
  assert.equal(q.t1mPrice, 0.3, "must be the last print at or before the target");
  assert.equal(q.t1mAgeSec, 1);
});

test("the near window is the documented 60 seconds before the target", () => {
  assert.equal(NEAR_SEC, 60);
  const q = derive([fill(139, 0.2), fill(140, 0.3), fill(200, 0.4)]);
  assert.equal(q.tradesNear, 2, "140 and 200 are inside [target-60, target]; 139 is not");
});

test("isolated print is flagged when the near window holds at most one trade", () => {
  assert.equal(derive([fill(200, 0.4)]).isolatedPrint, true);
  assert.equal(derive([fill(100, 0.4)]).isolatedPrint, true, "an old print alone is still isolated");
  assert.equal(derive([fill(180, 0.4), fill(200, 0.5)]).isolatedPrint, false);
});

test("price range and distinct prices are measured over the near window only", () => {
  const q = derive([fill(50, 0.9), fill(180, 0.40), fill(200, 0.44)]);
  assert.ok(Math.abs(q.priceRangeNear - 0.04) < 1e-12, "the far 0.9 print must not widen the range");
  assert.equal(q.distinctPricesNear, 2);
});

test("maker concentration is the top maker's share of pre-T-1m fills", () => {
  const q = derive([fill(100, 0.3, "0xa"), fill(120, 0.3, "0xa"), fill(140, 0.3, "0xb")]);
  assert.ok(Math.abs(q.makerConcentrationPre - 2 / 3) < 1e-12);
  assert.equal(q.uniqueMakersPre, 2);
  assert.equal(q.singleMakerPre, false);
});

test("unique participants counts makers and takers together, deduplicated", () => {
  const q = derive([fill(100, 0.3, "0xa", "0xb"), fill(120, 0.3, "0xb", "0xa")]);
  assert.equal(q.uniqueParticipantsPre, 2);
});

test("an empty tape yields no T-1m price and zeroed counts rather than NaN", () => {
  const q = derive([]);
  assert.equal(q.t1mPrice, null);
  assert.equal(q.t1mAgeSec, null);
  assert.equal(q.tradeCountPre, 0);
  assert.equal(q.volumePre, 0);
  assert.equal(q.priceRangeNear, 0);
  assert.equal(q.makerConcentrationPre, 0);
  assert.equal(q.diagnostic.absMovePost, null);
});

test("diagnostic post-T-1m move is measured against the T-1m price", () => {
  const q = derive([fill(200, 0.30), fill(240, 0.85)]);
  assert.ok(Math.abs(q.diagnostic.absMovePost! - 0.55) < 1e-12);
});

test("a tape with only post-target trades leaves every pre-T-1m field empty", () => {
  const q = derive([fill(210, 0.8), fill(230, 0.9)]);
  assert.equal(q.t1mPrice, null);
  assert.equal(q.tradeCountPre, 0);
  assert.equal(q.uniqueMakersPre, 0);
  assert.equal(q.diagnostic.tradesPost, 2);
});

test("support cohort follows the isolated-print flag", () => {
  assert.equal(supportCohort({ isolatedPrint: true }), "isolated-print");
  assert.equal(supportCohort({ isolatedPrint: false }), "supported");
});

// ---------- calibration aggregation over cohorts ----------

const s = (p: number, y: 0 | 1, id = String(Math.random())): CalibrationSample => ({ marketId: id, p, y });

test("cohort calibration reuses the Phase-2 definitions unchanged", () => {
  const samples = [s(0.8, 1), s(0.2, 0), s(0.6, 1)];
  const c = calibrate(samples);
  assert.equal(c.n, 3);
  assert.equal(c.buckets.length, 10, "always ten Phase-2 buckets, however small the cohort");
});

test("splitting a population into cohorts preserves the total sample count", () => {
  const all = Array.from({ length: 120 }, (_, i) => ({ p: (i + 0.5) / 120, y: (i % 2) as 0 | 1, trades: (i % 12) + 1 }));
  const cohorts = new Map<string, typeof all>();
  for (const a of all) {
    const k = tradeCohort(a.trades)!;
    cohorts.set(k, [...(cohorts.get(k) ?? []), a]);
  }
  const total = [...cohorts.values()].reduce((acc, xs) => acc + calibrate(xs.map((x) => s(x.p, x.y))).n, 0);
  assert.equal(total, all.length);
});

test("bucket counts within every cohort sum to that cohort's size", () => {
  const cohort = Array.from({ length: 37 }, (_, i) => s((i + 0.5) / 37, (i % 2) as 0 | 1));
  const c = calibrate(cohort);
  assert.equal(c.buckets.reduce((a, b) => a + b.n, 0), 37);
});

test("unweighted MACE ignores bucket size, weighted MACE does not", () => {
  // The distinction matters: a cohort whose mass sits in one bucket can post a
  // large unweighted MACE off a bucket holding a single market.
  const buckets = [{ n: 500, diff: 0.01 }, { n: 1, diff: 0.6 }];
  const m = mace(buckets);
  assert.ok(Math.abs(m.plain - 0.305) < 1e-12);
  assert.ok(m.weighted < 0.015, "weighted MACE must not be dominated by the n=1 bucket");
});

// ---------- deterministic statistics ----------

test("median handles odd and even lengths", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test("mean of an empty series is NaN rather than zero", () => {
  assert.ok(Number.isNaN(mean([])));
  assert.equal(mean([2, 4]), 3);
});

test("ranks average ties so repeated values do not bias correlation", () => {
  assert.deepEqual(ranks([10, 20, 30]), [1, 2, 3]);
  assert.deepEqual(ranks([10, 10, 30]), [1.5, 1.5, 3]);
  assert.deepEqual(ranks([5, 5, 5]), [2, 2, 2]);
});

test("spearman is +1 for a monotonic increase and -1 for a decrease", () => {
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-12);
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [40, 30, 20, 10]) + 1) < 1e-12);
});

test("spearman is rank-based, so a monotone transform does not change it", () => {
  const a = [1, 2, 3, 4, 5];
  const b = [2, 9, 11, 40, 41];
  assert.ok(Math.abs(spearman(a, b) - spearman(a, b.map((x) => Math.log(x)))) < 1e-12);
});

test("spearman returns NaN when a series has no variation or is too short", () => {
  assert.ok(Number.isNaN(spearman([1, 1, 1], [1, 2, 3])));
  assert.ok(Number.isNaN(spearman([1, 2], [1, 2])));
});

test("statistics are deterministic across repeated calls", () => {
  const xs = [5, 3, 9, 1, 7, 3];
  const ys = [2, 8, 1, 9, 4, 8];
  assert.equal(spearman(xs, ys), spearman(xs, ys));
  assert.equal(median(xs), median(xs));
});
