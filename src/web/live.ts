// The live-data layer: read-only reads of the DreamDEX indexer.
//
// Kept free of any HTTP-server concern so it can be driven by whatever is
// hosting it — the Node server in src/web/server.ts, or a serverless function
// under api/. It owns no market logic: `client` is the same key-less exchange
// the research pipeline uses, so these reads cannot do anything the pipeline
// could not.
//
// When the indexer is unreachable these return an error payload carrying the
// reason. They never substitute a placeholder or a synthetic market, because
// the UI's contract is that an unavailable number is shown as unavailable.

import { client, ENV, INDEXER_URL } from "../config.js";
import { cadenceCohort } from "../quality.js";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";

/** Upper bound on a single live query, so one request cannot pull the venue. */
export const MAX_LIVE_LIMIT = 50;
export const DEFAULT_LIVE_LIMIT = 24;

/** Live responses are reused for this long: a demo reloads far faster than markets roll. */
const CACHE_TTL_MS = 10_000;

type Cached<T> = { at: number; value: T };
const cache = new Map<string, Cached<unknown>>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Cached<T> | undefined;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * One open market, reduced to display fields.
 *
 * `impliedProbability` is the market's CURRENT last traded price scaled by its
 * own quoteDecimals. It is NOT a T-1m observation and must never be shown as
 * one: the research basis is the last print at or before `expiry - 60`, which
 * for a market still trading has not happened yet. Null when the market has not
 * traded, rather than a default.
 */
export type LiveMarket = {
  id: string;
  asset: string;
  question: string;
  cadence: string;
  intervalSec: number | null;
  tradingStart: number;
  expiry: number;
  status: string;
  tradeCount: number;
  impliedProbability: number | null;
  lastTradeAt: number | null;
  /** Collateral token address; the indexer does not serve its symbol on this row. */
  collateral: string;
  quoteDecimals: number;
};

export function projectLiveMarket(m: BinaryMarket): LiveMarket {
  const intervalSec = m.intervalSec == null ? null : Number(m.intervalSec);
  const price = m.lastPrice == null ? null : Number(m.lastPrice) / 10 ** m.quoteDecimals;
  return {
    id: m.marketId,
    asset: m.asset,
    question: m.question,
    cadence: m.interval ?? cadenceCohort(intervalSec),
    intervalSec,
    tradingStart: Number(m.tradingStart),
    expiry: Number(m.expiry),
    status: m.status,
    tradeCount: Number(m.tradeCount),
    impliedProbability: price != null && Number.isFinite(price) && price > 0 && price < 1 ? price : null,
    lastTradeAt: m.lastTradeAt == null ? null : Number(m.lastTradeAt),
    collateral: m.collateral,
    quoteDecimals: m.quoteDecimals,
  };
}

/** Clamp a caller-supplied limit into the bounded range. */
export function parseLiveLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_LIVE_LIMIT;
  return Math.min(MAX_LIVE_LIMIT, n);
}

const failure = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export async function liveStatus() {
  const t0 = Date.now();
  try {
    const markets = await cached("live:probe", () => client.listLiveBinaryMarkets({ limit: 1, orderBy: "closingSoon" }));
    return {
      ok: true as const,
      env: ENV,
      indexerUrl: INDEXER_URL,
      latencyMs: Date.now() - t0,
      checkedAt: new Date().toISOString(),
      reachable: true,
      openMarketSeen: markets.length > 0,
    };
  } catch (e) {
    return {
      ok: false as const,
      env: ENV,
      indexerUrl: INDEXER_URL,
      latencyMs: Date.now() - t0,
      checkedAt: new Date().toISOString(),
      reachable: false,
      error: failure(e),
    };
  }
}

export async function liveMarkets(limit: number) {
  const t0 = Date.now();
  try {
    const markets = await cached(`live:markets:${limit}`, () => client.listLiveBinaryMarkets({ limit, orderBy: "closingSoon" }));
    return {
      ok: true as const,
      env: ENV,
      indexerUrl: INDEXER_URL,
      fetchedAt: new Date().toISOString(),
      latencyMs: Date.now() - t0,
      count: markets.length,
      rows: markets.map(projectLiveMarket),
    };
  } catch (e) {
    return {
      ok: false as const,
      env: ENV,
      indexerUrl: INDEXER_URL,
      fetchedAt: new Date().toISOString(),
      latencyMs: Date.now() - t0,
      error: failure(e),
    };
  }
}
