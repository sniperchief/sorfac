import { readFileSync, writeFileSync } from "node:fs";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";

const ENV = process.env.DDX_ENV ?? "mainnet";
const M: BinaryMarket[] = JSON.parse(readFileSync(`out/markets-${ENV}.json`, "utf8"));

const n = (s: string | null | undefined) => (s == null ? null : Number(s));
const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((a / b) * 100).toFixed(2)}%`);
const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

// Probability = lastPrice scaled by the market's OWN quoteDecimals. Never a
// hardcoded 1e18: this dataset carries both 18dp and 6dp collateral.
const prob = (m: BinaryMarket) => {
  const lp = n(m.lastPrice);
  return lp == null ? null : lp / 10 ** m.quoteDecimals;
};
const vol = (m: BinaryMarket) => Number(m.cumulativeQuoteVolume) / 10 ** m.quoteDecimals;

const stat = (xs: number[]) => {
  if (!xs.length) return { n: 0, mean: NaN, median: NaN, p90: NaN, p95: NaN, max: NaN };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, median: q(0.5), p90: q(0.9), p95: q(0.95), max: s[s.length - 1] };
};

const L: string[] = [];
const say = (s = "") => { L.push(s); console.log(s); };

// ---------- Phase 5: dataset statistics ----------
const finalized = M.filter((m) => m.status === "Finalized");
const voided = M.filter((m) => m.voided || m.status === "Voided");
const stuck = M.filter((m) => m.status !== "Finalized" && !m.voided);
const terminal = [...finalized, ...voided];
const traded = terminal.filter((m) => Number(m.tradeCount) > 0);
const zeroTrade = terminal.filter((m) => Number(m.tradeCount) === 0);

say(`Past binary markets pulled:        ${M.length}`);
say(`  status Finalized:                ${finalized.length}`);
say(`  status Voided:                   ${voided.length}`);
say(`  past expiry but NOT terminal:    ${stuck.length}  ${JSON.stringify(stuck.map((m) => `${m.marketId.slice(0, 10)}:${m.status}`))}`);
say(`Terminal (Finalized + Voided):     ${terminal.length}`);
say();
say(`Markets with >=1 trade:            ${traded.length}   (${pct(traded.length, terminal.length)})`);
say(`Zero-trade markets:                ${zeroTrade.length}   (${pct(zeroTrade.length, terminal.length)})`);
say(`Voided markets:                    ${voided.length}   (${pct(voided.length, terminal.length)})`);

const up = finalized.filter((m) => m.winningOutcome === 0);
const down = finalized.filter((m) => m.winningOutcome === 1);
const noOutcome = finalized.filter((m) => m.winningOutcome == null);
const noPrice = terminal.filter((m) => m.lastPrice == null);
const noOracle = terminal.filter((m) => !m.oracleQuestionId);
say(`Resolved Up (winningOutcome=0):    ${up.length}   (${pct(up.length, finalized.length)})`);
say(`Resolved Down (winningOutcome=1):  ${down.length}   (${pct(down.length, finalized.length)})`);
say(`Missing outcome (finalized):       ${noOutcome.length}   (${pct(noOutcome.length, finalized.length)})`);
say(`Missing price (terminal):          ${noPrice.length}   (${pct(noPrice.length, terminal.length)})`);
say(`Missing oracleQuestionId:          ${noOracle.length}   (${pct(noOracle.length, terminal.length)})`);
say();

for (const a of ["BTC", "ETH"]) {
  const s = terminal.filter((m) => m.asset === a);
  say(`${a} markets: ${String(s.length).padStart(6)}  (${pct(s.length, terminal.length)})   traded: ${s.filter((m) => Number(m.tradeCount) > 0).length}`);
}
say();
const rung = (m: BinaryMarket) => {
  const i = Number(m.intervalSec ?? 0);
  for (const r of [300, 900, 3600]) if (Math.abs(i - r) <= 10) return `${r / 60}m`;
  return "other";
};
for (const r of ["5m", "15m", "60m", "other"]) {
  const s = terminal.filter((m) => rung(m) === r);
  say(`${r.padEnd(6)} markets: ${String(s.length).padStart(6)}  (${pct(s.length, terminal.length)})   traded: ${s.filter((m) => Number(m.tradeCount) > 0).length}`);
}
say();
const tc = stat(traded.map((m) => Number(m.tradeCount)));
const vs = stat(traded.map(vol));
say(`Trade count over TRADED markets:   median ${tc.median}  mean ${tc.mean.toFixed(2)}  p90 ${tc.p90}  max ${tc.max}`);
say(`Volume (collateral) over TRADED:   median ${vs.median.toFixed(4)}  mean ${vs.mean.toFixed(4)}  p90 ${vs.p90.toFixed(4)}  max ${vs.max.toFixed(4)}`);
const tcAll = stat(terminal.map((m) => Number(m.tradeCount)));
say(`Trade count over ALL terminal:     median ${tcAll.median}  mean ${tcAll.mean.toFixed(2)}`);
say();
const exps = terminal.map((m) => Number(m.expiry));
say(`Oldest market expiry:              ${iso(Math.min(...exps))}`);
say(`Newest market expiry:              ${iso(Math.max(...exps))}`);
say(`Span:                              ${((Math.max(...exps) - Math.min(...exps)) / 86400).toFixed(1)} days`);

// ---------- Phase 8: liquidity buckets ----------
say(`\n--- Liquidity distribution (terminal markets) ---`);
const bucketDefs: [string, (c: number) => boolean][] = [
  ["0 trades", (c) => c === 0], ["1 trade", (c) => c === 1], ["2-5", (c) => c >= 2 && c <= 5],
  ["6-20", (c) => c >= 6 && c <= 20], ["21-100", (c) => c >= 21 && c <= 100], ["100+", (c) => c > 100],
];
for (const [label, f] of bucketDefs) {
  const s = terminal.filter((m) => f(Number(m.tradeCount)));
  say(`  ${label.padEnd(10)} ${String(s.length).padStart(6)}  ${pct(s.length, terminal.length).padStart(7)}`);
}

// ---------- Phase 8: staleness ----------
say(`\n--- Staleness: expiry - lastTradeAt (seconds before expiry) ---`);
const withLast = traded.filter((m) => m.lastTradeAt);
const gaps = withLast.map((m) => Number(m.expiry) - Number(m.lastTradeAt));
const g = stat(gaps);
say(`  n=${g.n}  median ${g.median}s  p90 ${g.p90}s  p95 ${g.p95}s  max ${g.max}s`);
const frac = stat(withLast.map((m) => (Number(m.expiry) - Number(m.lastTradeAt)) / (Number(m.expiry) - Number(m.tradingStart))));
say(`  as fraction of the market's own window: median ${(frac.median * 100).toFixed(1)}%  p90 ${(frac.p90 * 100).toFixed(1)}%  p95 ${(frac.p95 * 100).toFixed(1)}%  max ${(frac.max * 100).toFixed(1)}%`);
const within = (s: number) => withLast.filter((m) => Number(m.expiry) - Number(m.lastTradeAt) <= s).length;
for (const s of [60, 300, 900]) say(`  last trade within ${String(s).padStart(4)}s of expiry: ${within(s)}  (${pct(within(s), g.n)})`);
say(`  negative gaps (trade AFTER expiry): ${gaps.filter((x) => x < 0).length}`);

