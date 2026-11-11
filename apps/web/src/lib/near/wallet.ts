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
import { checkIntearSession, installIntearMessageGuard, INTEAR_STORAGE_KEY } from "./intearGuard.ts";

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

export function subscribeAccount(selector: WalletSelector, onChange: (accountId: string | null) => void): () => void {
  const sub = selector.store.observable.subscribe(() => onChange(activeAccountId(selector)));
  return () => sub.unsubscribe();
}

export async function connect(): Promise<string | null> {
  const selector = await getSelector();
  const wallet = await selector.wallet<InjectedWallet>(WALLET_MODULE_ID); // intear-wallet 10.1.4 is typed as InjectedWallet
  const accounts = await wallet.signIn({});
  const session = checkIntearSession(globalThis.localStorage?.getItem(INTEAR_STORAGE_KEY) ?? null);
  if (!session.ok) {
    await wallet.signOut().catch(() => undefined);
    throw new Error(`Wallet connection refused: ${session.reason}`);
  }
  if (accounts[0] !== undefined && accounts[0].accountId !== session.accountId) {
    await wallet.signOut().catch(() => undefined);
    throw new Error("Wallet connection refused: the reported account does not match the stored session.");
  }
  return session.accountId;
}

export async function disconnect(): Promise<void> {
  const selector = await getSelector();
  if (!selector.isSignedIn()) return;
  const wallet = await selector.wallet();
  await wallet.signOut();
}

/**
 * Ask the wallet to sign and send one function call. The caller must treat
 * the result only as "submitted": success of a LineFair action is judged by
 * re-reading contract state (ARCHITECTURE.md §6.4), never by this return value.
 */
export async function signAndSend(signerId: string, call: FunctionCallSpec): Promise<FinalExecutionOutcome | void> {
  const selector = await getSelector();
  const sessionAccount = requireValidSession();
  if (sessionAccount !== signerId) throw new Error("The connected wallet account changed; reconnect before signing.");
  const { actionCreators } = await import("@near-wallet-selector/core");
  const wallet = await selector.wallet();
  return wallet.signAndSendTransaction({
    signerId,
    receiverId: call.receiverId,
    actions: [actionCreators.functionCall(call.methodName, call.args, call.gas, call.deposit)],
  });
}
