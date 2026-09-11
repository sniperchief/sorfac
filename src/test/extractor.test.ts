// Unit tests for the pure parts of the T-1m extractor.
//
// These fixtures are NOT market data standing in for real prices — no test here
// asserts anything about DreamDEX. They exercise selection, timestamp alignment
// and the missing / stale / malformed branches of pure functions. All real
// numbers in the reports come from live extraction (see live.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";
import { HORIZON_SEC, targetInstant, windowAdmits, mapLimit } from "../extract-t1m.js";
import { baseObservation, finalize, quoteOf, type ObserveOptions } from "../providers/types.js";
import { lastAtOrBefore } from "../providers/fills.js";
import { lastClosedBucket } from "../providers/candles.js";

const OPTS: ObserveOptions = { staleAfterSec: 300 };

/** A minimal stand-in carrying only the fields the pure functions read. */
const mkt = (over: Partial<BinaryMarket> = {}): BinaryMarket =>
  ({
    marketId: "0xabc",
    asset: "BTC",
    collateral: "0x00000022da000002656c64d9ea6011ea952d008a",
    quoteDecimals: 18,
    tradingStart: "1000",
    expiry: "1900",
    poolAddress: "0xpool",
    ...over,
  }) as unknown as BinaryMarket;

// ---------- timestamp alignment ----------

test("target instant is exactly 60s before this market's own expiry", () => {
  assert.equal(targetInstant(mkt({ expiry: "1900" })), 1840);
  assert.equal(targetInstant(mkt({ expiry: "1900" })), 1900 - HORIZON_SEC);
});

test("horizon is relative to each market, not to wall clock", () => {
  assert.equal(targetInstant(mkt({ expiry: "500" })), 440);
  assert.equal(targetInstant(mkt({ expiry: "999999" })), 999939);
});

test("window admits T-1m only when the market is longer than the horizon", () => {
  assert.equal(windowAdmits(mkt({ tradingStart: "1000", expiry: "1900" })), true);
  assert.equal(windowAdmits(mkt({ tradingStart: "1000", expiry: "1060" })), true, "exactly 60s window lands on tradingStart");
  assert.equal(windowAdmits(mkt({ tradingStart: "1000", expiry: "1030" })), false, "30s window cannot admit T-1m");
});

test("a 15m market cannot admit a T-30m observation", () => {
  const m = mkt({ tradingStart: "0", expiry: "900" });
  assert.equal(windowAdmits(m, 1800), false);
  assert.equal(windowAdmits(m, 60), true);
});

// ---------- fill selection ----------

test("fills: picks the latest print at or before the target", () => {
  const prints = [{ t: 100, raw: "1" }, { t: 150, raw: "2" }, { t: 199, raw: "3" }, { t: 201, raw: "4" }];
  assert.equal(lastAtOrBefore(prints, 200)?.raw, "3");
});

test("fills: a print exactly at the target is included (no look-ahead off-by-one)", () => {
  assert.equal(lastAtOrBefore([{ t: 200, raw: "at" }], 200)?.raw, "at");
  assert.equal(lastAtOrBefore([{ t: 201, raw: "after" }], 200), null);
});

test("fills: unordered input still yields the latest eligible print", () => {
  const prints = [{ t: 199, raw: "c" }, { t: 100, raw: "a" }, { t: 150, raw: "b" }];
  assert.equal(lastAtOrBefore(prints, 200)?.raw, "c");
});

test("fills: no eligible print returns null", () => {
  assert.equal(lastAtOrBefore([], 200), null);
  assert.equal(lastAtOrBefore([{ t: 300, raw: "x" }], 200), null);
});

// ---------- candle selection ----------

test("candles: only a fully closed bucket is eligible", () => {
  const buckets = [{ bucketStart: 60, closePrice: "a" }, { bucketStart: 120, closePrice: "b" }, { bucketStart: 180, closePrice: "c" }];
  // target 180: bucket starting 120 closes at 180 and is eligible; 180 closes at 240 and is not.
  assert.equal(lastClosedBucket(buckets, 180)?.closePrice, "b");
});

test("candles: a bucket still open at the target is excluded", () => {
  assert.equal(lastClosedBucket([{ bucketStart: 150, closePrice: "open" }], 180), null);
});

