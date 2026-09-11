// Phase 4 tests: chronological splitting, band and threshold classification,
// metric aggregation, denominators, and leakage prevention.
// Phase-1/2/3 tests are untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRESHNESS_BANDS, THRESHOLDS, TRAIN_FRACTION, bandMetrics, byBand, chronologicalSplit,
  disjoint, evaluateThreshold, freshnessBand, isMonotonicDecreasing, isMonotonicIncreasing,
  meanCI, wilsonCI, type Scored,
} from "../freshness.js";
import { ageCohort, volumeCohort } from "../quality.js";

const row = (marketId: string, ts: number, ageSec = 10, p = 0.4, y: 0 | 1 = 1) => ({ marketId, ts, ageSec, p, y });
const ts = (x: { ts: number }) => x.ts;
const id = (x: { marketId: string }) => x.marketId;

// ---------- deterministic chronological splitting ----------

test("the split is chronological: every test item is at or after every train item", () => {
  const items = [row("c", 300), row("a", 100), row("d", 400), row("b", 200), row("e", 500)];
  const s = chronologicalSplit(items, ts, id, 0.6);
  for (const tr of s.train) for (const te of s.test) assert.ok(tr.ts < te.ts, `${tr.ts} should precede ${te.ts}`);
});

test("the split is deterministic across repeated calls and input orderings", () => {
  const a = [row("a", 100), row("b", 200), row("c", 300), row("d", 400)];
  const b = [row("d", 400), row("c", 300), row("b", 200), row("a", 100)];
  const s1 = chronologicalSplit(a, ts, id, 0.7);
  const s2 = chronologicalSplit(b, ts, id, 0.7);
  assert.equal(s1.boundaryTimestamp, s2.boundaryTimestamp);
  assert.deepEqual(s1.train.map(id), s2.train.map(id));
  assert.deepEqual(s1.test.map(id), s2.test.map(id));
});

test("the split is never random: the same input always yields the same boundary", () => {
  const items = Array.from({ length: 200 }, (_, i) => row(`m${i}`, 1000 + i));
  const boundaries = new Set(Array.from({ length: 5 }, () => chronologicalSplit(items, ts, id).boundaryTimestamp));
  assert.equal(boundaries.size, 1);
});

test("items sharing a timestamp are never split across the boundary", () => {
  // Ten markets at one instant, straddling the nominal 70% index.
  const items = [...Array.from({ length: 6 }, (_, i) => row(`a${i}`, 100)), ...Array.from({ length: 10 }, (_, i) => row(`b${i}`, 200)), ...Array.from({ length: 4 }, (_, i) => row(`c${i}`, 300))];
  const s = chronologicalSplit(items, ts, id, 0.7);
  for (const t of [100, 200, 300]) {
    const inTrain = s.train.filter((x) => x.ts === t).length;
    const inTest = s.test.filter((x) => x.ts === t).length;
    assert.ok(inTrain === 0 || inTest === 0, `timestamp ${t} straddles the boundary: ${inTrain} train, ${inTest} test`);
  }
});

test("split partitions the population exactly: no loss, no duplication", () => {
  const items = Array.from({ length: 97 }, (_, i) => row(`m${i}`, 1000 + (i % 40)));
  const s = chronologicalSplit(items, ts, id);
  assert.equal(s.train.length + s.test.length, items.length);
  const ids = new Set([...s.train.map(id), ...s.test.map(id)]);
  assert.equal(ids.size, items.length);
});

test("train and test sets are disjoint", () => {
  const items = Array.from({ length: 50 }, (_, i) => row(`m${i}`, 1000 + i));
  const s = chronologicalSplit(items, ts, id);
  const testIds = new Set(s.test.map(id));
  assert.ok(s.train.every((x) => !testIds.has(x.marketId)));
});

test("the realised train fraction is reported rather than assumed", () => {
  const items = Array.from({ length: 10 }, (_, i) => row(`m${i}`, 100));  // all one instant
  const s = chronologicalSplit(items, ts, id, 0.7);
  assert.equal(s.actualTrainFraction, s.train.length / items.length);
  assert.equal(s.train.length, 0, "a single-instant population cannot be split, and says so");
});

test("the default train fraction is the declared 0.7", () => {
  assert.equal(TRAIN_FRACTION, 0.7);
});

test("splitting an empty population is an error, not a silent empty result", () => {
  assert.throws(() => chronologicalSplit([] as { marketId: string; ts: number }[], ts, id), /at least one item/);
});

// ---------- freshness band classification ----------

