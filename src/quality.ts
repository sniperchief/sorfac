// Phase 3: market-quality / liquidity variables derived from the real fill tape.
//
// Pure functions only. Phase 2 is locked: nothing here changes T-1m extraction
// semantics or the calibration definitions. The T-1m price is re-derived with
// Phase 2's own `lastAtOrBefore` so the Phase-3 tape can be cross-checked
// against the Phase-2 extraction rather than quietly diverging from it.

import { lastAtOrBefore } from "./providers/fills.js";

/**
 * "Near T-1m" half-width, seconds. Fixed at 60 BEFORE looking at any outcome:
 * it matches the horizon's own granularity (T-1m is itself a 60s offset) and is
 * the shortest window that can hold more than one print on a 5m market. It was
 * not tuned — the alternative width (300s) is reported alongside it in the
 * output so the choice can be inspected.
 */
export const NEAR_SEC = 60;

/** Secondary width, reported for comparison only. */
export const NEAR_SEC_WIDE = 300;

/** One real fill, already scoped to a single market's own trading window. */
export type Fill = {
  t: number;
  price: number;
  maker: string | null;
  taker: string | null;
  /** Quote/collateral value of the fill, already scaled by the market's decimals. */
  quote: number;
};

export type MarketQuality = {
  marketId: string;
  asset: string;
  cadence: string;
  intervalSec: number | null;
  windowSec: number;
  targetTimestamp: number;

  // ---- Leak-free: everything at or before T-1m ----
  /** Trades at or before T-1m. Knowable at forecast time. */
  tradeCountPre: number;
  uniqueMakersPre: number;
  uniqueTakersPre: number;
  uniqueParticipantsPre: number;
  volumePre: number;
  /** Trades in [target - NEAR_SEC, target]. */
  tradesNear: number;
  tradesNearWide: number;
  uniqueParticipantsNear: number;
  /** The T-1m price itself, re-derived from this tape. */
  t1mPrice: number | null;
  t1mAgeSec: number | null;
  /** True when exactly one trade sits in the near window: an isolated print. */
  isolatedPrint: boolean;
  /** Distinct prices printed in the near window. */
  distinctPricesNear: number;
  /** max - min price across the near window. 0 when a single print. */
  priceRangeNear: number;
  /** Largest single maker's share of pre-T-1m fills, 0..1. */
  makerConcentrationPre: number;
  /** Exactly one distinct maker at or before T-1m. */
  singleMakerPre: boolean;

  // ---- Lifetime: uses the whole window, so it includes post-T-1m information ----
  tradeCountTotal: number;
  uniqueMakersTotal: number;
  uniqueTakersTotal: number;
  volumeTotal: number;
  singleMakerTotal: boolean;

  // ---- DIAGNOSTIC ONLY: strictly after T-1m. Never an input to the predictor ----
  diagnostic: {
    tradesPost: number;
    /** |last price after T-1m - T-1m price|. Null when nothing traded after. */
    absMovePost: number | null;
    priceRangePost: number;
  };
};

const uniq = (xs: (string | null)[]) => new Set(xs.filter((x): x is string => x != null)).size;

/**
 * Derive every quality variable for one market from its real fill tape.
 * `tape` must already be scoped to this market's own window.
 */
