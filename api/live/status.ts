// Vercel serverless function: GET /api/live/status
//
// A thin shell over src/web/live.ts, which is the same code the Node server in
// src/web/server.ts runs. Deploying to a serverless host changes where the
// handler runs, not what it does.

import type { IncomingMessage, ServerResponse } from "node:http";
import { liveStatus } from "../../src/web/live.js";

export default async function handler(_req: IncomingMessage, res: ServerResponse) {
  const body = await liveStatus();
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
