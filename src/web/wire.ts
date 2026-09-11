// The columnar wire format for the market-explorer payload.
//
// Kept in its own dependency-free module because both sides use it: the build
// script encodes with it, and the browser decodes with it. It carries no
// research logic — it is purely a way of not repeating twenty field names
// 2,437 times. `decodeMarketRows(encodeMarketRows(x))` must equal `x`.

export const MARKET_FIELDS = [
  "id", "asset", "cadence", "intervalSec", "p", "y", "bucket", "subBand",
  "targetTimestamp", "sourceTimestamp", "ageSec", "provider", "quoteSymbol",
  "quoteDecimals", "expiry", "tradingStart", "tradeCountPre", "tradeCountTotal",
  "uniqueMakersPre", "volumePre", "isolatedPrint", "tradesPost", "question",
] as const;

export type MarketField = (typeof MARKET_FIELDS)[number];

export type EncodedMarkets = { fields: readonly string[]; rows: unknown[][] };

export function encodeMarketRows<T extends Record<MarketField, unknown>>(rows: T[]): EncodedMarkets {
  return { fields: MARKET_FIELDS, rows: rows.map((r) => MARKET_FIELDS.map((f) => r[f])) };
}

export function decodeMarketRows<T>(enc: EncodedMarkets): T[] {
  return enc.rows.map((values) => {
    const row: Record<string, unknown> = {};
    enc.fields.forEach((f, i) => (row[f] = values[i]));
    return row as T;
  });
}
