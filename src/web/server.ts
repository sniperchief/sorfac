// The web UI's runtime. Serves the built frontend and two read-only endpoints
// that proxy the existing SDK layer.
//
// Deliberately thin: it owns no market logic. `client` is the same read-only,
// key-less exchange the research pipeline uses, so the live endpoints cannot do
// anything the pipeline could not. Historical research is served as static
// files built by src/web/build-data.ts; nothing here recomputes calibration.
//
// When the indexer is unreachable these endpoints return an error payload with
// the reason. They never substitute a cached-looking placeholder or a synthetic
// market, because the UI's contract is that an unavailable number is shown as
// unavailable.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { client, ENV, INDEXER_URL } from "../config.js";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";
import { cadenceCohort } from "../quality.js";

const PORT = Number(process.env.PORT ?? 5173);
const STATIC_ROOT = resolve(process.env.DDX_WEB_ROOT ?? "web/dist");
export const staticRoot = () => STATIC_ROOT;

/** Upper bound on a single live query, so one request cannot pull the venue. */
const MAX_LIVE_LIMIT = 50;
const DEFAULT_LIVE_LIMIT = 24;

/** Live responses are reused for this long: a demo reloads far faster than markets roll. */
const CACHE_TTL_MS = 10_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

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

const send = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
};

const failure = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

async function handleStatus() {
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
    return { ok: false as const, env: ENV, indexerUrl: INDEXER_URL, latencyMs: Date.now() - t0, checkedAt: new Date().toISOString(), reachable: false, error: failure(e) };
  }
}

async function handleLiveMarkets(limit: number) {
  const t0 = Date.now();
  try {
    const markets = await cached(`live:markets:${limit}`, () => client.listLiveBinaryMarkets({ limit, orderBy: "closingSoon" }));
    return { ok: true as const, env: ENV, indexerUrl: INDEXER_URL, fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0, count: markets.length, rows: markets.map(projectLiveMarket) };
  } catch (e) {
    return { ok: false as const, env: ENV, indexerUrl: INDEXER_URL, fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0, error: failure(e) };
  }
}

/** Resolve a URL path inside STATIC_ROOT, refusing anything that escapes it. */
export function resolveStatic(root: string, urlPath: string): string | null {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
  if (rel.split(/[/\\]/).includes("..")) return null;
  const full = resolve(join(root, rel));
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

/** The whole request surface, exported so tests can drive it without a port. */
export const handleRequest = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, { ok: false, error: "method not allowed" });
    return;
  }

  if (url.pathname === "/api/live/status") {
    send(res, 200, await handleStatus());
    return;
  }
  if (url.pathname === "/api/live/markets") {
    const body = await handleLiveMarkets(parseLiveLimit(url.searchParams.get("limit")));
    send(res, body.ok ? 200 : 503, body);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    send(res, 404, { ok: false, error: `no such endpoint: ${url.pathname}` });
    return;
  }

  if (!existsSync(STATIC_ROOT)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end(`The frontend has not been built.\n\nRun:  npm run web:build\nthen: npm run web\n\nExpected static root: ${STATIC_ROOT}\n`);
    return;
  }

  let file = resolveStatic(STATIC_ROOT, url.pathname === "/" ? "/index.html" : url.pathname);
  if (!file) {
    send(res, 400, { ok: false, error: "bad path" });
    return;
  }
  // Single-page app: unknown non-asset paths fall back to the shell.
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_ROOT, "index.html");

  const ext = extname(file).toLowerCase();
  const immutable = file.includes(`${sep}assets${sep}`);
  // The explorer payload is the largest asset by an order of magnitude, so
  // compress anything textual the client will accept compressed.
  const compressible = [".html", ".js", ".css", ".json", ".svg"].includes(ext);
  const gzip = compressible && /(^|,)\s*gzip\s*(,|;|$)/i.test(String(req.headers["accept-encoding"] ?? ""));
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ...(gzip ? { "content-encoding": "gzip", vary: "accept-encoding" } : {}),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  if (gzip) pipeline(stream, createGzip(), res, () => {});
  else stream.pipe(res);
};

export const createApp = () => createServer(handleRequest);

/**
 * Turn a listen failure into an instruction rather than a stack trace.
 *
 * 5173 is a popular default — Vite's own — so "port already in use" is the most
 * likely way a first run fails, and an unhandled 'error' event prints twenty
 * lines of Node internals that say nothing about what to do next.
 */
export function listenFailureMessage(e: NodeJS.ErrnoException, port: number): string {
  if (e.code === "EADDRINUSE") {
    return [
      `\nERROR: port ${port} is already in use, so the UI did not start.`,
      `  Either stop whatever is using it, or pick another port:`,
      `    PORT=5174 npm run web            (bash)`,
      `    $env:PORT=5174; npm run web      (PowerShell)`,
      `  To find the process holding it:`,
      process.platform === "win32"
        ? `    Get-NetTCPConnection -LocalPort ${port} -State Listen`
        : `    lsof -i :${port}`,
      "",
    ].join("\n");
  }
  if (e.code === "EACCES") {
    return `\nERROR: not permitted to listen on port ${port}. Ports below 1024 need elevated privileges; try PORT=5173.\n`;
  }
  return `\nERROR: the UI could not start listening on port ${port}: ${e.message}\n`;
}

/** Only listen when this module is the entry point, so tests can import it. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.on("error", (e: NodeJS.ErrnoException) => {
    console.error(listenFailureMessage(e, PORT));
    process.exit(1);
  });
  app.listen(PORT, () => {
    console.log(`DreamDEX Calibration UI  ->  http://localhost:${PORT}`);
    console.log(`  env:     ${ENV}`);
    console.log(`  indexer: ${INDEXER_URL}`);
    console.log(`  static:  ${STATIC_ROOT}${existsSync(STATIC_ROOT) ? "" : "  (not built yet — run npm run web:build)"}`);
  });
}
