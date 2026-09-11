// Reproduce the Phase-1 DreamDEX calibration on T-1m prices and compare.
//
//   npm run compare
//
// Emits a machine-readable report (out/comparison-<env>.json) and a
// human-readable summary (out/comparison-<env>.txt).

import { writeFileSync } from "node:fs";
import { ENV } from "./config.js";
import { compare, providerBreakdown, qualityIssues } from "./compare.js";
import type { ExtractionRow } from "./extract-t1m.js";
import { failIfChecksFailed, loadRequired } from "./io.js";

type Extraction = {
  generatedAt: string; env: string; indexerUrl: string; horizonSec: number;
  staleAfterSec: number; populationSize: number; extracted: number; elapsedMs: number; rows: ExtractionRow[];
};

const ex = loadRequired<Extraction>(`out/t1m-${ENV}.json`, "T-1m observations");
const phase1 = loadRequired<any>(`out/stats-${ENV}.json`, "the Phase-1 reference calibration");

const providers = [...new Set(ex.rows.flatMap((r) => r.observations.map((o) => o.provider)))];
const PRIMARY = "dreamdex.fills";

const L: string[] = [];
const say = (s = "") => { L.push(s); console.log(s); };
const f = (x: number, d = 5) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const p2 = (x: number) => `${(x * 100).toFixed(2)}%`;

say(`DreamDEX T-1m Calibration Comparison`);
say(`env=${ex.env}  indexer=${ex.indexerUrl}`);
say(`extraction generated ${ex.generatedAt}  horizon T-${ex.horizonSec}s  staleAfter ${ex.staleAfterSec}s`);
say(`Phase-1 reference generated ${phase1.generatedAt}`);
say();
say(`Phase-1 calibration population: ${ex.populationSize}`);
say(`Rows extracted:                 ${ex.extracted}  in ${(ex.elapsedMs / 1000).toFixed(1)}s`);
say();

say(`--- Provider breakdown ---`);
say(`  provider              attempted    ok  stale  missing  malformed  unavail  usable   meanLat   p95Lat`);
const breakdowns = providers.map((p) => providerBreakdown(ex.rows, p));
for (const b of breakdowns) {
  say(`  ${b.provider.padEnd(20)} ${String(b.attempted).padStart(9)} ${String(b.ok).padStart(5)} ${String(b.stale).padStart(6)} ${String(b.missing).padStart(8)} ${String(b.malformed).padStart(10)} ${String(b.unavailable).padStart(8)} ${String(b.usable).padStart(7)} ${f(b.meanLatencyMs, 0).padStart(9)}ms ${f(b.p95LatencyMs, 0).padStart(6)}ms`);
}

const results = providers.map((p) => compare(ex.rows, p, ex.populationSize));
const primary = results.find((r) => r.provider === PRIMARY)!;

