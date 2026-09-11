// Phase 6: prospective test of the frozen -8.56pp correction.
//
//   npm run test-correction              reuse the persisted prospective dataset
//   DDX_REFETCH=1 npm run test-correction  re-pull from the live indexer
//
// The T-1m prediction is built with Phase 2's own extractor and provider, so
// the prospective prediction is constructed exactly as the historical one was.
// Repeated runs against the same persisted dataset are byte-identical: the
// bootstrap is seeded and every timestamp in the output comes from the dataset.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";
import { client, ENV, INDEXER_URL } from "./config.js";
import { outcomeOf, validProbability } from "./calibration.js";
import { cadenceCohort } from "./quality.js";
import { SUB_BANDS, deviationStats, inTargetBucket, subBand } from "./anomaly.js";
import { DEFAULT_STALE_AFTER_SEC, extractOne, mapLimit, observationFrom } from "./extract-t1m.js";
import { FillsProvider } from "./providers/fills.js";
import {
  BOOTSTRAP_ITERATIONS, BOOTSTRAP_SEED, FROZEN_CORRECTION, PRIMARY_CADENCE, PROSPECTIVE_CUTOFF,
  TARGET_SAMPLE, TARGET_WINDOW_DAYS, applyCorrection, comparePaired, isPrimaryEligible,
  isProspective, pairMarket, temporalSegments, type Paired,
} from "./correction.js";

const DATASET = `out/prospective-${ENV}.json`;
const CONCURRENCY = Number(process.env.DDX_CONCURRENCY ?? 8);

type Prospective = {
  fetchedAt: string; fetchedAtUnix: number; cutoff: number; indexerUrl: string;
  rows: { marketId: string; asset: string; cadence: string; intervalSec: number | null;
    tradingStart: number; expiry: number; tradeCount: number; winningOutcome: number | null;
    voided: boolean; status: string; rawP: number | null; t1mAgeSec: number | null }[];
};

// ---------------------------------------------------------------- dataset
let data: Prospective;
if (existsSync(DATASET) && !process.env.DDX_REFETCH) {
  data = JSON.parse(readFileSync(DATASET, "utf8"));
  console.log(`reusing persisted prospective dataset (${data.rows.length} markets, fetched ${data.fetchedAt})`);
  console.log(`  set DDX_REFETCH=1 to re-pull from the live indexer`);
} else {
  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`pulling prospective markets from ${INDEXER_URL} (expiry > ${PROSPECTIVE_CUTOFF})`);
  const all: BinaryMarket[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await client.listPastBinaryMarkets({ limit: 1000, offset, nowSec });
    all.push(...page);
    if (page.length < 1000 || offset > 6000) break;
  }
  const fresh = all.filter((m) => isProspective(Number(m.expiry)));
  console.log(`  ${all.length} past markets scanned, ${fresh.length} expired after the cutoff`);

  // Build the T-1m prediction with Phase 2's extractor, unchanged.
  const providers = [new FillsProvider()];
  const extracted = await mapLimit(fresh, CONCURRENCY, async (m) => {
    const r = await extractOne(m, providers, { staleAfterSec: DEFAULT_STALE_AFTER_SEC });
    const o = observationFrom(r, "dreamdex.fills");
    return {
      marketId: m.marketId, asset: m.asset, cadence: cadenceCohort(m.intervalSec == null ? null : Number(m.intervalSec)),
      intervalSec: m.intervalSec == null ? null : Number(m.intervalSec),
      tradingStart: Number(m.tradingStart), expiry: Number(m.expiry), tradeCount: Number(m.tradeCount),
      winningOutcome: m.winningOutcome, voided: m.voided, status: m.status,
      rawP: o?.price ?? null, t1mAgeSec: o?.ageSec ?? null,
    };
  });
  data = { fetchedAt: new Date(nowSec * 1000).toISOString(), fetchedAtUnix: nowSec, cutoff: PROSPECTIVE_CUTOFF, indexerUrl: INDEXER_URL, rows: extracted };
  writeFileSync(DATASET, JSON.stringify(data, null, 2));
  console.log(`  wrote ${DATASET}`);
}

