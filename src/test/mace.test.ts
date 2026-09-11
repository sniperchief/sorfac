// Tests for the mean-absolute-calibration-error summary added in Phase 2.
// It reads the Phase-1 buckets and introduces no new calibration rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mace } from "../compare.js";

test("mace averages the absolute bucket diffs", () => {
  const r = mace([{ n: 1, diff: 0.1 }, { n: 1, diff: -0.3 }]);
  assert.ok(Math.abs(r.plain - 0.2) < 1e-12);
});

test("mace ignores empty buckets rather than counting them as zero error", () => {
  const r = mace([{ n: 10, diff: 0.2 }, { n: 0, diff: null }]);
  assert.ok(Math.abs(r.plain - 0.2) < 1e-12, "an empty bucket must not halve the error");
});

test("weighted mace favours the buckets that hold the samples", () => {
  const r = mace([{ n: 99, diff: 0.01 }, { n: 1, diff: 0.5 }]);
  assert.ok(r.weighted < r.plain, "weighting should pull toward the large low-error bucket");
  assert.ok(Math.abs(r.weighted - (99 * 0.01 + 0.5) / 100) < 1e-12);
});

test("a perfectly calibrated curve scores zero", () => {
  assert.equal(mace([{ n: 5, diff: 0 }, { n: 7, diff: 0 }]).plain, 0);
});

test("no filled buckets yields NaN rather than a misleading zero", () => {
  assert.ok(Number.isNaN(mace([{ n: 0, diff: null }]).plain));
});
