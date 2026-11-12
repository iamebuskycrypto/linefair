// NEAR testnet wallet integration via the official NEAR Wallet Selector
// (@near-wallet-selector/core 10.1.4 + intear-wallet 10.1.4, pinned).
//
// Merged into main 2026-11-08 (founder approval) after the Intear connection test:
// testnet account creation confirmed on chain; connect / reload / disconnect /
// reconnect left the account's on-chain keys, permissions and balance unchanged
// (evidence/wallet-spike/INTEAR-REVIEW-AND-CONNECTION-TEST.md). TRANSACTION
// SIGNING IS NOT YET TESTED. MyNearWallet (sunset 2026-10-31) was replaced; Sender
// is the documented fallback (docs/33). Known: intear-wallet 10.1.4 generates a session key
// in the browser and stores it in localStorage; it signs locally only when the
// receiver equals a contractId the wallet confirmed with functionCallKeyAdded.
// LineFair signs in without a contractId, so every transaction goes to the wallet.
//
// STATUS: integration code written, NOT exercised against a contract. No
// LineFair contract is deployed and no transaction has been signed through
// this module. It must not be described as working until real wallet
// signatures against a deployed escrow succeed (ARCHITECTURE.md §12).
//
// API used (read from the installed type definitions, not assumed):
// - setupWalletSelector({ network: "testnet", modules }) -> WalletSelector
// - selector.wallet(id) -> Wallet; wallet.signIn({}) ; wallet.signOut()
// - wallet.signAndSendTransaction({ signerId, receiverId, actions }) -> FinalExecutionOutcome | void
// - actionCreators.functionCall(methodName, args, gas: bigint, deposit: bigint)
// - selector.store.getState().accounts / .observable
//
// Security choices:
// - No `createAccessKeyFor` and no `contractId` on sign-in, so no function-call
//   access key for the escrow is requested; transactions must be confirmed in the
//   wallet (verify: no new on-chain key after connect).
// - Network is fixed to "testnet" (sent to the wallet at sign-in); Intear's web
//   wallet is https://wallet.intear.tech.

import type { WalletSelector, FinalExecutionOutcome, InjectedWallet } from "@near-wallet-selector/core";
import type { FunctionCallSpec } from "./tx.ts";
import { checkIntearSession, installIntearMessageGuard, INTEAR_ORIGIN, INTEAR_STORAGE_KEY } from "./intearGuard.ts";
import type { WalletPort } from "./walletController.ts";

export const WALLET_MODULE_ID = "intear-wallet";
export const SUPPORTED_WALLETS = [
  { id: "intear-wallet", label: "Intear", note: "Web wallet · tested" },
  { id: "sender", label: "Sender", note: "Desktop extension · testnet" },
  { id: "nightly", label: "Nightly", note: "Browser extension · testnet" },
] as const;
export type SupportedWalletId = (typeof SUPPORTED_WALLETS)[number]["id"];
const CHOICE_KEY = "linefair.wallet-choice.v1";
const ALTERNATIVE_SESSION_KEY = "linefair.alternative-wallet-session.v1";
const TESTNET_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)+testnet$/;
function isSupportedWalletId(id: string): id is SupportedWalletId {
  return SUPPORTED_WALLETS.some((w) => w.id === id);
}
function chosenWallet(): SupportedWalletId {
  let saved: string | null = null;
  try { saved = localStorage.getItem(CHOICE_KEY); } catch { /* no persistent choice */ }
  return saved !== null && isSupportedWalletId(saved) ? saved : WALLET_MODULE_ID;
}
function validateAlternativeSession(raw: string | null, walletId: SupportedWalletId): { ok: true; accountId: string } | { ok: false; reason: string } {
  if (walletId === WALLET_MODULE_ID) return checkIntearSession(raw);
  if (raw === null) return { ok: false, reason: "The selected wallet is not connected." };
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return { ok: false, reason: "Wallet session unreadable." };
    const record = value as Record<string, unknown>;
    const accountId = record.accountId;
    if (record.walletId !== walletId || typeof accountId !== "string" || accountId.length > 64 || !TESTNET_ACCOUNT.test(accountId)) {
      return { ok: false, reason: "Wallet account or network does not match the selected testnet wallet." };
    }
    return { ok: true, accountId };
  } catch {
    return { ok: false, reason: "Wallet session unreadable." };
  }
}

let selectorPromise: Promise<WalletSelector> | null = null;
let guardInstalled = false;

/** M2 (intearGuard.ts): the stored Intear session must be the expected one; throws otherwise. */
function requireValidSession(): string {
  const r = checkIntearSession(globalThis.localStorage?.getItem(INTEAR_STORAGE_KEY) ?? null);
  if (!r.ok) throw new Error(r.reason);
  return r.accountId;
}

/** Lazily loads the wallet libraries (they need a Buffer global in the browser). */
export function getSelector(): Promise<WalletSelector> {
  if (selectorPromise === null) {
    selectorPromise = (async () => {
      // M1 (intearGuard.ts): installed before the wallet module adds its listeners.
      if (!guardInstalled) {
        installIntearMessageGuard(window);
        guardInstalled = true;
      }
      const { Buffer } = await import("buffer");
      const g = globalThis as { Buffer?: unknown };
      if (g.Buffer === undefined) g.Buffer = Buffer; // kept: harmless polyfill for the wallet libraries
      const [{ setupWalletSelector }, { setupIntearWallet }, { setupSender }, { setupNightly }] = await Promise.all([
        import("@near-wallet-selector/core"),
        import("@near-wallet-selector/intear-wallet"),
        import("@near-wallet-selector/sender"),
        import("@near-wallet-selector/nightly"),
      ]);
      return setupWalletSelector({ network: "testnet", modules: [setupIntearWallet(), setupSender(), setupNightly()] });
    })();
    selectorPromise.catch(() => {
      selectorPromise = null;
    });
  }
  return selectorPromise;
}

