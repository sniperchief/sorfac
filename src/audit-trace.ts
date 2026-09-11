// Production-readiness audit: live trace of the full T-1m calculation and a
// verification that runtime data really is DreamDEX/Somnia mainnet.
// Read-only. Not part of Phases 1-6; it asserts their behaviour, never changes it.

import { readFileSync } from "node:fs";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";
import { client, ENV, INDEXER_URL } from "./config.js";
import { DEFAULT_STALE_AFTER_SEC, HORIZON_SEC, extractOne, observationFrom, targetInstant } from "./extract-t1m.js";
import { FillsProvider } from "./providers/fills.js";
import { bucketIndex } from "./compare.js";
import { outcomeOf } from "./calibration.js";
import { cadenceCohort } from "./quality.js";
import { FROZEN_CORRECTION, PROSPECTIVE_CUTOFF, applyCorrection, isPrimaryEligible } from "./correction.js";

const fail: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail.push(name);
};

// ---------- Audit 2: is this really mainnet? ----------
console.log(`\n=== Audit 2: live mainnet provenance ===`);
const sdkVersion = JSON.parse(readFileSync("node_modules/@somnia-chain/markets-sdk/package.json", "utf8")).version;
console.log(`  env=${ENV}  indexer=${INDEXER_URL}  sdk=${sdkVersion}`);
check("indexer is the mainnet (prd) endpoint", INDEXER_URL.includes("prd.smk.somnia.host"), INDEXER_URL);
check("SDK meets the documented >=0.29.0 requirement", sdkVersion.localeCompare("0.29.0", undefined, { numeric: true }) >= 0, sdkVersion);

const live = await client.listBinaryMarkets({ limit: 5 });
check("indexer returns live binary markets", live.length > 0, `${live.length} rows`);
const decimals = [...new Set(live.map((m) => m.quoteDecimals))];
const collaterals = [...new Set(live.map((m) => m.collateral.toLowerCase()))];
check("collateral is mainnet USDso (18dp), not testnet tUSDC (6dp)",
  collaterals.every((c) => c === "0x00000022da000002656c64d9ea6011ea952d008a"),
  `collateral=${collaterals.join(",")} decimals=${decimals.join(",")}`);

// ---------- Audit 3: full T-1m trace on real settled markets ----------
console.log(`\n=== Audit 3: end-to-end T-1m trace (live settled markets) ===`);
const settled = await client.listPastBinaryMarkets({ status: "Finalized", limit: 400 });
const traceable = settled.filter((m) => Number(m.tradeCount) >= 3).slice(0, 3);
check("found live settled markets with a real tape to trace", traceable.length > 0, `${traceable.length}`);

