// Market detail drawer.
//
// Two shapes go through it. A research market has a T-1m observation and a
// settled outcome, so it can show the full provenance chain. A live market is
// still trading: it has a current price and no outcome, and the panel says so
// rather than borrowing the research vocabulary for a number that has not been
// measured the same way.

import { useEffect, useRef } from "react";
import type { LiveMarket, MarketRow } from "../lib/data";
import { DASH, UNAVAILABLE, duration, int, num, pct, shortId, stampUnix } from "../lib/format";

function Row({ k, v, mono = true }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="r">
      <dt>{k}</dt>
      <dd style={mono ? undefined : { fontFamily: "var(--sans)", textAlign: "right" }}>{v}</dd>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="dgroup">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

/** Shared chrome: scrim, escape-to-close, focus handling, scroll lock. */
function Drawer({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      // Keep tabbing inside the drawer while it is open.
      if (e.key !== "Tab" || !panel.current) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" ref={panel}>
        <div className="drawer-head">
          <div>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              {subtitle}
            </p>
            <h3 id="drawer-title">{title}</h3>
          </div>
          <button className="x" type="button" onClick={onClose} ref={closeBtn} aria-label="Close market detail">
            ✕
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </>
  );
}

export function ResearchMarketDetail({ market, onClose }: { market: MarketRow; onClose: () => void }) {
  const m = market;
  const lead = m.expiry != null && m.sourceTimestamp != null ? m.expiry - m.sourceTimestamp : null;

  return (
    <Drawer title={`${m.asset} · ${m.cadence}`} subtitle="Settled market · research dataset" onClose={onClose}>
      <div className="dgroup" style={{ paddingTop: 20 }}>
        <h4>T−1m probability</h4>
        <div className="bigp">{pct(m.p)}</div>
        <p style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 8 }}>
          The market's implied probability of Up, one minute before this contract expired.
        </p>
      </div>

      <Group title="Market">
        <dl className="dl">
          <Row k="Question" v={m.question ?? `${m.asset} closes at or above its opening price`} mono={false} />
          <Row k="Market ID" v={m.id} />
          <Row k="Asset" v={m.asset} />
          <Row k="Cadence" v={`${m.cadence}${m.intervalSec != null ? ` (${m.intervalSec}s)` : ""}`} />
          <Row k="Trading window" v={m.tradingStart != null && m.expiry != null ? duration(m.expiry - m.tradingStart) : UNAVAILABLE} />
        </dl>
      </Group>

      <Group title="Observation">
        <dl className="dl">
          <Row k="Provider" v={m.provider ?? UNAVAILABLE} />
          <Row k="Target timestamp (T−1m)" v={stampUnix(m.targetTimestamp)} />
          <Row k="Source timestamp (last print)" v={stampUnix(m.sourceTimestamp)} />
          <Row k="Observation age" v={duration(m.ageSec)} />
          <Row k="Lead time before expiry" v={duration(lead)} />
          <Row k="Collateral" v={m.quoteSymbol ? `${m.quoteSymbol} · ${m.quoteDecimals} dp` : m.quoteDecimals != null ? `${m.quoteDecimals} dp` : UNAVAILABLE} />
        </dl>
      </Group>

      <Group title="Outcome">
        <dl className="dl">
          <Row k="Settled" v={m.y === 1 ? "UP" : "DOWN"} />
          <Row k="Expiry" v={stampUnix(m.expiry)} />
          <Row k="Calibration bucket" v={m.bucket} />
          <Row k="Sub-band" v={m.subBand ?? "outside the 20–30% band"} />
          <Row k="Squared error (Brier contribution)" v={num((m.p - m.y) ** 2)} />
        </dl>
      </Group>

      <Group title="Order flow before T−1m">
        <dl className="dl">
          <Row k="Trades before T−1m" v={int(m.tradeCountPre)} />
          <Row k="Unique makers before T−1m" v={int(m.uniqueMakersPre)} />
          <Row k="Volume before T−1m" v={num(m.volumePre, 6)} />
          <Row k="Isolated print" v={m.isolatedPrint ? "yes — no company in the near window" : "no"} />
          <Row k="Trades after T−1m (excluded)" v={int(m.tradesPost)} />
          <Row k="Lifetime trades" v={int(m.tradeCountTotal)} />
        </dl>
      </Group>

      <Group title="Evidence">
        <p className="note">
          This probability was selected from information available at T−1m. Trades after the target timestamp are
          excluded. {m.tradesPost > 0 ? `This market had ${m.tradesPost} later trade${m.tradesPost === 1 ? "" : "s"}, and none of them could influence the number above.` : "This market had no later trades."}
        </p>
      </Group>
    </Drawer>
  );
}

export function LiveMarketDetail({ market, onClose }: { market: LiveMarket; onClose: () => void }) {
  const m = market;
  const now = Math.floor(Date.now() / 1000);

  return (
    <Drawer title={`${m.asset} · ${m.cadence}`} subtitle="Open market · live indexer" onClose={onClose}>
      <div className="dgroup" style={{ paddingTop: 20 }}>
        <h4>Current market price</h4>
        <div className="bigp">{m.impliedProbability == null ? DASH : pct(m.impliedProbability)}</div>
        <p style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 8 }}>
          {m.impliedProbability == null
            ? "This market has not traded yet, so it has no implied probability. Nothing is shown in its place."
            : "The last traded price, scaled by this market's own collateral decimals."}
        </p>
      </div>

      <Group title="Market">
        <dl className="dl">
          <Row k="Question" v={m.question} mono={false} />
          <Row k="Market ID" v={m.id} />
          <Row k="Status" v={m.status} />
          <Row k="Cadence" v={`${m.cadence}${m.intervalSec != null ? ` (${m.intervalSec}s)` : ""}`} />
          <Row k="Trading opened" v={stampUnix(m.tradingStart)} />
          <Row k="Expires" v={stampUnix(m.expiry)} />
          <Row k="Time to expiry" v={m.expiry > now ? duration(m.expiry - now) : "expired"} />
          <Row k="Trades so far" v={int(m.tradeCount)} />
          <Row k="Last trade" v={m.lastTradeAt == null ? "no trades yet" : stampUnix(m.lastTradeAt)} />
          <Row k="Collateral" v={`${m.collateral} · ${m.quoteDecimals} dp`} />
        </dl>
      </Group>

      <Group title="Why this is not a calibration result">
        <p className="note">
          This market has not settled, so there is no outcome to score it against, and the price above is a live last
          trade rather than a T−1m observation. Its T−1m instant is {stampUnix(m.expiry - 60)}, which has
          {m.expiry - 60 > now ? " not happened yet" : " passed but is not part of the frozen research dataset"}. It
          will only enter a calibration figure after settlement and a re-run of the pipeline.
        </p>
      </Group>
    </Drawer>
  );
}

export const DETAIL_UNAVAILABLE = UNAVAILABLE;
export const DETAIL_SHORT = shortId;
