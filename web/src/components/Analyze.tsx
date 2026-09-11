// The analysis workspace.
//
// A price goes in — typed, dragged, or taken from a contract trading right now
// — and the page runs the study's own analysis over that price's band: the
// headline deviation, the same figure split by cadence, the same figure split
// across chronological periods, what the frozen correction would have said, and
// the actual settled markets underneath it.
//
// Every statistic is read from the research payload, which produced them with
// the project's locked functions and refuses to build unless it reproduces the
// published Phase-5 results. This file selects and renders. It computes nothing.

import { useEffect, useMemo, useState } from "react";
import type { Async, LiveMarket, MarketRow, ResearchBundle } from "../lib/data";
import { useLiveMarkets, useMarkets } from "../lib/data";
import { EmptyState, ErrorState, Loading } from "./Shell";
import { ResearchMarketDetail } from "./MarketDetail";
import { DASH, duration, int, num, pct, pp, shortId, signed, stampIso } from "../lib/format";
import { filterMarkets, pageCount, pageOf, ALL } from "../lib/filter";
import type { Route } from "../lib/router";

type Band = ResearchBundle["bands"][number];
type Dev = Band["byCadence"][number]["dev"];

const LIVE_LIMIT = 12;
const SAMPLE_PAGE = 12;

const bandFor = (bands: Band[], probability: number): Band | null =>
  bands.find((b) => (b.hiPct === 100 ? probability * 100 >= b.loPct : probability * 100 >= b.loPct && probability * 100 < b.hiPct)) ?? null;

const VERDICT: Record<Band["verdict"], { title: string; chip: string; tone: string }> = {
  flagged: { title: "Unreliable range", chip: "Caution", tone: "NOT ROBUST" },
  "in-line": { title: "In line with outcomes", chip: "Trustworthy", tone: "SURVIVES" },
  thin: { title: "Not enough data", chip: "No verdict", tone: "NOT EXPLAINED" },
};

function headline(b: Band): string {
  if (b.verdict === "thin") return `Only ${int(b.n)} settled markets priced in this range. Too few to conclude anything, so nothing is concluded.`;
  if (b.verdict === "in-line") return `Across ${int(b.n)} settled markets, this range paid out about as often as its price implied.`;
  return b.direction === "over"
    ? `Across ${int(b.n)} settled markets, this range paid out considerably less often than its price implied.`
    : `Across ${int(b.n)} settled markets, this range paid out considerably more often than its price implied.`;
}

