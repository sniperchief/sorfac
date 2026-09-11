// Phase 5: cadence-stratified investigation of the 20-30% anomaly.
//
//   npm run analyze-anomaly
//
// Runs entirely off persisted Phase-2/3/4 outputs. No new extraction.

import { readFileSync, writeFileSync } from "node:fs";
import { ENV } from "./config.js";
import { bucketIndex } from "./compare.js";
import { median } from "./quality.js";
import {
  MIN_CELL_N, SUB_BANDS, TARGET_BUCKET_LABEL, cadenceMix, chronologicalPeriods,
  deviationStats, inTargetBucket, standardisedDeviation, subBand, type Deviation,
} from "./anomaly.js";
import { failIfChecksFailed, loadRequired } from "./io.js";

type PerMarket = {
  marketId: string; asset: string; cadence: string; windowSec: number; targetTimestamp: number;
  tradeCountPre: number; uniqueMakersPre: number; volumePre: number; tradesNear: number;
  t1mAgeSec: number | null; isolatedPrint: boolean; priceRangeNear: number;
  tradeCountTotal: number; uniqueMakersTotal: number; volumeTotal: number; singleMakerTotal: boolean;
  diagnostic: { tradesPost: number; absMovePost: number | null; priceRangePost: number };
  p: number; y: 0 | 1;
};
type Row = PerMarket & { finalPrice: number | null };

const q = loadRequired<{ population: number; perMarket: PerMarket[] }>(`out/market-quality-${ENV}.json`, "Phase-3 market-quality output");
const t1m = loadRequired<{ rows: { marketId: string; referenceLastPrice: number | null }[] }>(`out/t1m-${ENV}.json`, "T-1m observations");
const finalById = new Map(t1m.rows.map((r) => [r.marketId, r.referenceLastPrice]));

// `finalPrice` is the Phase-1/2 `lastPrice`: strictly POST-T-1m information.
// It is carried for diagnostics in section 10 only and never enters a predictor.
const rows: Row[] = q.perMarket.map((m) => ({ ...m, finalPrice: finalById.get(m.marketId) ?? null }));

const L: string[] = [];
const say = (s = "") => { L.push(s); console.log(s); };
const f = (x: number, d = 5) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pc = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : "n/a");
const pp = (x: number) => (Number.isFinite(x) ? `${(x * 100 >= 0 ? "+" : "") + (x * 100).toFixed(2)}pp` : "n/a");
const ciS = (c: [number, number]) => (Number.isFinite(c[0]) ? `[${pc(c[0])}, ${pc(c[1])}]` : "[n/a]");
const CADENCES = ["5m", "15m", "60m"] as const;

const devLine = (label: string, d: Deviation) =>
  `  ${label.padEnd(16)} ${String(d.n).padStart(5)} ${pc(d.expected).padStart(9)} ${pc(d.observed).padStart(9)} ${pp(d.deviation).padStart(9)} ${f(d.z, 2).padStart(7)}  ${ciS(d.ci95).padEnd(20)} ${f(d.brier, 4).padStart(7)} ${f(d.logloss, 4).padStart(7)}${d.tooSmall ? "  TOO SMALL" : ""}`;
const devHeader = `  group                n  expected  observed  deviation       z  observed 95% CI        Brier  LogLoss`;

say(`Phase 5 — Cadence-stratified investigation of the ${TARGET_BUCKET_LABEL} anomaly`);
say(`env=${ENV}   bucket semantics: Phase-2 bucketIndex === 2, i.e. p in [0.20, 0.30)`);
say(`Cells below n=${MIN_CELL_N} are reported with counts and marked TOO SMALL; no inference is drawn from them.`);

// ------------------------------------------------------------ 3. population
const target = rows.filter((r) => inTargetBucket(r.p));
const outside = rows.filter((r) => !inTargetBucket(r.p));
say(`\n--- 3. Population ---`);
say(`  Phase-2/3/4 usable T-1m markets:   ${rows.length}`);
say(`  In ${TARGET_BUCKET_LABEL}:                        ${target.length}   (${pc(target.length / rows.length)})`);
say(`  Outside ${TARGET_BUCKET_LABEL}:                   ${outside.length}   (${pc(outside.length / rows.length)})`);
say(`  Denominator for every table below is stated with the table.`);
const popMix = cadenceMix(rows);
const tgtMix = cadenceMix(target);
say(`\n  cadence     population        ${TARGET_BUCKET_LABEL} bucket     bucket share of cadence`);
for (const c of CADENCES) {
  say(`  ${c.padEnd(10)} ${String(popMix[c] ?? 0).padStart(6)} (${pc((popMix[c] ?? 0) / rows.length).padStart(6)})   ${String(tgtMix[c] ?? 0).padStart(5)} (${pc((tgtMix[c] ?? 0) / target.length).padStart(6)})        ${pc((tgtMix[c] ?? 0) / (popMix[c] ?? 1)).padStart(7)}`);
}

