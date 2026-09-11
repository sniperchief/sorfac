import { client, ENV, INDEXER_URL } from "./config.js";

const log = (...a: unknown[]) => console.log(...a);
const attempts: { method: string; ok: boolean; note: string }[] = [];

async function probe<T>(method: string, fn: () => Promise<T>, describe: (v: T) => string) {
  try {
    const v = await fn();
    attempts.push({ method, ok: true, note: describe(v) });
    log(`  OK   ${method}: ${describe(v)}`);
    return v;
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    attempts.push({ method, ok: false, note: msg });
    log(`  FAIL ${method}: ${msg}`);
    return undefined;
  }
}

log(`env=${ENV} indexer=${INDEXER_URL}\n`);

await probe("listBinaryAssets()", () => client.listBinaryAssets(), (v) => JSON.stringify(v));
await probe("listBinaryVenueIds()", () => client.listBinaryVenueIds(), (v) => JSON.stringify(v));
await probe(
  'listBinaryMarkets({status:"Finalized",limit:3})',
  () => client.listBinaryMarkets({ status: "Finalized", limit: 3 }),
  (v) => `${v.length} rows; first=${v[0]?.marketId ?? "-"} qDec=${v[0]?.quoteDecimals}`,
);
await probe(
  'listBinaryMarkets({status:"Resolved",limit:3})  [docs say this is the WRONG status]',
  () => client.listBinaryMarkets({ status: "Resolved", limit: 3 }),
  (v) => `${v.length} rows`,
);
await probe(
  'countBinaryMarketsBounded({phase:"past"})',
  () => client.countBinaryMarketsBounded({ phase: "past" }),
  (v) => JSON.stringify(v),
);
await probe(
  'countBinaryMarketsBounded({phase:"past",status:"Finalized"})',
  () => client.countBinaryMarketsBounded({ phase: "past", status: "Finalized" }),
  (v) => JSON.stringify(v),
);
await probe(
  'countBinaryMarketsBounded({phase:"live"})',
  () => client.countBinaryMarketsBounded({ phase: "live" }),
  (v) => JSON.stringify(v),
);
await probe(
  "loadMarkets() [docs: skips finalized binaries]",
  () => client.listRegistryMarkets(),
  (v) => `${v.length} registry markets, ${v.filter((m) => m.marketType === "BINARY").length} binary`,
);

console.log("\n" + JSON.stringify(attempts, null, 2));
