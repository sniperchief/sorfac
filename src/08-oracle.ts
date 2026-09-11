import { readFileSync } from "node:fs";
import { client, ORACLE_BASE } from "./config.js";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";

const M: BinaryMarket[] = JSON.parse(readFileSync(`out/markets-${process.env.DDX_ENV ?? "mainnet"}.json`, "utf8"));

const picks = M.filter((m) => m.status === "Finalized" && Number(m.tradeCount) > 0)
  .sort((a, b) => Number(b.tradeCount) - Number(a.tradeCount))
  .slice(0, 5);
const voided = M.filter((m) => m.voided).slice(0, 2);

async function head(url: string) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: "follow" });
    const body = await r.text();
    return { status: r.status, ms: Date.now() - t0, bytes: body.length, ct: r.headers.get("content-type") ?? "", body };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, bytes: 0, ct: "", body: e instanceof Error ? e.message : String(e) };
  }
}

for (const m of [...picks, ...voided]) {
  const qid = m.oracleQuestionId;
  console.log(`\n=== ${m.marketId.slice(0, 12)}… ${m.asset} ${m.interval} voided=${m.voided} oracleQuestionId=${qid}`);
  const page = `${ORACLE_BASE}/questions/${qid}?view=graph`;
  const r = await head(page);
  console.log(`  GET ${page}`);
  console.log(`      -> ${r.status} ${r.ct} ${r.bytes}B ${r.ms}ms`);
  // A single-page app returns 200 for ANY path, so a 200 alone proves nothing.
  // Probe an obviously-bogus id to see whether the server discriminates.
  if (m === picks[0]) {
    const bogus = await head(`${ORACLE_BASE}/questions/999999999999?view=graph`);
    console.log(`      control (bogus id) -> ${bogus.status} ${bogus.bytes}B  [same size as real => SPA shell, 200 means nothing]`);
  }
  // The real test: does an API behind the page actually carry this question?
  for (const path of [`/api/questions/${qid}`, `/v1/questions/${qid}`, `/questions/${qid}.json`]) {
    const a = await head(`${ORACLE_BASE}${path}`);
    console.log(`  GET ${path} -> ${a.status} ${a.ct.slice(0, 40)} ${a.bytes}B ${a.status === 200 ? a.body.slice(0, 260) : ""}`);
  }
}

// What does the SDK itself give us about the oracle answer, independent of the web page?
console.log(`\n=== SDK-side oracle evidence (no web page needed) ===`);
for (const m of picks.slice(0, 3)) {
  const res = await client.getMarketResolution(m.marketId);
  console.log(`${m.marketId.slice(0, 12)}… ${JSON.stringify(res, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}
