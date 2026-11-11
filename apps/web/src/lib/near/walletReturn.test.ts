import { test } from "node:test";
import assert from "node:assert/strict";

import { clearPending, loadPending, parseWalletReturn, savePending, stripWalletParams, walletErrorText, type PendingAction } from "./walletReturn.ts";

const HASH = "8xNqvK3m5pQ2rT7uW9yZaBcDeFgHiJkLmNoPqRsTuVwX";

test("success: transactionHashes (comma list), malformed hashes dropped", () => {
  assert.deepEqual(parseWalletReturn(`?transactionHashes=${HASH}`), { kind: "success", txHashes: [HASH] });
  assert.deepEqual(parseWalletReturn(`?transactionHashes=${HASH},${HASH}`), { kind: "success", txHashes: [HASH, HASH] });
  assert.deepEqual(parseWalletReturn("?transactionHashes=<script>"), { kind: "none" });
  assert.deepEqual(parseWalletReturn("?transactionHashes=0OIl"), { kind: "none" });
  assert.deepEqual(parseWalletReturn(""), { kind: "none" });
  assert.deepEqual(parseWalletReturn("?foo=bar"), { kind: "none" });
});

test("error: errorCode + errorMessage; unsafe codes neutralised; message length bounded", () => {
  assert.deepEqual(parseWalletReturn("?errorCode=userRejected&errorMessage=User%20rejected%20transaction"), { kind: "error", errorCode: "userRejected", errorMessage: "User rejected transaction" });
  assert.deepEqual(parseWalletReturn("?errorCode=%3Cimg%3E"), { kind: "error", errorCode: "unrecognised", errorMessage: null });
  const long = parseWalletReturn(`?errorCode=x&errorMessage=${"a".repeat(1000)}`);
  assert.ok(long.kind === "error" && long.errorMessage?.length === 300);
  assert.match(walletErrorText("userRejected"), /rejected the request/);
  assert.match(walletErrorText("other"), /returned no transaction hash/);
});

test("stripWalletParams removes only the wallet return params and keeps the #route", () => {
  assert.equal(stripWalletParams(`https://app.example/?transactionHashes=${HASH}#/agreements/3`), "https://app.example/#/agreements/3");
  assert.equal(stripWalletParams("https://app.example/?errorCode=userRejected&errorMessage=x&keep=1#/"), "https://app.example/?keep=1#/");
  assert.equal(stripWalletParams("https://app.example/?account_id=a.testnet#/"), "https://app.example/?account_id=a.testnet#/");
});

test("pending-action hint: round trip, strict validation, clear", () => {
  const m = new Map<string, string>();
  const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  const p: PendingAction = { kind: "fund", agreementId: "3", lineId: 1, signerId: "buyer.testnet", atMs: 1 };
  savePending(p, kv);
  assert.deepEqual(loadPending(kv), p);
  clearPending(kv);
  assert.equal(loadPending(kv), null);
  for (const bad of [
    { ...p, kind: "withdraw" },
    { ...p, agreementId: "01" },
    { ...p, lineId: 3 },
    { ...p, signerId: 5 },
    { ...p, evidenceCommitment: "XYZ" },
  ]) {
    m.set("linefair.pendingAction.v1", JSON.stringify(bad));
    assert.equal(loadPending(kv), null, JSON.stringify(bad));
  }
  m.set("linefair.pendingAction.v1", "{not json");
  assert.equal(loadPending(kv), null);
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.doesNotThrow(() => savePending(p, throwing));
  assert.equal(loadPending(throwing), null);
  assert.doesNotThrow(() => clearPending(throwing));
});