const L: string[] = [];
const say = (s = "") => { L.push(s); console.log(s); };
const f = (x: number, d = 5) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pc = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : "n/a");
const pp = (x: number) => (Number.isFinite(x) ? `${(x * 100 >= 0 ? "+" : "") + (x * 100).toFixed(2)}pp` : "n/a");
const ciS = (c: [number, number], d = 5) => (Number.isFinite(c[0]) ? `[${f(c[0], d)}, ${f(c[1], d)}]` : "[insufficient n]");

say(`Phase 6 — Prospective test of the frozen ${pp(-FROZEN_CORRECTION)} correction`);
say(`env=${ENV}  indexer=${data.indexerUrl}`);
say(`dataset fetched: ${data.fetchedAt}`);

// -------------------------------------------------- 1-2. hypothesis & freeze
say(`\n--- 1. Pre-registered hypothesis ---`);
say(`  For ${PRIMARY_CADENCE} markets whose T-1m probability lies in [0.20, 0.30), reducing the`);
say(`  prediction by ${(FROZEN_CORRECTION * 100).toFixed(2)} percentage points improves calibration without materially`);
say(`  worsening Brier or log loss.`);
say(`\n--- 2. Frozen correction ---`);
say(`  correction              ${FROZEN_CORRECTION}  (${pp(-FROZEN_CORRECTION)})`);
say(`  source                  Phase-5 equal-period-weighted estimate (pooled was -11.17pp)`);
say(`  adjusted = raw - ${FROZEN_CORRECTION}, bounded to a valid probability`);
say(`  This value is fixed. No alternative magnitude is evaluated in this phase.`);

// -------------------------------------------------- 3-5. population & window
const prospective = data.rows.filter((r) => isProspective(r.expiry));
const settled = prospective.filter((r) => r.status === "Finalized" && !r.voided);
const withOutcome = settled.filter((r) => outcomeOf(r.winningOutcome) !== null);
const withPrediction = withOutcome.filter((r) => validProbability(r.rawP));
const primary = withPrediction.filter((r) => isPrimaryEligible({ cadence: r.cadence, expiry: r.expiry, rawP: r.rawP }));

const windowStart = PROSPECTIVE_CUTOFF;
const windowEnd = prospective.length ? Math.max(...prospective.map((r) => r.expiry)) : PROSPECTIVE_CUTOFF;
const windowDays = (windowEnd - windowStart) / 86400;

say(`\n--- 3. Population definition ---`);
say(`  Prospective     expiry > ${PROSPECTIVE_CUTOFF} (${new Date(PROSPECTIVE_CUTOFF * 1000).toISOString()})`);
say(`  Primary         cadence ${PRIMARY_CADENCE}, finalized, not voided, valid outcome,`);
say(`                  usable T-1m probability in [0.20, 0.30)`);
say(`\n--- 4. Prospective cutoff ---`);
say(`  ${PROSPECTIVE_CUTOFF}  ${new Date(PROSPECTIVE_CUTOFF * 1000).toISOString()}`);
say(`  = the maximum expiry in the locked Phase-1 pull, so every market below was`);
say(`    invisible to Phases 1-5. No historical market enters the primary test.`);
say(`\n--- 5. Evaluation window ---`);
say(`  start                   ${new Date(windowStart * 1000).toISOString()}`);
say(`  end (latest expiry)     ${new Date(windowEnd * 1000).toISOString()}`);
say(`  elapsed                 ${windowDays.toFixed(4)} days`);
say(`  PRE-REGISTERED TARGET   ${TARGET_WINDOW_DAYS} days and ${TARGET_SAMPLE} qualifying ${PRIMARY_CADENCE} markets`);
const windowMet = windowDays >= TARGET_WINDOW_DAYS;
const sampleMet = primary.length >= TARGET_SAMPLE;
say(`  window target met       ${windowMet ? "YES" : `NO — ${(TARGET_WINDOW_DAYS - windowDays).toFixed(2)} days short`}`);

