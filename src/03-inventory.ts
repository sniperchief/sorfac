import { writeFileSync } from "node:fs";
import { client, ENV, jsonSafe } from "./config.js";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";

const PAGE = 2000;
const nowSec = Math.floor(Date.now() / 1000);

// Page the historical tail to exhaustion. `nowSec` is pinned so the window does
// not slide underneath the paging cursor while we walk it (a market expiring
// mid-walk would otherwise shift every subsequent offset by one).
async function pullAll(status?: BinaryMarket["status"]): Promise<BinaryMarket[]> {
  const out: BinaryMarket[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await client.listPastBinaryMarkets({ status, limit: PAGE, offset, nowSec });
    out.push(...page);
    process.stderr.write(`  ${status ?? "ALL"}: offset=${offset} +${page.length} (total ${out.length})\n`);
    if (page.length < PAGE) break;
  }
  return out;
}

const all = await pullAll();

// Dedupe defensively: offset paging over a live table can repeat a row.
const byId = new Map<string, BinaryMarket>();
for (const m of all) byId.set(m.marketId.toLowerCase(), m);
const markets = [...byId.values()];

console.log(`\nfetched rows: ${all.length}, unique marketIds: ${markets.length}, dupes: ${all.length - markets.length}`);

const statusCounts: Record<string, number> = {};
for (const m of markets) statusCounts[m.status] = (statusCounts[m.status] ?? 0) + 1;
console.log("past-tail status split:", statusCounts);

const decimalsSeen = new Set(markets.map((m) => m.quoteDecimals));
console.log("quoteDecimals observed:", [...decimalsSeen]);
console.log("voided flag true:", markets.filter((m) => m.voided).length);
console.log("finalized flag true:", markets.filter((m) => m.finalized).length);
console.log("cross-tab status x voided:", JSON.stringify(
  markets.reduce<Record<string, number>>((a, m) => {
    const k = `${m.status}/voided=${m.voided}`;
    a[k] = (a[k] ?? 0) + 1;
    return a;
  }, {}),
));

writeFileSync(`out/markets-${ENV}.json`, JSON.stringify(markets, jsonSafe, 2));
console.log(`\nwrote out/markets-${ENV}.json`);
