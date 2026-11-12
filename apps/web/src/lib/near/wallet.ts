// NEAR testnet wallet integration via the official NEAR Wallet Selector
// (@near-wallet-selector/core 10.1.4 + intear-wallet 10.1.4, pinned).
//
// Merged into main 2026-11-08 (founder approval) after the Intear connection test:
// testnet account creation confirmed on chain; connect / reload / disconnect /
// reconnect left the account's on-chain keys, permissions and balance unchanged
// (evidence/wallet-spike/INTEAR-REVIEW-AND-CONNECTION-TEST.md). TRANSACTION
// SIGNING IS NOT YET TESTED. MyNearWallet (sunset 2026-10-31) was replaced; Meteor
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
      const [{ setupWalletSelector }, { setupIntearWallet }] = await Promise.all([
        import("@near-wallet-selector/core"),
        import("@near-wallet-selector/intear-wallet"),
      ]);
      return setupWalletSelector({ network: "testnet", modules: [setupIntearWallet()] });
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
  const storage = (): Storage | null => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };
  return {
    readSession: () => storage()?.getItem(INTEAR_STORAGE_KEY) ?? null,
    async clearLocalSession() {
      const st = storage();
      st?.removeItem(INTEAR_STORAGE_KEY);
      for (const k of SELECTOR_SESSION_KEYS) st?.removeItem(k);
      // With the Intear record gone, the module's signOut returns without any network call and the
      // selector marks the wallet signed out in memory.
      if (selector !== null && selector.isSignedIn()) {
        const wallet = await selector.wallet(WALLET_MODULE_ID);
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
      const wallet = await s.wallet<InjectedWallet>(WALLET_MODULE_ID); // intear-wallet 10.1.4 is typed as InjectedWallet
      opened = false;
      const pending = wallet.signIn({});
      // intear-wallet 10.1.4 appends its connector iframe synchronously inside signIn().
      opened = connectorFrames().length > 0;
      const accounts = await pending;
      return accounts[0]?.accountId ?? null;
    },
    async signOut() {
      const s = selector ?? (selector = await getSelector());
      // Always the Intear module (not "the selected wallet"), so a stale Intear record is cleared too.
      const wallet = await s.wallet(WALLET_MODULE_ID);
      await wallet.signOut();
    },
    connectorOpen: () => connectorFrames().length > 0,
    connectorWasOpened: () => opened,
    closeConnector() {
      for (const f of connectorFrames()) f.remove();
    },
  };
}

/**
 * Ask the wallet to sign and send one function call. The caller must treat
 * the result only as "submitted": success of a LineFair action is judged by
 * re-reading contract state (ARCHITECTURE.md §6.4), never by this return value.
 */
export async function signAndSend(signerId: string, call: FunctionCallSpec): Promise<FinalExecutionOutcome | void> {
  // Checked before the wallet library is touched: no valid session, no signing request.
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
