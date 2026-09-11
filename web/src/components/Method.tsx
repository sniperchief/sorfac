// How it works: the lifecycle of one measurement, market to anomaly.
//
// The only section written entirely as copy. It describes the pipeline that
// already exists in src/ — it does not describe anything the frontend does.

import type { Async, ResearchBundle } from "../lib/data";
import { UNAVAILABLE, int } from "../lib/format";

const Arrow = () => (
  <svg className="step-arrow" viewBox="0 0 13 13" aria-hidden="true" focusable="false">
    <path d="M2 6.5h8M7 3l3.5 3.5L7 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function Method({ research }: { research: Async<ResearchBundle> }) {
  const s = research.state === "ready" ? research.data.stats : null;

  const steps = [
    {
      name: "Market",
      body: "A DreamDEX Event Contract: one binary question on a fixed 5m, 15m or 1h clock, settled by the Somnia oracle.",
      note: s ? `${int(s.tradedMarkets)} settled markets with trades` : UNAVAILABLE,
    },
    {
      name: "T−1m observation",
      body: `Freeze the information set ${s ? s.horizonSec : 60} seconds before that market's own expiry. The last trade at or before that instant is the only price we may use.`,
      note: s ? `${int(s.t1mUsable)} usable observations` : UNAVAILABLE,
    },
    {
      name: "Probability",
      body: "Normalise the observed price into a probability using the market's own collateral decimals, not a global constant.",
      note: "per-market quoteDecimals",
    },
    {
      name: "Outcome",
      body: "Compare against the actual settled outcome. Up is a winning YES; anything unresolved or voided is excluded rather than guessed.",
      note: "binary, oracle-settled",
    },
    {
      name: "Calibration",
      body: "Measure predicted probability against observed frequency across ten fixed 10% buckets, plus Brier score and log loss.",
      note: s ? `${s.calibrationBuckets} fixed buckets` : UNAVAILABLE,
    },
    {
      name: "Anomaly",
      body: "Identify regions where prediction and reality diverge, then attack each candidate explanation until one survives.",
      note: "one region survived",
    },
  ];

  return (
    <>
      <div className="pipeline">
        {steps.map((s2, i) => (
          <div className="step" key={s2.name}>
            <div className="step-n">STEP {String(i + 1).padStart(2, "0")}</div>
            <h3>{s2.name}</h3>
            <p>{s2.body}</p>
            <p className="mono" style={{ fontSize: 11, color: "var(--ink-mute)", letterSpacing: "0.04em" }}>
              {s2.note}
            </p>
            <Arrow />
          </div>
        ))}
      </div>

      <div className="note" style={{ marginTop: 26, maxWidth: "72ch" }}>
        Why the T−1m boundary matters: a market's own last price is recorded <em>after</em> the fact, and on a
        15-minute contract the final prints often land seconds before settlement, when the answer is nearly known.
        Scoring against that price flatters the venue. Freezing the information set one minute before expiry removes
        the hindsight, which is why the T−1m basis scores worse on Brier and better on calibration than the raw
        last-price basis.
      </div>
    </>
  );
}
