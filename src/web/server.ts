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
import { ENV, INDEXER_URL } from "../config.js";
import { liveMarkets, liveStatus, parseLiveLimit } from "./live.js";

// Re-exported so the server stays the single import point for its own surface.
export { projectLiveMarket, parseLiveLimit, type LiveMarket } from "./live.js";

const PORT = Number(process.env.PORT ?? 5173);
const STATIC_ROOT = resolve(process.env.DDX_WEB_ROOT ?? "web/dist");
export const staticRoot = () => STATIC_ROOT;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

const send = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
};

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
    send(res, 200, await liveStatus());
    return;
  }
  if (url.pathname === "/api/live/markets") {
    const body = await liveMarkets(parseLiveLimit(url.searchParams.get("limit")));
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
