// 60-second candle provider: the close of the last bucket ending at or before
// the target instant.
//
// Phase 1 flagged the hazard: candles are a POOL-level rollup with no marketId
// field, and on the busiest recycled pool the smallest gap between one market's
// expiry and the next market's trading start is 300s. A 900s or 3600s bucket can
// therefore straddle two different markets. 60s cannot, given that 300s gap, so
// this provider is pinned to 60s and additionally clamps its range to the
// market's own window. It exists to cross-check the fill tape, not to replace it.

import { client } from "../config.js";
import { baseObservation, finalize, type Observation, type ObserveOptions, type PriceProvider } from "./types.js";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";

export const BUCKET_SEC = 60;

export type Bucket = { bucketStart: number; closePrice: string };

/**
 * Pure: the close of the last bucket that has fully CLOSED at or before
 * `target`. A bucket starting at s covers [s, s+BUCKET_SEC), so it is only
 * usable once s + BUCKET_SEC <= target. Exported for tests.
 */
export function lastClosedBucket(buckets: Bucket[], target: number, bucketSec = BUCKET_SEC): Bucket | null {
  let best: Bucket | null = null;
  for (const b of buckets) {
    if (b.bucketStart + bucketSec <= target && (best === null || b.bucketStart > best.bucketStart)) best = b;
  }
  return best;
}

export class CandlesProvider implements PriceProvider {
  readonly name = "dreamdex.candles60";

  async observeAt(m: BinaryMarket, targetTimestamp: number, opts: ObserveOptions): Promise<Observation> {
    const start = Number(m.tradingStart);
    const expiry = Number(m.expiry);
    const t0 = Date.now();
    let rows;
    try {
      rows = await client.getCandles(m.poolAddress, BUCKET_SEC, { from: start, to: expiry, limit: 500 });
    } catch (e) {
      const latencyMs = Date.now() - t0;
      return {
        ...baseObservation(this.name, m, targetTimestamp, Date.now(), latencyMs),
        status: "unavailable",
        ok: false,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      };
    }
    const latencyMs = Date.now() - t0;
    const base = baseObservation(this.name, m, targetTimestamp, Date.now(), latencyMs);

    const buckets: Bucket[] = rows
      .filter((c) => c.bucketStart != null && c.closePrice != null)
      .map((c) => ({ bucketStart: Number(c.bucketStart), closePrice: String(c.closePrice) }))
      .filter((b) => b.bucketStart >= start && b.bucketStart < expiry);

    const pick = lastClosedBucket(buckets, targetTimestamp);
    // A bucket's close is stamped at its END, which is what we compare against.
    return finalize(base, pick?.closePrice ?? null, pick === null ? null : pick.bucketStart + BUCKET_SEC, expiry - start, opts);
  }
}