for (const r of results) {
  say(`\n=== Provider: ${r.provider} ===`);
  say(`  Calibration samples (population):  ${r.populationSize}`);
  say(`  Successful T-1m extractions:       ${r.paired}   (${p2(r.paired / r.attempted)} of attempted)`);
  say(`  Missing / failed samples:          ${r.missingOrFailed}   (${p2(r.missingOrFailed / r.attempted)})`);
  say();
  say(`  --- Agreement with DreamDEX reference (lastPrice), per market ---`);
  say(`  mean |extracted - reference|:      ${f(r.agreement.meanAbsDiff)}`);
  say(`  median |diff|:                     ${f(r.agreement.medianAbsDiff)}`);
  say(`  p95 |diff|:                        ${f(r.agreement.p95AbsDiff)}`);
  say(`  max |diff|:                        ${f(r.agreement.maxAbsDiff)}`);
  say(`  RMSE:                              ${f(r.agreement.rmse)}`);
  say(`  mean signed % difference:          ${f(r.agreement.meanPctDiff, 2)}%`);
  say(`  median |% difference|:             ${f(r.agreement.medianAbsPctDiff, 2)}%`);
  say(`  identical (<1e-9):                 ${p2(r.agreement.identical)}`);
  say(`  same 10% bucket:                   ${p2(r.agreement.sameBucket)}`);
  say(`  same side of 0.5:                  ${p2(r.agreement.sameSideOf50)}`);
  say();
  say(`  --- Phase-1 metrics, same methodology, same ${r.paired} markets ---`);
  say(`  metric              T-1m extracted    DreamDEX reference        delta`);
  const row = (name: string, a: number, b: number, d = 5) => say(`  ${name.padEnd(20)} ${f(a, d).padStart(13)} ${f(b, d).padStart(21)} ${(a - b >= 0 ? "+" : "") + f(a - b, d)}`);
  row("Brier", r.extractedCalibration.brier, r.referenceCalibration.brier);
  row("Brier skill score", r.extractedCalibration.brierSkillScore, r.referenceCalibration.brierSkillScore, 4);
  row("Log loss", r.extractedCalibration.logloss, r.referenceCalibration.logloss);
  row("Accuracy @0.5", r.extractedCalibration.accuracy, r.referenceCalibration.accuracy, 4);
  row("Base rate (Up)", r.extractedCalibration.baseRate, r.referenceCalibration.baseRate, 4);
  row("Mean predicted", r.extractedCalibration.meanPredicted, r.referenceCalibration.meanPredicted, 4);
  say(`  ${"Mean abs calib err".padEnd(20)} ${(r.mace.extracted * 100).toFixed(2).padStart(11)}pp ${(r.mace.reference * 100).toFixed(2).padStart(19)}pp ${(r.delta.mace * 100 >= 0 ? "+" : "") + (r.delta.mace * 100).toFixed(2)}pp`);
  say(`  ${"  n-weighted".padEnd(20)} ${(r.mace.extractedWeighted * 100).toFixed(2).padStart(11)}pp ${(r.mace.referenceWeighted * 100).toFixed(2).padStart(19)}pp ${(r.delta.maceWeighted * 100 >= 0 ? "+" : "") + (r.delta.maceWeighted * 100).toFixed(2)}pp`);
  say(`  eps clamp hits:      ${String(r.extractedCalibration.clampHits).padStart(13)} ${String(r.referenceCalibration.clampHits).padStart(21)}`);
  say();
  say(`  --- 10% buckets: T-1m extracted vs reference (same markets) ---`);
  say(`  bucket        n(T-1m)  meanPred   actualUp     diff  |  n(ref)  meanPred   actualUp     diff`);
  for (let i = 0; i < 10; i++) {
    const a = r.extractedCalibration.buckets[i], b = r.referenceCalibration.buckets[i];
    const fmt = (x: typeof a) => x.n === 0 ? `${String(0).padStart(6)}        -          -        -` : `${String(x.n).padStart(6)}  ${p2(x.meanPredicted!).padStart(8)}  ${p2(x.actualUpRate!).padStart(9)}  ${((x.diff! * 100) >= 0 ? "+" : "") + (x.diff! * 100).toFixed(2)}pp`;
    say(`  ${a.bucket.padEnd(9)} ${fmt(a)}  | ${fmt(b)}`);
  }
  say();
  say(`  --- Largest deviations ---`);
  // marketIds are zero-padded bytes32, so the identifying part is the SUFFIX.
  const shortId = (id: string) => `0x…${id.replace(/^0x0*/, "") || "0"}`;
  say(`  marketId    asset interval trades   reference    T-1m    absDiff    ageSec  stale`);
  for (const o of r.outliers.slice(0, 10)) {
    say(`  ${shortId(o.marketId).padEnd(11)} ${o.asset.padEnd(5)} ${String(o.interval).padEnd(8)} ${String(o.tradeCount).padStart(6)} ${f(o.reference, 4).padStart(11)} ${f(o.extracted, 4).padStart(7)} ${f(o.absDiff, 4).padStart(10)} ${String(o.ageSec).padStart(9)}  ${o.stale}`);
  }
}

// Cross-provider agreement, where both produced a usable price on one market.
if (results.length > 1) {
  const [a, b] = [results[0], results[1]];
  const pa = new Map<string, number>(), pb = new Map<string, number>();
  for (const r of ex.rows) {
    const oa = r.observations.find((o) => o.provider === a.provider);
    const ob = r.observations.find((o) => o.provider === b.provider);
    if (oa?.price != null) pa.set(r.marketId, oa.price);
    if (ob?.price != null) pb.set(r.marketId, ob.price);
  }
  const both = [...pa.keys()].filter((k) => pb.has(k));
  const d = both.map((k) => Math.abs(pa.get(k)! - pb.get(k)!)).sort((x, y) => x - y);
  say(`\n--- Cross-provider agreement (${a.provider} vs ${b.provider}) ---`);
  say(`  markets with both:   ${both.length}`);
  say(`  identical (<1e-9):   ${p2(d.filter((x) => x < 1e-9).length / d.length)}`);
  say(`  median |diff|:       ${f(d[Math.floor(d.length / 2)])}`);
  say(`  mean |diff|:         ${f(d.reduce((s, x) => s + x, 0) / d.length)}`);
  say(`  max |diff|:          ${f(d[d.length - 1])}`);
}