// ---------- Phase 7: calibration ----------
say(`\n--- Calibration sample construction ---`);
let sample = terminal.filter((m) => m.status === "Finalized");
say(`  finalized                        ${sample.length}`);
sample = sample.filter((m) => !m.voided);
say(`  & not voided                     ${sample.length}`);
sample = sample.filter((m) => Number(m.tradeCount) > 0);
say(`  & tradeCount > 0                 ${sample.length}`);
const preRange = sample.length;
sample = sample.filter((m) => { const v = prob(m); return v != null && v > 0 && v < 1; });
say(`  & valid probability in (0,1)     ${sample.length}   (dropped ${preRange - sample.length})`);
const preOutcome = sample.length;
sample = sample.filter((m) => m.winningOutcome === 0 || m.winningOutcome === 1);
say(`  & valid outcome                  ${sample.length}   (dropped ${preOutcome - sample.length})`);

const outOfRange = terminal
  .filter((m) => m.status === "Finalized" && Number(m.tradeCount) > 0)
  .filter((m) => { const v = prob(m); return !(v != null && v > 0 && v < 1); });
say(`  out-of-range price examples:     ${outOfRange.slice(0, 6).map((m) => prob(m)).join(", ")}`);

const y = (m: BinaryMarket) => (m.winningOutcome === 0 ? 1 : 0);
const p = (m: BinaryMarket) => prob(m)!;

say(`\n--- 10% probability buckets (n=${sample.length}) ---`);
say(`  bucket        n     meanPred    actualUp      diff`);
const rows: Record<string, unknown>[] = [];
for (let b = 0; b < 10; b++) {
  const lo = b / 10, hi = (b + 1) / 10;
  const s = sample.filter((m) => { const v = p(m); return b === 9 ? v >= lo && v <= hi : v >= lo && v < hi; });
  const label = `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`;
  if (!s.length) { say(`  ${label.padEnd(9)} ${String(0).padStart(6)}          -           -         -`); rows.push({ bucket: label, n: 0 }); continue; }
  const mp = s.reduce((a, m) => a + p(m), 0) / s.length;
  const au = s.reduce((a, m) => a + y(m), 0) / s.length;
  say(`  ${label.padEnd(9)} ${String(s.length).padStart(6)}   ${(mp * 100).toFixed(2).padStart(8)}%   ${(au * 100).toFixed(2).padStart(8)}%  ${((au - mp) * 100).toFixed(2).padStart(7)}pp`);
  rows.push({ bucket: label, n: s.length, meanPredicted: mp, actualUpRate: au, diff: au - mp });
}