export function deriveQuality(
  args: { marketId: string; asset: string; cadence: string; intervalSec: number | null; tradingStart: number; expiry: number; targetTimestamp: number; tradeCountTotal: number },
  tape: Fill[],
): MarketQuality {
  const { targetTimestamp: target } = args;
  const pre = tape.filter((f) => f.t <= target);
  const post = tape.filter((f) => f.t > target);
  const near = pre.filter((f) => f.t >= target - NEAR_SEC);
  const nearWide = pre.filter((f) => f.t >= target - NEAR_SEC_WIDE);

  // Re-derive T-1m with Phase 2's own selector, so the two cannot drift.
  const pick = lastAtOrBefore(pre.map((f) => ({ t: f.t, raw: String(f.price) })), target);
  const t1mPrice = pick ? Number(pick.raw) : null;

  const makerCounts = new Map<string, number>();
  for (const f of pre) if (f.maker) makerCounts.set(f.maker, (makerCounts.get(f.maker) ?? 0) + 1);
  const topMaker = Math.max(0, ...makerCounts.values());

  const nearPrices = near.map((f) => f.price);
  const postPrices = post.map((f) => f.price);

  return {
    marketId: args.marketId,
    asset: args.asset,
    cadence: args.cadence,
    intervalSec: args.intervalSec,
    windowSec: args.expiry - args.tradingStart,
    targetTimestamp: target,

    tradeCountPre: pre.length,
    uniqueMakersPre: uniq(pre.map((f) => f.maker)),
    uniqueTakersPre: uniq(pre.map((f) => f.taker)),
    uniqueParticipantsPre: uniq([...pre.map((f) => f.maker), ...pre.map((f) => f.taker)]),
    volumePre: pre.reduce((a, f) => a + f.quote, 0),
    tradesNear: near.length,
    tradesNearWide: nearWide.length,
    uniqueParticipantsNear: uniq([...near.map((f) => f.maker), ...near.map((f) => f.taker)]),
    t1mPrice,
    t1mAgeSec: pick ? target - pick.t : null,
    isolatedPrint: near.length <= 1,
    distinctPricesNear: new Set(nearPrices).size,
    priceRangeNear: nearPrices.length ? Math.max(...nearPrices) - Math.min(...nearPrices) : 0,
    makerConcentrationPre: pre.length ? topMaker / pre.length : 0,
    singleMakerPre: uniq(pre.map((f) => f.maker)) === 1,

    tradeCountTotal: args.tradeCountTotal,
    uniqueMakersTotal: uniq(tape.map((f) => f.maker)),
    uniqueTakersTotal: uniq(tape.map((f) => f.taker)),
    volumeTotal: tape.reduce((a, f) => a + f.quote, 0),
    singleMakerTotal: uniq(tape.map((f) => f.maker)) === 1,

    diagnostic: {
      tradesPost: post.length,
      absMovePost: post.length && t1mPrice != null ? Math.abs(post[post.length - 1].price - t1mPrice) : null,
      priceRangePost: postPrices.length ? Math.max(...postPrices) - Math.min(...postPrices) : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Cohort definitions. Every boundary below was fixed from the Phase-3 brief or
// from Phase-1's already-published liquidity table, BEFORE any calibration was
// computed. None was moved afterwards.
// ---------------------------------------------------------------------------

/** Trade-count cohorts exactly as specified in the Phase-3 brief. */
export const TRADE_COHORTS = ["1", "2-3", "4-5", "6-10", "11+"] as const;
export type TradeCohort = (typeof TRADE_COHORTS)[number];

export function tradeCohort(n: number): TradeCohort | null {
  if (!Number.isFinite(n) || n < 1) return null;
  if (n === 1) return "1";
  if (n <= 3) return "2-3";
  if (n <= 5) return "4-5";
  if (n <= 10) return "6-10";
  return "11+";
}

/** Maker cohorts. `unknown` when the indexer named no maker at all. */
export type MakerCohort = "single-maker" | "multi-maker" | "unknown";

export function makerCohort(uniqueMakers: number): MakerCohort {
  if (!Number.isFinite(uniqueMakers) || uniqueMakers < 1) return "unknown";
  return uniqueMakers === 1 ? "single-maker" : "multi-maker";
}

/**
 * Volume cohorts, in units of collateral. Fixed order-of-magnitude boundaries,
 * chosen before any calibration was computed and never moved. Decade steps are
 * used precisely so the boundaries cannot be accused of being fitted: the
 * observed volume distribution spans roughly 1e-5 to 1.5e3.
 */
export const VOLUME_COHORTS = ["<0.01", "0.01-1", "1-10", "10-100", "100+"] as const;
export function volumeCohort(v: number): string {
  if (!Number.isFinite(v)) return "unknown";
  if (v < 0.01) return "<0.01";
  if (v < 1) return "0.01-1";
  if (v < 10) return "1-10";
  if (v < 100) return "10-100";
  return "100+";
}

/** Cadence rungs, matching the Phase-1 ladder (±10s tolerance). */
export function cadenceCohort(intervalSec: number | null): string {
  if (intervalSec == null) return "unknown";
  for (const r of [300, 900, 3600]) if (Math.abs(intervalSec - r) <= 10) return `${r / 60}m`;
  return "other";
}

/** Age of the T-1m print. Boundaries mirror Phase 1's staleness table (60/300/900). */
export const AGE_COHORTS = ["0-60s", "61-300s", "301-900s", "900s+"] as const;
export function ageCohort(ageSec: number | null): string {
  if (ageSec == null) return "unknown";
  if (ageSec <= 60) return "0-60s";
  if (ageSec <= 300) return "61-300s";
  if (ageSec <= 900) return "301-900s";
  return "900s+";
}

/** Whether the T-1m price stood alone or had company inside the near window. */
export function supportCohort(q: Pick<MarketQuality, "isolatedPrint">): string {
  return q.isolatedPrint ? "isolated-print" : "supported";
}

// ---------------------------------------------------------------------------
// Simple descriptive statistics.
// ---------------------------------------------------------------------------

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Average ranks, so ties do not bias the correlation. */
export function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation. NaN when either series has no variation. */
export function spearman(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 3) return NaN;
  const ra = ranks(a), rb = ranks(b);
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da === 0 || db === 0 ? NaN : num / Math.sqrt(da * db);
}