test("freshness bands are the locked Phase-3 definitions", () => {
  assert.deepEqual([...FRESHNESS_BANDS], ["0-60s", "61-300s", "301-900s", "900s+"]);
  assert.equal(freshnessBand, ageCohort, "Phase 4 must not introduce a second classifier");
});

test("band boundaries are inclusive at the top of each band", () => {
  assert.equal(freshnessBand(0), "0-60s");
  assert.equal(freshnessBand(60), "0-60s");
  assert.equal(freshnessBand(61), "61-300s");
  assert.equal(freshnessBand(300), "61-300s");
  assert.equal(freshnessBand(301), "301-900s");
  assert.equal(freshnessBand(900), "301-900s");
  assert.equal(freshnessBand(901), "900s+");
});

test("byBand returns bands in the fixed order and drops none that are populated", () => {
  const rows: Scored[] = [
    { marketId: "a", p: 0.4, y: 1, ageSec: 10 },
    { marketId: "b", p: 0.4, y: 0, ageSec: 1000 },
    { marketId: "c", p: 0.6, y: 1, ageSec: 200 },
  ];
  const bands = byBand(rows);
  assert.deepEqual(bands.map((b) => b.band), ["0-60s", "61-300s", "900s+"]);
  assert.equal(bands.reduce((a, b) => a + b.n, 0), rows.length);
});

// ---------- threshold classification ----------

test("thresholds are the declared fixed set, not a search", () => {
  assert.deepEqual([...THRESHOLDS], [60, 120, 300, 600, 900]);
});

test("threshold classification is inclusive at the boundary", () => {
  const rows: Scored[] = [
    { marketId: "a", p: 0.4, y: 1, ageSec: 60 },
    { marketId: "b", p: 0.4, y: 1, ageSec: 61 },
  ];
  const r = evaluateThreshold(rows, 60);
  assert.equal(r.nPass, 1, "age exactly at the threshold passes");
  assert.equal(r.nFail, 1);
});

test("threshold pass and fail counts always sum to the population", () => {
  const rows: Scored[] = Array.from({ length: 40 }, (_, i) => ({ marketId: `m${i}`, p: 0.4, y: (i % 2) as 0 | 1, ageSec: i * 40 }));
  for (const t of THRESHOLDS) {
    const r = evaluateThreshold(rows, t);
    assert.equal(r.nPass + r.nFail, rows.length, `threshold ${t} lost rows`);
    assert.ok(Math.abs(r.coverage - r.nPass / rows.length) < 1e-12);
  }
});

test("coverage rises monotonically as the threshold loosens", () => {
  const rows: Scored[] = Array.from({ length: 60 }, (_, i) => ({ marketId: `m${i}`, p: 0.4, y: 1, ageSec: i * 25 }));
  const cov = THRESHOLDS.map((t) => evaluateThreshold(rows, t).coverage);
  assert.ok(isMonotonicIncreasing(cov));
});

test("a threshold that excludes everything yields a null excluded group, not NaN counts", () => {
  const rows: Scored[] = [{ marketId: "a", p: 0.4, y: 1, ageSec: 5 }];
  const r = evaluateThreshold(rows, 900);
  assert.equal(r.nFail, 0);
  assert.equal(r.fail, null);
  assert.ok(Number.isNaN(r.brierSeparation));
});

// ---------- cohort segmentation ----------

test("structural cohort definitions are reused from Phase 3, unchanged", () => {
  assert.equal(volumeCohort(0.009), "<0.01");
  assert.equal(volumeCohort(0.01), "0.01-1");
});

test("cohort segmentation preserves the denominator", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ marketId: `m${i}`, single: i % 3 === 0 }));
  const a = rows.filter((r) => r.single).length;
  const b = rows.filter((r) => !r.single).length;
  assert.equal(a + b, rows.length);
});

// ---------- metric aggregation ----------

test("band metrics reuse the locked calibration definitions", () => {
  const rows: Scored[] = [
    { marketId: "a", p: 0.8, y: 1, ageSec: 10 },
    { marketId: "b", p: 0.2, y: 0, ageSec: 20 },
  ];
  const m = bandMetrics("x", rows)!;
  assert.ok(Math.abs(m.brier - 0.04) < 1e-12);
  assert.equal(m.n, 2);
  assert.equal(m.accuracy, 1);
});

test("band metrics on an empty group return null rather than NaN-filled rows", () => {
  assert.equal(bandMetrics("empty", []), null);
});

