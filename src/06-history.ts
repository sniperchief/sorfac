import { readFileSync, writeFileSync } from "node:fs";
import { client, ORACLE_BASE } from "./config.js";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";

const ENV = process.env.DDX_ENV ?? "mainnet";
const M: BinaryMarket[] = JSON.parse(readFileSync(`out/markets-${ENV}.json`, "utf8"));
const jsonSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

const attempts: { method: string; ok: boolean; note: string }[] = [];
async function probe<T>(method: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const v = await fn();
    attempts.push({ method, ok: true, note: Array.isArray(v) ? `${v.length} rows` : "ok" });
    return v;
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    attempts.push({ method, ok: false, note: msg });
    console.log(`   FAIL ${method}: ${msg.slice(0, 200)}`);
    return undefined;
  }
}

// Representative finalized markets: the thickest books available, since a thin
// book cannot demonstrate whether a horizon is reconstructable at all.
const picks = M.filter((m) => m.status === "Finalized" && Number(m.tradeCount) > 0)
  .sort((a, b) => Number(b.tradeCount) - Number(a.tradeCount))
  .slice(0, 6);

const HORIZONS = [1800, 900, 300, 60];
const out: unknown[] = [];

for (const m of picks) {
  const start = Number(m.tradingStart), exp = Number(m.expiry);
  const dec = m.quoteDecimals;
  console.log(`\n=== ${m.marketId} ${m.asset} ${m.interval} trades=${m.tradeCount} window=${exp - start}s`);
  console.log(`    pool=${m.poolAddress}  outcome=${m.winningOutcome === 0 ? "Up" : m.winningOutcome === 1 ? "Down" : "?"}  lastPrice=${Number(m.lastPrice) / 10 ** dec}`);

  // Fills scoped to THIS market's own trading window. The pool is recycled, so
  // an unscoped read would mix in other markets' lives on the same pool.
  const fills = await probe(`getFills(pool, {since:tradingStart, until:expiry})`, () =>
    client.getFills(m.poolAddress, { since: start, until: exp, limit: 1000 }),
  );
  // Same pool, unscoped: how much of the tape belongs to OTHER markets?
  const unscoped = await probe(`getFills(pool) unscoped`, () => client.getFills(m.poolAddress, { limit: 1000 }));

  const mine = (fills ?? []).filter((f) => f.market.toLowerCase() === m.marketId.toLowerCase());
  const foreign = (fills ?? []).length - mine.length;
  console.log(`    getFills windowed: ${(fills ?? []).length} rows, ${mine.length} belong to this marketId, ${foreign} foreign`);
  console.log(`    getFills unscoped: ${(unscoped ?? []).length} rows, ${(unscoped ?? []).filter((f) => f.market.toLowerCase() === m.marketId.toLowerCase()).length} belong to this marketId`);
  if (mine[0]) console.log(`    sample fill: ${JSON.stringify(mine[0], jsonSafe).slice(0, 320)}`);

  const candlesByInterval: Record<number, number> = {};
  for (const iv of [60, 300, 900, 3600]) {
    const c = await probe(`getCandles(pool, ${iv})`, () => client.getCandles(m.poolAddress, iv, { from: start, to: exp, limit: 500 }));
    candlesByInterval[iv] = (c ?? []).length;
  }
  console.log(`    candles in window by interval: ${JSON.stringify(candlesByInterval)}`);
  const c60 = await probe(`getCandles(pool,60) sample`, () => client.getCandles(m.poolAddress, 60, { from: start, to: exp, limit: 5 }));
  if (c60?.[0]) console.log(`    sample candle: ${JSON.stringify(c60[0], jsonSafe).slice(0, 300)}`);

  const activity = await probe(`getMarketActivity(marketId)`, () => client.getMarketActivity(m.marketId, { limit: 200 }));
  console.log(`    getMarketActivity: ${(activity ?? []).length} rows; kinds=${JSON.stringify([...new Set((activity ?? []).map((a) => a.kind))])}`);

  const res = await probe(`getMarketResolution(marketId)`, () => client.getMarketResolution(m.marketId));
  console.log(`    getMarketResolution: ${JSON.stringify(res, jsonSafe).slice(0, 400)}`);
  const open = await probe(`getOpeningPrices([marketId])`, () => client.getOpeningPrices([m.marketId]));
  console.log(`    getOpeningPrices: ${JSON.stringify(open, jsonSafe).slice(0, 200)}`);
  const chain = await probe(`getMarketOnchain(marketId)`, () => client.getMarketOnchain(m.marketId));
  console.log(`    getMarketOnchain: ${JSON.stringify(chain, jsonSafe).slice(0, 400)}`);
  const hist = await probe(`getMarketStatusHistory(marketId)`, () => client.getMarketStatusHistory(m.marketId));
  console.log(`    getMarketStatusHistory: ${(hist ?? []).length} rows ${JSON.stringify((hist ?? []).map((h) => `${h.oldStatus}->${h.newStatus}@${h.timestamp}`), jsonSafe).slice(0, 260)}`);

  // Can we reconstruct a probability at each horizon from the fill tape alone?
  const tape = mine
    .map((f) => ({ t: Number(f.timestamp), p: Number(f.fillPrice) / 10 ** dec }))
    .sort((a, b) => a.t - b.t);
  const snaps: Record<string, unknown> = {};
  for (const h of HORIZONS) {
    if (exp - h < start) { snaps[`T-${h / 60}m`] = "window too short"; continue; }
    const cut = exp - h;
    const prior = tape.filter((x) => x.t <= cut);
    snaps[`T-${h / 60}m`] = prior.length ? { price: prior[prior.length - 1].p, ageSec: cut - prior[prior.length - 1].t } : "no trade yet";
  }
  snaps["Final"] = tape.length ? { price: tape[tape.length - 1].p, ageSec: exp - tape[tape.length - 1].t } : "none";
  console.log(`    reconstructed snapshots: ${JSON.stringify(snaps)}`);
  console.log(`    oracle: ${ORACLE_BASE}/questions/${m.oracleQuestionId}?view=graph`);

  out.push({ marketId: m.marketId, asset: m.asset, interval: m.interval, tradeCount: m.tradeCount, windowSec: exp - start, fillsWindowed: (fills ?? []).length, fillsMine: mine.length, fillsForeignInWindow: foreign, fillsUnscoped: (unscoped ?? []).length, candlesByInterval, activityRows: (activity ?? []).length, resolution: res, openingPrices: open, snapshots: snaps, tape });
}

writeFileSync(`out/history-${ENV}.json`, JSON.stringify({ picks: out, attempts }, jsonSafe, 2));
console.log(`\n--- SDK method attempts ---`);
const agg: Record<string, { ok: number; fail: number; err: string }> = {};
for (const a of attempts) {
  const k = a.method.replace(/\d+/g, "N");
  agg[k] ??= { ok: 0, fail: 0, err: "" };
  if (a.ok) agg[k].ok++; else { agg[k].fail++; agg[k].err = a.note; }
}
for (const [k, v] of Object.entries(agg)) console.log(`  ${v.fail === 0 ? "OK  " : "FAIL"} ${k.padEnd(48)} ok=${v.ok} fail=${v.fail} ${v.err.slice(0, 140)}`);
