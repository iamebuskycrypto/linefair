import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Static SPA build. No server-side code, no API routes, nothing that signs.
// The shared encoder lives outside this package (packages/shared-schemas).
export default defineConfig({
  base: "./",
  server: {
    host: "127.0.0.1",
    fs: { allow: [fileURLToPath(new URL("../../packages/shared-schemas/ts", import.meta.url)), fileURLToPath(new URL(".", import.meta.url))] },
  },
  preview: { host: "127.0.0.1" },
  build: {
    target: "es2022",
    sourcemap: false,
  },
});
