import { useEffect, useState } from "react";
import { useApp } from "./context.tsx";
import { AgreementsScreen } from "./screens/AgreementsScreen.tsx";
import { DraftScreen } from "./screens/DraftScreen.tsx";
import { AgreementScreen } from "./screens/AgreementScreen.tsx";
import { WalletReturnBanner } from "./WalletReturn.tsx";

type Route = { name: "list" } | { name: "new" } | { name: "agreement"; id: string } | { name: "missing" };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/" || path === "/agreements") return { name: "list" };
  if (path === "/agreements/new") return { name: "new" };
  const m = /^\/agreements\/(0|[1-9][0-9]{0,19})$/.exec(path);
  if (m !== null) return { name: "agreement", id: m[1] };
  return { name: "missing" };
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

function WalletControl() {
  const { wallet } = useApp();
  if (wallet.accountId !== null) {
    return (
      <div className="wallet">
        <span className="small muted">Signed in</span>
        <span className="account" title={wallet.accountId}>
          {wallet.accountId}
        </span>
        <button className="button quiet" type="button" onClick={wallet.disconnect}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <div className="wallet">
      <button
        className="button secondary"
        type="button"
        onClick={wallet.connect}
        disabled={wallet.status === "loading" || wallet.status === "error"}
      >
        {wallet.status === "loading" ? "Opening wallet…" : "Connect testnet wallet"}
      </button>
      {wallet.error !== undefined && (
        <span className="small" role="alert" style={{ color: "var(--negative)" }}>
          {wallet.error}
        </span>
      )}
    </div>
  );
}

export function App() {
  const route = useRoute();
  return (
    <>
      <div className="network-banner" role="note">
        <strong>NEAR testnet</strong> · test tokens only · no real money · nothing on this site is a production service
      </div>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="wordmark" href="#/" aria-label="LineFair home">
            <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" focusable="false">
              <rect width="26" height="26" rx="7" fill="#0f2f25" />
              <rect x="6" y="7.5" width="14" height="2.6" rx="1.3" fill="#34c08d" />
              <rect x="6" y="11.7" width="10" height="2.6" rx="1.3" fill="#dfeee7" />
              <rect x="6" y="15.9" width="12" height="2.6" rx="1.3" fill="#dfeee7" />
            </svg>
            <span aria-hidden="true"><span style={{ color: "var(--ink)" }}>Line</span>Fair</span>
          </a>
          <nav className="nav" aria-label="Main">
            <a href="#/" aria-current={route.name === "list" || route.name === "agreement" ? "page" : undefined}>
              Agreements
            </a>
            <a href="#/agreements/new" aria-current={route.name === "new" ? "page" : undefined}>
              New agreement
            </a>
          </nav>
          <WalletControl />
        </div>
      </header>
      <main id="main">
        <WalletReturnBanner />
        {route.name === "list" && <AgreementsScreen />}
        {route.name === "new" && <DraftScreen />}
        {route.name === "agreement" && <AgreementScreen id={route.id} />}
        {route.name === "missing" && (
          <div className="panel empty">
            <h1>Page not found</h1>
            <p>
              <a href="#/">Back to agreements</a>
            </p>
          </div>
        )}
      </main>
      <footer className="site-footer">
        <span>LineFair · experimental NEAR testnet MVP · not for real funds</span>
        <span>
          Not independently audited · the escrow keeps deployer upgrade authority ·{" "}
          <a href="https://github.com/iamebuskycrypto/linefair#security" target="_blank" rel="noreferrer">Security details</a>
        </span>
      </footer>
    </>
  );
}