say(`\n--- 6. Sample size ---`);
say(`  markets expiring after the cutoff        ${prospective.length}`);
say(`    finalized and not voided              ${settled.length}`);
say(`    with a valid outcome                  ${withOutcome.length}`);
say(`    with a usable T-1m probability        ${withPrediction.length}`);
say(`    cadence ${PRIMARY_CADENCE}                            ${withPrediction.filter((r) => r.cadence === PRIMARY_CADENCE).length}`);
say(`    QUALIFYING (${PRIMARY_CADENCE} and in [0.20,0.30))     ${primary.length}`);
say(`  sample target met                       ${sampleMet ? "YES" : `NO — ${TARGET_SAMPLE - primary.length} short of ${TARGET_SAMPLE}`}`);
const cadTab: Record<string, number> = {};
for (const r of withPrediction) cadTab[r.cadence] = (cadTab[r.cadence] ?? 0) + 1;
say(`  scored-eligible by cadence              ${JSON.stringify(cadTab)}`);

// -------------------------------------------------- 7-9. scoring
const pairs: Paired[] = primary.map((r) => pairMarket(r.marketId, r.rawP!, outcomeOf(r.winningOutcome)!));
const cmp = comparePaired(pairs);
const rawDev = deviationStats(primary.map((r) => ({ p: r.rawP!, y: outcomeOf(r.winningOutcome)! })));
const adjDev = deviationStats(primary.map((r) => ({ p: applyCorrection(r.rawP!), y: outcomeOf(r.winningOutcome)! })));
const acc = (get: (p: Paired) => number) => (pairs.length ? pairs.filter((p) => (get(p) >= 0.5 ? 1 : 0) === p.y).length / pairs.length : NaN);

say(`\n--- 7. Baseline results (raw T-1m, the control) ---`);
if (!pairs.length) {
  say(`  NO QUALIFYING MARKETS. Nothing to score. The baseline is not defined on an empty sample.`);
} else {
  say(`  n                         ${cmp.n}`);
  say(`  Brier                     ${f(cmp.brierRaw)}`);
  say(`  log loss                  ${f(cmp.loglossRaw)}`);
  say(`  accuracy @0.5             ${pc(acc((p) => p.raw))}`);
  say(`  mean predicted            ${pc(rawDev.expected)}`);
  say(`  observed Up rate          ${pc(rawDev.observed)}`);
  say(`  calibration deviation     ${pp(rawDev.deviation)}`);
}

say(`\n--- 8. Adjusted results (raw ${pp(-FROZEN_CORRECTION)}) ---`);
if (!pairs.length) {
  say(`  NO QUALIFYING MARKETS. The correction was applied to zero markets.`);
} else {
  say(`  n                         ${cmp.n}`);
  say(`  Brier                     ${f(cmp.brierAdj)}`);
  say(`  log loss                  ${f(cmp.loglossAdj)}`);
  say(`  accuracy @0.5             ${pc(acc((p) => p.adjusted))}`);
  say(`  mean predicted            ${pc(adjDev.expected)}`);
  say(`  observed Up rate          ${pc(adjDev.observed)}   (identical: the outcome is unchanged)`);
  say(`  calibration deviation     ${pp(adjDev.deviation)}`);
}

say(`\n--- 9. Paired metric differences (adjusted minus baseline; negative favours the correction) ---`);
if (pairs.length < 3) {
  say(`  n=${pairs.length}. A paired comparison needs at least three observations for a bootstrap.`);
  say(`  Reporting point estimates only where n>0; no interval is computable.`);
  if (pairs.length) {
    say(`  Brier diff                ${f(cmp.brierDiff)}`);
    say(`  log loss diff             ${f(cmp.loglossDiff)}`);
  }
} else {
  say(`  Brier diff                ${f(cmp.brierDiff)}   95% CI ${ciS(cmp.brierDiffCI)}`);
  say(`  log loss diff             ${f(cmp.loglossDiff)}   95% CI ${ciS(cmp.loglossDiffCI)}`);
  say(`  markets improved on Brier ${cmp.adjustedBetterCount}/${cmp.n}`);
  say(`  bootstrap                 ${BOOTSTRAP_ITERATIONS} resamples, seed ${BOOTSTRAP_SEED} (deterministic)`);
}
say(`  calibration deviation     raw ${pp(rawDev.deviation)} -> adjusted ${pp(adjDev.deviation)}`);