export function activeAccountId(selector: WalletSelector): string | null {
  const accounts = selector.store.getState().accounts;
  return accounts.find((a) => a.active)?.accountId ?? accounts[0]?.accountId ?? null;
}

/** Wallet-selector 10.1.4 storage keys (JsonStorage namespace "near-wallet-selector", ":" delimiter). */
export const SELECTOR_SESSION_KEYS = [
  "near-wallet-selector:selectedWalletId",
  "near-wallet-selector:selectedWalletId:pending",
  "near-wallet-selector:contract",
  "near-wallet-selector:contract:pending",
] as const;

/** The Intear connector overlay added by intear-wallet 10.1.4 signIn(). */
function connectorFrames(): HTMLIFrameElement[] {
  return [...document.querySelectorAll("iframe")].filter((f) => f.src.startsWith(`${INTEAR_ORIGIN}/wallet-connector-iframe.html`));
}

/** Real WalletPort over the wallet selector (walletController.ts). */
export function createWalletPort(): WalletPort {
  let selector: WalletSelector | null = null;
  let opened = false;
  let walletId: SupportedWalletId = chosenWallet();
  const storage = (): Storage | null => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };
  return {
    readSession: () => storage()?.getItem(walletId === WALLET_MODULE_ID ? INTEAR_STORAGE_KEY : ALTERNATIVE_SESSION_KEY) ?? null,
    isIntearWallet: () => walletId === WALLET_MODULE_ID,
    validateSession: () => validateAlternativeSession(storage()?.getItem(walletId === WALLET_MODULE_ID ? INTEAR_STORAGE_KEY : ALTERNATIVE_SESSION_KEY) ?? null, walletId),
    selectWallet(id) {
      if (!isSupportedWalletId(id)) throw new Error("Unsupported wallet option.");
      walletId = id;
      storage()?.setItem(CHOICE_KEY, id);
      if (id !== WALLET_MODULE_ID) storage()?.removeItem(ALTERNATIVE_SESSION_KEY);
    },
    async clearLocalSession() {
      const st = storage();
      st?.removeItem(INTEAR_STORAGE_KEY);
      st?.removeItem(ALTERNATIVE_SESSION_KEY);
      for (const k of SELECTOR_SESSION_KEYS) st?.removeItem(k);
      // Clear the current selector wallet without assuming that every provider is Intear.
      if (selector !== null && selector.isSignedIn()) {
        const wallet = await selector.wallet(walletId);
        await wallet.signOut();
      }
    },
    async init() {
      selector = await getSelector();
    },
    storeAccount: () => (selector === null ? null : activeAccountId(selector)),
    subscribe(onChange) {
      if (selector === null) return () => undefined;
      const sub = selector.store.observable.subscribe(() => onChange());
      return () => sub.unsubscribe();
    },
    async signIn() {
      const s = selector ?? (selector = await getSelector());
      const wallet = await s.wallet<InjectedWallet>(walletId);
      opened = false;
      const pending = wallet.signIn({});
      // Intear appends an iframe synchronously; extension wallets have their own UI.
      opened = walletId === WALLET_MODULE_ID && connectorFrames().length > 0;
      const accounts = await pending;
      const accountId = accounts[0]?.accountId ?? null;
      if (walletId !== WALLET_MODULE_ID && accountId !== null) {
        if (!TESTNET_ACCOUNT.test(accountId)) throw new Error("Only NEAR Testnet accounts are supported.");
        storage()?.setItem(ALTERNATIVE_SESSION_KEY, JSON.stringify({ walletId, accountId }));
      }
      return accountId;
    },
    async signOut() {
      const s = selector ?? (selector = await getSelector());
      const wallet = await s.wallet(walletId);
      await wallet.signOut();
    },
    connectorOpen: () => walletId === WALLET_MODULE_ID ? connectorFrames().length > 0 : true,
    connectorWasOpened: () => opened,
    closeConnector() {
      if (walletId === WALLET_MODULE_ID) for (const f of connectorFrames()) f.remove();
    },
  };
}

/**
 * Ask the wallet to sign and send one function call. The caller must treat
 * the result only as "submitted": success of a LineFair action is judged by
 * re-reading contract state (ARCHITECTURE.md §6.4), never by this return value.
 */
export async function signAndSend(signerId: string, call: FunctionCallSpec): Promise<FinalExecutionOutcome | void> {
  // Fail closed for the new connectors until their real-wallet signing and account-key behaviour has been audited.
  // Intear's original sign guard and signing pathway are unchanged.
  const walletId = chosenWallet();
  if (walletId !== WALLET_MODULE_ID) {
    const checked = validateAlternativeSession(localStorage.getItem(ALTERNATIVE_SESSION_KEY), walletId);
    if (!checked.ok || checked.accountId !== signerId) throw new Error("The selected testnet wallet account is not verified; reconnect before signing.");
    throw new Error("Transaction signing for this wallet is not yet approved. Use the Intear wallet for testnet transaction actions.");
  }
  const sessionAccount = requireValidSession();
  if (sessionAccount !== signerId) throw new Error("The connected wallet account changed; reconnect before signing.");
  const selector = await getSelector();
  const { actionCreators } = await import("@near-wallet-selector/core");
  const wallet = await selector.wallet();
  return wallet.signAndSendTransaction({
    signerId,
    receiverId: call.receiverId,
    actions: [actionCreators.functionCall(call.methodName, call.args, call.gas, call.deposit)],
  });
}
