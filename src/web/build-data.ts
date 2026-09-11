// Build the static data payload the web UI reads.
//
// Reads the persisted Phase 1-6 artifacts through the same guarded loader the
// research runners use, projects them with src/web/bundle.ts, and writes two
// files into web/public/data. It fetches nothing and computes nothing: if a
// prerequisite phase has not been run, it exits with the same actionable
// message every other command gives.

import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { ENV } from "../config.js";
import { loadRequired } from "../io.js";
import {
  buildMarketRows,
  buildResearchBundle,
  encodeMarketRows,
  type AnomalyDoc,
  type ComparisonDoc,
  type FreshnessDoc,
  type ProspectiveDoc,
  type QualityDoc,
  type RegistryRow,
  type StatsDoc,
  type T1mDoc,
} from "./bundle.js";

const OUT_DIR = "web/public/data";

const anomaly = loadRequired<AnomalyDoc>(`out/anomaly-analysis-${ENV}.json`, "Phase 5 anomaly analysis");
const comparison = loadRequired<ComparisonDoc>(`out/comparison-${ENV}.json`, "Phase 2 calibration comparison");
const quality = loadRequired<QualityDoc>(`out/market-quality-${ENV}.json`, "Phase 3 per-market quality");
const freshness = loadRequired<FreshnessDoc>(`out/freshness-validation-${ENV}.json`, "Phase 4 out-of-sample validation");
const prospective = loadRequired<ProspectiveDoc>(`out/prospective-correction-${ENV}.json`, "Phase 6 prospective correction state");
const stats = loadRequired<StatsDoc>(`out/stats-${ENV}.json`, "Phase 1 population statistics");
const t1m = loadRequired<T1mDoc>(`out/t1m-${ENV}.json`, "T-1m observations");
// Only the on-chain question text is taken from the registry; it is the one
// display field the later phases do not carry forward.
const registry = loadRequired<RegistryRow[]>(`out/markets-${ENV}.json`, "the market registry");

const builtAt = new Date().toISOString();
// The repository URL is not discoverable from the working tree, so it is
// supplied rather than guessed. Without it the footer omits the link instead of
// pointing somewhere that is not this project.
const repositoryUrl = process.env.DDX_REPO_URL?.trim() || null;

const research = buildResearchBundle({ anomaly, comparison, quality, freshness, prospective, stats, t1m, builtAt, repositoryUrl });
const markets = buildMarketRows(quality, t1m, registry);

// A silently empty explorer would look like a product bug and read like fake
// data, so an empty projection is fatal rather than shipped.
if (!markets.length) {
  console.error(`\nERROR: the market projection produced zero rows from out/market-quality-${ENV}.json.`);
  console.error(`  regenerate the phase outputs with: npm run analyze-quality\n`);
  process.exit(1);
}
if (markets.length !== quality.perMarket.length) {
  console.error(`\nERROR: projected ${markets.length} rows from ${quality.perMarket.length} per-market records.`);
  console.error(`  the projection must not drop or duplicate markets.\n`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/research.json`, JSON.stringify(research));
writeFileSync(
  `${OUT_DIR}/markets.json`,
  JSON.stringify({ env: research.env, builtAt, source: `out/market-quality-${ENV}.json`, count: markets.length, ...encodeMarketRows(markets) }),
);

const kb = (p: string) => `${(statSync(p).size / 1024).toFixed(0)} KB`;
console.log(`wrote ${OUT_DIR}/research.json  (${kb(`${OUT_DIR}/research.json`)})`);
console.log(`wrote ${OUT_DIR}/markets.json   (${kb(`${OUT_DIR}/markets.json`)}, ${markets.length} markets)`);
console.log(`headline: ${research.headline.bucket} n=${research.headline.n} deviation=${((research.headline.deviation ?? 0) * 100).toFixed(2)}pp`);
console.log(`phase 6:  gate ${research.phase6.gate}, ${research.phase6.qualifying} qualifying markets, validated=${research.phase6.validated}`);
