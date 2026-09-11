// Run the T-1m extractor over the real Phase-1 calibration population.
//
//   npm run extract            full run
//   npm run extract -- 200     first 200 markets (smoke)
//
// Reads the Phase-1 market pull for the population definition, then hits the
// live DreamDEX indexer for every observation. No fixtures, no fabrication.

import { writeFileSync } from "node:fs";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";
import { ENV, INDEXER_URL } from "./config.js";
import { FillsProvider } from "./providers/fills.js";
import { CandlesProvider } from "./providers/candles.js";
import { DEFAULT_STALE_AFTER_SEC, HORIZON_SEC, extractOne, mapLimit, type ExtractionRow } from "./extract-t1m.js";
import { loadRequired, parseLimitArg } from "./io.js";

const CONCURRENCY = Number(process.env.DDX_CONCURRENCY ?? 8);
const limitArg = parseLimitArg(process.argv[2], "market limit");

const markets = loadRequired<BinaryMarket[]>(`out/markets-${ENV}.json`, "the Phase-1 market registry");

// The Phase-1 calibration population, reproduced with Phase-1's own filters:
// finalized, not voided, tradeCount > 0. Price and outcome validity are applied
// later, at comparison time, exactly as Phase 1 applied them.
const population = markets
  .filter((m) => m.status === "Finalized" && !m.voided && Number(m.tradeCount) > 0)
  .sort((a, b) => Number(a.expiry) - Number(b.expiry));

const target = limitArg ? population.slice(0, limitArg) : population;
const providers = [new FillsProvider(), new CandlesProvider()];

console.log(`env=${ENV} indexer=${INDEXER_URL}`);
console.log(`horizon=T-${HORIZON_SEC}s staleAfter=${DEFAULT_STALE_AFTER_SEC}s concurrency=${CONCURRENCY}`);
console.log(`population=${population.length} extracting=${target.length} providers=${providers.map((p) => p.name).join(", ")}\n`);

const t0 = Date.now();
let done = 0;
const rows: ExtractionRow[] = await mapLimit(target, CONCURRENCY, async (m) => {
  const r = await extractOne(m, providers, { staleAfterSec: DEFAULT_STALE_AFTER_SEC });
  if (++done % 250 === 0 || done === target.length) {
    const rate = done / ((Date.now() - t0) / 1000);
    process.stderr.write(`  ${done}/${target.length}  ${rate.toFixed(1)}/s  eta ${(((target.length - done) / rate) / 60).toFixed(1)}min\n`);
  }
  return r;
});
const elapsedMs = Date.now() - t0;

const byStatus: Record<string, Record<string, number>> = {};
for (const r of rows) {
  for (const o of r.observations) {
    byStatus[o.provider] ??= {};
    byStatus[o.provider][o.status] = (byStatus[o.provider][o.status] ?? 0) + 1;
  }
}

console.log(`\nextracted ${rows.length} markets in ${(elapsedMs / 1000).toFixed(1)}s`);
for (const [p, counts] of Object.entries(byStatus)) console.log(`  ${p.padEnd(20)} ${JSON.stringify(counts)}`);

writeFileSync(
  `out/t1m-${ENV}.json`,
  JSON.stringify({ generatedAt: new Date().toISOString(), env: ENV, indexerUrl: INDEXER_URL, horizonSec: HORIZON_SEC, staleAfterSec: DEFAULT_STALE_AFTER_SEC, populationSize: population.length, extracted: rows.length, elapsedMs, rows }, null, 2),
);
console.log(`\nwrote out/t1m-${ENV}.json`);
