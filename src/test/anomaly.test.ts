// Phase 5 tests: period assignment, bucket and sub-band classification,
// aggregation invariants, and the deviation statistics.
// Phase-1/2/3/4 tests are untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_CELL_N, SUB_BANDS, TARGET_BUCKET_INDEX, cadenceMix, chronologicalPeriods,
  deviationStats, inTargetBucket, standardisedDeviation, subBand,
} from "../anomaly.js";
import { bucketIndex } from "../compare.js";
import { cadenceCohort } from "../quality.js";

const it = (marketId: string, ts: number) => ({ marketId, ts });
const ts = (x: { ts: number }) => x.ts;
const id = (x: { marketId: string }) => x.marketId;

// ---------- deterministic chronological period assignment ----------

test("periods are chronological: every period precedes the next", () => {
  const items = Array.from({ length: 40 }, (_, i) => it(`m${i}`, 1000 + i));
  const ps = chronologicalPeriods(items, ts, id, 4);
  for (let i = 1; i < ps.length; i++) {
    const prevMax = Math.max(...ps[i - 1].items.map(ts));
    const nextMin = Math.min(...ps[i].items.map(ts));
    assert.ok(prevMax < nextMin, `period ${i} overlaps period ${i + 1}`);
  }
});

test("period assignment is deterministic regardless of input ordering", () => {
  const a = Array.from({ length: 33 }, (_, i) => it(`m${i}`, 500 + i * 3));
  const b = [...a].reverse();
  const pa = chronologicalPeriods(a, ts, id, 4);
  const pb = chronologicalPeriods(b, ts, id, 4);
  assert.deepEqual(pa.map((p) => p.items.map(id)), pb.map((p) => p.items.map(id)));
});

test("periods partition the population with no loss or duplication", () => {
  const items = Array.from({ length: 97 }, (_, i) => it(`m${i}`, 1000 + (i % 50)));
  const ps = chronologicalPeriods(items, ts, id, 4);
  assert.equal(ps.reduce((a, p) => a + p.items.length, 0), items.length);
  const seen = new Set(ps.flatMap((p) => p.items.map(id)));
  assert.equal(seen.size, items.length);
});

test("markets sharing a timestamp never straddle a period boundary", () => {
  const items = [
    ...Array.from({ length: 10 }, (_, i) => it(`a${i}`, 100)),
    ...Array.from({ length: 10 }, (_, i) => it(`b${i}`, 200)),
    ...Array.from({ length: 10 }, (_, i) => it(`c${i}`, 300)),
    ...Array.from({ length: 10 }, (_, i) => it(`d${i}`, 400)),
  ];
  const ps = chronologicalPeriods(items, ts, id, 4);
  for (const stamp of [100, 200, 300, 400]) {
    const holding = ps.filter((p) => p.items.some((x) => x.ts === stamp));
    assert.equal(holding.length, 1, `timestamp ${stamp} appears in ${holding.length} periods`);
  }
});

test("periods are approximately equal in count on evenly spaced data", () => {
  const items = Array.from({ length: 400 }, (_, i) => it(`m${i}`, 1000 + i));
  const ps = chronologicalPeriods(items, ts, id, 4);
  for (const p of ps) assert.ok(Math.abs(p.items.length - 100) <= 2, `period has ${p.items.length}`);
});

test("duplicate quantile timestamps collapse rather than creating empty periods", () => {
  // All items share one instant: no cut is possible, so one period results.
  const items = Array.from({ length: 20 }, (_, i) => it(`m${i}`, 777));
  const ps = chronologicalPeriods(items, ts, id, 4);
  assert.equal(ps.length, 1);
  assert.equal(ps[0].items.length, 20);
});

test("period assignment rejects empty input and nonsensical period counts", () => {
  assert.throws(() => chronologicalPeriods([] as { marketId: string; ts: number }[], ts, id, 4), /at least one item/);
  assert.throws(() => chronologicalPeriods([it("a", 1)], ts, id, 0), /at least one period/);
});

// ---------- 20-30% and sub-band classification ----------

test("the target bucket reuses Phase-2 semantics exactly", () => {
  assert.equal(TARGET_BUCKET_INDEX, 2);
  assert.equal(inTargetBucket(0.2), true, "lower bound is inclusive");
  assert.equal(inTargetBucket(0.29999), true);
  assert.equal(inTargetBucket(0.3), false, "upper bound is exclusive");
  assert.equal(inTargetBucket(0.19999), false);
  for (const p of [0.2, 0.25, 0.299]) assert.equal(bucketIndex(p), TARGET_BUCKET_INDEX);
});

