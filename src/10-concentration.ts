import { readFileSync, writeFileSync } from "node:fs";
import { client } from "./config.js";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";

const M: BinaryMarket[] = JSON.parse(readFileSync(`out/markets-${process.env.DDX_ENV ?? "mainnet"}.json`, "utf8"));

// Who provides the prices the calibration is measuring? If one account makes
// nearly every fill, "the market's belief" is one bot's quote, not a consensus.
const traded = M.filter((m) => m.status === "Finalized" && Number(m.tradeCount) > 0);
const sample = traded.sort(() => Math.random() - 0.5).slice(0, 300);

const makers: Record<string, number> = {};
const takers: Record<string, number> = {};
const perMarketMakers: number[] = [];
let fills = 0, nullTaker = 0;

for (const m of sample) {
  const f = await client.getFills(m.poolAddress, { since: Number(m.tradingStart), until: Number(m.expiry), limit: 500 });
  const mine = f.filter((x) => x.market.toLowerCase() === m.marketId.toLowerCase());
  fills += mine.length;
  const mk = new Set<string>();
  for (const x of mine) {
    if (x.maker) { makers[x.maker] = (makers[x.maker] ?? 0) + 1; mk.add(x.maker); }
    if (x.taker) takers[x.taker] = (takers[x.taker] ?? 0) + 1; else nullTaker++;
  }
  perMarketMakers.push(mk.size);
}

const top = (o: Record<string, number>, n: number) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
const share = (o: Record<string, number>, n: number) => {
  const tot = Object.values(o).reduce((a, b) => a + b, 0);
  return tot ? (top(o, n).reduce((a, [, v]) => a + v, 0) / tot) * 100 : 0;
};

console.log(`Sampled ${sample.length} traded finalized markets, ${fills} fills\n`);
console.log(`Distinct makers: ${Object.keys(makers).length}   distinct takers: ${Object.keys(takers).length}`);
console.log(`Fills with null taker (indexer bridge gap): ${nullTaker} (${((nullTaker / fills) * 100).toFixed(1)}%)`);
console.log(`Top-1 maker share of fills:  ${share(makers, 1).toFixed(1)}%`);
console.log(`Top-3 maker share of fills:  ${share(makers, 3).toFixed(1)}%`);
console.log(`Top-1 taker share of fills:  ${share(takers, 1).toFixed(1)}%`);
console.log(`Top-3 taker share of fills:  ${share(takers, 3).toFixed(1)}%`);
console.log(`\nTop makers: ${JSON.stringify(top(makers, 5))}`);
console.log(`Top takers: ${JSON.stringify(top(takers, 5))}`);
const avgMk = perMarketMakers.reduce((a, b) => a + b, 0) / perMarketMakers.length;
console.log(`\nDistinct makers per market: mean ${avgMk.toFixed(2)}, markets with exactly 1 maker: ${perMarketMakers.filter((x) => x === 1).length}/${perMarketMakers.length}`);

writeFileSync("out/concentration.json", JSON.stringify({ sampledMarkets: sample.length, fills, distinctMakers: Object.keys(makers).length, distinctTakers: Object.keys(takers).length, top1MakerShare: share(makers, 1), top3MakerShare: share(makers, 3), top1TakerShare: share(takers, 1), top3TakerShare: share(takers, 3), nullTakerPct: (nullTaker / fills) * 100, meanMakersPerMarket: avgMk }, null, 2));
