// Phase 6 tests: the frozen correction, eligibility, paired scoring, and the
// leakage guarantees the prospective design depends on.
// Phase-1/2/3/4/5 tests are untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOOTSTRAP_SEED, FROZEN_CORRECTION, PRIMARY_CADENCE, PROSPECTIVE_CUTOFF, TARGET_SAMPLE,
  TARGET_WINDOW_DAYS, applyCorrection, bootstrapMeanCI, comparePaired, isPrimaryEligible,
  isProspective, mulberry32, pairMarket, temporalSegments,
} from "../correction.js";
import { EPS } from "../calibration.js";
import { inTargetBucket } from "../anomaly.js";

// ---------- the frozen correction ----------

test("the correction is exactly the pre-registered -8.56pp", () => {
  assert.equal(FROZEN_CORRECTION, 0.0856);
});

test("the pre-registered scope and stopping rule are the declared values", () => {
  assert.equal(PRIMARY_CADENCE, "15m");
  assert.equal(TARGET_WINDOW_DAYS, 30);
  assert.equal(TARGET_SAMPLE, 270);
  assert.equal(PROSPECTIVE_CUTOFF, 1789064400);
});

test("the correction subtracts, it does not scale or rescale", () => {
  assert.ok(Math.abs(applyCorrection(0.25) - 0.1644) < 1e-12);
  assert.ok(Math.abs(applyCorrection(0.2) - 0.1144) < 1e-12);
  assert.ok(Math.abs(applyCorrection(0.2999) - 0.2143) < 1e-9);
});

test("the correction never binds the probability bound inside the target bucket", () => {
  for (let p = 0.2; p < 0.3; p += 0.005) {
    const a = applyCorrection(Number(p.toFixed(4)));
    assert.ok(a > EPS && a < 1 - EPS, `p=${p} produced ${a}`);
    assert.ok(Math.abs(a - (p - FROZEN_CORRECTION)) < 1e-9, "no clamping should occur here");
  }
});

test("probability bounds hold even for inputs outside the target bucket", () => {
  assert.equal(applyCorrection(0.01), EPS, "a value driven below zero is bounded, not negative");
  assert.ok(applyCorrection(0.0856) >= EPS);
  assert.ok(applyCorrection(1) < 1);
  assert.ok(applyCorrection(0) > 0);
});

// ---------- eligibility ----------

const m = (over: Partial<{ cadence: string; expiry: number; rawP: number | null }> = {}) => ({
  cadence: "15m", expiry: PROSPECTIVE_CUTOFF + 1, rawP: 0.25, ...over,
});

test("eligibility requires the 20-30% bucket with Phase-2 boundaries", () => {
  assert.equal(isPrimaryEligible(m({ rawP: 0.2 })), true, "lower bound inclusive");
  assert.equal(isPrimaryEligible(m({ rawP: 0.29999 })), true);
  assert.equal(isPrimaryEligible(m({ rawP: 0.3 })), false, "upper bound exclusive");
  assert.equal(isPrimaryEligible(m({ rawP: 0.19999 })), false);
  for (const p of [0.2, 0.25, 0.299]) assert.equal(inTargetBucket(p), true);
});

test("eligibility is 15m only: other cadences are excluded from the primary test", () => {
  assert.equal(isPrimaryEligible(m({ cadence: "5m" })), false);
  assert.equal(isPrimaryEligible(m({ cadence: "60m" })), false);
  assert.equal(isPrimaryEligible(m({ cadence: "other" })), false);
  assert.equal(isPrimaryEligible(m({ cadence: "15m" })), true);
});

test("eligibility enforces the prospective cutoff strictly", () => {
  assert.equal(isPrimaryEligible(m({ expiry: PROSPECTIVE_CUTOFF })), false, "a market at the cutoff is historical");
  assert.equal(isPrimaryEligible(m({ expiry: PROSPECTIVE_CUTOFF - 1 })), false);
  assert.equal(isPrimaryEligible(m({ expiry: PROSPECTIVE_CUTOFF + 1 })), true);
  assert.equal(isProspective(PROSPECTIVE_CUTOFF), false);
  assert.equal(isProspective(PROSPECTIVE_CUTOFF + 1), true);
});

