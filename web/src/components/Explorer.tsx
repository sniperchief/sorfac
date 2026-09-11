// Market explorer.
//
// Two populations, never mixed:
//   Research dataset — the settled markets the calibration was measured on,
//                      each with a T-1m observation and a realised outcome.
//   Open markets     — what is trading on the indexer right now, through the
//                      project's own SDK layer. No outcomes, by definition.
//
// Filtering and paging are the only computation here. There is no fallback
// population: if a source fails, that tab shows the failure.

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { Async, LiveMarket, MarketRow, ResearchBundle } from "../lib/data";
import { useLiveMarkets, useMarkets } from "../lib/data";
import { EmptyState, ErrorState, Loading } from "./Shell";
import { LiveMarketDetail, ResearchMarketDetail } from "./MarketDetail";
import { DASH, duration, int, pct, shortId, stampIso, stampUnix } from "../lib/format";
import { ALL, BUCKET_OPTIONS, filterMarkets, pageCount, pageOf } from "../lib/filter";

const PAGE_SIZE = 25;
const LIVE_LIMIT = 24;

type Tab = "research" | "live";

function Outcome({ y }: { y: 0 | 1 }) {
  return (
    <span className="outcome" data-y={y}>
      {y === 1 ? "UP" : "DOWN"}
    </span>
  );
}

