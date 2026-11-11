import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Offline DOM-check build: renders real app panels from FIXTURE views in a
// real browser. Built only into a scratch directory (--outDir), never into
// apps/web/dist, never deployed. No network: the RPC fetch always throws.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  preview: { host: "127.0.0.1" },
  build: { target: "es2022", sourcemap: false, emptyOutDir: true },
});