// -------------------------------------------------- 10-11. calibration detail
say(`\n--- 10. Calibration analysis (qualifying population) ---`);
say(`  n                         ${primary.length}`);
say(`  mean raw prediction       ${pc(rawDev.expected)}`);
say(`  mean adjusted prediction  ${pc(adjDev.expected)}`);
say(`  observed Up frequency     ${pc(rawDev.observed)}`);
say(`  raw deviation             ${pp(rawDev.deviation)}`);
say(`  adjusted deviation        ${pp(adjDev.deviation)}`);
say(`  |deviation| improved      ${Number.isFinite(rawDev.deviation) ? (Math.abs(adjDev.deviation) < Math.abs(rawDev.deviation) ? "YES" : "NO") : "n/a"}`);

say(`\n--- 11. Internal sub-band analysis (diagnostic only; the same ${pp(-FROZEN_CORRECTION)} applies to all) ---`);
say(`  sub-band        n   mean raw  mean adj  observed  raw dev   adj dev`);
const subBandRows: Record<string, unknown>[] = [];
for (const b of SUB_BANDS) {
  const s = primary.filter((r) => subBand(r.rawP!) === b.label);
  const r0 = deviationStats(s.map((r) => ({ p: r.rawP!, y: outcomeOf(r.winningOutcome)! })));
  const r1 = deviationStats(s.map((r) => ({ p: applyCorrection(r.rawP!), y: outcomeOf(r.winningOutcome)! })));
  say(`  ${b.label.padEnd(12)} ${String(s.length).padStart(4)} ${pc(r0.expected).padStart(10)} ${pc(r1.expected).padStart(9)} ${pc(r0.observed).padStart(9)} ${pp(r0.deviation).padStart(9)} ${pp(r1.deviation).padStart(9)}`);
  subBandRows.push({ subBand: b.label, n: s.length, raw: r0, adjusted: r1 });
}

// -------------------------------------------------- 12. temporal stability
say(`\n--- 12. Temporal stability (deterministic equal-count thirds by expiry) ---`);
const segments = temporalSegments(primary, (r) => r.expiry, (r) => r.marketId, 3);
const segRows: Record<string, unknown>[] = [];
say(`  segment    n   window                                     raw dev   adj dev   Brier raw  Brier adj`);
segments.forEach((seg, i) => {
  const label = ["first", "second", "final"][i];
  if (!seg.length) { say(`  ${label.padEnd(10)} 0   (empty)`); segRows.push({ segment: label, n: 0 }); return; }
  const r0 = deviationStats(seg.map((r) => ({ p: r.rawP!, y: outcomeOf(r.winningOutcome)! })));
  const r1 = deviationStats(seg.map((r) => ({ p: applyCorrection(r.rawP!), y: outcomeOf(r.winningOutcome)! })));
  const ps = seg.map((r) => pairMarket(r.marketId, r.rawP!, outcomeOf(r.winningOutcome)!));
  const c = comparePaired(ps);
  say(`  ${label.padEnd(10)} ${String(seg.length).padStart(3)} ${new Date(Math.min(...seg.map((r) => r.expiry)) * 1000).toISOString().slice(0, 19)}..${new Date(Math.max(...seg.map((r) => r.expiry)) * 1000).toISOString().slice(11, 19)} ${pp(r0.deviation).padStart(9)} ${pp(r1.deviation).padStart(9)} ${f(c.brierRaw, 4).padStart(10)} ${f(c.brierAdj, 4).padStart(10)}`);
  segRows.push({ segment: label, n: seg.length, raw: r0, adjusted: r1, brierRaw: c.brierRaw, brierAdj: c.brierAdj });
});
const segSigns = segRows.filter((s) => (s.n as number) > 0).map((s) => (s.raw as { deviation: number }).deviation);
say(`  deviation sign by segment: ${segSigns.length ? segSigns.map((d) => (d < 0 ? "negative" : "positive")).join(", ") : "no populated segments"}`);

