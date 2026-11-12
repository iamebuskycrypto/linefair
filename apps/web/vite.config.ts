import { defineConfig, loadEnv, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { checkBuildEnv, findBundleLeaks, findEnvAccess } from "./src/lib/envGuard.ts";

/**
 * Fails the build if a secret-like VITE_* variable is present, or if any VITE_* variable other
 * than the five public settings (src/lib/envGuard.ts PUBLIC_ENV_KEYS) reaches the emitted code.
 * Errors name variables only, never values.
 */
export function envLeakGuard(): Plugin {
  let env: Record<string, string> = {};
  return {
    name: "linefair-env-leak-guard",
    enforce: "pre",
    transform(code, id) {
      if (id.includes("/node_modules/") || !/\.(?:[cm]?[jt]sx?)$/.test(id.split("?")[0] ?? "")) return null;
      const errors = findEnvAccess(code);
      if (errors.length > 0) this.error(`${id}: ${errors.join("; ")}`);
      return null;
    },
    configResolved(config) {
      env = loadEnv(config.mode, config.envDir || process.cwd(), "VITE_");
      const errors = checkBuildEnv(env);
      if (errors.length > 0) throw new Error(`Refusing to build:\n- ${errors.join("\n- ")}`);
    },
    generateBundle(_options, bundle) {
      const leaks: string[] = [];
      for (const [file, out] of Object.entries(bundle)) {
        const code = out.type === "chunk" ? out.code : typeof out.source === "string" ? out.source : "";
        for (const l of findBundleLeaks(code, env)) leaks.push(`${file}: ${l}`);
      }
      if (leaks.length > 0) this.error(`Environment leak into the public bundle:\n- ${leaks.join("\n- ")}`);
    },
  };
}

// Static SPA build. No server-side code, no API routes, nothing that signs.
// The shared encoder lives outside this package (packages/shared-schemas).
export default defineConfig({
  base: "./",
  plugins: [envLeakGuard()],
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
