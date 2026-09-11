import { readFileSync } from "node:fs";
import { client } from "./config.js";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";

const M: BinaryMarket[] = JSON.parse(readFileSync(`out/markets-${process.env.DDX_ENV ?? "mainnet"}.json`, "utf8"));

const byPool = new Map<string, BinaryMarket[]>();
for (const m of M) byPool.set(m.poolAddress, [...(byPool.get(m.poolAddress) ?? []), m]);

// The most-recycled pool in the dataset — the hardest case for window scoping.
const [pool, lives] = [...byPool.entries()].sort((a, b) => b[1].length - a[1].length)[0];
console.log(`pool ${pool} has served ${lives.length} markets\n`);

const traded = lives.filter((m) => Number(m.tradeCount) > 0).sort((a, b) => Number(b.tradeCount) - Number(a.tradeCount)).slice(0, 3);
console.log(`traded lives on this pool: ${lives.filter((m) => Number(m.tradeCount) > 0).length}\n`);

for (const m of traded) {
  const start = Number(m.tradingStart), exp = Number(m.expiry);
  const win = await client.getFills(pool, { since: start, until: exp, limit: 1000 });
  const mine = win.filter((f) => f.market.toLowerCase() === m.marketId.toLowerCase());
  const foreign = win.filter((f) => f.market.toLowerCase() !== m.marketId.toLowerCase());
  const foreignMarkets = [...new Set(foreign.map((f) => f.market))];
  console.log(`market ${m.marketId.slice(0, 12)}… nonce=${m.nonce} ${m.asset} ${m.interval} tradeCount=${m.tradeCount}`);
  console.log(`  window ${start}..${exp} (${exp - start}s)`);
  console.log(`  getFills windowed:  ${win.length} rows | mine ${mine.length} | FOREIGN ${foreign.length} from ${foreignMarkets.length} other markets`);
  if (foreignMarkets.length) console.log(`  foreign marketIds: ${foreignMarkets.slice(0, 3).join(", ")}`);

  // Candles cannot be filtered by marketId at all — they are a pool-level rollup.
  const c = await client.getCandles(pool, 60, { from: start, to: exp, limit: 500 });
  console.log(`  getCandles(60) in window: ${c.length} buckets (pool-level rollup, no marketId field: ${!("market" in (c[0] ?? {}))})`);

  // getMarketActivity is keyed by marketId, so it needs no window at all.
  const act = await client.getMarketActivity(m.marketId, { limit: 500 });
  const trades = act.filter((a) => a.kind === "TRADE");
  console.log(`  getMarketActivity(marketId): ${act.length} rows, ${trades.length} TRADE rows (expected ${m.tradeCount})\n`);
}

// Do adjacent lives on a recycled pool ever overlap in time?
const sorted = [...lives].sort((a, b) => Number(a.tradingStart) - Number(b.tradingStart));
let overlaps = 0, gapMin = Infinity;
for (let i = 1; i < sorted.length; i++) {
  const gap = Number(sorted[i].tradingStart) - Number(sorted[i - 1].expiry);
  if (gap < 0) overlaps++;
  gapMin = Math.min(gapMin, gap);
}
console.log(`adjacent lives on this pool: overlaps=${overlaps}, smallest gap between one life's expiry and the next life's tradingStart = ${gapMin}s`);
