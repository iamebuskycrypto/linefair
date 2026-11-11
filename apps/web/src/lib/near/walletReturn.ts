// Wallet return handling (legacy: written for MyNearWallet; the Intear wallet
// used since 2026-11-08 answers by postMessage and never redirects, so these
// parameters only appear if a wallet redirects back). MyNearWallet (10.1.4) is given the current page as
// `callbackUrl` and comes back to it with `?transactionHashes=<h1,h2>` on
// success or `?errorCode=<code>&errorMessage=<text>` on failure (read from the
// installed module: requestSignTransactionsUrl / handlePopupTransaction).
// In 10.1.4 that callback page normally opens in the wallet popup; a
// full-page return is handled the same way. The parameters are only a
// pointer: the hash is shown with an explorer link and the outcome is taken
// from a fresh contract read, never from the URL. The parameters are then
// removed from the address bar (history.replaceState), keeping the #route.
//
// The pending-action record is a non-secret hint (which agreement/line and
// action was being signed, by whom) kept in localStorage so the page that
// receives the callback knows what to re-read. It never decides an outcome.

export type WalletReturn =
  | { readonly kind: "none" }
  | { readonly kind: "success"; readonly txHashes: readonly string[] }
  | { readonly kind: "error"; readonly errorCode: string; readonly errorMessage: string | null };

// Sign-in parameters (account_id, public_key, all_keys) are left alone: the wallet library may read them.
export const WALLET_RETURN_PARAMS = ["transactionHashes", "errorCode", "errorMessage"] as const;

/** base58 NEAR CryptoHash (43–44 chars typically; accept 32–44). */
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Parse the query part of a URL (`location.search`). Unknown / malformed values are dropped, never shown raw. */
export function parseWalletReturn(search: string): WalletReturn {
  const p = new URLSearchParams(search);
  const hashes = p.get("transactionHashes");
  if (hashes !== null && hashes !== "") {
    const list = hashes.split(",").filter((h) => TX_HASH.test(h));
    if (list.length > 0) return { kind: "success", txHashes: list };
  }
  const code = p.get("errorCode");
  if (code !== null && code !== "") {
    const safeCode = /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : "unrecognised";
    const msg = p.get("errorMessage");
    return { kind: "error", errorCode: safeCode, errorMessage: msg === null || msg === "" ? null : msg.slice(0, 300) };
  }
  return { kind: "none" };
}

/** The same URL without the wallet parameters (other query params and the #route kept). */
export function stripWalletParams(href: string): string {
  const u = new URL(href);
  for (const k of WALLET_RETURN_PARAMS) u.searchParams.delete(k);
  return u.toString();
}

export const WALLET_ERROR_COPY: Record<string, string> = {
  userRejected: "You rejected the request in the wallet. Nothing was signed by this request.",
};

export function walletErrorText(code: string): string {
  return WALLET_ERROR_COPY[code] ?? `The wallet reported an error (${code}). It returned no transaction hash.`;
}

// ---- pending action hint

export type PendingKind = "accept_terms" | "accept_appointment" | "fund" | "submit_delivery" | "accept_line" | "open_dispute" | "advance_case";

export interface PendingAction {
  readonly kind: PendingKind;
  readonly agreementId: string;
  /** null for agreement-level actions (acceptances). */
  readonly lineId: number | null;
  readonly signerId: string;
  /** Only for submit_delivery: the commitment that was sent (public value). */
  readonly evidenceCommitment?: string;
  readonly atMs: number;
}

const KEY = "linefair.pendingAction.v1";
const KINDS: readonly string[] = ["accept_terms", "accept_appointment", "fund", "submit_delivery", "accept_line", "open_dispute", "advance_case"];

interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function store(): KV | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function savePending(p: PendingAction, kv: KV | null = store()): void {
  try {
    kv?.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: the return page then only shows the hash and re-reads what the route names */
  }
}

export function loadPending(kv: KV | null = store()): PendingAction | null {
  let raw: string | null = null;
  try {
    raw = kv?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingAction>;
    if (
      typeof v.kind !== "string" ||
      !KINDS.includes(v.kind) ||
      typeof v.agreementId !== "string" ||
      !/^(0|[1-9][0-9]{0,19})$/.test(v.agreementId) ||
      !(v.lineId === null || (typeof v.lineId === "number" && Number.isInteger(v.lineId) && v.lineId >= 0 && v.lineId <= 2)) ||
      typeof v.signerId !== "string" ||
      typeof v.atMs !== "number"
    ) {
      return null;
    }
    if (v.evidenceCommitment !== undefined && !/^[0-9a-f]{64}$/.test(v.evidenceCommitment)) return null;
    return v as PendingAction;
  } catch {
    return null;
  }
}

export function clearPending(kv: KV | null = store()): void {
  try {
    kv?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
