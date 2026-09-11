// The T-1m extractor.
//
// For each calibration market, observe the market-implied probability of Up at
// exactly 60 seconds before that market's own expiry, from every configured
// provider. The horizon is relative to each market's expiry, not to wall clock.

import type { BinaryMarket } from "@somnia-chain/markets-sdk";
import type { Observation, ObserveOptions, PriceProvider } from "./providers/types.js";

/** Phase-2 horizon: 60 seconds before expiry. */
export const HORIZON_SEC = 60;

/**
 * Default staleness flag. Descriptive only — it never removes a sample from
 * calibration, because Phase 1's inclusion filters are the source of truth and
 * they contain no staleness rule. 300s matches the middle rung of the Phase-1
 * staleness table so the two reports read on the same scale.
 */
export const DEFAULT_STALE_AFTER_SEC = 300;

/** The instant to observe for a market: its expiry minus the horizon. */
export const targetInstant = (m: BinaryMarket, horizonSec = HORIZON_SEC) => Number(m.expiry) - horizonSec;

/**
 * Whether a market's own trading window is long enough for this horizon. A 15m
 * contract cannot have a T-30m observation; every traded market in the Phase-1
 * dataset is at least 298s long, so all of them admit T-1m.
 */
export const windowAdmits = (m: BinaryMarket, horizonSec = HORIZON_SEC) =>
  Number(m.expiry) - horizonSec >= Number(m.tradingStart);

export type ExtractionRow = {
  marketId: string;
  asset: string;
  interval: string | null;
  intervalSec: number | null;
  tradingStart: number;
  expiry: number;
  targetTimestamp: number;
  tradeCount: number;
  winningOutcome: number | null;
  /** The Phase-1 basis, carried alongside so the comparison needs no second pull. */
  referenceLastPrice: number | null;
  referenceLastTradeAt: number | null;
  windowAdmitsHorizon: boolean;
  observations: Observation[];
};

/** Run every provider against one market at its T-1m instant. */
export async function extractOne(
  m: BinaryMarket,
  providers: PriceProvider[],
  opts: ObserveOptions,
  horizonSec = HORIZON_SEC,
): Promise<ExtractionRow> {
  const target = targetInstant(m, horizonSec);
  const admits = windowAdmits(m, horizonSec);
  const observations = admits
    ? await Promise.all(providers.map((p) => p.observeAt(m, target, opts)))
    : [];

  const lp = m.lastPrice == null ? null : Number(m.lastPrice) / 10 ** m.quoteDecimals;
  return {
    marketId: m.marketId,
    asset: m.asset,
    interval: m.interval ?? null,
    intervalSec: m.intervalSec == null ? null : Number(m.intervalSec),
    tradingStart: Number(m.tradingStart),
    expiry: Number(m.expiry),
    targetTimestamp: target,
    tradeCount: Number(m.tradeCount),
    winningOutcome: m.winningOutcome,
    referenceLastPrice: lp,
    referenceLastTradeAt: m.lastTradeAt == null ? null : Number(m.lastTradeAt),
    windowAdmitsHorizon: admits,
    observations,
  };
}

/** Pick one provider's observation off a row. */
export const observationFrom = (row: ExtractionRow, provider: string): Observation | null =>
  row.observations.find((o) => o.provider === provider) ?? null;

/** Bounded-concurrency map. Keeps the indexer load modest and predictable. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
