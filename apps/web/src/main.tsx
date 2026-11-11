import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { parseConfig } from "./lib/config.ts";
import { AppProvider } from "./app/context.tsx";
import { App } from "./app/App.tsx";
import { StartupGate } from "./app/StartupGate.tsx";

const root = createRoot(document.getElementById("root") as HTMLElement);
const cfg = parseConfig(import.meta.env);

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
