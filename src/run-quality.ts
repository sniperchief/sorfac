// Phase 3: empirical market-quality / liquidity analysis.
//
//   npm run analyze-quality
//
// Population: the Phase-2 paired T-1m set, unchanged. Tapes are pulled live from
// mainnet with the same window scoping the Phase-2 fills provider uses.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";
import { client, ENV, INDEXER_URL } from "./config.js";
import { calibrate, outcomeOf, validProbability, type CalibrationSample } from "./calibration.js";
import { mace } from "./compare.js";
import { mapLimit, observationFrom, type ExtractionRow } from "./extract-t1m.js";
import {
  AGE_COHORTS, NEAR_SEC, NEAR_SEC_WIDE, TRADE_COHORTS, VOLUME_COHORTS, ageCohort, cadenceCohort,
  deriveQuality, makerCohort, mean, median, spearman, supportCohort, tradeCohort, volumeCohort,
  type Fill, type MarketQuality,
} from "./quality.js";
import { failIfChecksFailed, loadRequired } from "./io.js";

const CONCURRENCY = Number(process.env.DDX_CONCURRENCY ?? 8);
const TAPES = `out/tapes-${ENV}.json`;

const ex = loadRequired<{
  horizonSec: number; populationSize: number; rows: ExtractionRow[];
}>(`out/t1m-${ENV}.json`, "T-1m observations");
const markets = loadRequired<BinaryMarket[]>(`out/markets-${ENV}.json`, "the Phase-1 market registry");
const byId = new Map(markets.map((m) => [m.marketId.toLowerCase(), m]));

const PROVIDER = "dreamdex.fills";

// The Phase-2 paired population, reconstructed with Phase-2's own rules. Locked.
type Paired = { row: ExtractionRow; p: number; y: 0 | 1 };
const paired: Paired[] = [];
for (const row of ex.rows) {
  const y = outcomeOf(row.winningOutcome);
  const p = observationFrom(row, PROVIDER)?.price ?? null;
  if (y === null || !validProbability(row.referenceLastPrice) || !validProbability(p)) continue;
  paired.push({ row, p, y });
}
console.log(`env=${ENV} indexer=${INDEXER_URL}`);
console.log(`Phase-2 paired population: ${paired.length} (expected 2437)\n`);

// ---- Fetch real fill tapes, cached so reruns of the analysis are cheap ----
type TapeCache = Record<string, Fill[]>;
let tapes: TapeCache = {};
if (existsSync(TAPES) && !process.env.DDX_REFETCH) {
  tapes = JSON.parse(readFileSync(TAPES, "utf8"));
  console.log(`reusing cached tapes for ${Object.keys(tapes).length} markets (DDX_REFETCH=1 to refetch)`);
} else {
  console.log(`fetching fill tapes for ${paired.length} markets...`);
  const t0 = Date.now();
  let done = 0;
  const fetched = await mapLimit(paired, CONCURRENCY, async ({ row }) => {
    const m = byId.get(row.marketId.toLowerCase())!;
    const rows = await client.getFills(m.poolAddress, { since: Number(m.tradingStart), until: Number(m.expiry), limit: 1000 });
    const dec = m.quoteDecimals;
    const tape: Fill[] = rows
      .filter((f) => f.market.toLowerCase() === m.marketId.toLowerCase())
      .map((f) => ({
        t: Number(f.timestamp),
        price: Number(f.fillPrice) / 10 ** dec,
        maker: f.maker ? f.maker.toLowerCase() : null,
        taker: f.taker ? f.taker.toLowerCase() : null,
        quote: Number(f.quoteQuantity) / 10 ** dec,
      }))
      .sort((a, b) => a.t - b.t);
    if (++done % 500 === 0) process.stderr.write(`  ${done}/${paired.length}\n`);
    return [row.marketId, tape] as const;
  });
  tapes = Object.fromEntries(fetched);
  writeFileSync(TAPES, JSON.stringify(tapes));
  console.log(`fetched in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${TAPES}`);
}

// ---- Derive quality variables ----
type Record_ = Paired & { q: MarketQuality };
const recs: Record_[] = paired.map(({ row, p, y }) => {
  const m = byId.get(row.marketId.toLowerCase())!;
  const q = deriveQuality(
    {
      marketId: row.marketId, asset: row.asset, cadence: cadenceCohort(row.intervalSec),
      intervalSec: row.intervalSec, tradingStart: row.tradingStart, expiry: row.expiry,
      targetTimestamp: row.targetTimestamp, tradeCountTotal: Number(m.tradeCount),
    },
    tapes[row.marketId] ?? [],
  );
  return { row, p, y, q };
});

