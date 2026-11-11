import { test } from "node:test";
import assert from "node:assert/strict";
import { readWalletOutcome, toPlainDeep } from "./walletOutcome.ts";

const HASH = "Cus2jjk5LwKqLK5PPtnFXhW1wHPDFi1aYG8zQiLjXxPa";
const PAID = Buffer.from('{"withdrawal_id":"1","outcome":"PAID"}').toString("base64");

test("plain FinalExecutionOutcome: hash + SuccessValue", () => {
  assert.deepEqual(readWalletOutcome({ transaction: { hash: HASH }, status: { SuccessValue: PAID } }), { txHash: HASH, failure: null, successValue: PAID });
});

test("Intear shape: top level plain, nested Maps (the live case)", () => {
  const raw = { transaction: new Map([["hash", HASH]]), status: new Map([["SuccessValue", PAID]]) };
  assert.deepEqual(readWalletOutcome(raw), { txHash: HASH, failure: null, successValue: PAID });
});

test("whole outcome as a Map", () => {
  const raw = new Map<string, unknown>([["transaction", new Map([["hash", HASH]])], ["status", new Map([["SuccessValue", ""]])]]);
  assert.deepEqual(readWalletOutcome(raw), { txHash: HASH, failure: null, successValue: "" });
});

test("Failure is reported as JSON, never as success", () => {
  const r = readWalletOutcome({ transaction: { hash: HASH }, status: new Map([["Failure", { ActionError: { index: 0 } }]]) });
  assert.equal(r.successValue, null);
  assert.equal(r.failure, '{"ActionError":{"index":0}}');
});

test("missing or malformed hash -> null, never the string 'undefined'", () => {
  assert.equal(readWalletOutcome({ transaction: new Map(), status: {} }).txHash, null);
  assert.equal(readWalletOutcome({ transaction: { hash: "undefined" } }).txHash, null);
  assert.equal(readWalletOutcome({ transaction: { hash: 123 } }).txHash, null);
});

test("non-object / void outcomes -> all null", () => {
  for (const v of [undefined, null, "x", 1, []]) assert.deepEqual(readWalletOutcome(v), { txHash: null, failure: null, successValue: null });
});

test("SuccessReceiptId (not final value) -> no successValue", () => {
  assert.equal(readWalletOutcome({ transaction: { hash: HASH }, status: { SuccessReceiptId: "abc" } }).successValue, null);
});

test("toPlainDeep bounds depth and drops non-string Map keys", () => {
  let deep: unknown = 1;
  for (let i = 0; i < 40; i++) deep = { x: deep };
  assert.doesNotThrow(() => toPlainDeep(deep));
  assert.deepEqual(toPlainDeep(new Map<unknown, unknown>([[1, "a"], ["k", "b"]])), { k: "b" });
});
