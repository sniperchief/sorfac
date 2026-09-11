import { client } from "./config.js";

const t = async (label: string, fn: () => Promise<unknown[]>) => {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`${label.padEnd(52)} -> ${String(r.length).padStart(5)} rows  ${Date.now() - t0}ms`);
    return r;
  } catch (e) {
    console.log(`${label.padEnd(52)} -> ERROR ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    return [];
  }
};

// How large a page will the indexer actually serve?
for (const limit of [50, 100, 500, 1000, 2000, 5000]) {
  await t(`listPastBinaryMarkets limit=${limit}`, () =>
    client.listPastBinaryMarkets({ status: "Finalized", limit }),
  );
}

// How deep does offset paging go?
for (const offset of [0, 1000, 5000, 10000, 20000]) {
  await t(`listPastBinaryMarkets limit=200 offset=${offset}`, () =>
    client.listPastBinaryMarkets({ status: "Finalized", limit: 200, offset }),
  );
}

// Are non-Finalized past statuses present (i.e. is Finalized the whole tail)?
for (const status of ["Finalized", "Resolved", "Voided", "Locked", "Settling", "Trading", "Listed"] as const) {
  await t(`listPastBinaryMarkets status=${status} limit=5`, () =>
    client.listPastBinaryMarkets({ status, limit: 5 }),
  );
}
await t(`listPastBinaryMarkets (no status) limit=5`, () => client.listPastBinaryMarkets({ limit: 5 }));
