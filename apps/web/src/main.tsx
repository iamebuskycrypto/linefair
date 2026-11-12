import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { parseConfig } from "./lib/config.ts";
import { AppProvider } from "./app/context.tsx";
import { App } from "./app/App.tsx";
import { StartupGate } from "./app/StartupGate.tsx";

const root = createRoot(document.getElementById("root") as HTMLElement);
// Only the five public settings are read, each by name: Vite then inlines exactly these values.
// Passing the whole env object would bundle EVERY VITE_* variable present at build time
// (on Vercel: commit author, commit message, project and deployment ids). vite.config.ts fails
// the build on any other env access or VITE_* name in the bundle (envLeakGuard).
const cfg = parseConfig({
  VITE_NEAR_NETWORK: import.meta.env.VITE_NEAR_NETWORK,
  VITE_NEAR_RPC_URL: import.meta.env.VITE_NEAR_RPC_URL,
  VITE_NEAR_EXPLORER_URL: import.meta.env.VITE_NEAR_EXPLORER_URL,
  VITE_ESCROW_ID: import.meta.env.VITE_ESCROW_ID,
  VITE_FT_ID: import.meta.env.VITE_FT_ID,
});

if (!cfg.ok) {
  // Refuse to start on a bad or non-testnet configuration (ARCHITECTURE.md §1).
  root.render(
    <main>
      <div className="panel">
        <h1>Configuration refused</h1>
        <p className="lede">LineFair runs on NEAR testnet only. The build configuration was rejected:</p>
        <ul className="reasons">
          {cfg.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
    </main>,
  );
} else {
  root.render(
    <StrictMode>
      {/* Fail closed: with an escrow configured, nothing renders until it matches the expected release build (lib/deployment.ts). */}
      <StartupGate config={cfg.config}>
        {(deployment) => (
          <AppProvider config={cfg.config} deployment={deployment}>
            <App />
          </AppProvider>
        )}
      </StartupGate>
    </StrictMode>,
  );
}