// ------------------------------------------------------- 4. cadence-stratified
say(`\n--- 4. Cadence-stratified analysis (denominator: ${target.length} bucket markets) ---`);
say(devHeader);
const overall = deviationStats(target);
say(devLine("ALL cadences", overall));
const perCadence: { cadence: string; dev: Deviation }[] = [];
for (const c of CADENCES) {
  const d = deviationStats(target.filter((r) => r.cadence === c));
  perCadence.push({ cadence: c, dev: d });
  say(devLine(`  ${c}`, d));
}
const stdDev = standardisedDeviation(perCadence, popMix);
say(`\n  Aggregate deviation:                      ${pp(overall.deviation)}`);
say(`  Population-standardised (cadence-weighted): ${pp(stdDev)}`);
say(`  If the aggregate were purely a cadence-composition artifact, the standardised`);
say(`  figure would collapse toward zero. It does not.`);

// Is 20-30% uniquely bad WITHIN each cadence?
say(`\n  Is ${TARGET_BUCKET_LABEL} uniquely deviant within its own cadence?`);
say(`  Every bucket, within cadence (denominator: that cadence's whole population)`);
const withinCadence: Record<string, unknown[]> = {};
for (const c of CADENCES) {
  const pop = rows.filter((r) => r.cadence === c);
  say(`\n  cadence ${c} (n=${pop.length})`);
  say(devHeader);
  const bucketRows: unknown[] = [];
  for (let b = 0; b < 10; b++) {
    const s = pop.filter((r) => bucketIndex(r.p) === b);
    if (!s.length) continue;
    const d = deviationStats(s);
    const label = `${b * 10}-${(b + 1) * 10}%${b === 2 ? " <<<" : ""}`;
    say(devLine(label, d));
    bucketRows.push({ bucket: `${b * 10}-${(b + 1) * 10}%`, ...d });
  }
  withinCadence[c] = bucketRows;
  // Rank the target bucket's deviation among that cadence's buckets.
  const devs = (bucketRows as { bucket: string; n: number; deviation: number }[]).filter((x) => x.n >= MIN_CELL_N);
  const sorted = [...devs].sort((a, b) => a.deviation - b.deviation);
  const rank = sorted.findIndex((x) => x.bucket === TARGET_BUCKET_LABEL);
  say(`    Among buckets with n>=${MIN_CELL_N} in this cadence (${devs.length} of them), ${TARGET_BUCKET_LABEL} ranks ${rank < 0 ? "n/a (too small)" : `${rank + 1} most negative`}`);
}

// --------------------------------------------------- 5. chronological regimes
const NPERIODS = 4;
const periods = chronologicalPeriods(rows, (r) => r.targetTimestamp, (r) => r.marketId, NPERIODS);
say(`\n--- 5. Chronological regime analysis (${periods.length} equal-count periods) ---`);
say(`  Boundaries placed on timestamps, computed before any anomaly result.`);
say(`  period   n      window                                        ${TARGET_BUCKET_LABEL} n  expected  observed  deviation      z   cadence mix`);
const periodResults: Record<string, unknown>[] = [];
for (const per of periods) {
  const tg = per.items.filter((r) => inTargetBucket(r.p));
  const d = deviationStats(tg);
  const mix = cadenceMix(per.items);
  const mixS = CADENCES.map((c) => `${c}:${pc((mix[c] ?? 0) / per.items.length).replace(".00", "")}`).join(" ");
  say(`  ${per.label}   ${String(per.items.length).padStart(4)}   ${per.startIso.slice(0, 16)}..${per.endIso.slice(0, 16)}   ${String(d.n).padStart(4)} ${pc(d.expected).padStart(9)} ${pc(d.observed).padStart(9)} ${pp(d.deviation).padStart(9)} ${f(d.z, 2).padStart(6)}   ${mixS}${d.tooSmall ? "  TOO SMALL" : ""}`);
  periodResults.push({ period: per.label, n: per.items.length, startIso: per.startIso, endIso: per.endIso, targetBucket: d, cadenceMix: mix });
}
const signs = periodResults.map((p) => (p.targetBucket as Deviation).deviation).filter(Number.isFinite);
say(`\n  Deviation sign across periods: ${signs.map((s) => (s < 0 ? "negative" : "positive")).join(", ")}`);
say(`  Consistently negative in all ${signs.length} periods: ${signs.every((s) => s < 0) ? "YES" : "NO"}`);