test("candles: no buckets returns null", () => {
  assert.equal(lastClosedBucket([], 500), null);
});

// ---------- normalization: missing / stale / malformed ----------

const base = () => baseObservation("test", mkt(), 1840, Date.now(), 5);

test("missing: no print produces a missing, unusable observation", () => {
  const o = finalize(base(), null, null, 900, OPTS);
  assert.equal(o.status, "missing");
  assert.equal(o.ok, false);
  assert.equal(o.price, null);
  assert.equal(o.sourceTimestamp, null);
});

test("ok: a fresh in-range print scales by the market's own decimals", () => {
  const o = finalize(base(), "250000000000000000", 1840, 900, OPTS);
  assert.equal(o.status, "ok");
  assert.equal(o.ok, true);
  assert.equal(o.price, 0.25);
  assert.equal(o.rawPrice, "250000000000000000");
  assert.equal(o.ageSec, 0);
});

test("decimals come from the row, so a 6dp market is not misread by 1e12", () => {
  const six = baseObservation("test", mkt({ quoteDecimals: 6 }), 1840, Date.now(), 1);
  assert.equal(finalize(six, "250000", 1840, 900, OPTS).price, 0.25);
  // Reading an 18dp raw price with 6dp scaling overshoots by 1e12 and lands
  // far outside (0,1) — caught as malformed rather than silently believed.
  const wrongScale = finalize(six, "250000000000000000", 1840, 900, OPTS);
  assert.equal(wrongScale.status, "malformed");
  assert.equal(wrongScale.price, null);
});

test("stale: an old print stays usable but is flagged", () => {
  const o = finalize(base(), "500000000000000000", 1840 - 400, 900, OPTS);
  assert.equal(o.status, "stale");
  assert.equal(o.ok, true, "stale observations remain usable; staleness never filters calibration");
  assert.equal(o.price, 0.5);
  assert.equal(o.ageSec, 400);
});

test("stale boundary is exclusive at exactly staleAfterSec", () => {
  assert.equal(finalize(base(), "500000000000000000", 1840 - 300, 900, OPTS).status, "ok");
  assert.equal(finalize(base(), "500000000000000000", 1840 - 301, 900, OPTS).status, "stale");
});

test("ageFraction is measured against the market's own window", () => {
  const o = finalize(base(), "500000000000000000", 1840 - 180, 900, OPTS);
  assert.equal(o.ageFraction, 0.2);
});

test("malformed: prices at or outside the (0,1) probability range are rejected", () => {
  for (const raw of ["0", "1000000000000000000", "2000000000000000000"]) {
    const o = finalize(base(), raw, 1840, 900, OPTS);
    assert.equal(o.status, "malformed", `raw ${raw} should be malformed`);
    assert.equal(o.ok, false);
    assert.equal(o.price, null);
    assert.match(o.error!, /not a probability/);
  }
});

test("malformed: a non-numeric price is rejected rather than becoming NaN", () => {
  const o = finalize(base(), "not-a-number", 1840, 900, OPTS);
  assert.equal(o.status, "malformed");
  assert.equal(o.price, null);
});

test("malformed observations keep their timestamps for auditing", () => {
  const o = finalize(base(), "0", 1800, 900, OPTS);
  assert.equal(o.sourceTimestamp, 1800);
  assert.equal(o.ageSec, 40);
});

test("quote carries the collateral address and the row's decimals", () => {
  assert.deepEqual(quoteOf(mkt()), { token: "0x00000022da000002656c64d9ea6011ea952d008a", symbol: "USDso", decimals: 18 });
  assert.equal(quoteOf(mkt({ collateral: "0xdeadbeef" as `0x${string}` })).symbol, null, "unknown collateral is not guessed at");
});

// ---------- concurrency helper ----------

test("mapLimit preserves input order and visits every item", async () => {
  const r = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => x * 2);
  assert.deepEqual(r, [2, 4, 6, 8, 10, 12, 14]);
});

test("mapLimit respects its concurrency ceiling", async () => {
  let live = 0, peak = 0;
  await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
  });
  assert.ok(peak <= 4, `peak concurrency ${peak} exceeded 4`);
});