test("every pre-cutoff market is excluded no matter how well it qualifies otherwise", () => {
  const historical = Array.from({ length: 50 }, (_, i) => m({ expiry: PROSPECTIVE_CUTOFF - i - 1, rawP: 0.25 }));
  assert.equal(historical.filter(isPrimaryEligible).length, 0);
});

test("eligibility rejects an absent or invalid probability", () => {
  assert.equal(isPrimaryEligible(m({ rawP: null })), false);
  assert.equal(isPrimaryEligible(m({ rawP: NaN })), false);
});

test("eligibility reads the RAW probability, not the adjusted one", () => {
  // raw 0.25 qualifies; its adjusted value 0.1644 does not sit in the bucket.
  const row = m({ rawP: 0.25 });
  assert.equal(isPrimaryEligible(row), true);
  assert.equal(inTargetBucket(applyCorrection(0.25)), false, "the adjusted value leaves the bucket");
  // A raw value whose ADJUSTED form lands in the bucket must not qualify.
  assert.equal(isPrimaryEligible(m({ rawP: 0.36 })), false);
  assert.equal(inTargetBucket(applyCorrection(0.36)), true);
});

// ---------- paired scoring ----------

test("the baseline is preserved alongside every adjusted prediction", () => {
  const p = pairMarket("a", 0.25, 1);
  assert.equal(p.raw, 0.25, "the raw prediction must survive untouched");
  assert.ok(Math.abs(p.adjusted - 0.1644) < 1e-12);
  assert.notEqual(p.raw, p.adjusted);
});

test("both predictions are scored against the same realized outcome", () => {
  const p = pairMarket("a", 0.25, 0);
  assert.ok(Math.abs(p.brierRaw - 0.0625) < 1e-12);
  assert.ok(Math.abs(p.brierAdj - 0.1644 ** 2) < 1e-9);
  assert.equal(p.y, 0);
});

test("lowering the prediction helps when the outcome is Down and hurts when it is Up", () => {
  const down = pairMarket("a", 0.25, 0);
  assert.ok(down.brierAdj < down.brierRaw);
  const up = pairMarket("b", 0.25, 1);
  assert.ok(up.brierAdj > up.brierRaw);
});

test("log loss stays finite for both predictions at the bounds", () => {
  for (const y of [0, 1] as const) {
    const p = pairMarket("a", 0.2, y);
    assert.ok(Number.isFinite(p.loglossRaw) && Number.isFinite(p.loglossAdj));
  }
});

test("paired differences are adjusted minus baseline, so negative favours the correction", () => {
  const rows = [pairMarket("a", 0.25, 0), pairMarket("b", 0.25, 0), pairMarket("c", 0.25, 0)];
  const c = comparePaired(rows);
  assert.ok(c.brierDiff < 0, "all-Down outcomes should favour a downward correction");
  assert.equal(c.adjustedBetterCount, 3);
});

test("paired comparison keeps both means and never overwrites the baseline", () => {
  const rows = [pairMarket("a", 0.25, 1), pairMarket("b", 0.25, 0)];
  const c = comparePaired(rows);
  assert.ok(Math.abs(c.brierRaw - (0.5625 + 0.0625) / 2) < 1e-12);
  assert.notEqual(c.brierRaw, c.brierAdj);
  assert.equal(c.n, 2);
});

test("an empty paired comparison yields NaN rather than a zero that reads as a result", () => {
  const c = comparePaired([]);
  assert.equal(c.n, 0);
  assert.ok(Number.isNaN(c.brierRaw));
  assert.ok(Number.isNaN(c.brierDiff));
});

// ---------- denominators ----------

test("every qualifying market contributes exactly one pair", () => {
  const raws = [0.21, 0.24, 0.27, 0.29];
  const pairs = raws.map((r, i) => pairMarket(`m${i}`, r, (i % 2) as 0 | 1));
  assert.equal(comparePaired(pairs).n, raws.length);
  assert.equal(new Set(pairs.map((p) => p.marketId)).size, raws.length);
});