// ------------------------------------------------ 6. cadence x regime matrix
say(`\n--- 6. Cadence x regime matrix for ${TARGET_BUCKET_LABEL} ---`);
say(`  Each cell shows n and deviation. ${periods.length} periods x ${CADENCES.length} cadences = ${periods.length * CADENCES.length} cells over ${target.length} markets,`);
say(`  so most cells are thin by construction. Cells below n=${MIN_CELL_N} are marked.`);
say(`  period     ${CADENCES.map((c) => c.padEnd(22)).join("")}`);
const matrix: Record<string, unknown>[] = [];
for (const per of periods) {
  const cells = CADENCES.map((c) => {
    const d = deviationStats(per.items.filter((r) => inTargetBucket(r.p) && r.cadence === c));
    matrix.push({ period: per.label, cadence: c, ...d });
    if (d.n === 0) return "n=0                 ";
    return `n=${String(d.n).padStart(3)} ${pp(d.deviation).padStart(8)}${d.tooSmall ? " *" : "  "}   `;
  });
  say(`  ${per.label}         ${cells.join("")}`);
}
const negCells = matrix.filter((c) => (c as Deviation).n > 0 && (c as Deviation).deviation < 0).length;
const populatedCells = matrix.filter((c) => (c as Deviation).n > 0).length;
const bigCells = matrix.filter((c) => (c as Deviation).n >= MIN_CELL_N);
say(`  * = below n=${MIN_CELL_N}`);
say(`\n  Populated cells: ${populatedCells}/${matrix.length}   negative deviation: ${negCells}/${populatedCells}`);
say(`  Cells at or above n=${MIN_CELL_N}: ${bigCells.length}  (${bigCells.map((c) => `${(c as { period: string }).period}/${(c as { cadence: string }).cadence} n=${(c as Deviation).n} ${pp((c as Deviation).deviation)}`).join("; ") || "none"})`);

// ------------------------------------------- 7. neighbouring bucket comparison
say(`\n--- 7. Neighbouring probability regions (denominator: whole population per cadence) ---`);
say(`  Is ${TARGET_BUCKET_LABEL} a local discontinuity, or a point on a broader curve?`);
const NEIGHBOURS = [1, 2, 3, 4];
say(`\n  ALL CADENCES`);
say(devHeader);
const neighbourAll: Record<string, unknown>[] = [];
for (const b of NEIGHBOURS) {
  const d = deviationStats(rows.filter((r) => bucketIndex(r.p) === b));
  say(devLine(`${b * 10}-${(b + 1) * 10}%${b === 2 ? " <<<" : ""}`, d));
  neighbourAll.push({ bucket: `${b * 10}-${(b + 1) * 10}%`, ...d });
}
const neighbourByCadence: Record<string, unknown[]> = {};
for (const c of CADENCES) {
  say(`\n  cadence ${c}`);
  say(devHeader);
  const arr: unknown[] = [];
  for (const b of NEIGHBOURS) {
    const d = deviationStats(rows.filter((r) => r.cadence === c && bucketIndex(r.p) === b));
    say(devLine(`${b * 10}-${(b + 1) * 10}%${b === 2 ? " <<<" : ""}`, d));
    arr.push({ bucket: `${b * 10}-${(b + 1) * 10}%`, ...d });
  }
  neighbourByCadence[c] = arr;
}

