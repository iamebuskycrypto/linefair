// Hardening for @near-wallet-selector/intear-wallet 10.1.4 (branch
// wallet/intear-spike). The module's window "message" listeners check neither
// event.origin nor event.source and correlate nothing, and it stores the
// `walletUrl` from the sign-in "connected" message unauthenticated; later
// transaction / sign-message popups open at that stored URL. A forged message
// could therefore redirect every later "wallet" popup or fake results.
//
// M1 (installIntearMessageGuard): a capture-phase window listener, installed
// before the module adds its own (non-capture) listeners, drops any message
// carrying one of the module's types unless event.origin is exactly the Intear
// wallet origin (set by the browser; not forgeable by a page).
// M2 (checkIntearSession): fail-closed validation of the stored session after
// sign-in and before every signing request.
// Neither changes contracts or transaction builders. COOP/CSP headers are
// defence in depth only, not the fix.

export const INTEAR_ORIGIN = "https://wallet.intear.tech";
export const INTEAR_STORAGE_KEY = "_intear_wallet_connected_account";
const INTEAR_MESSAGE_TYPES: ReadonlySet<string> = new Set(["ready", "connected", "error", "close", "sent", "signed"]);
const TESTNET_ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)+testnet$/;

export function shouldBlockMessage(origin: string, data: unknown): boolean {
  if (data === null || typeof data !== "object") return false;
  const type = (data as { type?: unknown }).type;
  return typeof type === "string" && INTEAR_MESSAGE_TYPES.has(type) && origin !== INTEAR_ORIGIN;
}

/** Installs M1 on `target` (the window in the app). Returns a remover. */
export function installIntearMessageGuard(target: Pick<EventTarget, "addEventListener" | "removeEventListener">): () => void {
  const gate = (e: Event) => {
    const m = e as MessageEvent;
    if (shouldBlockMessage(m.origin, m.data)) {
      e.stopImmediatePropagation();
      e.stopPropagation();
    }
  };
  target.addEventListener("message", gate, { capture: true });
  return () => target.removeEventListener("message", gate, { capture: true });
}

export type SessionCheck = { readonly ok: true; readonly accountId: string } | { readonly ok: false; readonly reason: string };

/** M2: the stored Intear session must be exactly what LineFair expects. */
export function checkIntearSession(raw: string | null): SessionCheck {
  const no = (reason: string): SessionCheck => ({ ok: false, reason });
  if (raw === null) return no("Intear wallet is not connected.");
  let s: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return no("Intear session is unreadable.");
    s = parsed as Record<string, unknown>;
  } catch {
    return no("Intear session is unreadable.");
  }
  const accounts = s.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return no("Intear session has no account.");
  if (s.walletUrl !== undefined && s.walletUrl !== null) {
    if (typeof s.walletUrl !== "string") return no("Intear session has an unexpected wallet URL.");
    let origin: string;
    try {
      const u = new URL(s.walletUrl);
      origin = u.username === "" && u.password === "" ? u.origin : "invalid";
    } catch {
      origin = "invalid";
    }
    if (origin !== INTEAR_ORIGIN || s.walletUrl.replace(/\/+$/, "") !== INTEAR_ORIGIN) return no(`Intear session has an unexpected wallet URL (expected ${INTEAR_ORIGIN}).`);
  }
  if ((s.contractId ?? "") !== "" || (Array.isArray(s.methodNames) && s.methodNames.length > 0)) {
    return no("Intear session holds a function-call key for a contract; LineFair requires every transaction to be confirmed in the wallet.");
  }
  if (s.useBridge === true) return no("Intear bridge mode is not supported by LineFair.");
  const first = accounts[0] as { accountId?: unknown } | null;
  const accountId = first?.accountId;
  if (typeof accountId !== "string" || accountId.length > 64 || !TESTNET_ACCOUNT_RE.test(accountId)) {
    return no("Intear session account is not a valid NEAR testnet account.");
  }
  return { ok: true, accountId };
}