function ResearchTable({
  rows,
  onOpen,
  openId,
}: {
  rows: MarketRow[];
  onOpen: (m: MarketRow) => void;
  openId: string | null;
}) {
  return (
    <>
      <div className="tbl-scroll tbl-mkt">
        <table className="mkt-table">
          <caption className="sr-only">Settled DreamDEX markets with a T−1m observation. Select a row for detail.</caption>
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Cadence</th>
              <th scope="col">T−1m probability</th>
              <th scope="col">Observation age</th>
              <th scope="col">Outcome</th>
              <th scope="col">Bucket</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr className="row" key={m.id} data-open={openId === m.id ? "true" : undefined}>
                <td>
                  <button className="cell first" type="button" onClick={() => onOpen(m)} aria-label={`Open detail for ${m.asset} ${m.cadence} market ${shortId(m.id)}`}>
                    <strong>{m.asset}</strong>
                    <span className="mkt-id">{shortId(m.id)}</span>
                  </button>
                </td>
                <td>
                  <button className="cell" type="button" tabIndex={-1} onClick={() => onOpen(m)}>
                    {m.cadence}
                  </button>
                </td>
                <td>
                  <button className="cell" type="button" tabIndex={-1} onClick={() => onOpen(m)}>
                    {pct(m.p)}
                  </button>
                </td>
                <td>
                  <button className="cell" type="button" tabIndex={-1} onClick={() => onOpen(m)}>
                    {duration(m.ageSec, DASH)}
                  </button>
                </td>
                <td>
                  <button className="cell" type="button" tabIndex={-1} onClick={() => onOpen(m)}>
                    <Outcome y={m.y} />
                  </button>
                </td>
                <td>
                  <button className="cell" type="button" tabIndex={-1} onClick={() => onOpen(m)}>
                    {m.bucket}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mkt-cards">
        {rows.map((m) => (
          <button className="mkt-card" type="button" key={m.id} onClick={() => onOpen(m)}>
            <div className="mkt-card-top">
              <div>
                <strong>{m.asset}</strong>
                <span className="mkt-id">{shortId(m.id)}</span>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="mkt-card-p">{pct(m.p, 1)}</div>
                <Outcome y={m.y} />
              </div>
            </div>
            <div className="mkt-card-grid">
              <div>
                <span className="k">Cadence</span>
                <span className="v">{m.cadence}</span>
              </div>
              <div>
                <span className="k">Obs. age</span>
                <span className="v">{duration(m.ageSec, DASH)}</span>
              </div>
              <div>
                <span className="k">Bucket</span>
                <span className="v">{m.bucket}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

function LiveTable({ rows, onOpen, openId }: { rows: LiveMarket[]; onOpen: (m: LiveMarket) => void; openId: string | null }) {
  const now = Math.floor(Date.now() / 1000);
  return (
    <>
      <div className="tbl-scroll tbl-mkt">
        <table className="mkt-table">
          <caption className="sr-only">Currently trading DreamDEX markets. Select a row for detail.</caption>
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Cadence</th>
              <th scope="col">Live price → P(Up)</th>
              <th scope="col">Expires in</th>
              <th scope="col">Trades</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr className="row" key={m.id} data-open={openId === m.id ? "true" : undefined}>
                <td>
                  <button className="cell first" type="button" onClick={() => onOpen(m)} aria-label={`Open detail for open market ${m.asset} ${shortId(m.id)}`}>
                    <strong>{m.asset}</strong>
                    <span className="mkt-id">{shortId(m.id)}</span>
                  </button>
                </td>
                <td>
                  <button className="cell" type="button" tabIndex={-1} onClick={() => onOpen(m)}>
                    {m.cadence}
                  </button>
                </td>
                <td>
                  <button className="cell" type="button" tabIndex={-1} onClick={() => onOpen(m)}>
                    {m.impliedProbability == null ? <span style={{ color: "var(--ink-mute)" }}>not traded</span> : pct(m.impliedProbability)}
                  </button>
                </td>
                <td>
                  <button className="cell" type="button" tabIndex={-1} onClick={() => onOpen(m)}>
                    {m.expiry > now ? duration(m.expiry - now) : "expired"}
                  </button>
                </td>
                <td>
                  <button className="cell" type="button" tabIndex={-1} onClick={() => onOpen(m)}>
                    {int(m.tradeCount)}
                  </button>
                </td>
                <td>
                  <button className="cell" type="button" tabIndex={-1} onClick={() => onOpen(m)}>
                    {m.status}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mkt-cards">
        {rows.map((m) => (
          <button className="mkt-card" type="button" key={m.id} onClick={() => onOpen(m)}>
            <div className="mkt-card-top">
              <div>
                <strong>{m.asset}</strong>
                <span className="mkt-id">{shortId(m.id)}</span>
              </div>
              <div className="mkt-card-p">{m.impliedProbability == null ? DASH : pct(m.impliedProbability, 1)}</div>
            </div>
            <div className="mkt-card-grid">
              <div>
                <span className="k">Cadence</span>
                <span className="v">{m.cadence}</span>
              </div>
              <div>
                <span className="k">Expires in</span>
                <span className="v">{m.expiry > now ? duration(m.expiry - now) : "expired"}</span>
              </div>
              <div>
                <span className="k">Trades</span>
                <span className="v">{int(m.tradeCount)}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

export function Explorer({ research }: { research: Async<ResearchBundle> }) {
  const [tab, setTab] = useState<Tab>("research");
  const [visible, setVisible] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);

  // The explorer payload is half a megabyte, so it is not fetched until the
  // section is actually approaching the viewport.
  useEffect(() => {
    if (visible || !anchor.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(anchor.current);
    return () => io.disconnect();
  }, [visible]);

  const markets = useMarkets(visible);
  const live = useLiveMarkets(LIVE_LIMIT);

  const [query, setQuery] = useState("");
  const [cadence, setCadence] = useState(ALL);
  const [bucket, setBucket] = useState(ALL);
  const [page, setPage] = useState(0);
  const [openResearch, setOpenResearch] = useState<MarketRow | null>(null);
  const [openLive, setOpenLive] = useState<LiveMarket | null>(null);

  const deferredQuery = useDeferredValue(query);

  const cadences = useMemo(() => {
    if (research.state !== "ready") return [];
    return research.data.stats.cadences.map((c) => c.cadence);
  }, [research]);

  const filtered = useMemo(
    () => (markets.state === "ready" ? filterMarkets(markets.data.rows, { query: deferredQuery, cadence, bucket }) : []),
    [markets, deferredQuery, cadence, bucket],
  );

  useEffect(() => {
    setPage(0);
  }, [deferredQuery, cadence, bucket, tab]);

  const pages = pageCount(filtered.length, PAGE_SIZE);
  const pageRows = pageOf(filtered, page, PAGE_SIZE);

  const switchTab = (t: Tab) => {
    setTab(t);
    if (t === "live" && !live.armed) live.load();
  };

  return (
    <div ref={anchor}>
      <div className="tabs" role="tablist" aria-label="Market population">
        <button role="tab" type="button" aria-selected={tab === "research"} aria-controls="panel-research" id="tab-research" onClick={() => switchTab("research")}>
          Research dataset
        </button>
        <button role="tab" type="button" aria-selected={tab === "live"} aria-controls="panel-live" id="tab-live" onClick={() => switchTab("live")}>
          Open markets
        </button>
      </div>

      {tab === "research" ? (
        <div role="tabpanel" id="panel-research" aria-labelledby="tab-research">
          <div className="controls">
            <div className="field">
              <label htmlFor="q">Search</label>
              <input id="q" type="search" placeholder="asset or market id" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="cad">Cadence</label>
              <select id="cad" value={cadence} onChange={(e) => setCadence(e.target.value)}>
                <option value={ALL}>All</option>
                {cadences.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="buck">Bucket</label>
              <select id="buck" value={bucket} onChange={(e) => setBucket(e.target.value)}>
                <option value={ALL}>All</option>
                {BUCKET_OPTIONS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <p className="count" aria-live="polite">
              {markets.state === "ready" ? `${int(filtered.length)} of ${int(markets.data.rows.length)} markets` : ""}
            </p>
          </div>

          {markets.state === "loading" ? <Loading label="Loading the research market population" rows={6} /> : null}

          {markets.state === "error" ? (
            <ErrorState
              title="The research market population could not be loaded, so no markets are listed."
              detail={`${markets.error}. Run: npm run web:data`}
            />
          ) : null}

          {markets.state === "ready" && filtered.length === 0 ? (
            <EmptyState
              title="No market in the research dataset matches these filters."
              detail="The dataset contains only settled markets that produced a usable T−1m price."
              action={
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setCadence(ALL);
                    setBucket(ALL);
                  }}
                >
                  Clear filters
                </button>
              }
            />
          ) : null}

          {markets.state === "ready" && filtered.length > 0 ? (
            <>
              <ResearchTable rows={pageRows} onOpen={setOpenResearch} openId={openResearch?.id ?? null} />
              <div className="pager">
                <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                  ← Previous
                </button>
                <button type="button" onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}>
                  Next →
                </button>
                <span className="pos">
                  Page {page + 1} of {int(pages)}
                </span>
                <span className="pos" style={{ marginLeft: "auto" }}>
                  Source: {markets.data.source} · built {stampIso(markets.data.builtAt)}
                </span>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <div role="tabpanel" id="panel-live" aria-labelledby="tab-live">
          <div className="controls">
            <p style={{ fontSize: 13.5, color: "var(--ink-soft)", maxWidth: "68ch" }}>
              Markets trading on Somnia mainnet right now, closing soonest first, read through the same read-only SDK
              the research pipeline uses. These have not settled, so they carry a live price rather than a T−1m
              observation and no outcome.
            </p>
            <p className="count">
              {live.result.state === "ready" ? `${int(live.result.data.count ?? 0)} open · ${live.result.data.latencyMs} ms` : ""}
            </p>
          </div>

          {live.result.state === "loading" ? <Loading label="Loading open markets from the indexer" rows={5} /> : null}

          {live.result.state === "error" ? (
            <ErrorState
              title="Live market data is unavailable. Nothing is shown in its place."
              detail={live.result.error}
              onRetry={live.load}
            />
          ) : null}

          {live.result.state === "ready" && (live.result.data.rows ?? []).length === 0 ? (
            <EmptyState title="The indexer reported no open markets at this moment." detail="Markets roll on a fixed cadence; try again shortly." action={<button className="btn ghost" type="button" onClick={live.load}>Refresh</button>} />
          ) : null}

          {live.result.state === "ready" && (live.result.data.rows ?? []).length > 0 ? (
            <>
              <LiveTable rows={live.result.data.rows ?? []} onOpen={setOpenLive} openId={openLive?.id ?? null} />
              <div className="pager">
                <button type="button" onClick={live.load}>
                  Refresh
                </button>
                <span className="pos">Fetched {stampIso(live.result.data.fetchedAt)}</span>
                <span className="pos" style={{ marginLeft: "auto" }}>
                  {live.result.data.indexerUrl}
                </span>
              </div>
            </>
          ) : null}
        </div>
      )}

      {openResearch ? <ResearchMarketDetail market={openResearch} onClose={() => setOpenResearch(null)} /> : null}
      {openLive ? <LiveMarketDetail market={openLive} onClose={() => setOpenLive(null)} /> : null}
    </div>
  );
}

export const EXPLORER_STAMP = stampUnix;