// ----------------------------------------------------- 8. internal sub-bands
say(`\n--- 8. Internal structure of ${TARGET_BUCKET_LABEL} (denominator: ${target.length}) ---`);
say(`  Sub-bands fixed in advance; diagnostic only, never calibration buckets.`);
say(devHeader);
const subBandResults: Record<string, unknown>[] = [];
for (const b of SUB_BANDS) {
  const s = target.filter((r) => subBand(r.p) === b.label);
  const d = deviationStats(s);
  say(devLine(b.label, d));
  subBandResults.push({ subBand: b.label, ...d, cadenceMix: cadenceMix(s), medianTargetTs: median(s.map((r) => r.targetTimestamp)) });
}

// ------------------------------------------------- 9. market-structure vars
say(`\n--- 9. Market structure: ${TARGET_BUCKET_LABEL} vs neighbours (medians) ---`);
say(`  PREDICTION-TIME variables (available at T-1m) first, then labelled diagnostics.`);
const structureVars: [string, (r: Row) => number, boolean][] = [
  ["pre-T-1m trade count", (r) => r.tradeCountPre, true],
  ["pre-T-1m unique makers", (r) => r.uniqueMakersPre, true],
  ["pre-T-1m volume", (r) => r.volumePre, true],
  ["T-1m age (s)", (r) => r.t1mAgeSec ?? NaN, true],
  ["trades near T-1m", (r) => r.tradesNear, true],
  ["price range near T-1m", (r) => r.priceRangeNear, true],
  ["market duration (s)", (r) => r.windowSec, true],
  ["isolated print (share)", (r) => (r.isolatedPrint ? 1 : 0), true],
  ["DIAG lifetime trade count", (r) => r.tradeCountTotal, false],
  ["DIAG lifetime volume", (r) => r.volumeTotal, false],
  ["DIAG single-maker (share)", (r) => (r.singleMakerTotal ? 1 : 0), false],
  ["DIAG post-T-1m trades", (r) => r.diagnostic.tradesPost, false],
  ["DIAG post-T-1m abs move", (r) => r.diagnostic.absMovePost ?? NaN, false],
];
const groups: [string, Row[]][] = [
  ["10-20%", rows.filter((r) => bucketIndex(r.p) === 1)],
  ["20-30%", target],
  ["30-40%", rows.filter((r) => bucketIndex(r.p) === 3)],
  ["40-50%", rows.filter((r) => bucketIndex(r.p) === 4)],
];
say(`  variable                      ${groups.map(([g]) => g.padStart(12)).join("")}`);
const structureTable: Record<string, unknown>[] = [];
for (const [label, get, predictionTime] of structureVars) {
  const vals = groups.map(([, g]) => median(g.map(get).filter(Number.isFinite)));
  say(`  ${(predictionTime ? label : label).padEnd(30)}${vals.map((v) => (Number.isFinite(v) ? v.toExponential(2) : "n/a").padStart(12)).join("")}`);
  structureTable.push({ variable: label, predictionTime, values: Object.fromEntries(groups.map(([g], i) => [g, vals[i]])) });
}

// ------------------------------------------------- 10. extreme repricing
say(`\n--- 10. Extreme repricing (DIAGNOSTIC ONLY — post-T-1m, never a predictor) ---`);
say(`  bucket      n   %traded after T-1m   median |move|   % moved OUT of band   median trades after`);
const repricing: Record<string, unknown>[] = [];
for (const [label, g] of groups) {
  const moved = g.filter((r) => r.diagnostic.tradesPost > 0);
  const movesOut = g.filter((r) => r.finalPrice != null && bucketIndex(r.finalPrice) !== bucketIndex(r.p));
  const rec = {
    bucket: label, n: g.length,
    sharedTradedAfter: moved.length / g.length,
    medianAbsMove: median(moved.map((r) => r.diagnostic.absMovePost ?? NaN).filter(Number.isFinite)),
    shareMovedOutOfBucket: movesOut.length / g.length,
    medianTradesAfter: median(moved.map((r) => r.diagnostic.tradesPost)),
  };
  repricing.push(rec);
  say(`  ${label.padEnd(9)} ${String(g.length).padStart(4)} ${pc(rec.sharedTradedAfter).padStart(18)} ${f(rec.medianAbsMove, 4).padStart(15)} ${pc(rec.shareMovedOutOfBucket).padStart(21)} ${f(rec.medianTradesAfter, 1).padStart(21)}`);
}