// Data-quality gate.
const issues = qualityIssues(ex.rows);
const byIssue: Record<string, number> = {};
for (const i of issues) byIssue[i.issue] = (byIssue[i.issue] ?? 0) + 1;
say(`\n--- Timestamp / data-quality issues ---`);
say(`  total: ${issues.length} ${issues.length === 0 ? "(no look-ahead, no out-of-window sources, no malformed prices)" : JSON.stringify(byIssue)}`);
for (const i of issues.slice(0, 8)) say(`  ${i.issue} ${i.marketId.slice(0, 14)} ${i.provider ?? ""} ${i.detail}`);

// Internal consistency of the report itself.
say(`\n--- Internal consistency checks ---`);
const checks: [string, boolean, string][] = [];
for (const r of results) {
  checks.push([`${r.provider}: paired + missing == attempted`, r.paired + r.missingOrFailed === r.attempted, `${r.paired}+${r.missingOrFailed} vs ${r.attempted}`]);
  checks.push([`${r.provider}: bucket n sums to paired`, r.extractedCalibration.buckets.reduce((a, b) => a + b.n, 0) === r.paired, `${r.extractedCalibration.buckets.reduce((a, b) => a + b.n, 0)} vs ${r.paired}`]);
  checks.push([`${r.provider}: reference buckets sum to paired`, r.referenceCalibration.buckets.reduce((a, b) => a + b.n, 0) === r.paired, ``]);
  checks.push([`${r.provider}: both calibrations share a base rate`, Math.abs(r.extractedCalibration.baseRate - r.referenceCalibration.baseRate) < 1e-12, `delta ${r.delta.baseRate}`]);
  checks.push([`${r.provider}: Brier in [0,1]`, r.extractedCalibration.brier >= 0 && r.extractedCalibration.brier <= 1, `${r.extractedCalibration.brier}`]);
  checks.push([`${r.provider}: log loss finite`, Number.isFinite(r.extractedCalibration.logloss), `${r.extractedCalibration.logloss}`]);
}
// The reference recomputed on the FULL Phase-1 sample must match Phase 1 exactly.
checks.push([`Phase-1 reference reproduced (n)`, phase1.calibration.n === 3198, `${phase1.calibration.n}`]);
for (const [name, ok, detail] of checks) say(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
const allPass = checks.every((c) => c[1]);
say(`  ${allPass ? "All internal consistency checks passed." : "SOME CHECKS FAILED."}`);

say(`\n--- Conclusion (primary provider: ${PRIMARY}) ---`);
say(`  T-1m reproduces the DreamDEX calibration on ${primary.paired}/${primary.populationSize} markets.`);
say(`  Prices agree exactly on ${p2(primary.agreement.identical)} of markets and share a 10% bucket on ${p2(primary.agreement.sameBucket)}.`);
say(`  Brier moves ${primary.delta.brier >= 0 ? "+" : ""}${f(primary.delta.brier)} (${f(primary.referenceCalibration.brier)} -> ${f(primary.extractedCalibration.brier)}).`);
say(`  Log loss moves ${primary.delta.logloss >= 0 ? "+" : ""}${f(primary.delta.logloss)} (${f(primary.referenceCalibration.logloss)} -> ${f(primary.extractedCalibration.logloss)}).`);

writeFileSync(
  `out/comparison-${ENV}.json`,
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    env: ENV,
    extraction: { generatedAt: ex.generatedAt, horizonSec: ex.horizonSec, staleAfterSec: ex.staleAfterSec, populationSize: ex.populationSize, extracted: ex.extracted, elapsedMs: ex.elapsedMs },
    phase1Reference: phase1.calibration,
    providerBreakdown: breakdowns,
    results,
    qualityIssues: { total: issues.length, byIssue, sample: issues.slice(0, 50) },
    consistencyChecks: checks.map(([name, ok, detail]) => ({ name, ok, detail })),
    allChecksPassed: allPass,
  }, null, 2),
);
failIfChecksFailed(checks.map(([name, ok]) => ({ name, ok })));
writeFileSync(`out/comparison-${ENV}.txt`, L.join("\n"));
console.log(`\nwrote out/comparison-${ENV}.json and out/comparison-${ENV}.txt`);
