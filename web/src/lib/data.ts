// The app's three data sources, kept deliberately separate.
//
//   1. research.json  — the committed projection of out/*.json (historical).
//   2. markets.json   — the same research population, per market (lazy).
//   3. /api/live/*    — the DreamDEX indexer through the project's SDK layer.
//
// Nothing here computes a statistic and nothing has a fallback dataset. A fetch
// that fails resolves to an error state the UI renders as such.

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeMarketRows, type EncodedMarkets } from "../../../src/web/wire";
import type { MarketRow, ResearchBundle } from "../../../src/web/bundle";
import type { LiveMarket } from "../../../src/web/server";

export type { MarketRow, ResearchBundle, LiveMarket };

export type Async<T> =
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "error"; error: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  // A static host with a single-page fallback answers an unknown path with the
  // HTML shell rather than a 404, so an absent API arrives here as a page, not
  // as an error. Say that plainly instead of surfacing a JSON parse error.
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) {
    throw new Error(
      url.startsWith("api/")
        ? `${url} returned ${type || "no content type"} instead of JSON — the API server is not running. Start it with: npm run web`
        : `${url} returned ${type || "no content type"} instead of JSON`,
    );
  }
  return (await res.json()) as T;
}

/** Load a JSON document once, on mount. */
function useJson<T>(url: string, enabled = true): Async<T> {
  const [result, setResult] = useState<Async<T>>({ state: "loading" });
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    setResult({ state: "loading" });
    getJson<T>(url, ac.signal)
      .then((data) => setResult({ state: "ready", data }))
      .catch((e) => {
        if (ac.signal.aborted) return;
        setResult({ state: "error", error: message(e) });
      });
    return () => ac.abort();
  }, [url, enabled]);
  return result;
}

export const useResearch = () => useJson<ResearchBundle>("data/research.json");

export type MarketsDoc = { env: string; builtAt: string; source: string; count: number } & EncodedMarkets;

/**
 * The explorer population, fetched only once the explorer is actually wanted.
 * It is half a megabyte, and the page must be readable long before that.
 */
export function useMarkets(enabled: boolean): Async<{ rows: MarketRow[]; source: string; builtAt: string }> {
  const doc = useJson<MarketsDoc>("data/markets.json", enabled);
  const [decoded, setDecoded] = useState<Async<{ rows: MarketRow[]; source: string; builtAt: string }>>({ state: "loading" });

  useEffect(() => {
    if (doc.state === "loading") return setDecoded({ state: "loading" });
    if (doc.state === "error") return setDecoded({ state: "error", error: doc.error });
    setDecoded({
      state: "ready",
      data: { rows: decodeMarketRows<MarketRow>(doc.data), source: doc.data.source, builtAt: doc.data.builtAt },
    });
  }, [doc]);

  return enabled ? decoded : { state: "loading" };
}

// ---------------------------------------------------------------------------
// Live indexer state.
// ---------------------------------------------------------------------------

export type LiveStatus = {
  ok: boolean;
  env: string;
  indexerUrl: string;
  latencyMs: number;
  checkedAt: string;
  reachable: boolean;
  error?: string;
};

export type LiveMarketsDoc = {
  ok: boolean;
  env: string;
  indexerUrl: string;
  fetchedAt: string;
  latencyMs: number;
  count?: number;
  rows?: LiveMarket[];
  error?: string;
};

/** Poll the indexer status. Slow on purpose: this is a heartbeat, not a feed. */
export function useLiveStatus(intervalMs = 60_000): Async<LiveStatus> {
  const [result, setResult] = useState<Async<LiveStatus>>({ state: "loading" });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const data = await getJson<LiveStatus>("api/live/status");
        if (mounted.current) setResult({ state: "ready", data });
      } catch (e) {
        // The static build can be served without the API server; that is a
        // legitimate deployment, and it means live state is simply unknown.
        if (mounted.current) setResult({ state: "error", error: message(e) });
      }
      if (mounted.current) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [intervalMs]);

  return result;
}

/** Fetch open markets on demand. Never called on initial page load. */
export function useLiveMarkets(limit: number) {
  const [result, setResult] = useState<Async<LiveMarketsDoc>>({ state: "loading" });
  const [nonce, setNonce] = useState(0);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const ac = new AbortController();
    setResult({ state: "loading" });
    getJson<LiveMarketsDoc>(`api/live/markets?limit=${limit}`, ac.signal)
      .then((data) => {
        if (data.ok) setResult({ state: "ready", data });
        else setResult({ state: "error", error: data.error ?? "the indexer did not return markets" });
      })
      .catch((e) => {
        if (!ac.signal.aborted) setResult({ state: "error", error: message(e) });
      });
    return () => ac.abort();
  }, [limit, nonce, armed]);

  const load = useCallback(() => {
    setArmed(true);
    setNonce((n) => n + 1);
  }, []);

  return { result, load, armed };
}
