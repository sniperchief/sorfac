// Verify that the shipped page payload is exactly what the phase outputs say.
//
// The page's central claim is that it displays recorded research rather than
// anything of its own. This checks that claim the strongest way available:
// rebuild the payload from out/*.json and diff it, field by field, against the
// file the browser actually downloads. Any drift — a stale rebuild, a hand-edit,
// a number that moved — fails loudly and exits non-zero.
//
// Run it with: npm run web:check

import { existsSync, readFileSync } from "node:fs";
import { ENV } from "../config.js";
import { loadRequired } from "../io.js";
import {
  buildMarketRows,
  buildResearchBundle,
  decodeMarketRows,
  encodeMarketRows,
  type AnomalyDoc,
  type ComparisonDoc,
  type EncodedMarkets,
  type FreshnessDoc,
  type MarketRow,
  type ProspectiveDoc,
  type QualityDoc,
  type RegistryRow,
  type ResearchBundle,
  type StatsDoc,
  type T1mDoc,
} from "./bundle.js";

const RESEARCH_PATH = "web/public/data/research.json";
const MARKETS_PATH = "web/public/data/markets.json";

const fail = (msg: string): never => {
  console.error(`\n${msg}\n`);
  process.exit(1);
};

for (const p of [RESEARCH_PATH, MARKETS_PATH]) {
  if (!existsSync(p)) {
    fail(`ERROR: ${p} does not exist.\n  build it with: npm run web:data`);
  }
}

const shipped = JSON.parse(readFileSync(RESEARCH_PATH, "utf8")) as ResearchBundle;
const shippedMarkets = JSON.parse(readFileSync(MARKETS_PATH, "utf8")) as EncodedMarkets & { count: number };

// Rebuild from the recorded phase outputs.
const anomaly = loadRequired<AnomalyDoc>(`out/anomaly-analysis-${ENV}.json`, "Phase 5 anomaly analysis");
const comparison = loadRequired<ComparisonDoc>(`out/comparison-${ENV}.json`, "Phase 2 calibration comparison");
const quality = loadRequired<QualityDoc>(`out/market-quality-${ENV}.json`, "Phase 3 per-market quality");
const freshness = loadRequired<FreshnessDoc>(`out/freshness-validation-${ENV}.json`, "Phase 4 out-of-sample validation");
const prospective = loadRequired<ProspectiveDoc>(`out/prospective-correction-${ENV}.json`, "Phase 6 prospective state");
const stats = loadRequired<StatsDoc>(`out/stats-${ENV}.json`, "Phase 1 population statistics");
const t1m = loadRequired<T1mDoc>(`out/t1m-${ENV}.json`, "T-1m observations");
const registry = loadRequired<RegistryRow[]>(`out/markets-${ENV}.json`, "the market registry");

// `builtAt` is a clock reading and `repositoryUrl` comes from the environment,
// so both are carried over rather than compared: neither is research data.
const rebuilt = buildResearchBundle({
  anomaly,
  comparison,
  quality,
  freshness,
  prospective,
  stats,
  t1m,
  builtAt: shipped.builtAt,
  repositoryUrl: shipped.repositoryUrl,
});

/** Every leaf of an object, as dotted path plus value, for a readable diff. */
function leaves(value: unknown, path = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (value === null || typeof value !== "object") {
    out.set(path, value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaves(v, `${path}[${i}]`).forEach((x, k) => out.set(k, x)));
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    leaves(v, path ? `${path}.${k}` : k).forEach((x, kk) => out.set(kk, x));
  }
  return out;
}

const a = leaves(rebuilt);
const b = leaves(shipped);
const paths = new Set([...a.keys(), ...b.keys()]);

const drift: string[] = [];
for (const p of paths) {
  const fromOut = a.get(p);
  const onPage = b.get(p);
  if (!Object.is(fromOut, onPage)) {
    drift.push(`  ${p}\n      out/*.json : ${JSON.stringify(fromOut)}\n      page       : ${JSON.stringify(onPage)}`);
  }
}

// The explorer population must also round-trip: same markets, same order.
const rebuiltRows = buildMarketRows(quality, t1m, registry);
const pageRows = decodeMarketRows<MarketRow>(shippedMarkets);
const marketDrift: string[] = [];
if (rebuiltRows.length !== pageRows.length) {
  marketDrift.push(`  row count: out/*.json has ${rebuiltRows.length}, the page ships ${pageRows.length}`);
} else {
  const encoded = encodeMarketRows(rebuiltRows);
  for (let i = 0; i < encoded.rows.length && marketDrift.length < 5; i++) {
    for (let f = 0; f < encoded.fields.length; f++) {
      if (!Object.is(encoded.rows[i][f], shippedMarkets.rows[i]?.[f])) {
        marketDrift.push(`  market ${i} field ${encoded.fields[f]}: ${JSON.stringify(encoded.rows[i][f])} vs ${JSON.stringify(shippedMarkets.rows[i]?.[f])}`);
        break;
      }
    }
  }
}

const h = shipped.headline;
const pp = (v: number | null) => (v == null ? "n/a" : `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(2)}pp`);
const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(2)}%`);

console.log(`\nPage payload vs recorded phase outputs   env=${shipped.env}\n`);
console.log(`  headline band        ${h.bucket}`);
console.log(`  predicted            ${pct(h.expected)}`);
console.log(`  observed             ${pct(h.observed)}`);
console.log(`  calibration gap      ${pp(h.deviation)}   z=${h.z?.toFixed(4) ?? "n/a"}   n=${h.n}`);
console.log(`  frozen correction    ${pp(-shipped.phase6.correction)}   validated=${shipped.phase6.validated}`);
console.log(`  qualifying markets   ${shipped.phase6.qualifying}`);
console.log(`  explorer markets     ${pageRows.length}`);
console.log(`  fields compared      ${paths.size}\n`);

if (drift.length || marketDrift.length) {
  console.error(`FAIL: the page does not match the recorded research.\n`);
  if (drift.length) console.error(`${drift.length} differing field(s):\n${drift.slice(0, 20).join("\n")}`);
  if (marketDrift.length) console.error(`\nexplorer population differs:\n${marketDrift.join("\n")}`);
  console.error(`\n  the payload is stale or was edited by hand. rebuild it with: npm run web:data\n`);
  process.exit(1);
}

console.log(`OK: every one of the ${paths.size} fields on the page is the value recorded in out/*.json,`);
console.log(`    and all ${pageRows.length} explorer markets round-trip identically.\n`);