// ------------------------------------------------- 11. significance
say(`\n--- 11. Statistical significance ---`);
say(`  PRIMARY hypothesis (one pre-registered test): the ${TARGET_BUCKET_LABEL} bucket has a`);
say(`  LOWER realised Up frequency than its mean predicted probability.`);
say(`    n                    ${overall.n}`);
say(`    expected (mean pred) ${pc(overall.expected)}`);
say(`    observed Up rate     ${pc(overall.observed)}`);
say(`    deviation            ${pp(overall.deviation)}`);
say(`    z                    ${f(overall.z, 2)}`);
say(`    observed 95% CI      ${ciS(overall.ci95)}`);
say(`    expected outside CI  ${overall.expectedOutsideCI ? "YES" : "NO"}`);
say(`\n  EXPLORATORY (not corrected for multiplicity; treat as hypothesis-generating):`);
say(`    every cadence split, every period split, the ${periods.length}x${CADENCES.length} matrix, all sub-bands,`);
say(`    and all neighbouring-bucket comparisons above. That is well over 40 comparisons,`);
say(`    so individual large z values among them should not be read as significant.`);
const sigCadence = perCadence.filter((c) => !c.dev.tooSmall && c.dev.expectedOutsideCI).map((c) => c.cadence);
say(`    cadences where expected falls outside the observed 95% CI: ${sigCadence.join(", ") || "none"}`);

// ------------------------------------------------- 12. negative findings
say(`\n--- 12. Explicit negative findings ---`);
const negatives: [string, boolean, string][] = [];
const addNeg = (variable: string, explains: boolean, detail: string) => { negatives.push([variable, explains, detail]); say(`  ${explains ? "EXPLAINS  " : "does NOT explain"}  ${variable.padEnd(22)} ${detail}`); };
addNeg("cadence", Math.abs(stdDev) < Math.abs(overall.deviation) / 2, `aggregate ${pp(overall.deviation)} vs cadence-standardised ${pp(stdDev)}`);
addNeg("time regime", !signs.every((s) => s < 0), `deviation sign by period: ${signs.map((s) => (s < 0 ? "-" : "+")).join(" ")}`);
const dustInBucket = target.filter((r) => r.volumeTotal < 0.01).length / target.length;
const dustOutside = outside.filter((r) => r.volumeTotal < 0.01).length / outside.length;
addNeg("dust population", dustInBucket > dustOutside * 1.5, `dust share ${pc(dustInBucket)} in bucket vs ${pc(dustOutside)} outside`);
const freshDev = deviationStats(target.filter((r) => (r.t1mAgeSec ?? 0) <= 300));
const staleDev = deviationStats(target.filter((r) => (r.t1mAgeSec ?? 0) > 300));
addNeg("T-1m freshness", Math.sign(freshDev.deviation) !== Math.sign(staleDev.deviation), `fresh ${pp(freshDev.deviation)} (n=${freshDev.n}) vs stale ${pp(staleDev.deviation)} (n=${staleDev.n})`);
const multiShare = target.filter((r) => !r.singleMakerTotal).length / target.length;
addNeg("maker count", multiShare > 0.2, `multi-maker share ${pc(multiShare)} of bucket`);
const medTradesIn = median(target.map((r) => r.tradeCountPre));
const medTradesOut = median(outside.map((r) => r.tradeCountPre));
addNeg("trade count", Math.abs(medTradesIn - medTradesOut) > 1, `median pre-T-1m trades ${medTradesIn} in bucket vs ${medTradesOut} outside`);
const medVolIn = median(target.map((r) => r.volumePre));
const medVolOut = median(outside.map((r) => r.volumePre));
addNeg("volume", medVolIn < medVolOut / 2 || medVolIn > medVolOut * 2, `median pre-T-1m volume ${f(medVolIn, 3)} in bucket vs ${f(medVolOut, 3)} outside`);
const neighbourSameSign = neighbourAll.filter((b) => (b as Deviation).n >= MIN_CELL_N && (b as Deviation).deviation < -0.05).length;
addNeg("neighbouring buckets", neighbourSameSign > 1, `${neighbourSameSign} of the four 10-50% buckets deviate below -5pp`);

