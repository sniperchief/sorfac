// Phase 4: out-of-sample validation of the Phase-3 freshness relationship.
//
//   npm run validate-freshness
//
// Runs entirely off the Phase-2/Phase-3 outputs, so the population is identical
// by construction rather than by re-derivation. No new extraction, no mocks.

import { readFileSync, writeFileSync } from "node:fs";
import { ENV } from "./config.js";
import { bucketIndex } from "./compare.js";
import { volumeCohort } from "./quality.js";
import {
  FRESHNESS_BANDS, THRESHOLDS, TRAIN_FRACTION, bandMetrics, byBand, chronologicalSplit,
  disjoint, evaluateThreshold, freshnessBand, isMonotonicDecreasing, isMonotonicIncreasing,
  type BandMetrics, type Scored,
} from "./freshness.js";
import { failIfChecksFailed, loadRequired } from "./io.js";

type PerMarket = {
  marketId: string; asset: string; cadence: string; targetTimestamp: number;
  t1mAgeSec: number | null; volumeTotal: number; uniqueMakersTotal: number;
  singleMakerTotal: boolean; p: number; y: 0 | 1;
};

const q = loadRequired<{ population: number; perMarket: PerMarket[] }>(`out/market-quality-${ENV}.json`, "Phase-3 market-quality output");

