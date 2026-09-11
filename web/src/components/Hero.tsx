// Hero and the research statistics strip.
//
// The hero has one job: say what the product tests, and show the one number
// that makes it worth testing. Every figure comes from the research bundle.

import type { Async, LiveStatus, ResearchBundle } from "../lib/data";
import { LiveStatusPill } from "./Shell";
import { hrefFor, linkHandler, type Route } from "../lib/router";
import { UNAVAILABLE, int, pct, pp } from "../lib/format";

const ANALYZE: Route = { name: "analyze", price: null };

export function Hero({
  research,
  status,
  onNavigate,
}: {
  research: Async<ResearchBundle>;
  status: Async<LiveStatus>;
  onNavigate?: (r: Route) => void;
}) {
  const h = research.state === "ready" ? research.data.headline : null;

  return (
    <div className="hero" id="top">
      <div className="wrap hero-in">
        <div>
          <p className="eyebrow">DreamDEX × Somnia</p>
          <h1>Can you trust the probability?</h1>
          <p className="hero-sub">
            DreamDEX gives every Event Contract a probability. We test whether those probabilities actually match
            reality.
          </p>
          <div className="hero-cta">
            <a className="btn" href={hrefFor(ANALYZE)} onClick={linkHandler(onNavigate ?? (() => {}), ANALYZE)}>
              Analyse a price
            </a>
            <a className="btn ghost" href="#method">
              How it works
            </a>
          </div>
          <div style={{ marginTop: 26 }}>
            <LiveStatusPill status={status} />
          </div>
        </div>

        <div className="hero-card">
          <p className="eyebrow" style={{ marginBottom: 12 }}>
            Headline result · settled markets
          </p>
          <dl>
            <div className="row">
              <dt>Probability band</dt>
              <dd>{h ? h.bucket : UNAVAILABLE}</dd>
            </div>
            <div className="row">
              <dt>Market said</dt>
              <dd>{h ? pct(h.expected) : UNAVAILABLE}</dd>
            </div>
            <div className="row">
              <dt>Reality was</dt>
              <dd>{h ? pct(h.observed) : UNAVAILABLE}</dd>
            </div>
            <div className="row">
              <dt>Calibration gap</dt>
              <dd className="neg">{h ? pp(h.deviation) : UNAVAILABLE}</dd>
            </div>
            <div className="row">
              <dt>Sample</dt>
              <dd>{h ? `n = ${int(h.n)}` : UNAVAILABLE}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}

export function StatStrip({ research }: { research: Async<ResearchBundle> }) {
  const s = research.state === "ready" ? research.data.stats : null;
  const cadences = s ? s.cadences.map((c) => c.cadence).join(" / ") : UNAVAILABLE;

  const cells: { v: string; k: string; text?: boolean }[] = [
    { v: s ? int(s.tradedMarkets) : UNAVAILABLE, k: "Settled markets with trades", text: !s },
    { v: s ? int(s.t1mUsable) : UNAVAILABLE, k: `T−1m observations (${s ? s.horizonSec : 60}s before expiry)`, text: !s },
    { v: cadences, k: "Cadences covered", text: true },
    { v: s ? String(s.calibrationBuckets) : UNAVAILABLE, k: "Fixed calibration buckets", text: !s },
    { v: s ? s.prospectiveStatus : UNAVAILABLE, k: "Prospective test status", text: true },
  ];

  return (
    <div className="stats">
      <div className="wrap">
        <div className="stats-grid">
          {cells.map((c) => (
            <div className="stat" key={c.k}>
              <div className={c.text ? "stat-v text" : "stat-v"}>{c.v}</div>
              <div className="stat-k">{c.k}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