/** A deviation row, used by both breakdown tables. */
function DevRows({ rows, caption, note }: { rows: { label: string; dev: Dev }[]; caption: string; note?: string }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>{caption}</h3>
        {note ? <p className="panel-note">{note}</p> : null}
      </div>
      <div className="tbl-scroll">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Group</th>
              <th scope="col">n</th>
              <th scope="col">Implied</th>
              <th scope="col">Happened</th>
              <th scope="col">Gap</th>
              <th scope="col">z</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <th scope="row" style={{ textAlign: "left", fontWeight: 500 }}>
                  {r.label}
                  {r.dev.tooSmall && r.dev.n > 0 ? <span style={{ color: "var(--ink-mute)", fontSize: 11 }}> · too small</span> : null}
                </th>
                <td className="n">{int(r.dev.n, DASH)}</td>
                <td className="n">{pct(r.dev.expected, 2, DASH)}</td>
                <td className="n">{pct(r.dev.observed, 2, DASH)}</td>
                <td className={`n ${(r.dev.deviation ?? 0) < 0 ? "neg" : "pos"}`}>{pp(r.dev.deviation, 2, DASH)}</td>
                <td className="n">{signed(r.dev.z, 2, DASH)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Where the chosen price sits on the whole calibration curve. */
function BandStrip({ bands, active }: { bands: Band[]; active: Band | null }) {
  const worst = Math.max(...bands.map((b) => Math.abs(b.deviation ?? 0)), 0.01);
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Every range, for comparison</h3>
        <p className="panel-note">Bar length is the size of the gap. Red bars fall outside their own 95% interval.</p>
      </div>
      <ul className="strip">
        {bands.map((b) => {
          const dev = b.deviation ?? 0;
          const w = (Math.abs(dev) / worst) * 50;
          return (
            <li key={b.bucket} className="strip-row" data-active={active?.bucket === b.bucket ? "true" : undefined}>
              <span className="strip-label">{b.bucket}</span>
              <span className="strip-track">
                <span className="strip-mid" />
                <span
                  className="strip-bar"
                  data-v={b.verdict}
                  style={dev < 0 ? { right: "50%", width: `${w}%` } : { left: "50%", width: `${w}%` }}
                />
              </span>
              <span className={`strip-val ${dev < 0 ? "neg" : "pos"}`}>{b.verdict === "thin" ? DASH : pp(b.deviation, 1, DASH)}</span>
              <span className="strip-n">{b.n === 0 ? DASH : `n=${b.n}`}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function Analyze({ research, route, go }: { research: Async<ResearchBundle>; route: Extract<Route, { name: "analyze" }>; go: (r: Route, replace?: boolean) => void }) {
  const live = useLiveMarkets(LIVE_LIMIT);
  const markets = useMarkets(true);
  const [pricePct, setPricePct] = useState<number | null>(route.price);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [touched, setTouched] = useState(route.price != null);
  const [samplePage, setSamplePage] = useState(0);
  const [open, setOpen] = useState<MarketRow | null>(null);

  useEffect(() => {
    if (!live.armed) live.load();
  }, [live]);

  const bands = research.state === "ready" ? research.data.bands : [];
  const liveRows = live.result.state === "ready" ? (live.result.data.rows ?? []) : [];

  // Open on a contract the venue is actually trading rather than a number of
  // our choosing, unless the URL already carries a price.
  useEffect(() => {
    if (touched || pricePct !== null) return;
    const first = liveRows.find((m) => m.impliedProbability != null);
    if (first?.impliedProbability != null) {
      setPricePct(Math.round(first.impliedProbability * 100));
      setPickedId(first.id);
    }
  }, [liveRows, touched, pricePct]);

  const band = useMemo(() => (pricePct == null || !bands.length ? null : bandFor(bands, pricePct / 100)), [bands, pricePct]);

  // Keep the URL in step so an analysis can be linked to or reloaded.
  useEffect(() => {
    if (pricePct != null && pricePct !== route.price) go({ name: "analyze", price: pricePct }, true);
  }, [pricePct, route.price, go]);

  useEffect(() => {
    setSamplePage(0);
  }, [pricePct]);

  const setPrice = (v: number) => {
    setTouched(true);
    setPickedId(null);
    setPricePct(Math.min(99, Math.max(1, Math.round(v))));
  };

  const sample = useMemo(() => {
    if (markets.state !== "ready" || !band) return [];
    return filterMarkets(markets.data.rows, { query: "", cadence: ALL, bucket: band.bucket });
  }, [markets, band]);

  const correction = research.state === "ready" ? research.data.phase6 : null;
  const now = Math.floor(Date.now() / 1000);

  if (research.state === "loading") return <Loading label="Loading the analysis data" rows={6} />;
  if (research.state === "error") {
    return <ErrorState title="The calibration data could not be loaded, so nothing can be analysed." detail={`${research.error}. Run: npm run web:data`} />;
  }

  return (
    <div className="workspace">
      <aside className="rail" aria-label="Analysis input">
        <div className="rail-block">
          <label className="check-label" htmlFor="price">
            Contract price
          </label>
          <div className="check-input">
            <input
              id="price"
              type="number"
              min={1}
              max={99}
              step={1}
              value={pricePct ?? ""}
              placeholder="25"
              onChange={(e) => (e.target.value === "" ? setPricePct(null) : setPrice(Number(e.target.value)))}
            />
            <span className="check-unit">¢ implies {pricePct == null ? DASH : `${pricePct}%`}</span>
          </div>
          <input
            className="check-slider"
            type="range"
            min={1}
            max={99}
            step={1}
            value={pricePct ?? 25}
            onChange={(e) => setPrice(Number(e.target.value))}
            aria-label="Contract price in cents"
          />
        </div>

        <div className="rail-block">
          <div className="check-live-head">
            <p className="eyebrow">Or pick one trading now</p>
            {live.result.state === "ready" ? (
              <button className="mini" type="button" onClick={live.load}>
                Refresh
              </button>
            ) : null}
          </div>

          {live.result.state === "loading" ? <Loading label="Loading open markets" rows={3} /> : null}
          {live.result.state === "error" ? (
            <ErrorState title="Open markets are unavailable." detail={live.result.error} onRetry={live.load} />
          ) : null}
          {live.result.state === "ready" && liveRows.length === 0 ? (
            <div className="state">
              <p className="k">Nothing open</p>
              <p>The indexer reports no markets trading right now.</p>
            </div>
          ) : null}

          {liveRows.length > 0 ? (
            <ul className="livelist">
              {liveRows.map((m: LiveMarket) => {
                const untraded = m.impliedProbability == null;
                const b = untraded ? null : bandFor(bands, m.impliedProbability!);
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      className="liverow"
                      disabled={untraded}
                      data-active={pickedId === m.id ? "true" : undefined}
                      onClick={() => {
                        setTouched(true);
                        setPricePct(Math.round(m.impliedProbability! * 100));
                        setPickedId(m.id);
                      }}
                      aria-label={untraded ? `${m.asset} ${m.cadence}, not traded yet` : `Analyse ${m.asset} ${m.cadence} at ${pct(m.impliedProbability, 0)}`}
                    >
                      <span className="lm-asset">
                        <strong>{m.asset}</strong>
                        <span className="lm-sub">
                          {m.cadence} · {m.expiry > now ? `${duration(m.expiry - now)} left` : "expiring"}
                        </span>
                      </span>
                      <span className="lm-p">{untraded ? <span className="lm-none">no trades</span> : pct(m.impliedProbability, 0)}</span>
                      <span className="lm-dot" data-v={b?.verdict ?? "none"} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <p className="check-note" style={{ marginTop: 12, marginBottom: 0 }}>
            Live last-traded prices, not the T−1m observations the study measured. None of these contracts has
            settled.
          </p>
        </div>
      </aside>

      <div className="results">
        {pricePct == null || !band ? (
          <div className="state">
            <p className="k">Nothing to analyse</p>
            <p>Enter a contract price, or pick one trading right now.</p>
          </div>
        ) : (
          <>
            <section className="panel result-head" data-v={band.verdict}>
              <div className="verdict-head">
                <div>
                  <p className="eyebrow" style={{ marginBottom: 6 }}>
                    {pricePct}¢ · band {band.bucket} · {int(band.n)} settled markets
                  </p>
                  <h2 className="h2" style={{ fontSize: 30 }}>
                    {VERDICT[band.verdict].title}
                  </h2>
                </div>
                <span className="chip" data-v={VERDICT[band.verdict].tone}>
                  {VERDICT[band.verdict].chip}
                </span>
              </div>

              <div className="verdict-nums">
                <div>
                  <span className="k">Price implies</span>
                  <span className="v">{pct(band.predicted)}</span>
                </div>
                <div>
                  <span className="k">Actually happened</span>
                  <span className="v">{pct(band.observed)}</span>
                </div>
                <div>
                  <span className="k">Gap</span>
                  <span className={`v ${(band.deviation ?? 0) < 0 ? "neg" : "pos"}`}>{pp(band.deviation)}</span>
                </div>
              </div>

              <p className="verdict-say">{headline(band)}</p>

              <dl className="dl" style={{ marginTop: 14 }}>
                <div className="r">
                  <dt>z-score against the implied rate</dt>
                  <dd>{signed(band.z, 2, DASH)}</dd>
                </div>
                <div className="r">
                  <dt>Observed 95% interval (Wilson)</dt>
                  <dd>
                    {pct(band.ci95[0], 2, DASH)} – {pct(band.ci95[1], 2, DASH)}
                  </dd>
                </div>
                <div className="r">
                  <dt>Implied rate inside that interval</dt>
                  <dd>{band.verdict === "thin" ? DASH : band.verdict === "flagged" ? "No — outside" : "Yes"}</dd>
                </div>
              </dl>
            </section>

            <BandStrip bands={bands} active={band} />

            <DevRows
              caption="Does it hold across cadences?"
              note="The same band measured inside each contract clock. A gap that only exists at one cadence is a composition artefact, not a venue property."
              rows={band.byCadence.map((c) => ({ label: c.cadence, dev: c.dev }))}
            />

            <DevRows
              caption="Does it hold over time?"
              note="Four equal-count chronological windows, with boundaries fixed before any result was inspected."
              rows={band.byPeriod.map((p) => ({ label: `${p.period} · ${p.startIso.slice(0, 10)} → ${p.endIso.slice(0, 10)}`, dev: p.dev }))}
            />

            {correction ? (
              <section className="panel">
                <div className="panel-head">
                  <h3>What the proposed correction would say</h3>
                  <p className="panel-note">
                    The project proposed one correction, for the {correction.bucket} range on {correction.cadence}{" "}
                    contracts only.
                  </p>
                </div>
                {band.isAnomaly ? (
                  <>
                    <dl className="dl">
                      <div className="r">
                        <dt>Raw price implies</dt>
                        <dd>{pricePct}%</dd>
                      </div>
                      <div className="r">
                        <dt>Correction, frozen before testing</dt>
                        <dd className="neg">{pp(-correction.correction)}</dd>
                      </div>
                      <div className="r">
                        <dt>Corrected probability, if it holds</dt>
                        <dd>{pct(Math.max(0, pricePct / 100 - correction.correction))}</dd>
                      </div>
                    </dl>
                    <div className="notvalid light" role="note">
                      <strong>Not validated</strong>
                      <p>
                        This number is shown so you can see what is being tested, not because it is trustworthy. The
                        forward test has {int(correction.qualifying)} qualifying markets of the{" "}
                        {int(correction.targetSample)} it needs, so the verdict is gate {correction.gate}: insufficient
                        evidence. Do not act on the corrected figure.
                      </p>
                    </div>
                  </>
                ) : (
                  <p style={{ fontSize: 14, color: "var(--ink-soft)" }}>
                    No correction applies to this range. The only one proposed covers {correction.bucket} on{" "}
                    {correction.cadence} contracts, and it is not validated either.
                  </p>
                )}
              </section>
            ) : null}

            <section className="panel">
              <div className="panel-head">
                <h3>The markets behind this verdict</h3>
                <p className="panel-note">
                  Every settled contract whose T−1m probability fell in {band.bucket}. Open one to see the timestamps
                  that prove no later trade touched its price.
                </p>
              </div>

              {markets.state === "loading" ? <Loading label="Loading the settled market sample" rows={4} /> : null}
              {markets.state === "error" ? (
                <ErrorState title="The settled market sample could not be loaded." detail={`${markets.error}. Run: npm run web:data`} />
              ) : null}
              {markets.state === "ready" && sample.length === 0 ? (
                <EmptyState title={`No settled market priced in ${band.bucket}.`} />
              ) : null}

              {markets.state === "ready" && sample.length > 0 ? (
                <>
                  <div className="tbl-scroll">
                    <table className="data">
                      <thead>
                        <tr>
                          <th scope="col">Market</th>
                          <th scope="col">Cadence</th>
                          <th scope="col">T−1m</th>
                          <th scope="col">Age</th>
                          <th scope="col">Outcome</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageOf(sample, samplePage, SAMPLE_PAGE).map((m) => (
                          <tr key={m.id}>
                            <th scope="row" style={{ textAlign: "left", fontWeight: 400 }}>
                              <button className="linkish" type="button" onClick={() => setOpen(m)}>
                                {m.asset} <span className="mkt-id">{shortId(m.id)}</span>
                              </button>
                            </th>
                            <td className="n">{m.cadence}</td>
                            <td className="n">{pct(m.p)}</td>
                            <td className="n">{duration(m.ageSec, DASH)}</td>
                            <td className="n">
                              <span className="outcome" data-y={m.y}>
                                {m.y === 1 ? "UP" : "DOWN"}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="pager">
                    <button type="button" onClick={() => setSamplePage((p) => Math.max(0, p - 1))} disabled={samplePage === 0}>
                      ← Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => setSamplePage((p) => Math.min(pageCount(sample.length, SAMPLE_PAGE) - 1, p + 1))}
                      disabled={samplePage >= pageCount(sample.length, SAMPLE_PAGE) - 1}
                    >
                      Next →
                    </button>
                    <span className="pos">
                      {int(sample.length)} markets · page {samplePage + 1} of {int(pageCount(sample.length, SAMPLE_PAGE))}
                    </span>
                  </div>
                </>
              ) : null}
            </section>

            <p className="workspace-foot">
              Band statistics computed by the study's own functions over {int(research.data.stats.t1mUsable)} settled
              markets, each measured {research.data.stats.horizonSec} seconds before its own expiry. Brier{" "}
              {num(research.data.calibration.brier)} and log loss {num(research.data.calibration.logloss)} across the
              whole population. Payload built {stampIso(research.data.builtAt)}.
            </p>
          </>
        )}
      </div>

      {open ? <ResearchMarketDetail market={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