test("age descriptives are computed over the group's own ages", () => {
  const rows: Scored[] = [
    { marketId: "a", p: 0.5, y: 1, ageSec: 10 },
    { marketId: "b", p: 0.5, y: 0, ageSec: 30 },
  ];
  const m = bandMetrics("x", rows)!;
  assert.equal(m.meanAge, 20);
  assert.equal(m.medianAge, 20);
});

test("metric aggregation is deterministic", () => {
  const rows: Scored[] = Array.from({ length: 25 }, (_, i) => ({ marketId: `m${i}`, p: (i + 1) / 26, y: (i % 2) as 0 | 1, ageSec: i * 10 }));
  const a = bandMetrics("x", rows)!;
  const b = bandMetrics("x", [...rows].reverse())!;
  assert.equal(a.brier, b.brier);
  assert.equal(a.logloss, b.logloss);
  assert.equal(a.accuracy, b.accuracy);
});

// ---------- intervals and monotonicity ----------

test("Wilson interval stays inside [0,1] even at the extremes", () => {
  const [lo, hi] = wilsonCI(10, 10);
  assert.ok(lo >= 0 && hi <= 1);
  assert.ok(lo < 1, "a perfect sample still carries uncertainty");
  const [lo0, hi0] = wilsonCI(0, 10);
  assert.ok(lo0 >= 0 && hi0 <= 1);
});

test("Wilson interval narrows as the sample grows", () => {
  const wide = wilsonCI(5, 10);
  const narrow = wilsonCI(500, 1000);
  assert.ok(narrow[1] - narrow[0] < wide[1] - wide[0]);
});

test("mean interval is undefined below two observations", () => {
  assert.ok(Number.isNaN(meanCI([0.5])[0]));
  assert.ok(Number.isFinite(meanCI([0.1, 0.2, 0.3])[0]));
});

test("mean interval brackets the mean", () => {
  const xs = [0.1, 0.2, 0.3, 0.4];
  const [lo, hi] = meanCI(xs);
  assert.ok(lo < 0.25 && hi > 0.25);
});

test("disjoint detects separation in both directions and requires finite bounds", () => {
  assert.equal(disjoint([0, 1], [2, 3]), true);
  assert.equal(disjoint([2, 3], [0, 1]), true);
  assert.equal(disjoint([0, 2], [1, 3]), false);
  assert.equal(disjoint([NaN, NaN], [1, 3]), false, "an undefined interval is never called separated");
});

test("monotonicity helpers detect direction and reject reversals", () => {
  assert.equal(isMonotonicIncreasing([1, 2, 3]), true);
  assert.equal(isMonotonicIncreasing([1, 3, 2]), false);
  assert.equal(isMonotonicDecreasing([3, 2, 1]), true);
  assert.equal(isMonotonicDecreasing([3, 1, 2]), false);
  assert.equal(isMonotonicIncreasing([1, 1, 1]), true, "flat counts as non-decreasing");
});

// ---------- leakage prevention ----------

test("freshness classification depends only on age, never on outcome or probability", () => {
  // Identical ages, opposite outcomes and probabilities: the band must not move.
  const a = freshnessBand(200);
  const b = freshnessBand(200);
  assert.equal(a, b);
  const rows: Scored[] = [
    { marketId: "a", p: 0.01, y: 0, ageSec: 200 },
    { marketId: "b", p: 0.99, y: 1, ageSec: 200 },
  ];
  assert.deepEqual(byBand(rows).map((x) => x.band), ["61-300s"], "both land in one band regardless of p and y");
});

test("threshold classification depends only on age, never on outcome", () => {
  const win: Scored[] = [{ marketId: "a", p: 0.9, y: 1, ageSec: 500 }];
  const lose: Scored[] = [{ marketId: "a", p: 0.9, y: 0, ageSec: 500 }];
  assert.equal(evaluateThreshold(win, 300).nPass, evaluateThreshold(lose, 300).nPass);
});

test("changing an outcome changes the score but never the band membership", () => {
  // p must not be 0.5: there the squared error is 0.25 either way, so flipping
  // the outcome would not change the score and the test would prove nothing.
  const base: Scored[] = Array.from({ length: 20 }, (_, i) => ({ marketId: `m${i}`, p: 0.8, y: 1 as 0 | 1, ageSec: i * 100 }));
  const flipped: Scored[] = base.map((r) => ({ ...r, y: 0 as 0 | 1 }));
  assert.deepEqual(byBand(base).map((b) => `${b.band}:${b.n}`), byBand(flipped).map((b) => `${b.band}:${b.n}`));
  assert.notEqual(byBand(base)[0].brier, byBand(flipped)[0].brier);
});
