import { readFileSync } from "node:fs";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";
const m: BinaryMarket[] = JSON.parse(readFileSync(`out/markets-${process.env.DDX_ENV ?? "mainnet"}.json`, "utf8"));

const tab = (name: string, key: (x: BinaryMarket) => string) => {
  const c: Record<string, number> = {};
  for (const x of m) c[key(x)] = (c[key(x)] ?? 0) + 1;
  console.log(`\n${name}:`);
  for (const [k, v] of Object.entries(c).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(74)} ${v}`);
};

tab("collateral x quoteDecimals", (x) => `${x.collateral} dec=${x.quoteDecimals}`);
tab("operatorId/venueId x quoteDecimals", (x) => `op=${x.operatorId ?? "?"} ${x.venueId ?? "?"} dec=${x.quoteDecimals}`);
tab("asset", (x) => x.asset);
tab("interval label", (x) => `${x.interval ?? "?"} (intervalSec=${x.intervalSec ?? "?"})`);
tab("mode", (x) => x.mode);

const withVol = m.filter((x) => Number(x.tradeCount) > 0);
console.log(`\ntraded markets: ${withVol.length}`);
console.log("sample traded row:");
const s = withVol.sort((a, b) => Number(b.tradeCount) - Number(a.tradeCount))[0];
console.log(JSON.stringify(s, null, 2).slice(0, 2600));