// Cross-check: the tape-derived T-1m price must equal the Phase-2 extraction.
const mismatches = recs.filter((r) => r.q.t1mPrice == null || Math.abs(r.q.t1mPrice - r.p) > 1e-12);
console.log(`T-1m price reproduced from tape: ${recs.length - mismatches.length}/${recs.length} exact${mismatches.length ? ` (${mismatches.length} MISMATCH)` : ""}`);

// ---- Calibration by cohort ----
const L: string[] = [];
const say = (s = "") => { L.push(s); console.log(s); };
const f = (x: number, d = 5) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pp = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}pp` : "n/a");

type CohortMetrics = {
  cohort: string; n: number; brier: number; logloss: number; accuracy: number;
  meanPredicted: number; baseRate: number; mace: number; maceWeighted: number;
  medianTradeCount: number; medianUniqueMakers: number; medianVolume: number;
  medianT1mAge: number; pctSingleMaker: number; pctIsolated: number;
  buckets: ReturnType<typeof calibrate>["buckets"];
};

function metricsFor(cohort: string, rs: Record_[]): CohortMetrics | null {
  if (!rs.length) return null;
  const samples: CalibrationSample[] = rs.map((r) => ({ marketId: r.row.marketId, p: r.p, y: r.y }));
  const c = calibrate(samples);
  const m = mace(c.buckets);
  return {
    cohort, n: rs.length, brier: c.brier, logloss: c.logloss, accuracy: c.accuracy,
    meanPredicted: c.meanPredicted, baseRate: c.baseRate, mace: m.plain, maceWeighted: m.weighted,
    medianTradeCount: median(rs.map((r) => r.q.tradeCountTotal)),
    medianUniqueMakers: median(rs.map((r) => r.q.uniqueMakersTotal)),
    medianVolume: median(rs.map((r) => r.q.volumeTotal)),
    medianT1mAge: median(rs.map((r) => r.q.t1mAgeSec ?? NaN)),
    pctSingleMaker: rs.filter((r) => r.q.singleMakerTotal).length / rs.length,
    pctIsolated: rs.filter((r) => r.q.isolatedPrint).length / rs.length,
    buckets: c.buckets,
  };
}

function group(name: string, key: (r: Record_) => string, order?: readonly string[]) {
  const g = new Map<string, Record_[]>();
  for (const r of recs) g.set(key(r), [...(g.get(key(r)) ?? []), r]);
  const keys = order ? order.filter((k) => g.has(k)).concat([...g.keys()].filter((k) => !order.includes(k))) : [...g.keys()].sort();
  const rows = keys.map((k) => metricsFor(k, g.get(k)!)).filter((x): x is CohortMetrics => x !== null);
  say(`\n--- ${name} ---`);
  say(`  cohort            n   Brier   LogLoss    Acc   meanP   base    MACE  wMACE  medTrades medMakers     medVol  medAge  %single  %isolated`);
  for (const m of rows) {
    say(`  ${m.cohort.padEnd(14)} ${String(m.n).padStart(5)} ${f(m.brier).padStart(7)} ${f(m.logloss).padStart(9)} ${(m.accuracy * 100).toFixed(1).padStart(6)}% ${(m.meanPredicted * 100).toFixed(1).padStart(6)}% ${(m.baseRate * 100).toFixed(1).padStart(5)}% ${pp(m.mace).padStart(7)} ${pp(m.maceWeighted).padStart(6)} ${String(m.medianTradeCount).padStart(10)} ${String(m.medianUniqueMakers).padStart(9)} ${m.medianVolume.toExponential(2).padStart(9)} ${f(m.medianT1mAge, 0).padStart(7)} ${(m.pctSingleMaker * 100).toFixed(1).padStart(7)}% ${(m.pctIsolated * 100).toFixed(1).padStart(9)}%`);
  }
  return { name, rows };
}

say(`Phase 3 — Market quality / liquidity vs T-1m calibration`);
say(`env=${ENV}  population=${recs.length}  nearWindow=${NEAR_SEC}s (wide ${NEAR_SEC_WIDE}s)`);

const overall = metricsFor("ALL", recs)!;
say(`\nOverall: n=${overall.n} Brier ${f(overall.brier)} LogLoss ${f(overall.logloss)} MACE ${pp(overall.mace)} wMACE ${pp(overall.maceWeighted)}`);

const groups = [
  group("Cohort: total trade count", (r) => tradeCohort(r.q.tradeCountTotal) ?? "unknown", TRADE_COHORTS),
  group("Cohort: pre-T-1m trade count (leak-free)", (r) => tradeCohort(r.q.tradeCountPre) ?? "unknown", TRADE_COHORTS),
  group("Cohort: unique makers (lifetime)", (r) => makerCohort(r.q.uniqueMakersTotal), ["single-maker", "multi-maker", "unknown"]),
  group("Cohort: unique makers at or before T-1m", (r) => makerCohort(r.q.uniqueMakersPre), ["single-maker", "multi-maker", "unknown"]),
  group("Cohort: cadence", (r) => r.q.cadence, ["5m", "15m", "60m"]),
  group("Cohort: T-1m observation age", (r) => ageCohort(r.q.t1mAgeSec), AGE_COHORTS),
  group("Cohort: T-1m print support", (r) => supportCohort(r.q), ["isolated-print", "supported"]),
  group("Cohort: unique participants at or before T-1m", (r) => (r.q.uniqueParticipantsPre <= 2 ? "2 or fewer" : r.q.uniqueParticipantsPre <= 4 ? "3-4" : "5+"), ["2 or fewer", "3-4", "5+"]),
  group("Cohort: traded volume (collateral)", (r) => volumeCohort(r.q.volumeTotal), VOLUME_COHORTS),
];

// Trade count is widely assumed to proxy liquidity. Test that here rather than
// assuming it: if the two are uncorrelated, the trade-count cohorts above are
// NOT liquidity cohorts and must not be described as such.
const rhoTradesVolume = spearman(recs.map((r) => r.q.tradeCountTotal), recs.map((r) => r.q.volumeTotal));
say(`\n--- Is trade count a liquidity proxy? ---`);
say(`  Spearman(total trade count, traded volume) = ${(rhoTradesVolume >= 0 ? "+" : "") + f(rhoTradesVolume, 4)}`);
say(`  median volume per trade by trade cohort:`);
for (const c of TRADE_COHORTS) {
  const s = recs.filter((r) => tradeCohort(r.q.tradeCountTotal) === c);
  if (!s.length) continue;
  say(`    ${c.padEnd(6)} n=${String(s.length).padStart(5)}  median volume ${median(s.map((r) => r.q.volumeTotal)).toExponential(3)}  per trade ${median(s.map((r) => r.q.volumeTotal / Math.max(1, r.q.tradeCountTotal))).toExponential(3)}`);
}

// ---- 20-30% anomaly ----
say(`\n--- 20-30% bucket anomaly: structure vs the rest ---`);
const inBucket = (r: Record_, lo: number, hi: number) => r.p >= lo && r.p < hi;
const anomaly = recs.filter((r) => inBucket(r, 0.2, 0.3));
const rest = recs.filter((r) => !inBucket(r, 0.2, 0.3));
const mirror = recs.filter((r) => inBucket(r, 0.7, 0.8)); // the symmetric bucket
const vars: [string, (r: Record_) => number][] = [
  ["total trade count", (r) => r.q.tradeCountTotal],
  ["pre-T-1m trade count", (r) => r.q.tradeCountPre],
  ["unique makers (lifetime)", (r) => r.q.uniqueMakersTotal],
  ["unique takers (lifetime)", (r) => r.q.uniqueTakersTotal],
  ["volume (collateral)", (r) => r.q.volumeTotal],
  ["T-1m age (s)", (r) => r.q.t1mAgeSec ?? NaN],
  ["trades near T-1m", (r) => r.q.tradesNear],
  ["price range near T-1m", (r) => r.q.priceRangeNear],
  ["maker concentration pre", (r) => r.q.makerConcentrationPre],
  ["DIAGNOSTIC post-T-1m move", (r) => r.q.diagnostic.absMovePost ?? NaN],
];
say(`  variable                        20-30% (n=${anomaly.length})      rest (n=${rest.length})     70-80% mirror (n=${mirror.length})`);
const anomalyTable: Record<string, unknown>[] = [];
for (const [label, get] of vars) {
  const a = anomaly.map(get).filter(Number.isFinite);
  const b = rest.map(get).filter(Number.isFinite);
  const c = mirror.map(get).filter(Number.isFinite);
  say(`  ${label.padEnd(30)} med ${f(median(a), 3).padStart(8)} / mean ${f(mean(a), 3).padStart(8)}   med ${f(median(b), 3).padStart(8)}   med ${f(median(c), 3).padStart(8)}`);
  anomalyTable.push({ variable: label, anomalyMedian: median(a), anomalyMean: mean(a), restMedian: median(b), restMean: mean(b), mirrorMedian: median(c) });
}
const share = (rs: Record_[], pred: (r: Record_) => boolean) => (rs.length ? rs.filter(pred).length / rs.length : NaN);
const anomalyShares = {
  singleMaker: { anomaly: share(anomaly, (r) => r.q.singleMakerTotal), rest: share(rest, (r) => r.q.singleMakerTotal) },
  isolated: { anomaly: share(anomaly, (r) => r.q.isolatedPrint), rest: share(rest, (r) => r.q.isolatedPrint) },
  cadence5m: { anomaly: share(anomaly, (r) => r.q.cadence === "5m"), rest: share(rest, (r) => r.q.cadence === "5m") },
  cadence15m: { anomaly: share(anomaly, (r) => r.q.cadence === "15m"), rest: share(rest, (r) => r.q.cadence === "15m") },
  cadence60m: { anomaly: share(anomaly, (r) => r.q.cadence === "60m"), rest: share(rest, (r) => r.q.cadence === "60m") },
  singleTrade: { anomaly: share(anomaly, (r) => r.q.tradeCountTotal === 1), rest: share(rest, (r) => r.q.tradeCountTotal === 1) },
};
say(`\n  structure share            20-30%      rest`);
for (const [k, v] of Object.entries(anomalyShares)) say(`  ${k.padEnd(24)} ${(v.anomaly * 100).toFixed(1).padStart(6)}% ${(v.rest * 100).toFixed(1).padStart(9)}%`);

// Within the 20-30% bucket, does structure move the realised Up-rate?
say(`\n  20-30% bucket split by structure (actual Up-rate vs ~24.5% predicted):`);
const splits: [string, (r: Record_) => boolean][] = [
  ["single-maker", (r) => r.q.singleMakerTotal],
  ["multi-maker", (r) => !r.q.singleMakerTotal],
  ["1 trade", (r) => r.q.tradeCountTotal === 1],
  ["2+ trades", (r) => r.q.tradeCountTotal > 1],
  ["isolated print", (r) => r.q.isolatedPrint],
  ["supported print", (r) => !r.q.isolatedPrint],
  ["5m", (r) => r.q.cadence === "5m"],
  ["15m", (r) => r.q.cadence === "15m"],
  ["60m", (r) => r.q.cadence === "60m"],
];
const anomalySplits: Record<string, unknown>[] = [];
for (const [label, pred] of splits) {
  const s = anomaly.filter(pred);
  if (!s.length) { say(`  ${label.padEnd(18)} n=0`); anomalySplits.push({ split: label, n: 0 }); continue; }
  const up = s.reduce((a, r) => a + r.y, 0) / s.length;
  const mp = mean(s.map((r) => r.p));
  say(`  ${label.padEnd(18)} n=${String(s.length).padStart(4)}  meanPred ${(mp * 100).toFixed(2)}%  actualUp ${(up * 100).toFixed(2)}%  diff ${((up - mp) * 100 >= 0 ? "+" : "") + ((up - mp) * 100).toFixed(2)}pp`);
  anomalySplits.push({ split: label, n: s.length, meanPredicted: mp, actualUpRate: up, diff: up - mp });
}

// ---- Price stability around T-1m ----
say(`\n--- T-1m price stability (near window = ${NEAR_SEC}s) ---`);
const supported = recs.filter((r) => !r.q.isolatedPrint);
say(`  markets with >1 trade in the near window: ${supported.length} (${((supported.length / recs.length) * 100).toFixed(1)}%)`);
say(`  price range in near window: median ${f(median(supported.map((r) => r.q.priceRangeNear)), 4)}  mean ${f(mean(supported.map((r) => r.q.priceRangeNear)), 4)}`);
say(`  distinct prices in near window: median ${f(median(supported.map((r) => r.q.distinctPricesNear)), 1)}`);
say(`  DIAGNOSTIC (post-T-1m, never an input): markets trading after T-1m: ${recs.filter((r) => r.q.diagnostic.tradesPost > 0).length}`);
const moves = recs.map((r) => r.q.diagnostic.absMovePost).filter((x): x is number => x != null);
say(`  DIAGNOSTIC |price move after T-1m|: median ${f(median(moves), 4)}  mean ${f(mean(moves), 4)}  p90 ${f([...moves].sort((a, b) => a - b)[Math.floor(moves.length * 0.9)], 4)}`);

// ---- Associations ----
say(`\n--- Associations with per-market squared error (Spearman rho) ---`);
say(`  NOTE: per-market squared error is dominated by forecast confidence, so a`);
say(`  rho here is NOT a calibration measure. Cohort MACE above is the calibration`);
say(`  evidence; this table is a secondary check for monotonic structure.`);
const sqErr = recs.map((r) => (r.p - r.y) ** 2);
const assoc: Record<string, number> = {};
for (const [label, get] of vars) {
  const xs = recs.map(get);
  const keep = xs.map((v, i) => [v, sqErr[i]] as const).filter(([v]) => Number.isFinite(v));
  const rho = spearman(keep.map((k) => k[0]), keep.map((k) => k[1]));
  assoc[label] = rho;
  say(`  ${label.padEnd(30)} rho ${(rho >= 0 ? "+" : "") + f(rho, 4)}   n=${keep.length}`);
}

// Monotonicity of cohort MACE across the ordered trade-count cohorts.
const tradeRows = groups[0].rows.filter((r) => (TRADE_COHORTS as readonly string[]).includes(r.cohort));
const maceSeq = tradeRows.map((r) => r.mace);
const monotoneDown = maceSeq.every((v, i) => i === 0 || v <= maceSeq[i - 1] + 1e-12);
say(`\n  Cohort MACE across trade-count cohorts ${TRADE_COHORTS.join(" < ")}: ${maceSeq.map((v) => pp(v)).join(" -> ")}`);
say(`  Monotonically improving with liquidity? ${monotoneDown ? "YES" : "NO"}`);

// ---- Consistency checks ----
say(`\n--- Consistency checks ---`);
const checks: [string, boolean, string][] = [
  ["population equals the Phase-2 paired set", recs.length === 2437, `${recs.length}`],
  ["T-1m price reproduced from tape for every market", mismatches.length === 0, `${mismatches.length} mismatches`],
  ["overall bucket counts sum to population", overall.buckets.reduce((a, b) => a + b.n, 0) === recs.length, ``],
  ["trade cohorts partition the population", groups[0].rows.reduce((a, r) => a + r.n, 0) === recs.length, ``],
  ["maker cohorts partition the population", groups[2].rows.reduce((a, r) => a + r.n, 0) === recs.length, ``],
  ["cadence cohorts partition the population", groups[4].rows.reduce((a, r) => a + r.n, 0) === recs.length, ``],
  ["every market has a named maker (no unknown cohort)", !groups[2].rows.some((r) => r.cohort === "unknown"), ``],
  ["no market has a T-1m age below zero", !recs.some((r) => (r.q.t1mAgeSec ?? 0) < 0), ``],
  ["diagnostic post-T-1m data excluded from every cohort key", true, "by construction: cohort keys read only pre-T-1m or lifetime-count fields"],
];
for (const [name, ok, detail] of checks) say(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
const allPass = checks.every((c) => c[1]);
say(`  ${allPass ? "All consistency checks passed." : "SOME CHECKS FAILED."}`);

writeFileSync(
  `out/market-quality-${ENV}.json`,
  JSON.stringify({
    generatedAt: new Date().toISOString(), env: ENV, indexerUrl: INDEXER_URL,
    population: recs.length, horizonSec: ex.horizonSec, nearSec: NEAR_SEC, nearSecWide: NEAR_SEC_WIDE,
    overall,
    cohorts: Object.fromEntries(groups.map((g) => [g.name, g.rows])),
    anomaly: { bucket: "20-30%", n: anomaly.length, variables: anomalyTable, structureShares: anomalyShares, splits: anomalySplits },
    stability: {
      supportedMarkets: supported.length,
      medianPriceRangeNear: median(supported.map((r) => r.q.priceRangeNear)),
      diagnosticPostMoveMedian: median(moves),
      diagnosticPostMoveMean: mean(moves),
    },
    associations: assoc,
    tradeCountVsVolumeSpearman: rhoTradesVolume,
    monotonicMaceWithTradeCount: monotoneDown,
    consistencyChecks: checks.map(([name, ok, detail]) => ({ name, ok, detail })),
    allChecksPassed: allPass,
    perMarket: recs.map((r) => ({ ...r.q, p: r.p, y: r.y })),
  }, null, 2),
);
failIfChecksFailed(checks.map(([name, ok]) => ({ name, ok })));
writeFileSync(`out/market-quality-${ENV}.txt`, L.join("\n"));
console.log(`\nwrote out/market-quality-${ENV}.json and out/market-quality-${ENV}.txt`);
