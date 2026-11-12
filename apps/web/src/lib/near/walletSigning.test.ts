// Prevention of unauthorised transaction requests (wallet.ts signAndSend).
// SIMULATED storage only: no wallet library is loaded. signAndSend must refuse
// before touching the wallet library (which needs a browser `window`; if it
// were reached here the error would be a ReferenceError instead).

import { test } from "node:test";
import assert from "node:assert/strict";

import { INTEAR_ORIGIN, INTEAR_STORAGE_KEY } from "./intearGuard.ts";
import { signAndSend } from "./wallet.ts";
import type { FunctionCallSpec } from "./tx.ts";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
});

const CALL: FunctionCallSpec = { receiverId: "escrow2.ebusky-linefair.testnet", methodName: "accept_line", args: {}, gas: 30_000_000_000_000n, deposit: 1n } as unknown as FunctionCallSpec;
const session = (accountId: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ accounts: [{ accountId, active: true }], key: "ed25519:simulated", contractId: "", methodNames: [], logoutKey: "ed25519:1111", walletUrl: INTEAR_ORIGIN, useBridge: false, ...over });

async function refused(re: RegExp) {
  await assert.rejects(signAndSend("uat-buyer.testnet", CALL), (e: unknown) => e instanceof Error && !(e instanceof ReferenceError) && re.test(e.message));
}

test("no stored session -> no signing request", async () => {
  store.clear();
  await refused(/not connected/);
});

test("session for a different account than the signer -> refused (account changed)", async () => {
  store.set(INTEAR_STORAGE_KEY, session("someone-else.testnet"));
  await refused(/account changed; reconnect/);
});

test("session redirected to a foreign wallet URL -> refused", async () => {
  store.set(INTEAR_STORAGE_KEY, session("uat-buyer.testnet", { walletUrl: "https://evil.example" }));
  await refused(/unexpected wallet URL/);
});

test("session holding a function-call key (would sign without confirmation) -> refused", async () => {
  store.set(INTEAR_STORAGE_KEY, session("uat-buyer.testnet", { contractId: "escrow2.ebusky-linefair.testnet", methodNames: ["withdraw"] }));
  await refused(/function-call key/);
});

test("malformed session -> refused", async () => {
  store.set(INTEAR_STORAGE_KEY, "{broken");
  await refused(/unreadable/);
});


test("Sender and Nightly beta wallets refuse transaction signing before loading any wallet library", async () => {
  for (const walletId of ["sender", "nightly"]) {
    store.clear();
    store.set("linefair.wallet-choice.v1", walletId);
    store.set("linefair.alternative-wallet-session.v1", JSON.stringify({ walletId, accountId: "uat-buyer.testnet" }));
    await assert.rejects(
      signAndSend("uat-buyer.testnet", CALL),
      (e: unknown) => e instanceof Error && !(e instanceof ReferenceError) &&
        /Transaction signing for this wallet is not yet approved/.test(e.message),
      walletId,
    );
  }
  store.clear();
});

test("Alternate wallet session rejects incorrect provider and wrong signing account", async () => {
  store.clear();
  store.set("linefair.wallet-choice.v1", "sender");
  store.set("linefair.alternative-wallet-session.v1", JSON.stringify({ walletId: "nightly", accountId: "uat-buyer.testnet" }));
  await assert.rejects(signAndSend("uat-buyer.testnet", CALL), /not verified/);
  store.set("linefair.alternative-wallet-session.v1", JSON.stringify({ walletId: "sender", accountId: "other-account.testnet" }));
  await assert.rejects(signAndSend("uat-buyer.testnet", CALL), /not verified/);
  store.clear();
});
