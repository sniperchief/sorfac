// Fill-tape provider: the last real trade at or before the target instant.
//
// Phase 1 established this as the trustworthy path. Fills carry the stable
// `market` (bytes32 marketId), so after windowing we can additionally assert
// each row belongs to THIS market — necessary because one pool in the dataset
// has served 694 successive markets.

import { client } from "../config.js";
import { baseObservation, finalize, type Observation, type ObserveOptions, type PriceProvider } from "./types.js";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";

export type Print = { t: number; raw: string };

/** Pure: pick the latest print at or before `target`. Exported for tests. */
export function lastAtOrBefore(prints: Print[], target: number): Print | null {
  let best: Print | null = null;
  for (const p of prints) {
    if (p.t <= target && (best === null || p.t > best.t)) best = p;
  }
  return best;
}

export class FillsProvider implements PriceProvider {
  readonly name = "dreamdex.fills";

  async observeAt(m: BinaryMarket, targetTimestamp: number, opts: ObserveOptions): Promise<Observation> {
    const start = Number(m.tradingStart);
    const expiry = Number(m.expiry);
    const t0 = Date.now();
    let rows;
    try {
      // Scope to this market's own window: the pool is recycled, so an
      // unscoped read would return other markets' lives on the same address.
      rows = await client.getFills(m.poolAddress, { since: start, until: expiry, limit: 1000 });
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

    // Belt and braces on top of the time window.
    const mine = rows.filter((f) => f.market.toLowerCase() === m.marketId.toLowerCase());
    const prints: Print[] = mine
      .filter((f) => f.timestamp != null && f.fillPrice != null)
      .map((f) => ({ t: Number(f.timestamp), raw: String(f.fillPrice) }));

    const pick = lastAtOrBefore(prints, targetTimestamp);
    return finalize(base, pick?.raw ?? null, pick?.t ?? null, expiry - start, opts);
  }
}