const EPS = 1e-6;
const clamp = (v: number) => Math.min(1 - EPS, Math.max(EPS, v));
const brier = sample.reduce((a, m) => a + (p(m) - y(m)) ** 2, 0) / sample.length;
const logloss = -sample.reduce((a, m) => { const q = clamp(p(m)); return a + (y(m) * Math.log(q) + (1 - y(m)) * Math.log(1 - q)); }, 0) / sample.length;
const base = sample.reduce((a, m) => a + y(m), 0) / sample.length;
const brierBase = sample.reduce((a, m) => a + (base - y(m)) ** 2, 0) / sample.length;
const loglossBase = -(base * Math.log(clamp(base)) + (1 - base) * Math.log(1 - clamp(base)));
const acc = sample.filter((m) => (p(m) >= 0.5 ? 1 : 0) === y(m)).length / sample.length;

say(`\n--- Scores (n=${sample.length}) ---`);
say(`  Base rate (actual Up):           ${(base * 100).toFixed(2)}%`);
say(`  Mean predicted probability:      ${((sample.reduce((a, m) => a + p(m), 0) / sample.length) * 100).toFixed(2)}%`);
say(`  Brier score:                     ${brier.toFixed(5)}   (always-base-rate baseline ${brierBase.toFixed(5)})`);
say(`  Brier skill score vs base rate:  ${(1 - brier / brierBase).toFixed(4)}`);
say(`  Log loss (eps=${EPS}):            ${logloss.toFixed(5)}   (baseline ${loglossBase.toFixed(5)})`);
say(`  Markets hitting the eps clamp:   ${sample.filter((m) => p(m) !== clamp(p(m))).length}`);
say(`  Accuracy @0.5 (secondary):       ${(acc * 100).toFixed(2)}%`);

const upRate = (s: BinaryMarket[]) => {
  const r = s.filter((m) => m.winningOutcome != null);
  return r.length ? r.filter((m) => m.winningOutcome === 0).length / r.length : NaN;
};
say(`\n--- Selection check: Up-rate by subgroup ---`);
say(`  all finalized                    ${(upRate(finalized) * 100).toFixed(2)}%  (n=${finalized.length})`);
const zt = finalized.filter((m) => Number(m.tradeCount) === 0);
const tr = finalized.filter((m) => Number(m.tradeCount) > 0);
say(`  zero-trade finalized             ${(upRate(zt) * 100).toFixed(2)}%  (n=${zt.length})`);
say(`  traded finalized                 ${(upRate(tr) * 100).toFixed(2)}%  (n=${tr.length})`);
say(`  calibration sample               ${(base * 100).toFixed(2)}%  (n=${sample.length})`);

say(`\n--- Is calibration driven by thin books? ---`);
for (const min of [1, 2, 6, 21, 101]) {
  const s = sample.filter((m) => Number(m.tradeCount) >= min);
  if (!s.length) { say(`  tradeCount>=${String(min).padEnd(4)} n=0`); continue; }
  const b = s.reduce((a, m) => a + (p(m) - y(m)) ** 2, 0) / s.length;
  const ll = -s.reduce((a, m) => { const q = clamp(p(m)); return a + (y(m) * Math.log(q) + (1 - y(m)) * Math.log(1 - q)); }, 0) / s.length;
  say(`  tradeCount>=${String(min).padEnd(4)} n=${String(s.length).padStart(5)}  Brier ${b.toFixed(5)}  LogLoss ${ll.toFixed(5)}  upRate ${((s.reduce((a, m) => a + y(m), 0) / s.length) * 100).toFixed(2)}%  acc ${((s.filter((m) => (p(m) >= 0.5 ? 1 : 0) === y(m)).length / s.length) * 100).toFixed(2)}%`);
}

writeFileSync(`out/stats-${ENV}.json`, JSON.stringify({
  generatedAt: new Date().toISOString(), env: ENV,
  counts: { pulled: M.length, finalized: finalized.length, voided: voided.length, terminal: terminal.length, traded: traded.length, zeroTrade: zeroTrade.length },
  calibration: { n: sample.length, brier, brierBase, logloss, loglossBase, accuracy: acc, baseRate: base, buckets: rows },
  staleness: g,
}, null, 2));
writeFileSync(`out/report-${ENV}.txt`, L.join("\n"));
console.log(`\nwrote out/stats-${ENV}.json and out/report-${ENV}.txt`);