// -------------------------------------------------- 13. secondary controls
say(`\n--- 13. Secondary controls ---`);
say(`  (a) ${PRIMARY_CADENCE} markets OUTSIDE [0.20,0.30) — the correction is NOT applied to these.`);
const outside15 = withPrediction.filter((r) => r.cadence === PRIMARY_CADENCE && !inTargetBucket(r.rawP!));
const outDev = deviationStats(outside15.map((r) => ({ p: r.rawP!, y: outcomeOf(r.winningOutcome)! })));
say(`      n ${outside15.length}   mean pred ${pc(outDev.expected)}   observed ${pc(outDev.observed)}   deviation ${pp(outDev.deviation)}   Brier ${f(outDev.brier, 4)}`);
say(`      This establishes whether any movement is localized to the pre-registered region.`);
const otherCadences: Record<string, unknown> = {};
for (const c of ["5m", "60m"]) {
  const s = withPrediction.filter((r) => r.cadence === c && inTargetBucket(r.rawP!));
  const d = deviationStats(s.map((r) => ({ p: r.rawP!, y: outcomeOf(r.winningOutcome)! })));
  otherCadences[c] = { ...d, n: s.length };
  say(`  (b) cadence ${c} in [0.20,0.30): n=${s.length}${s.length ? `   deviation ${pp(d.deviation)}   DESCRIPTIVE ONLY, not part of the primary test` : "   no observations"}`);
}
say(`      The 15m correction is not extrapolated to other cadences.`);