test("sub-bands partition the 20-30% bucket with no gap or overlap", () => {
  for (let p = 0.2; p < 0.3; p += 0.001) {
    const b = subBand(Number(p.toFixed(4)));
    assert.notEqual(b, null, `p=${p.toFixed(4)} fell into no sub-band`);
  }
});

test("sub-band boundaries are half-open and in the declared order", () => {
  assert.equal(subBand(0.2), "20-22.5%");
  assert.equal(subBand(0.2249), "20-22.5%");
  assert.equal(subBand(0.225), "22.5-25%");
  assert.equal(subBand(0.25), "25-27.5%");
  assert.equal(subBand(0.275), "27.5-30%");
  assert.equal(subBand(0.2999), "27.5-30%");
  assert.deepEqual(SUB_BANDS.map((b) => b.label), ["20-22.5%", "22.5-25%", "25-27.5%", "27.5-30%"]);
});

test("probabilities outside the bucket have no sub-band", () => {
  assert.equal(subBand(0.15), null);
  assert.equal(subBand(0.3), null);
  assert.equal(subBand(0.9), null);
});

test("cadence classification is the locked Phase-3 function", () => {
  assert.equal(cadenceCohort(300), "5m");
  assert.equal(cadenceCohort(900), "15m");
  assert.equal(cadenceCohort(3600), "60m");
});

// ---------- deviation statistics ----------

test("deviation is the observed rate minus the group's own mean prediction", () => {
  const rows = [{ p: 0.25, y: 1 as const }, { p: 0.25, y: 0 as const }, { p: 0.25, y: 0 as const }, { p: 0.25, y: 0 as const }];
  const d = deviationStats(rows);
  assert.equal(d.expected, 0.25);
  assert.equal(d.observed, 0.25);
  assert.ok(Math.abs(d.deviation) < 1e-12);
});

test("a perfectly deviant group reports the right sign and magnitude", () => {
  const rows = Array.from({ length: 100 }, () => ({ p: 0.25, y: 0 as const }));
  const d = deviationStats(rows);
  assert.ok(Math.abs(d.deviation - -0.25) < 1e-12);
  assert.ok(d.z < 0);
});

test("z uses the expected rate's standard error, not the observed rate's", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ p: 0.25, y: (i < 10 ? 1 : 0) as 0 | 1 }));
  const d = deviationStats(rows);
  const expectedZ = (0.1 - 0.25) / Math.sqrt((0.25 * 0.75) / 100);
  assert.ok(Math.abs(d.z - expectedZ) < 1e-9);
});

test("small groups are flagged rather than silently reported as findings", () => {
  const small = deviationStats(Array.from({ length: MIN_CELL_N - 1 }, () => ({ p: 0.25, y: 0 as const })));
  const big = deviationStats(Array.from({ length: MIN_CELL_N }, () => ({ p: 0.25, y: 0 as const })));
  assert.equal(small.tooSmall, true);
  assert.equal(big.tooSmall, false);
});

test("an empty group returns NaN metrics rather than zeros that read as findings", () => {
  const d = deviationStats([]);
  assert.equal(d.n, 0);
  assert.ok(Number.isNaN(d.deviation));
  assert.ok(Number.isNaN(d.observed));
  assert.equal(d.tooSmall, true);
  assert.equal(d.expectedOutsideCI, false);
});

test("expectedOutsideCI is true only when the prediction falls outside the observed interval", () => {
  const far = deviationStats(Array.from({ length: 200 }, () => ({ p: 0.25, y: 0 as const })));
  assert.equal(far.expectedOutsideCI, true);
  const onTarget = deviationStats(Array.from({ length: 200 }, (_, i) => ({ p: 0.25, y: (i % 4 === 0 ? 1 : 0) as 0 | 1 })));
  assert.equal(onTarget.expectedOutsideCI, false);
});

test("Brier and log loss are finite at the probability extremes", () => {
  const d = deviationStats([{ p: 1e-9, y: 1 }, { p: 1 - 1e-9, y: 0 }]);
  assert.ok(Number.isFinite(d.logloss));
  assert.ok(Number.isFinite(d.brier));
});

