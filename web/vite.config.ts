import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// The app is a single static page plus two read-only API routes served by
// src/web/server.ts. In dev those routes are proxied to that same server, so
// the live-data path behaves identically in development and production.
export default defineConfig({
  root: __dirname,
  plugins: [
    react(),
    {
      // A deploy builds from the committed payload, not from out/*.json. If the
      // payload is missing the page would ship and then fail at runtime with an
      // empty study, so refuse to build instead.
      name: "ddx-require-payload",
      buildStart() {
        const missing = ["research.json", "markets.json"]
          .map((f) => resolve(__dirname, "public/data", f))
          .filter((f) => !existsSync(f));
        if (missing.length) {
          this.error(
            [
              "the page payload is missing:",
              ...missing.map((f) => `  ${f}`),
              "",
              "It is normally committed. Regenerate it from the phase outputs with:",
              "  npm run web:data",
            ].join("\n"),
          );
        }
      },
    },
  ],
  build: { outDir: "dist", emptyOutDir: true, target: "es2020" },
  server: {
    port: 5174,
    // The shared wire codec and the payload types live in ../src/web, outside
    // the Vite root, so dev has to be allowed to read the repository root.
    fs: { allow: [resolve(__dirname, "..")] },
    proxy: { "/api": { target: `http://localhost:${process.env.PORT ?? 5173}`, changeOrigin: true } },
  },
});
