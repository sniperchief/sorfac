// Live tests: the extractor against the real DreamDEX indexer.
//
// These make network calls and assert on real, settled markets. They are the
// counterpart to the pure unit tests — nothing here uses a fixture. Skipped
// automatically when the extraction output is absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";
import { ENV } from "../config.js";
import { FillsProvider } from "../providers/fills.js";
import { CandlesProvider } from "../providers/candles.js";
import { DEFAULT_STALE_AFTER_SEC, extractOne, targetInstant } from "../extract-t1m.js";
import { qualityIssues } from "../compare.js";

const MARKETS = `out/markets-${ENV}.json`;
const hasMarkets = existsSync(MARKETS);
const opts = { staleAfterSec: DEFAULT_STALE_AFTER_SEC };

const pickMarkets = (n: number): BinaryMarket[] =>
  (JSON.parse(readFileSync(MARKETS, "utf8")) as BinaryMarket[])
    .filter((m) => m.status === "Finalized" && !m.voided && Number(m.tradeCount) >= 5)
    .sort((a, b) => Number(b.tradeCount) - Number(a.tradeCount))
    .slice(0, n);

test("live: extracts a real T-1m observation from settled market data", { skip: !hasMarkets }, async () => {
  const [m] = pickMarkets(1);
  const r = await extractOne(m, [new FillsProvider()], opts);
  const o = r.observations[0];

  assert.equal(o.status === "ok" || o.status === "stale", true, `unexpected status ${o.status}: ${o.error}`);
  assert.ok(o.price! > 0 && o.price! < 1, `price ${o.price} is not a probability`);
  assert.ok(o.sourceTimestamp! <= r.targetTimestamp, "no look-ahead");
  assert.ok(o.sourceTimestamp! >= r.tradingStart, "source is inside the trading window");
  assert.equal(o.quote.decimals, m.quoteDecimals, "decimals come from the row");
  assert.ok(o.latencyMs >= 0);
  assert.ok(o.retrievalTimestamp > 1_700_000_000_000, "retrieval stamp is unix ms");
});

test("live: the horizon lands 60s before this market's real expiry", { skip: !hasMarkets }, async () => {
  const [m] = pickMarkets(1);
  assert.equal(targetInstant(m), Number(m.expiry) - 60);
  const r = await extractOne(m, [new FillsProvider()], opts);
  assert.equal(r.targetTimestamp, Number(m.expiry) - 60);
});

test("live: fills are scoped to one market even on a recycled pool", { skip: !hasMarkets }, async () => {
  // Find a pool that has served many successive markets, then confirm the
  // windowed read returns nothing belonging to another market.
  const all = JSON.parse(readFileSync(MARKETS, "utf8")) as BinaryMarket[];
  const byPool = new Map<string, BinaryMarket[]>();
  for (const m of all) byPool.set(m.poolAddress, [...(byPool.get(m.poolAddress) ?? []), m]);
  const [, lives] = [...byPool.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  assert.ok(lives.length > 100, `expected a heavily recycled pool, saw ${lives.length} lives`);

  const m = lives.filter((x) => Number(x.tradeCount) > 0).sort((a, b) => Number(b.tradeCount) - Number(a.tradeCount))[0];
  const r = await extractOne(m, [new FillsProvider()], opts);
  const o = r.observations[0];
  assert.notEqual(o.status, "unavailable", o.error ?? "");
  if (o.sourceTimestamp != null) {
    assert.ok(o.sourceTimestamp >= Number(m.tradingStart) && o.sourceTimestamp <= r.targetTimestamp,
      "a foreign market's fill would fall outside this window");
  }
});

test("live: both providers agree on which market and window they read", { skip: !hasMarkets }, async () => {
  const [m] = pickMarkets(1);
  const r = await extractOne(m, [new FillsProvider(), new CandlesProvider()], opts);
  assert.equal(r.observations.length, 2);
  for (const o of r.observations) {
    assert.equal(o.marketId, m.marketId);
    assert.equal(o.targetTimestamp, Number(m.expiry) - 60);
    assert.equal(o.quote.decimals, m.quoteDecimals);
  }
});

test("live: a batch of real markets raises no timestamp quality issues", { skip: !hasMarkets }, async () => {
  const ms = pickMarkets(5);
  const rows = [];
  for (const m of ms) rows.push(await extractOne(m, [new FillsProvider(), new CandlesProvider()], opts));
  const issues = qualityIssues(rows);
  assert.deepEqual(issues, [], `quality issues on live data: ${JSON.stringify(issues.slice(0, 3))}`);
});

test("live: a provider failure degrades to unavailable rather than throwing", { skip: !hasMarkets }, async () => {
  const [m] = pickMarkets(1);
  // A syntactically valid but non-existent pool address: the read fails or
  // returns nothing, and either way the extractor must not throw.
  const bogus = { ...m, poolAddress: "0x0000000000000000000000000000000000000001" } as BinaryMarket;
  const r = await extractOne(bogus, [new FillsProvider()], opts);
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0].ok, false);
  assert.ok(["missing", "unavailable"].includes(r.observations[0].status), `saw ${r.observations[0].status}`);
});