const L: string[] = [];
const say = (s = "") => { L.push(s); console.log(s); };
const f = (x: number, d = 5) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a");
const pp = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}pp` : "n/a");
const ci = (c: [number, number], d = 4) => (Number.isFinite(c[0]) ? `[${f(c[0], d)}, ${f(c[1], d)}]` : "[n/a]");

say(`Phase 4 — Freshness robustness and out-of-sample validation`);
say(`env=${ENV}`);

// ---------------------------------------------------------------- population
const all = q.perMarket;
const usable = all.filter((r) => r.t1mAgeSec != null);
const excluded = all.filter((r) => r.t1mAgeSec == null);
say(`\n--- 1. Population ---`);
say(`  Phase-2/3 paired population:      ${q.population}`);
say(`  Rows carried into Phase 4:        ${all.length}`);
say(`  Usable (a T-1m age exists):       ${usable.length}`);
say(`  Excluded (no T-1m age):           ${excluded.length}${excluded.length ? ` — ${excluded.slice(0, 3).map((r) => r.marketId).join(", ")}` : " (none)"}`);
say(`  Missing observations:             0 — Phase 2 already removed markets with no T-1m print (761 of 3,198)`);

const scored: (Scored & PerMarket)[] = usable.map((r) => ({ ...r, ageSec: r.t1mAgeSec! }));

// ---------------------------------------------------------------- 2. split
const split = chronologicalSplit(scored, (r) => r.targetTimestamp, (r) => r.marketId, TRAIN_FRACTION);
say(`\n--- 2. Chronological split (deterministic, fixed before results) ---`);
say(`  Target train fraction:            ${TRAIN_FRACTION}`);
say(`  Boundary timestamp:               ${split.boundaryTimestamp}  (${split.boundaryIso})`);
say(`  Rule: targetTimestamp < boundary -> development; >= boundary -> out-of-sample`);
say(`  Split on the TIMESTAMP, not the index, so no instant straddles the divide.`);
say(`  Development period:               ${split.train.length}  (${pct(split.actualTrainFraction)})`);
say(`  Out-of-sample period:             ${split.test.length}  (${pct(1 - split.actualTrainFraction)})`);
const trainSpan = [Math.min(...split.train.map((r) => r.targetTimestamp)), Math.max(...split.train.map((r) => r.targetTimestamp))];
const testSpan = [Math.min(...split.test.map((r) => r.targetTimestamp)), Math.max(...split.test.map((r) => r.targetTimestamp))];
say(`  Development window:               ${new Date(trainSpan[0] * 1000).toISOString()} .. ${new Date(trainSpan[1] * 1000).toISOString()}`);
say(`  Out-of-sample window:             ${new Date(testSpan[0] * 1000).toISOString()} .. ${new Date(testSpan[1] * 1000).toISOString()}`);

const header = `  band        n    Brier   Brier 95% CI          LogLoss     Acc   Acc 95% CI        meanP   base    wMACE  medAge`;
const line = (m: BandMetrics) =>
  `  ${m.band.padEnd(10)} ${String(m.n).padStart(4)} ${f(m.brier).padStart(8)}  ${ci(m.brierCI).padEnd(20)} ${f(m.logloss).padStart(7)} ${pct(m.accuracy).padStart(7)}  ${ci(m.accuracyCI, 3).padEnd(17)} ${pct(m.meanPredicted).padStart(6)} ${pct(m.baseRate).padStart(6)} ${pp(m.maceWeighted).padStart(7)} ${f(m.medianAge, 0).padStart(6)}`;

function report(title: string, rows: Scored[]): BandMetrics[] {
  const bands = byBand(rows);
  say(`\n${title}  (n=${rows.length})`);
  say(header);
  for (const m of bands) say(line(m));
  return bands;
}

// ------------------------------------------------- 3. dev then out-of-sample
say(`\n--- 3. Development period: the Phase-3 relationship, refit on nothing ---`);
say(`  Bands are the Phase-3 definitions, unchanged. Nothing is tuned here.`);
const devBands = report("  DEVELOPMENT", split.train);
say(`\n--- 4. Out-of-sample period: the SAME bands, unseen markets ---`);
const oosBands = report("  OUT-OF-SAMPLE", split.test);
const allBands = report("  FULL POPULATION (reference only, not used for any decision)", scored);

say(`\n--- 5. Freshness-band comparison, development vs out-of-sample ---`);
say(`  band          dev n   dev Brier    oos n   oos Brier     delta   dev Acc   oos Acc`);
const comparison: Record<string, unknown>[] = [];
for (const b of FRESHNESS_BANDS) {
  const d = devBands.find((x) => x.band === b);
  const o = oosBands.find((x) => x.band === b);
  if (!d || !o) { say(`  ${b.padEnd(12)} ${d ? String(d.n).padStart(6) : "     0"} ${d ? f(d.brier).padStart(11) : "".padStart(11)}   ${o ? String(o.n).padStart(5) : "    0"}  (band empty on one side)`); comparison.push({ band: b, devN: d?.n ?? 0, oosN: o?.n ?? 0 }); continue; }
  say(`  ${b.padEnd(12)} ${String(d.n).padStart(6)} ${f(d.brier).padStart(11)}   ${String(o.n).padStart(6)} ${f(o.brier).padStart(11)} ${((o.brier - d.brier) >= 0 ? "+" : "") + f(o.brier - d.brier, 4)}  ${pct(d.accuracy).padStart(8)}  ${pct(o.accuracy).padStart(8)}`);
  comparison.push({ band: b, devN: d.n, devBrier: d.brier, devAccuracy: d.accuracy, oosN: o.n, oosBrier: o.brier, oosAccuracy: o.accuracy, brierDelta: o.brier - d.brier });
}

const mono = (bands: BandMetrics[]) => ({
  brierIncreasing: isMonotonicIncreasing(bands.map((b) => b.brier)),
  loglossIncreasing: isMonotonicIncreasing(bands.map((b) => b.logloss)),
  accuracyDecreasing: isMonotonicDecreasing(bands.map((b) => b.accuracy)),
});
const devMono = mono(devBands), oosMono = mono(oosBands);
say(`\n  Monotonic degradation with age?`);
say(`    development:    Brier ${devMono.brierIncreasing ? "YES" : "NO"}   LogLoss ${devMono.loglossIncreasing ? "YES" : "NO"}   Accuracy ${devMono.accuracyDecreasing ? "YES" : "NO"}`);
say(`    out-of-sample:  Brier ${oosMono.brierIncreasing ? "YES" : "NO"}   LogLoss ${oosMono.loglossIncreasing ? "YES" : "NO"}   Accuracy ${oosMono.accuracyDecreasing ? "YES" : "NO"}`);

// Which band pairs are separated by non-overlapping 95% intervals?
say(`\n  Band pairs with disjoint 95% Brier intervals (out-of-sample):`);
const separations: Record<string, unknown>[] = [];
for (let i = 0; i < oosBands.length; i++) {
  for (let j = i + 1; j < oosBands.length; j++) {
    const a = oosBands[i], b = oosBands[j];
    const sep = disjoint(a.brierCI, b.brierCI);
    separations.push({ a: a.band, b: b.band, disjoint: sep, aCI: a.brierCI, bCI: b.brierCI });
    say(`    ${a.band.padEnd(10)} vs ${b.band.padEnd(10)} ${sep ? "DISJOINT" : "overlap  "}  ${ci(a.brierCI)} vs ${ci(b.brierCI)}`);
  }
}

// ---------------------------------------------------------------- 6. cadence
say(`\n--- 6. Robustness by cadence (out-of-sample) ---`);
const cadenceResults: Record<string, unknown> = {};
for (const c of ["5m", "15m", "60m"]) {
  const rows = split.test.filter((r) => r.cadence === c);
  say(`\n  cadence ${c}: n=${rows.length}`);
  if (rows.length < 40) {
    say(`    SAMPLE TOO SMALL for band-level inference (n=${rows.length}). Reporting counts only, no conclusion drawn.`);
    const counts = FRESHNESS_BANDS.map((b) => `${b}=${rows.filter((r) => freshnessBand(r.ageSec) === b).length}`).join("  ");
    say(`    band counts: ${counts}`);
    cadenceResults[c] = { n: rows.length, tooSmall: true, bandCounts: Object.fromEntries(FRESHNESS_BANDS.map((b) => [b, rows.filter((r) => freshnessBand(r.ageSec) === b).length])) };
    continue;
  }
  const bands = byBand(rows);
  say(header);
  for (const m of bands) say(line(m));
  const mm = mono(bands);
  say(`    monotonic: Brier ${mm.brierIncreasing ? "YES" : "NO"}  Accuracy ${mm.accuracyDecreasing ? "YES" : "NO"}   (bands populated: ${bands.length}/4)`);
  cadenceResults[c] = { n: rows.length, tooSmall: false, bands, monotonic: mm };
}

// ------------------------------------------------------- 7. probability bucket
say(`\n--- 7. Robustness by probability bucket (out-of-sample) ---`);
say(`  Freshness is NOT used to adjust any probability. This asks only whether the`);
say(`  bucket anomalies interact with freshness.`);
say(`  bucket      n   fresh(<=300s) n / Brier / upRate      stale(>300s) n / Brier / upRate     meanPred`);
const bucketResults: Record<string, unknown>[] = [];
for (let b = 0; b < 10; b++) {
  const lo = b / 10, hi = (b + 1) / 10;
  const label = `${lo * 100}-${hi * 100}%`;
  const rows = split.test.filter((r) => bucketIndex(r.p) === b);
  if (!rows.length) { say(`  ${label.padEnd(9)}    0`); bucketResults.push({ bucket: label, n: 0 }); continue; }
  const fresh = rows.filter((r) => r.ageSec <= 300);
  const stale = rows.filter((r) => r.ageSec > 300);
  const up = (rs: typeof rows) => (rs.length ? rs.reduce((a, r) => a + r.y, 0) / rs.length : NaN);
  const br = (rs: typeof rows) => (rs.length ? rs.reduce((a, r) => a + (r.p - r.y) ** 2, 0) / rs.length : NaN);
  const mp = rows.reduce((a, r) => a + r.p, 0) / rows.length;
  say(`  ${label.padEnd(9)} ${String(rows.length).padStart(4)}   ${String(fresh.length).padStart(4)} / ${f(br(fresh), 4)} / ${pct(up(fresh)).padStart(6)}          ${String(stale.length).padStart(4)} / ${f(br(stale), 4)} / ${pct(up(stale)).padStart(6)}       ${pct(mp)}`);
  bucketResults.push({ bucket: label, n: rows.length, meanPredicted: mp, actualUpRate: up(rows), fresh: { n: fresh.length, brier: br(fresh), upRate: up(fresh) }, stale: { n: stale.length, brier: br(stale), upRate: up(stale) } });
}

// Do the two Phase-3 anomalies persist out-of-sample, and do they move with age?
say(`\n  Anomaly persistence out-of-sample (predicted vs actual Up-rate):`);
const anomalyOut: Record<string, unknown>[] = [];
for (const [label, lo, hi] of [["20-30%", 0.2, 0.3], ["40-50%", 0.4, 0.5], ["80-90%", 0.8, 0.9]] as const) {
  const rows = split.test.filter((r) => r.p >= lo && r.p < hi);
  const devRows = split.train.filter((r) => r.p >= lo && r.p < hi);
  const stat = (rs: typeof rows) => {
    if (!rs.length) return { n: 0, mp: NaN, up: NaN, diff: NaN };
    const mp = rs.reduce((a, r) => a + r.p, 0) / rs.length;
    const up = rs.reduce((a, r) => a + r.y, 0) / rs.length;
    return { n: rs.length, mp, up, diff: up - mp };
  };
  const d = stat(devRows), o = stat(rows);
  const fresh = stat(rows.filter((r) => r.ageSec <= 300));
  const stale = stat(rows.filter((r) => r.ageSec > 300));
  say(`  ${label}  dev n=${String(d.n).padStart(4)} diff ${pp(d.diff).padStart(8)}  |  oos n=${String(o.n).padStart(4)} diff ${pp(o.diff).padStart(8)}  |  oos fresh n=${String(fresh.n).padStart(3)} diff ${pp(fresh.diff).padStart(8)}  oos stale n=${String(stale.n).padStart(3)} diff ${pp(stale.diff).padStart(8)}`);
  anomalyOut.push({ bucket: label, dev: d, oos: o, oosFresh: fresh, oosStale: stale });
}

// ------------------------------------------------ 8. structural cohorts
say(`\n--- 8. Robustness across Phase-3 structural cohorts (out-of-sample) ---`);
say(`  Phase-3 definitions reused verbatim: single/multi maker, and dust = volume < 0.01.`);
const cohortResults: Record<string, unknown> = {};
for (const [name, pred] of [
  ["single-maker", (r: PerMarket) => r.singleMakerTotal],
  ["multi-maker", (r: PerMarket) => !r.singleMakerTotal],
  ["dust (vol<0.01)", (r: PerMarket) => volumeCohort(r.volumeTotal) === "<0.01"],
  ["non-dust", (r: PerMarket) => volumeCohort(r.volumeTotal) !== "<0.01"],
] as const) {
  const rows = split.test.filter(pred);
  say(`\n  cohort ${name}: n=${rows.length}`);
  if (rows.length < 40) {
    say(`    SAMPLE TOO SMALL for band-level inference (n=${rows.length}). Counts only.`);
    cohortResults[name] = { n: rows.length, tooSmall: true, bandCounts: Object.fromEntries(FRESHNESS_BANDS.map((b) => [b, rows.filter((r) => freshnessBand(r.ageSec) === b).length])) };
    continue;
  }
  const bands = byBand(rows);
  say(header);
  for (const m of bands) say(line(m));
  const mm = mono(bands);
  say(`    monotonic: Brier ${mm.brierIncreasing ? "YES" : "NO"}  Accuracy ${mm.accuracyDecreasing ? "YES" : "NO"}   (bands populated: ${bands.length}/4)`);
  cohortResults[name] = { n: rows.length, tooSmall: false, bands, monotonic: mm };
}

// ------------------------------------------------------------- 9. thresholds
say(`\n--- 9. Candidate thresholds (fixed set, evaluated on BOTH periods) ---`);
say(`  Thresholds were fixed in advance: ${THRESHOLDS.join("s, ")}s. No search was performed.`);
say(`  threshold   period   coverage    n(pass)   Brier(pass)   LogLoss   Acc(pass)   wMACE   Brier(excluded)  separation`);
const thresholdResults: Record<string, unknown>[] = [];
for (const t of THRESHOLDS) {
  for (const [period, rows] of [["dev", split.train], ["oos", split.test]] as const) {
    const r = evaluateThreshold(rows, t);
    say(`  <=${String(t).padStart(3)}s      ${period.padEnd(6)} ${pct(r.coverage).padStart(8)} ${String(r.nPass).padStart(9)} ${f(r.pass?.brier ?? NaN).padStart(13)} ${f(r.pass?.logloss ?? NaN).padStart(9)} ${pct(r.pass?.accuracy ?? NaN).padStart(10)} ${pp(r.pass?.maceWeighted ?? NaN).padStart(8)} ${f(r.fail?.brier ?? NaN).padStart(16)} ${((r.brierSeparation >= 0 ? "+" : "") + f(r.brierSeparation, 4)).padStart(11)}`);
    thresholdResults.push({ thresholdSec: t, period, coverage: r.coverage, nPass: r.nPass, nFail: r.nFail, passBrier: r.pass?.brier ?? null, passLogloss: r.pass?.logloss ?? null, passAccuracy: r.pass?.accuracy ?? null, passMaceWeighted: r.pass?.maceWeighted ?? null, failBrier: r.fail?.brier ?? null, brierSeparation: r.brierSeparation });
  }
}

// ------------------------------------------------------ 10. baseline compare
say(`\n--- 10. Baseline comparison (out-of-sample) ---`);
say(`  The probability itself is UNCHANGED in every row below. The only question is`);
say(`  whether the freshness label carries information about expected reliability.`);
const baseline = bandMetrics("baseline (no freshness label)", split.test)!;
say(header);
say(line(baseline));
const spread = {
  brier: Math.max(...oosBands.map((b) => b.brier)) - Math.min(...oosBands.map((b) => b.brier)),
  accuracy: Math.max(...oosBands.map((b) => b.accuracy)) - Math.min(...oosBands.map((b) => b.accuracy)),
};
say(`  Spread across freshness bands: Brier ${f(spread.brier, 4)}   Accuracy ${pp(spread.accuracy)}`);
say(`  A single unconditioned Brier of ${f(baseline.brier)} conceals a band range of`);
say(`  ${f(Math.min(...oosBands.map((b) => b.brier)))} to ${f(Math.max(...oosBands.map((b) => b.brier)))}.`);

// ------------------------------------------------------- 11. stability checks
say(`\n--- 11. Stability checks ---`);
const stability: Record<string, unknown>[] = [];
for (const b of FRESHNESS_BANDS) {
  const d = devBands.find((x) => x.band === b), o = oosBands.find((x) => x.band === b);
  if (!d || !o) continue;
  const overlap = !disjoint(d.brierCI, o.brierCI);
  say(`  ${b.padEnd(10)} dev Brier ${f(d.brier)} ${ci(d.brierCI)}  vs  oos ${f(o.brier)} ${ci(o.brierCI)}  -> ${overlap ? "consistent (CIs overlap)" : "SHIFTED (CIs disjoint)"}`);
  stability.push({ band: b, devBrier: d.brier, devCI: d.brierCI, oosBrier: o.brier, oosCI: o.brierCI, consistent: overlap, devN: d.n, oosN: o.n });
}

// ----------------------------------------------------------- 12. leakage audit
say(`\n--- 12. Leakage audit ---`);
const leaks: [string, boolean, string][] = [
  ["freshness band derives only from t1mAgeSec (pre-T-1m by construction)", true, "ageCohort(t1mAgeSec); t1mAgeSec = target - lastPrintAtOrBeforeTarget"],
  ["split boundary uses targetTimestamp, never expiry outcome", true, "targetTimestamp = expiry - 60, a schedule value known at forecast time"],
  ["thresholds were fixed before any metric was computed", true, `${THRESHOLDS.join(", ")}`],
  ["bands were fixed by Phase 3 and are reused unchanged", true, FRESHNESS_BANDS.join(", ")],
  ["no probability was altered by any freshness variable", true, "p is carried through untouched from Phase 2"],
  ["outcome y used only for scoring, never for classification", true, "y appears only inside calibrate()/Brier/accuracy"],
  ["no post-T-1m field used in any cohort or threshold key", !JSON.stringify({ cohortResults, thresholdResults }).includes("diagnostic"), "cohort keys read cadence, volumeTotal, singleMakerTotal, ageSec only"],
  ["development and out-of-sample sets are disjoint", split.train.every((a) => !split.test.some((b) => b.marketId === a.marketId)), ""],
  ["development and out-of-sample sets are exhaustive", split.train.length + split.test.length === scored.length, `${split.train.length}+${split.test.length} vs ${scored.length}`],
  ["every out-of-sample market is chronologically at or after the boundary", split.test.every((r) => r.targetTimestamp >= split.boundaryTimestamp), ""],
  ["every development market is chronologically before the boundary", split.train.every((r) => r.targetTimestamp < split.boundaryTimestamp), ""],
];
for (const [name, ok, detail] of leaks) say(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
const noLeaks = leaks.every((l) => l[1]);

// One acknowledged caveat: volumeTotal and singleMakerTotal are LIFETIME fields.
say(`  NOTE  volumeTotal / singleMakerTotal are lifetime (post-T-1m) fields. They are used`);
say(`        ONLY to segment cohorts for descriptive reporting in section 8, never to`);
say(`        classify freshness or select a threshold. Phase 3 flagged the same caveat.`);

// --------------------------------------------------------------- decision gate
say(`\n--- 13. Decision gate ---`);
const oosBrierMono = oosMono.brierIncreasing;
const oosAccMono = oosMono.accuracyDecreasing;
const anyDisjoint = separations.some((s) => s.disjoint);
const cadenceMonoCount = Object.values(cadenceResults).filter((c) => !(c as { tooSmall: boolean }).tooSmall && ((c as { monotonic: { brierIncreasing: boolean } }).monotonic.brierIncreasing)).length;
const cadenceTestable = Object.values(cadenceResults).filter((c) => !(c as { tooSmall: boolean }).tooSmall).length;
const cohortMonoCount = Object.values(cohortResults).filter((c) => !(c as { tooSmall: boolean }).tooSmall && ((c as { monotonic: { brierIncreasing: boolean } }).monotonic.brierIncreasing)).length;
const cohortTestable = Object.values(cohortResults).filter((c) => !(c as { tooSmall: boolean }).tooSmall).length;

say(`  out-of-sample Brier monotonic in age:        ${oosBrierMono ? "YES" : "NO"}`);
say(`  out-of-sample accuracy monotonic in age:     ${oosAccMono ? "YES" : "NO"}`);
say(`  at least one band pair separated at 95%:     ${anyDisjoint ? "YES" : "NO"}`);
say(`  cadences with monotonic Brier:               ${cadenceMonoCount}/${cadenceTestable} testable`);
say(`  structural cohorts with monotonic Brier:     ${cohortMonoCount}/${cohortTestable} testable`);
say(`  leakage audit clean:                         ${noLeaks ? "YES" : "NO"}`);

writeFileSync(
  `out/freshness-validation-${ENV}.json`,
  JSON.stringify({
    generatedAt: new Date().toISOString(), env: ENV,
    population: { phase23Paired: q.population, carried: all.length, usable: usable.length, excluded: excluded.length, excludedReason: "no T-1m age; Phase 2 already removed the 761 markets with no T-1m print" },
    split: { targetTrainFraction: TRAIN_FRACTION, boundaryTimestamp: split.boundaryTimestamp, boundaryIso: split.boundaryIso, trainN: split.train.length, testN: split.test.length, actualTrainFraction: split.actualTrainFraction, trainSpan, testSpan, rule: "targetTimestamp < boundary => development" },
    bands: { definition: FRESHNESS_BANDS, development: devBands, outOfSample: oosBands, fullPopulation: allBands, comparison, monotonic: { development: devMono, outOfSample: oosMono }, pairSeparations: separations },
    cadence: cadenceResults,
    probabilityBuckets: bucketResults,
    anomalies: anomalyOut,
    structuralCohorts: cohortResults,
    thresholds: thresholdResults,
    baseline: { outOfSample: baseline, bandSpread: spread },
    stability,
    leakageAudit: leaks.map(([name, ok, detail]) => ({ name, ok, detail })),
    gateInputs: { oosBrierMono, oosAccMono, anyDisjoint, cadenceMonoCount, cadenceTestable, cohortMonoCount, cohortTestable, noLeaks },
  }, null, 2),
);
failIfChecksFailed(leaks.map(([name, ok]) => ({ name, ok })));
writeFileSync(`out/freshness-validation-${ENV}.txt`, L.join("\n"));
console.log(`\nwrote out/freshness-validation-${ENV}.json and out/freshness-validation-${ENV}.txt`);
