// Minimal price-observation provider layer.
//
// Phase 1 had no provider abstraction — it was a spike with one SDK client and
// ad-hoc scripts. This is the smallest interface that lets the T-1m extractor
// read from more than one REAL historical source and report per-provider
// results. It adds no new data source: both implementations read the same live
// DreamDEX indexer the Phase-1 spike used.

import type { BinaryMarket } from "@somnia-chain/markets-sdk";

/**
 * Why an observation is or is not usable.
 * - `ok`         a real print exists at or before the target instant
 * - `missing`    the source responded, but had no print at or before the target
 * - `stale`      a print exists but is older than `staleAfterSec` (still usable;
 *                the flag is descriptive and never filters calibration)
 * - `malformed`  a print exists but its price is not a probability in (0,1)
 * - `unavailable` the source itself failed (network / indexer error)
 */
export type ObservationStatus = "ok" | "missing" | "stale" | "malformed" | "unavailable";

/** The collateral a binary market is quoted in. Binary rows carry no symbol. */
export type Quote = {
  /** Collateral ERC-20 address, lowercased. Always present. */
  token: string;
  /** Known-address label, or null when we cannot name it without guessing. */
  symbol: string | null;
  /** The market's OWN quoteDecimals. Never assume 18 — mainnet carries both. */
  decimals: number;
};

/** One normalized price observation at one instant, from one provider. */
export type Observation = {
  provider: string;
  marketId: string;
  asset: string;
  quote: Quote;
  /** The instant we asked about (unix seconds). */
  targetTimestamp: number;
  /** Probability of Up in (0,1), scaled by quote.decimals. Null unless ok/stale. */
  price: number | null;
  /** The integer string exactly as the indexer served it, before scaling. */
  rawPrice: string | null;
  /** Unix seconds of the underlying print. Null when there is none. */
  sourceTimestamp: number | null;
  /** Unix milliseconds at which we fetched. */
  retrievalTimestamp: number;
  /** Round-trip time of the source read, milliseconds. */
  latencyMs: number;
  /** targetTimestamp - sourceTimestamp, seconds. Null when there is no print. */
  ageSec: number | null;
  /** ageSec as a fraction of the market's own trading window. */
  ageFraction: number | null;
  status: ObservationStatus;
  ok: boolean;
  error: string | null;
};

export interface PriceProvider {
  readonly name: string;
  /**
   * The last real print at or before `targetTimestamp`, scoped to this market's
   * own trading window. Must never throw: a source failure becomes an
   * `unavailable` observation so one bad read cannot lose a whole run.
   */
  observeAt(market: BinaryMarket, targetTimestamp: number, opts: ObserveOptions): Promise<Observation>;
}

export type ObserveOptions = {
  /** Age beyond which a print is flagged stale. Descriptive only. */
  staleAfterSec: number;
};

/** Mainnet collateral addresses seen in the Phase-1 pull. Unknown => null. */
const KNOWN_COLLATERAL: Record<string, string> = {
  "0x00000022da000002656c64d9ea6011ea952d008a": "USDso",
  "0x70a86d8842fb63c4ad2b7cdddf530ebf1bb25d8e": "tUSDC",
};

export const quoteOf = (m: BinaryMarket): Quote => ({
  token: m.collateral.toLowerCase(),
  symbol: KNOWN_COLLATERAL[m.collateral.toLowerCase()] ?? null,
  decimals: m.quoteDecimals,
});

/** Shared shell so every provider emits the same normalized shape. */
export function baseObservation(
  provider: string,
  m: BinaryMarket,
  targetTimestamp: number,
  retrievalTimestamp: number,
  latencyMs: number,
): Observation {
  return {
    provider,
    marketId: m.marketId,
    asset: m.asset,
    quote: quoteOf(m),
    targetTimestamp,
    price: null,
    rawPrice: null,
    sourceTimestamp: null,
    retrievalTimestamp,
    latencyMs,
    ageSec: null,
    ageFraction: null,
    status: "missing",
    ok: false,
    error: null,
  };
}

/**
 * Turn a raw integer price + its timestamp into a finished observation.
 * Pure, so the missing / stale / malformed paths are unit-testable without a
 * network call. Scaling always uses the market's own decimals.
 */
export function finalize(
  base: Observation,
  raw: string | null | undefined,
  sourceTimestamp: number | null | undefined,
  windowSec: number,
  opts: ObserveOptions,
): Observation {
  if (raw == null || sourceTimestamp == null) {
    return { ...base, status: "missing", ok: false };
  }
  const scaled = Number(raw) / 10 ** base.quote.decimals;
  const ageSec = base.targetTimestamp - sourceTimestamp;
  const ageFraction = windowSec > 0 ? ageSec / windowSec : null;
  const common = { ...base, rawPrice: String(raw), sourceTimestamp, ageSec, ageFraction };

  if (!Number.isFinite(scaled) || scaled <= 0 || scaled >= 1) {
    return { ...common, price: null, status: "malformed", ok: false, error: `price ${raw} scaled to ${scaled}, not a probability in (0,1)` };
  }
  return { ...common, price: scaled, status: ageSec > opts.staleAfterSec ? "stale" : "ok", ok: true };
}
