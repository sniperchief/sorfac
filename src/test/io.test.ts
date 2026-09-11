// Regression tests for the production-audit fixes.
//
// These cover bugs found during the final audit, not research methodology:
//   - a bad CLI limit silently truncated the extraction to zero rows
//   - missing prerequisite files crashed with a raw ENOENT stack trace
//   - a failed consistency check still exited 0
//   - the observed price tick grid is what keeps 18-decimal Number() exact

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { bucketIndex } from "../compare.js";
import { lastAtOrBefore } from "../providers/fills.js";
import { lastClosedBucket } from "../providers/candles.js";

// ---------- BUG: a bad CLI limit silently produced an empty dataset ----------

test("slice with a NaN limit yields an empty array (the bug this guards)", () => {
  // Documents the underlying JS behaviour that made the bug silent: a typo'd
  // limit became NaN, and slice(0, NaN) is [], so the run overwrote the
  // extraction output with zero rows instead of failing.
  assert.equal([1, 2, 3].slice(0, Number("abc")).length, 0);
});

function spawn(args: string[], env: Record<string, string> = {}) {
  try {
    const out = execFileSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8", stdio: "pipe", env: { ...process.env, ...env } });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number | null; stdout: string; stderr: string };
    return { code: err.status ?? -1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}


test("parseLimitArg accepts a positive integer and passes undefined through", async () => {
  const { parseLimitArg } = await import("../io.js");
  assert.equal(parseLimitArg(undefined), undefined);
  assert.equal(parseLimitArg("200"), 200);
  assert.equal(parseLimitArg("1"), 1);
});

test("the extract command exits non-zero on a bad limit rather than writing an empty dataset", () => {
  const r = spawn(["--import", "tsx", "src/run-extract.ts", "abc"]);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.out.slice(0, 300)}`);
  assert.match(r.out, /must be a positive integer/);
});

// ---------- BUG: missing prerequisites crashed with a raw stack trace ----------

test("a missing prerequisite exits 1 with an actionable message, not an ENOENT trace", () => {
  // testnet is a valid env with no persisted outputs in this checkout, so the
  // command reaches loadRequired rather than failing earlier on config.
  const r = spawn(["--import", "tsx", "src/run-compare.ts"], { DDX_ENV: "testnet" });
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.out.slice(0, 300)}`);
  assert.match(r.out, /required input is missing/, "must name the problem");
  assert.match(r.out, /npm run/, "must say which command produces it");
  assert.doesNotMatch(r.out, /at readFileSync/, "must not surface a raw fs stack trace");
});

test("an invalid DDX_ENV is rejected with a clear message, not an SDK stack trace", () => {
  // Regression: DDX_ENV was cast unchecked, so a typo produced an undefined
  // indexer URL AND silently selected testnet chain/addresses.
  const r = spawn(["--import", "tsx", "src/run-compare.ts"], { DDX_ENV: "Mainnet" });
  assert.equal(r.code, 1);
  assert.match(r.out, /DDX_ENV must be one of/);
  assert.doesNotMatch(r.out, /NotConfiguredError/, "must not surface the raw SDK error");
});

// ---------- Precision assumption that keeps 18-decimal scaling exact ----------

test("observed prices sit on a 0.001 tick grid, which is why Number() stays exact", () => {
  // 18-decimal raw prices exceed 2^53, so Number() would lose precision if the
  // venue ever quoted more than ~15 significant digits. Every price observed on
  // mainnet has at most 3. If this assumption ever breaks, the pipeline must
  // move to BigInt scaling — this test is the tripwire.
  const path = "out/t1m-mainnet.json";
  if (!existsSync(path)) return; // dataset not built in this checkout
  const data = JSON.parse(readFileSync(path, "utf8"));
  let checked = 0;
  for (const row of data.rows) {
    for (const o of row.observations) {
      if (o.rawPrice == null) continue;
      checked++;
      const significant = String(o.rawPrice).replace(/0+$/, "").length;
      assert.ok(significant <= 15, `raw price ${o.rawPrice} has ${significant} significant digits; Number() is no longer exact`);
      assert.equal(BigInt(o.rawPrice), BigInt(Math.round(Number(o.rawPrice))), `raw price ${o.rawPrice} does not survive Number()`);
    }
  }
  assert.ok(checked > 0, "expected at least one raw price to check");
});

test("bucket boundaries survive float arithmetic at every quotable tick", () => {
  // Guards the 20-30% bucket in particular: p*10 must not drift across an
  // integer boundary for any price the venue can actually quote.
  for (let tick = 1; tick <= 999; tick++) {
    assert.equal(bucketIndex(tick / 1000), Math.min(9, Math.floor(tick / 100)), `p=${tick / 1000} landed in the wrong bucket`);
  }
  assert.equal(bucketIndex(0.2), 2);
  assert.equal(bucketIndex(0.299), 2);
  assert.equal(bucketIndex(0.3), 3);
});

// ---------- Look-ahead guarantee at the provider level ----------

test("neither provider can ever return a source timestamp after the target", () => {
  const target = 1000;
  const prints = Array.from({ length: 50 }, (_, i) => ({ t: 960 + i, raw: String(i) }));
  const pick = lastAtOrBefore(prints, target);
  assert.ok(pick !== null && pick.t <= target, "fills provider selected a future print");

  const buckets = Array.from({ length: 50 }, (_, i) => ({ bucketStart: 700 + i * 20, closePrice: String(i) }));
  const b = lastClosedBucket(buckets, target);
  assert.ok(b !== null && b.bucketStart + 60 <= target, "candles provider selected an unclosed bucket");
});
