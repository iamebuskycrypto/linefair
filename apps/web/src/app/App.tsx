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
  const [chooseWallet, setChooseWallet] = useState(false);
  if (wallet.accountId !== null && (wallet.status === "connected" || wallet.status === "disconnecting")) {
    return (
      <div className="wallet">
        <span className="small muted">Signed in</span>
        <span className="account" title={wallet.accountId} data-wallet-account={wallet.accountId}>
          {wallet.accountId}
        </span>
        <button className="button quiet" type="button" onClick={wallet.disconnect} disabled={wallet.status === "disconnecting"} aria-busy={wallet.status === "disconnecting"}>
          {wallet.status === "disconnecting" ? "Disconnecting…" : "Disconnect"}
        </button>
      </div>
    );
  }
  const busy = wallet.status === "connecting" || wallet.status === "initializing" || wallet.status === "disconnecting";
  const label =
    wallet.status === "connecting"
      ? "Waiting for wallet…"
      : wallet.status === "initializing"
        ? "Checking wallet…"
        : wallet.status === "unavailable"
          ? "Retry wallet"
          : "Connect testnet wallet";
  return (
    <div className="wallet wallet-picker" data-wallet-status={wallet.status}>
      <button className="button secondary" type="button" onClick={() => setChooseWallet((v) => !v)} disabled={busy} aria-busy={busy} aria-expanded={chooseWallet} aria-controls="wallet-options">
        {chooseWallet ? "Close wallet choices" : label}
      </button>
      {chooseWallet && !busy && (
        <div className="wallet-options" id="wallet-options" role="group" aria-label="Connect a NEAR Testnet wallet">
          <span className="eyebrow">Choose a testnet wallet</span>
          <button type="button" onClick={() => { setChooseWallet(false); wallet.connect("intear-wallet"); }}>
            <strong>Intear</strong><small>Web wallet · tested connection</small>
          </button>
          <button type="button" onClick={() => { setChooseWallet(false); wallet.connect("sender"); }}>
            <strong>Sender</strong><small>Desktop extension · connection beta</small>
          </button>
          <button type="button" onClick={() => { setChooseWallet(false); wallet.connect("nightly"); }}>
            <strong>Nightly</strong><small>Browser extension · connection beta</small>
          </button>
          <p>NEAR Testnet only. Sender and Nightly are connection-only until signing QA passes; use Intear for transaction actions.</p>
        </div>
      )}
    </div>
  );
}

/** Wallet messages (cancellation, failures, account changes) shown under the header, readable on phones. */
function WalletNoticeBar() {
  const { wallet } = useApp();
  const n = wallet.notice;
  if (wallet.status === "connecting") {
    return (
      <div className="notice wallet-notice" role="status" aria-live="polite" data-wallet-notice="connecting">
        <p>Finish connecting in your selected wallet. Closing that window cancels; nothing is signed or sent when you connect.</p>
      </div>
    );
  }
  if (n === null) return null;
  const tone = n.kind === "error" ? " negative" : n.kind === "warning" ? " warning" : "";
  return (
    <div className={`notice wallet-notice${tone}`} role={n.kind === "info" ? "status" : "alert"} aria-live={n.kind === "info" ? "polite" : "assertive"} data-wallet-notice={n.kind}>
      <p>{n.text}</p>
      <button className="button quiet" type="button" onClick={wallet.dismissNotice} aria-label="Dismiss wallet message">
        Dismiss
      </button>
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
            <a href="#/" aria-current={route.name === "list" ? "page" : undefined}>
              Home
            </a>
            <a href="#/agreements/0" aria-current={route.name === "agreement" && route.id === "0" ? "page" : undefined}>
              Live demo
            </a>
            <a href="#/agreements/new" aria-current={route.name === "new" ? "page" : undefined} title="Creating agreements is restricted to approved testnet accounts">
              Draft
            </a>
          </nav>
          <WalletControl />
        </div>
      </header>
      <main id="main">
        <WalletNoticeBar />
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
