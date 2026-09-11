// Vercel serverless function: GET /api/live/markets?limit=n
//
// See api/live/status.ts — the handler is shared with the Node server, so the
// two deployments cannot drift.

import type { IncomingMessage, ServerResponse } from "node:http";
import { liveMarkets, parseLiveLimit } from "../../src/web/live.js";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const body = await liveMarkets(parseLiveLimit(url.searchParams.get("limit")));
  res.writeHead(body.ok ? 200 : 503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
