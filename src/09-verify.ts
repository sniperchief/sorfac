import { readFileSync, writeFileSync } from "node:fs";
import { client } from "./config.js";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";

const M: BinaryMarket[] = JSON.parse(readFileSync(`out/markets-${process.env.DDX_ENV ?? "mainnet"}.json`, "utf8"));
const safe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

// --- Independently re-derive the outcome from the oracle's own two answers ---
// A "reference" market resolves Up iff closing >= opening. If that reproduces
// winningOutcome, the outcome column is auditable rather than merely asserted.
const finalized = M.filter((m) => m.status === "Finalized" && Number(m.tradeCount) > 0);
const sample = finalized.sort(() => Math.random() - 0.5).slice(0, 60);

let agree = 0, disagree = 0, missing = 0;
const mismatches: unknown[] = [];
for (const m of sample) {
  const r = await client.getMarketResolution(m.marketId);
  const o = r.openingAnswer?.numericValue, c = r.closingAnswer?.numericValue;
  if (o == null || c == null) { missing++; continue; }
  const derived = BigInt(c) >= BigInt(o) ? 0 : 1;   // 0 = Up/YES
  if (derived === m.winningOutcome) agree++;
  else { disagree++; mismatches.push({ marketId: m.marketId, opening: o, closing: c, derived, reported: m.winningOutcome }); }
}
console.log(`Outcome re-derivation from oracle answers (n=${sample.length}):`);
console.log(`  agree ${agree}  disagree ${disagree}  missing an answer ${missing}`);
if (mismatches.length) console.log(`  mismatches: ${JSON.stringify(mismatches.slice(0, 5), safe, 2)}`);

// --- Opening-price availability across the whole traded population ---
const ids = finalized.slice(0, 500).map((m) => m.marketId);
const opens = await client.getOpeningPrices(ids);
const haveOpen = Object.values(opens).filter((v) => v != null).length;
console.log(`\ngetOpeningPrices batch of ${ids.length}: ${haveOpen} non-null (${((haveOpen / ids.length) * 100).toFixed(1)}%)`);

// --- What actually happened to the voided markets? ---
const voided = M.filter((m) => m.voided);
console.log(`\nVoided markets (${voided.length}):`);
const reasons: Record<string, number> = {};
for (const m of voided) {
  const r = await client.getMarketResolution(m.marketId);
  const key = `voidReason=${r.closingAnswer?.voidReason ?? r.oracleAnswer?.voidReason ?? "?"} policy=${m.voidPolicy ?? "?"} payout=${JSON.stringify(m.payoutNumerators)}`;
  reasons[key] = (reasons[key] ?? 0) + 1;
}
for (const [k, v] of Object.entries(reasons)) console.log(`  ${v.toString().padStart(3)}x  ${k}`);
console.log(`  voided with trades: ${voided.filter((m) => Number(m.tradeCount) > 0).length} / ${voided.length}`);
console.log(`  voided by asset/interval: ${JSON.stringify(voided.reduce<Record<string, number>>((a, m) => { const k = `${m.asset}/${m.interval}`; a[k] = (a[k] ?? 0) + 1; return a; }, {}))}`);
const vexp = voided.map((m) => Number(m.expiry));
console.log(`  voided expiry range: ${new Date(Math.min(...vexp) * 1000).toISOString()} .. ${new Date(Math.max(...vexp) * 1000).toISOString()}`);

// --- Rate/reliability: how does the indexer behave under a burst? ---
console.log(`\nBurst test: 40 concurrent getMarketResolution calls`);
const t0 = Date.now();
const res = await Promise.allSettled(finalized.slice(0, 40).map((m) => client.getMarketResolution(m.marketId)));
const ok = res.filter((r) => r.status === "fulfilled").length;
console.log(`  ${ok}/40 fulfilled in ${Date.now() - t0}ms; rejects: ${JSON.stringify(res.filter((r) => r.status === "rejected").slice(0, 2).map((r) => String((r as PromiseRejectedResult).reason).slice(0, 150)))}`);

writeFileSync("out/verify.json", JSON.stringify({ agree, disagree, missing, haveOpen, sampled: ids.length, voidReasons: reasons, burst: { ok, of: 40 } }, safe, 2));
