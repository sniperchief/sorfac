// Header, live-status pill, and the small shared state components.

import type { ReactNode } from "react";
import type { Async, LiveStatus } from "../lib/data";
import { hrefFor, linkHandler, SECTIONS, type Route } from "../lib/router";
import { UNAVAILABLE, stampIso } from "../lib/format";

/**
 * Section links, as home routes rather than bare hashes.
 *
 * A bare `#finding` does nothing from the workspace, where that section is not
 * mounted. Routing home with a section navigates first and scrolls after.
 */
const NAV: { section: (typeof SECTIONS)[number]; label: string }[] = [
  { section: "finding", label: "The finding" },
  { section: "tested", label: "What we tested" },
  { section: "method", label: "How it works" },
  { section: "markets", label: "Markets" },
  { section: "experiment", label: "Experiment" },
];

/**
 * The live indicator. It reports what is actually known: reachable, not
 * reachable, or not yet checked. It never displays "MAINNET DATA" on the
 * strength of hope — the label only claims mainnet once the indexer answered.
 */
export function LiveStatusPill({ status }: { status: Async<LiveStatus> }) {
  if (status.state === "loading") {
    return (
      <span className="status" data-state="loading" title="Checking the Somnia mainnet indexer">
        <span className="dot" aria-hidden="true" />
        Checking indexer
      </span>
    );
  }
  if (status.state === "error" || !status.data.reachable) {
    const detail = status.state === "error" ? status.error : (status.data.error ?? "indexer unreachable");
    return (
      <span className="status" data-state="down" title={`Live indexer unavailable — ${detail}`}>
        <span className="dot" aria-hidden="true" />
        Live data unavailable
      </span>
    );
  }
  const d = status.data;
  return (
    <span className="status" data-state="ok" title={`${d.indexerUrl} — ${d.latencyMs} ms at ${stampIso(d.checkedAt)}`}>
      <span className="dot" aria-hidden="true" />
      {d.env} data · {d.latencyMs} ms
    </span>
  );
}

const HOME: Route = { name: "home" };
const ANALYZE: Route = { name: "analyze", price: null };

export function Header({ status, onNavigate }: { status: Async<LiveStatus>; onNavigate?: (r: Route) => void }) {
  const go = onNavigate ?? (() => {});
  return (
    <header className="topbar">
      <div className="wrap topbar-in">
        <a className="wordmark" href={hrefFor(HOME)} onClick={linkHandler(go, HOME)}>
          <span className="tick" aria-hidden="true" />
          DreamDEX Calibration
        </a>
        <nav className="topnav" aria-label="Sections">
          {NAV.map((n) => {
            const to: Route = { name: "home", section: n.section };
            return (
              <a key={n.section} href={hrefFor(to)} onClick={linkHandler(go, to)}>
                {n.label}
              </a>
            );
          })}
          <a className="topnav-cta" href={hrefFor(ANALYZE)} onClick={linkHandler(go, ANALYZE)}>
            Analyse a price
          </a>
        </nav>
        <LiveStatusPill status={status} />
      </div>
    </header>
  );
}

export function Section({
  id,
  eyebrow,
  title,
  lede,
  children,
  inverted,
}: {
  id: string;
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  children: ReactNode;
  inverted?: boolean;
}) {
  return (
    <section id={id} className={`section${inverted ? " inverted" : ""}`} aria-labelledby={`${id}-h`}>
      <div className="wrap">
        <div className="section-head">
          <p className="eyebrow">{eyebrow}</p>
          <h2 id={`${id}-h`} className="h2">
            {title}
          </h2>
          {lede ? <p className="lede">{lede}</p> : null}
        </div>
        {children}
      </div>
    </section>
  );
}

export function Loading({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" style={{ display: "grid", gap: 8 }}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel" aria-hidden="true" />
      ))}
    </div>
  );
}

export function ErrorState({ title, detail, onRetry }: { title: string; detail: string; onRetry?: () => void }) {
  return (
    <div className="state err" role="alert">
      <p className="k">{UNAVAILABLE}</p>
      <p>{title}</p>
      <code>{detail}</code>
      {onRetry ? (
        <button className="btn ghost" type="button" onClick={onRetry} style={{ marginTop: 6 }}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="state">
      <p className="k">No results</p>
      <p>{title}</p>
      {detail ? <p style={{ fontSize: 13.5 }}>{detail}</p> : null}
      {action}
    </div>
  );
}
