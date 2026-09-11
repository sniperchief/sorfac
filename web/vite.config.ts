import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The app is a single static page plus two read-only API routes served by
// src/web/server.ts. In dev those routes are proxied to that same server, so
// the live-data path behaves identically in development and production.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2020" },
  server: {
    port: 5174,
    // The shared wire codec and the payload types live in ../src/web, outside
    // the Vite root, so dev has to be allowed to read the repository root.
    fs: { allow: [resolve(__dirname, "..")] },
    proxy: { "/api": { target: `http://localhost:${process.env.PORT ?? 5173}`, changeOrigin: true } },
  },
});