for (const m of traceable) {
  const expiry = Number(m.expiry);
  const start = Number(m.tradingStart);
  const target = targetInstant(m);
  const dec = m.quoteDecimals;
  console.log(`\n  market ${m.marketId.replace(/^0x0*/, "0x..")} ${m.asset} ${cadenceCohort(Number(m.intervalSec ?? 0))} trades=${m.tradeCount}`);
  console.log(`    expiry            ${expiry}  ${new Date(expiry * 1000).toISOString()}`);
  console.log(`    target = expiry-${HORIZON_SEC}  ${target}  ${new Date(target * 1000).toISOString()}`);

  const raw = await client.getFills(m.poolAddress, { since: start, until: expiry, limit: 1000 });
  const mine = raw.filter((f) => f.market.toLowerCase() === m.marketId.toLowerCase());
  const eligible = mine.filter((f) => Number(f.timestamp) <= target).sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const after = mine.filter((f) => Number(f.timestamp) > target);
  console.log(`    fills in window   ${mine.length}   eligible (<=target) ${eligible.length}   after target ${after.length}`);

  const r = await extractOne(m, [new FillsProvider()], { staleAfterSec: DEFAULT_STALE_AFTER_SEC });
  const o = observationFrom(r, "dreamdex.fills")!;
  const expectedPick = eligible[eligible.length - 1];
  console.log(`    selected source   ${o.sourceTimestamp}  age=${o.ageSec}s  status=${o.status}`);
  console.log(`    normalized price  ${o.price}  (raw ${o.rawPrice} / 1e${dec})`);
  console.log(`    retrieval stamp   ${o.retrievalTimestamp} (unix ms, distinct from source)`);

  check(`  [${m.marketId.slice(-6)}] target is exactly expiry-60`, r.targetTimestamp === expiry - 60);
  check(`  [${m.marketId.slice(-6)}] selected fill is the LAST at or before target`,
    expectedPick == null ? o.sourceTimestamp === null : o.sourceTimestamp === Number(expectedPick.timestamp),
    `expected ${expectedPick?.timestamp ?? "none"}, got ${o.sourceTimestamp}`);
  check(`  [${m.marketId.slice(-6)}] no post-target fill influenced the price`,
    o.sourceTimestamp === null || o.sourceTimestamp <= target);
  check(`  [${m.marketId.slice(-6)}] source is inside the market's own window`,
    o.sourceTimestamp === null || o.sourceTimestamp >= start);
  check(`  [${m.marketId.slice(-6)}] age = target - source`,
    o.sourceTimestamp === null || o.ageSec === target - o.sourceTimestamp);
  check(`  [${m.marketId.slice(-6)}] price scaled by the row's OWN decimals`,
    o.price === null || Math.abs(o.price - Number(o.rawPrice) / 10 ** dec) < 1e-15);
  check(`  [${m.marketId.slice(-6)}] price is a valid probability`, o.price === null || (o.price > 0 && o.price < 1));
  check(`  [${m.marketId.slice(-6)}] retrieval timestamp is not the source timestamp`,
    o.retrievalTimestamp > 1_700_000_000_000 && o.retrievalTimestamp !== o.sourceTimestamp);
  check(`  [${m.marketId.slice(-6)}] stale flag agrees with the age`,
    o.status === "missing" || o.status === "malformed" || (o.ageSec! > DEFAULT_STALE_AFTER_SEC) === (o.status === "stale"));

  // A market that traded ONLY after T-1m must yield no observation at all.
  if (eligible.length === 0) check(`  [${m.marketId.slice(-6)}] no eligible fill yields a missing observation`, o.status === "missing" && o.price === null);
}

// ---------- Audit 5: the frozen correction, live ----------
console.log(`\n=== Audit 5: frozen correction guards (live markets) ===`);
check("correction constant is exactly 0.0856", FROZEN_CORRECTION === 0.0856, String(FROZEN_CORRECTION));
const historical = settled.filter((m) => Number(m.expiry) <= PROSPECTIVE_CUTOFF);
check("historical markets exist in this sample", historical.length > 0, `${historical.length}`);
const wronglyEligible = historical.filter((m) =>
  isPrimaryEligible({ cadence: cadenceCohort(Number(m.intervalSec ?? 0)), expiry: Number(m.expiry), rawP: 0.25 }));
check("no pre-cutoff market is primary-eligible even at a qualifying probability", wronglyEligible.length === 0, `${wronglyEligible.length} leaked`);
check("adjusted probability stays valid across the whole bucket",
  [0.2, 0.25, 0.2999].every((p) => { const a = applyCorrection(p); return a > 0 && a < 1; }));
check("correction is independent of the outcome",
  applyCorrection(0.25) === applyCorrection(0.25) && bucketIndex(0.25) === 2);

// ---------- Audit 4: calibration boundaries ----------
console.log(`\n=== Audit 4: calibration bucket boundaries ===`);
const cases: [number, number][] = [[0, 0], [0.1, 1], [0.2, 2], [0.29999, 2], [0.3, 3], [0.9, 9], [1, 9]];
for (const [p, want] of cases) check(`bucketIndex(${p}) === ${want}`, bucketIndex(p) === want, `got ${bucketIndex(p)}`);
check("winningOutcome 0 maps to Up=1", outcomeOf(0) === 1);
check("winningOutcome 1 maps to Down=0", outcomeOf(1) === 0);
check("winningOutcome null maps to null", outcomeOf(null) === null);

console.log(`\n=== RESULT: ${fail.length === 0 ? "ALL CHECKS PASSED" : `${fail.length} FAILED`} ===`);
if (fail.length) { for (const f of fail) console.log(`  FAILED: ${f}`); process.exitCode = 1; }