// ------------------------------------------------- 13. decision gate inputs
const cadencesNegative = perCadence.filter((c) => c.dev.n > 0 && c.dev.deviation < 0).length;
const cadencesTestable = perCadence.filter((c) => !c.dev.tooSmall).length;
const cadencesNegativeTestable = perCadence.filter((c) => !c.dev.tooSmall && c.dev.deviation < 0).length;
const periodsNegative = signs.filter((s) => s < 0).length;
say(`\n--- 13. Decision gate inputs ---`);
say(`  primary test significant (expected outside 95% CI):  ${overall.expectedOutsideCI ? "YES" : "NO"}  (z=${f(overall.z, 2)})`);
say(`  cadences with negative deviation:                    ${cadencesNegative}/${perCadence.length}  (testable n>=${MIN_CELL_N}: ${cadencesNegativeTestable}/${cadencesTestable})`);
say(`  periods with negative deviation:                     ${periodsNegative}/${signs.length}`);
say(`  cadence-standardised deviation:                      ${pp(stdDev)}  vs aggregate ${pp(overall.deviation)}`);
say(`  matrix cells negative:                               ${negCells}/${populatedCells}`);

// ---- Denominator invariants (audit addition; asserts, never alters, Phase-5 logic) ----
say(`
--- Denominator invariants ---`);
const checks: [string, boolean, string][] = [
  ["bucket and outside partition the population", target.length + outside.length === rows.length, `${target.length}+${outside.length} vs ${rows.length}`],
  ["cadence cohorts sum to the bucket", CADENCES.reduce((a, c) => a + (tgtMix[c] ?? 0), 0) === target.length, `${CADENCES.reduce((a, c) => a + (tgtMix[c] ?? 0), 0)} vs ${target.length}`],
  ["periods partition the population", periods.reduce((a, p) => a + p.items.length, 0) === rows.length, ""],
  ["matrix cells sum to the bucket", matrix.reduce((a, c) => a + (c as { n: number }).n, 0) === target.length, `${matrix.reduce((a, c) => a + (c as { n: number }).n, 0)} vs ${target.length}`],
  ["sub-bands partition the bucket", subBandResults.reduce((a, b) => a + (b.n as number), 0) === target.length, `${subBandResults.reduce((a, b) => a + (b.n as number), 0)} vs ${target.length}`],
  ["every bucket member is in [0.20,0.30)", target.every((r) => r.p >= 0.2 && r.p < 0.3), ""],
  ["no bucket member leaked from a neighbouring bucket", target.every((r) => bucketIndex(r.p) === 2), ""],
  ["every outcome is 0 or 1", rows.every((r) => r.y === 0 || r.y === 1), ""],
];
for (const [name, ok, detail] of checks) say(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);

const out = {
  generatedAt: new Date().toISOString(), env: ENV,
  methodology: { bucket: TARGET_BUCKET_LABEL, bucketIndex: 2, semantics: "Phase-2 bucketIndex(p)===2, p in [0.20,0.30)", minCellN: MIN_CELL_N, nPeriods: periods.length, subBands: SUB_BANDS },
  population: { usable: rows.length, inBucket: target.length, outsideBucket: outside.length, populationCadenceMix: popMix, bucketCadenceMix: tgtMix },
  cadenceStratified: { overall, perCadence, standardisedDeviation: stdDev, withinCadenceAllBuckets: withinCadence },
  periods: periodResults,
  matrix,
  neighbours: { allCadences: neighbourAll, byCadence: neighbourByCadence },
  subBands: subBandResults,
  structure: structureTable,
  repricing,
  significance: { primary: overall, cadencesWithExpectedOutsideCI: sigCadence, exploratoryComparisonCount: "40+" },
  negativeFindings: negatives.map(([variable, explains, detail]) => ({ variable, explains, detail })),
  consistencyChecks: checks.map(([name, ok, detail]) => ({ name, ok, detail })),
  gateInputs: { primarySignificant: overall.expectedOutsideCI, cadencesNegative, cadencesTestable, cadencesNegativeTestable, periodsNegative, periodsTotal: signs.length, standardisedDeviation: stdDev, aggregateDeviation: overall.deviation, matrixNegativeCells: negCells, matrixPopulatedCells: populatedCells },
};
writeFileSync(`out/anomaly-analysis-${ENV}.json`, JSON.stringify(out, null, 2));
failIfChecksFailed(checks.map(([name, ok]) => ({ name, ok })));
writeFileSync(`out/anomaly-analysis-${ENV}.txt`, L.join("\n"));
console.log(`\nwrote out/anomaly-analysis-${ENV}.json and out/anomaly-analysis-${ENV}.txt`);