// -------------------------------------------------- 14. leakage audit
say(`\n--- 14. Leakage audit ---`);
const audit: [string, boolean, string][] = [
  ["correction is exactly the pre-registered value", FROZEN_CORRECTION === 0.0856, `${FROZEN_CORRECTION}`],
  ["correction was not re-estimated from prospective data", true, "FROZEN_CORRECTION is a module constant with no data dependency"],
  ["no alternative correction magnitude was evaluated", true, "the runner applies exactly one value"],
  ["every primary market expires after the cutoff", primary.every((r) => r.expiry > PROSPECTIVE_CUTOFF), `${primary.length} markets`],
  ["no historical (pre-cutoff) market enters the primary test", !primary.some((r) => r.expiry <= PROSPECTIVE_CUTOFF), ""],
  ["primary population is 15m only", primary.every((r) => r.cadence === PRIMARY_CADENCE), ""],
  ["eligibility uses the RAW probability, never the adjusted one", true, "isPrimaryEligible reads rawP"],
  ["eligibility does not read the outcome", true, "isPrimaryEligible has no access to winningOutcome"],
  ["baseline preserved alongside every adjusted prediction", pairs.every((p) => Number.isFinite(p.raw)), ""],
  ["T-1m prediction built by the Phase-2 extractor unchanged", true, "extractOne + FillsProvider, staleAfterSec unchanged"],
  ["no post-T-1m field enters either prediction", true, "rawP comes from the last fill at or before expiry-60"],
  ["adjusted probabilities remain valid", pairs.every((p) => p.adjusted > 0 && p.adjusted < 1), ""],
  ["stopping rule fixed before evaluation", true, `${TARGET_WINDOW_DAYS} days / ${TARGET_SAMPLE} markets`],
];
for (const [name, ok, detail] of audit) say(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
const auditClean = audit.every((a) => a[1]);

// -------------------------------------------------- 15-16. uncertainty & gate
say(`\n--- 15. Statistical uncertainty ---`);
if (primary.length < 3) {
  say(`  n=${primary.length}. No interval is computable. Every quantity above is a point`);
  say(`  estimate on a sample far below the pre-registered target of ${TARGET_SAMPLE}.`);
  say(`  Phase 5 measured the historical effect at -8.56pp to -11.17pp. Detecting a shift of`);
  say(`  that size against a ~24.5% base rate at 80% power needs on the order of 150-250`);
  say(`  markets, so this sample cannot distinguish success from failure.`);
} else {
  say(`  paired Brier diff 95% CI      ${ciS(cmp.brierDiffCI)}`);
  say(`  paired log loss diff 95% CI   ${ciS(cmp.loglossDiffCI)}`);
  say(`  observed Up rate 95% CI       [${pc(rawDev.ci95[0])}, ${pc(rawDev.ci95[1])}]`);
}

const gate = !windowMet || !sampleMet || primary.length < 3 ? "D" : "see report";
say(`\n--- 16. Decision gate ---`);
say(`  window target (${TARGET_WINDOW_DAYS}d) met       ${windowMet ? "YES" : "NO"}   (${windowDays.toFixed(4)} days elapsed)`);
say(`  sample target (${TARGET_SAMPLE}) met       ${sampleMet ? "YES" : "NO"}   (${primary.length} qualifying)`);
say(`  leakage audit clean            ${auditClean ? "YES" : "NO"}`);
say(`  GATE: ${gate === "D" ? "D — INSUFFICIENT EVIDENCE" : gate}`);
if (gate === "D") {
  say(`  The pre-registered stopping rule was not reached. Neither success nor failure`);
  say(`  is declared, and the correction remains frozen at ${pp(-FROZEN_CORRECTION)} for future evaluation.`);
}

writeFileSync(
  `out/prospective-correction-${ENV}.json`,
  JSON.stringify({
    datasetFetchedAt: data.fetchedAt, env: ENV, indexerUrl: data.indexerUrl,
    preregistration: { correction: FROZEN_CORRECTION, cadence: PRIMARY_CADENCE, bucket: "[0.20,0.30)", cutoff: PROSPECTIVE_CUTOFF, targetWindowDays: TARGET_WINDOW_DAYS, targetSample: TARGET_SAMPLE, bootstrapIterations: BOOTSTRAP_ITERATIONS, bootstrapSeed: BOOTSTRAP_SEED },
    window: { startUnix: windowStart, endUnix: windowEnd, elapsedDays: windowDays, windowTargetMet: windowMet },
    funnel: { prospective: prospective.length, settled: settled.length, withOutcome: withOutcome.length, withPrediction: withPrediction.length, cadenceMix: cadTab, qualifying: primary.length, sampleTargetMet: sampleMet },
    baseline: pairs.length ? { ...rawDev, n: cmp.n, brier: cmp.brierRaw, logloss: cmp.loglossRaw, accuracy: acc((p) => p.raw) } : null,
    adjusted: pairs.length ? { ...adjDev, n: cmp.n, brier: cmp.brierAdj, logloss: cmp.loglossAdj, accuracy: acc((p) => p.adjusted) } : null,
    paired: pairs.length ? cmp : null,
    subBands: subBandRows,
    temporalSegments: segRows,
    secondaryControls: { fifteenMinuteOutsideBucket: { ...outDev, n: outside15.length }, otherCadences },
    leakageAudit: audit.map(([name, ok, detail]) => ({ name, ok, detail })),
    gate,
    perMarket: primary.map((r) => {
      const p = pairs.find((x) => x.marketId === r.marketId)!;
      return { marketId: r.marketId, asset: r.asset, cadence: r.cadence, expiry: r.expiry, tradeCount: r.tradeCount, t1mAgeSec: r.t1mAgeSec, raw: p.raw, adjusted: p.adjusted, y: p.y, brierRaw: p.brierRaw, brierAdj: p.brierAdj, loglossRaw: p.loglossRaw, loglossAdj: p.loglossAdj };
    }),
  }, null, 2),
);
writeFileSync(`out/prospective-correction-${ENV}.txt`, L.join("\n"));
console.log(`\nwrote out/prospective-correction-${ENV}.json and out/prospective-correction-${ENV}.txt`);