test("the qualifying set is a subset of the prospective set", () => {
  const rows = [
    m({ expiry: PROSPECTIVE_CUTOFF - 100 }),
    m({ cadence: "5m" }),
    m({ rawP: 0.5 }),
    m(),
  ];
  const prospectiveRows = rows.filter((r) => isProspective(r.expiry));
  const qualifying = rows.filter(isPrimaryEligible);
  assert.ok(qualifying.length <= prospectiveRows.length);
  assert.equal(qualifying.length, 1);
});

// ---------- bootstrap determinism ----------

test("the seeded generator is deterministic", () => {
  const a = Array.from({ length: 5 }, mulberry32(BOOTSTRAP_SEED));
  const b = Array.from({ length: 5 }, mulberry32(BOOTSTRAP_SEED));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, Array.from({ length: 5 }, mulberry32(BOOTSTRAP_SEED + 1)));
});

test("bootstrap intervals reproduce exactly across runs", () => {
  const diffs = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? -0.05 : 0.02));
  assert.deepEqual(bootstrapMeanCI(diffs), bootstrapMeanCI(diffs));
});

test("bootstrap brackets the observed mean difference", () => {
  const diffs = Array.from({ length: 60 }, (_, i) => -0.04 + (i % 5) * 0.01);
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const [lo, hi] = bootstrapMeanCI(diffs);
  assert.ok(lo <= mean && mean <= hi);
});

test("bootstrap declines to produce an interval below three observations", () => {
  assert.ok(Number.isNaN(bootstrapMeanCI([0.1])[0]));
  assert.ok(Number.isNaN(bootstrapMeanCI([0.1, 0.2])[0]));
  assert.ok(Number.isFinite(bootstrapMeanCI([0.1, 0.2, 0.3])[0]));
});

// ---------- temporal segmentation ----------

const seg = (id: string, expiry: number) => ({ id, expiry });

test("temporal segments are chronological and deterministic", () => {
  const rows = [seg("c", 300), seg("a", 100), seg("d", 400), seg("b", 200), seg("e", 500), seg("f", 600)];
  const s = temporalSegments(rows, (r) => r.expiry, (r) => r.id, 3);
  assert.deepEqual(s.map((x) => x.map((r) => r.id)), [["a", "b"], ["c", "d"], ["e", "f"]]);
  const again = temporalSegments([...rows].reverse(), (r) => r.expiry, (r) => r.id, 3);
  assert.deepEqual(s, again);
});

test("temporal segments partition without loss or duplication", () => {
  const rows = Array.from({ length: 29 }, (_, i) => seg(`m${i}`, 1000 + i));
  const s = temporalSegments(rows, (r) => r.expiry, (r) => r.id, 3);
  assert.equal(s.reduce((a, x) => a + x.length, 0), rows.length);
  assert.equal(new Set(s.flat().map((r) => r.id)).size, rows.length);
});

test("temporal segmentation of an empty population yields empty segments, not an error", () => {
  const s = temporalSegments([] as { id: string; expiry: number }[], (r) => r.expiry, (r) => r.id, 3);
  assert.equal(s.length, 3);
  assert.ok(s.every((x) => x.length === 0));
});

// ---------- leakage guarantees ----------

test("the correction is independent of the outcome", () => {
  assert.equal(pairMarket("a", 0.25, 1).adjusted, pairMarket("b", 0.25, 0).adjusted);
});

test("the correction is independent of anything except the raw probability", () => {
  // Same raw probability, wildly different everything else: same adjusted value.
  const a = pairMarket("early", 0.2345, 1);
  const b = pairMarket("late", 0.2345, 0);
  assert.equal(a.adjusted, b.adjusted);
});

test("applying the correction twice is not the tested hypothesis", () => {
  // Guards against an accidental double application in a future refactor.
  const once = applyCorrection(0.25);
  assert.ok(Math.abs(once - 0.1644) < 1e-12);
  assert.ok(Math.abs(applyCorrection(once) - 0.0788) < 1e-9, "documents what double application would give");
  assert.notEqual(once, applyCorrection(once));
});
