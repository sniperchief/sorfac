// Explorer filtering and paging.
//
// Pure and separate from the component so it can be tested directly. It only
// ever removes rows from the population it is given: it cannot introduce one.

import type { MarketRow } from "./data";

export type Filters = { query: string; cadence: string; bucket: string };

export const ALL = "all";

export const EMPTY_FILTERS: Filters = { query: "", cadence: ALL, bucket: ALL };

export const BUCKET_OPTIONS = [
  "0-10%", "10-20%", "20-30%", "30-40%", "40-50%",
  "50-60%", "60-70%", "70-80%", "80-90%", "90-100%",
];

/**
 * Search matches the asset symbol or the market id, case-insensitively. The id
 * is matched as a substring so a judge can paste a full bytes32 or just its
 * tail. Cadence and bucket are exact matches against the values the research
 * data already carries — neither is derived here.
 */
export function filterMarkets(rows: MarketRow[], f: Filters): MarketRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((m) => {
    if (f.cadence !== ALL && m.cadence !== f.cadence) return false;
    if (f.bucket !== ALL && m.bucket !== f.bucket) return false;
    if (!q) return true;
    return m.asset.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
  });
}

export const pageCount = (total: number, size: number) => Math.max(1, Math.ceil(total / size));

export function pageOf<T>(rows: T[], page: number, size: number): T[] {
  const p = Math.max(0, Math.min(page, pageCount(rows.length, size) - 1));
  return rows.slice(p * size, p * size + size);
}