test("deviation statistics are deterministic for identical input", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ p: 0.2 + (i % 10) / 100, y: (i % 3 === 0 ? 1 : 0) as 0 | 1 }));
  assert.deepEqual(deviationStats(rows), deviationStats(rows));
});

test("deviation statistics agree to floating-point tolerance under reordering", () => {
  // Summation is not associative in binary floating point, so reversing the
  // input can shift the last bits. The runner always feeds a stably ordered
  // array, and run-to-run determinism is verified separately by re-running the
  // whole analysis and diffing its output.
  const rows = Array.from({ length: 50 }, (_, i) => ({ p: 0.2 + (i % 10) / 100, y: (i % 3 === 0 ? 1 : 0) as 0 | 1 }));
  const a = deviationStats(rows);
  const b = deviationStats([...rows].reverse());
  assert.ok(Math.abs(a.deviation - b.deviation) < 1e-12);
  assert.ok(Math.abs(a.z - b.z) < 1e-9);
  assert.ok(Math.abs(a.ci95[0] - b.ci95[0]) < 1e-12);
});

// ---------- aggregation invariants ----------

test("cadence mix counts sum to the group size", () => {
  const rows = [{ cadence: "5m" }, { cadence: "15m" }, { cadence: "15m" }, { cadence: "60m" }];
  const m = cadenceMix(rows);
  assert.equal(Object.values(m).reduce((a, b) => a + b, 0), rows.length);
  assert.equal(m["15m"], 2);
});

test("cadence x regime cells partition the bucket population", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ marketId: `m${i}`, ts: 1000 + i, cadence: ["5m", "15m", "60m"][i % 3], p: 0.25, y: 0 as const }));
  const ps = chronologicalPeriods(rows, ts, id, 4);
  let total = 0;
  for (const per of ps) for (const c of ["5m", "15m", "60m"]) total += per.items.filter((r) => r.cadence === c).length;
  assert.equal(total, rows.length, "every market lands in exactly one period x cadence cell");
});

test("neighbouring bucket groups are disjoint and cover their range", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ p: 0.1 + (i / 200) * 0.4 }));
  const counts = [1, 2, 3, 4].map((b) => rows.filter((r) => bucketIndex(r.p) === b).length);
  assert.equal(counts.reduce((a, b) => a + b, 0), rows.filter((r) => r.p >= 0.1 && r.p < 0.5).length);
});

test("standardised deviation collapses toward zero when the effect is composition-driven", () => {
  // One cadence carries a large deviation but is rare in the population.
  const perCadence = [
    { cadence: "5m", dev: deviationStats(Array.from({ length: 50 }, () => ({ p: 0.25, y: 0 as const }))) },
    { cadence: "15m", dev: deviationStats(Array.from({ length: 50 }, (_, i) => ({ p: 0.25, y: (i % 4 === 0 ? 1 : 0) as 0 | 1 }))) },
  ];
  const heavy15m = standardisedDeviation(perCadence, { "5m": 1, "15m": 999 });
  const heavy5m = standardisedDeviation(perCadence, { "5m": 999, "15m": 1 });
  assert.ok(Math.abs(heavy15m) < 0.01, "weighting toward the well-calibrated cadence should nearly cancel the effect");
  assert.ok(heavy5m < -0.2, "weighting toward the deviant cadence should preserve it");
});

test("standardised deviation equals the plain deviation when cadences agree", () => {
  const same = deviationStats(Array.from({ length: 40 }, () => ({ p: 0.25, y: 0 as const })));
  const perCadence = [{ cadence: "5m", dev: same }, { cadence: "15m", dev: same }];
  const s = standardisedDeviation(perCadence, { "5m": 10, "15m": 90 });
  assert.ok(Math.abs(s - same.deviation) < 1e-12);
});

test("standardised deviation ignores empty cadences rather than returning NaN", () => {
  const perCadence = [
    { cadence: "5m", dev: deviationStats([]) },
    { cadence: "15m", dev: deviationStats(Array.from({ length: 30 }, () => ({ p: 0.25, y: 0 as const }))) },
  ];
  const s = standardisedDeviation(perCadence, { "5m": 100, "15m": 100 });
  assert.ok(Number.isFinite(s));
  assert.ok(Math.abs(s - -0.25) < 1e-12);
});
