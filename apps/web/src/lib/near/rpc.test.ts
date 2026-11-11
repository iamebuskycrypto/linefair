// RPC client unit tests with an injected test double for fetch. No network
// access; the responses are hand-written in the documented JSON-RPC shape and
// prove only request encoding and response decoding, not chain behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";

import { NearRpc, RpcError, type FetchFn } from "./rpc.ts";

function fakeFetch(respond: (body: Record<string, unknown>) => unknown, status = 200): { fn: FetchFn; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const fn: FetchFn = async (_url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push(body);
    const payload = respond(body);
    return { ok: status === 200, status, text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)) };
  };
  return { fn, calls };
}

const bytes = (s: string) => [...new TextEncoder().encode(s)];

test("view encodes args as base64 JSON and decodes the byte result", async () => {
  const { fn, calls } = fakeFetch(() => ({
    jsonrpc: "2.0",
    id: "x",
    result: { result: bytes('{"network_id":"testnet","agreements_created":"3","max_agreements":25}'), logs: [], block_height: 123, block_hash: "H" },
  }));
  const rpc = new NearRpc("https://rpc.testnet.near.org", fn);
  const r = await rpc.view<{ agreements_created: string }>("escrow.testnet", "get_agreement", { agreement_id: "7" });
  assert.equal(r.value.agreements_created, "3");
  assert.equal(r.blockHeight, 123n);
  const p = calls[0].params as Record<string, string>;
  assert.equal(calls[0].method, "query");
  assert.equal(p.request_type, "call_function");
  assert.equal(p.finality, "final");
  assert.equal(p.method_name, "get_agreement");
  assert.equal(Buffer.from(p.args_base64, "base64").toString("utf8"), '{"agreement_id":"7"}');
});

test("unsafe integers in a view result are refused, not rounded", async () => {
  const { fn } = fakeFetch(() => ({ result: { result: bytes('{"locked":340282366920938463463374607431768211455}'), block_height: 1, block_hash: "H" } }));
  await assert.rejects(new NearRpc("https://x.testnet", fn).view("e.testnet", "m"), (e: unknown) => e instanceof RpcError && e.kind === "decode");
});

test("contract panic in a view surfaces as kind contract with the code text", async () => {
  const { fn } = fakeFetch(() => ({ result: { error: "wasm execution failed with error: ... ERR_TERMS_PARSE:Json", logs: [], block_height: 1, block_hash: "H" } }));
  await assert.rejects(
    new NearRpc("https://x.testnet", fn).computeTermsHash("e.testnet", {}),
    (e: unknown) => e instanceof RpcError && e.kind === "contract" && /ERR_TERMS_PARSE:Json/.test(e.message),
  );
});

test("RPC error object, HTTP error and malformed JSON are distinct failures", async () => {
  const rpcErr = fakeFetch(() => ({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }));
  await assert.rejects(new NearRpc("https://x.testnet", rpcErr.fn).view("e.testnet", "m"), (e: unknown) => e instanceof RpcError && e.kind === "rpc");
  const http = fakeFetch(() => "", 503);
  await assert.rejects(new NearRpc("https://x.testnet", http.fn).view("e.testnet", "m"), (e: unknown) => e instanceof RpcError && e.kind === "transport");
  const bad = fakeFetch(() => '{"result": {"a":1,"a":2}}');
  await assert.rejects(new NearRpc("https://x.testnet", bad.fn).view("e.testnet", "m"), (e: unknown) => e instanceof RpcError && e.kind === "decode");
});

test("finalBlock reads height and ns timestamp as BigInt", async () => {
  const { fn, calls } = fakeFetch(() => ({ result: { header: { height: 200000000, timestamp_nanosec: "1800000000000000123", hash: "B" } } }));
  const b = await new NearRpc("https://x.testnet", fn).finalBlock();
  assert.equal(b.timestampNs, 1_800_000_000_000_000_123n);
  assert.equal(b.height, 200_000_000n);
  assert.equal(calls[0].method, "block");
});

test("finalBlock accepts a real nearcore header whose u64 `timestamp` is an unsafe JSON number", async () => {
  // Shape seen from near-sandbox 2.13.4 (evidence/frontend/sandbox-lf009-demo-*-FAILED-1): the header
  // carries `timestamp` as a bare JSON number above 2^53 next to the string `timestamp_nanosec`.
  const text = '{"jsonrpc":"2.0","id":"lf-1","result":{"author":"test.near","header":{"height":120,"timestamp":1793852157909109000,"timestamp_nanosec":"1793852157909109000","hash":"H"},"chunks":[]}}';
  const fn: FetchFn = async () => ({ ok: true, status: 200, text: async () => text });
  const b = await new NearRpc("http://127.0.0.1:0", fn).finalBlock();
  assert.equal(b.timestampNs, 1_793_852_157_909_109_000n);
  assert.equal(b.height, 120n);
});

test("contract view payloads stay strict: an unsafe number inside the view result is still a decode error", async () => {
  const bytes = [...new TextEncoder().encode('{"x":9007199254740993}')];
  const fn: FetchFn = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: "x", result: { result: bytes, logs: [], block_height: 1, block_hash: "h" } }) });
  await assert.rejects(new NearRpc("http://127.0.0.1:0", fn).view("e", "m"), /unsafe integer/);
});

test("status chain_id and view_account code_hash: request shape and strict decoding", async () => {
  const ok = fakeFetch((b) =>
    b.method === "status"
      ? { jsonrpc: "2.0", id: "x", result: { chain_id: "testnet", sync_info: { latest_block_height: 1, latest_block_time: "t" } } }
      : { jsonrpc: "2.0", id: "x", result: { amount: "6000000000000000000000000", code_hash: "2pS3pvSsJDoZAiDPMQ3jNK5PnDZDk2qcBDhCzXLNQuU5", storage_usage: 1, block_height: 9, block_hash: "H" } },
  );
  const rpc = new NearRpc("https://rpc.testnet.near.org", ok.fn);
  assert.equal(await rpc.chainId(), "testnet");
  const a = await rpc.viewAccount("escrow.testnet");
  assert.equal(a.value.code_hash, "2pS3pvSsJDoZAiDPMQ3jNK5PnDZDk2qcBDhCzXLNQuU5");
  assert.equal(a.blockHeight, 9n);
  assert.deepEqual(ok.calls[0]?.params, []);
  assert.deepEqual(ok.calls[1]?.params, { request_type: "view_account", finality: "final", account_id: "escrow.testnet" });
  const bad = (result: unknown) => new NearRpc("https://rpc.testnet.near.org", fakeFetch(() => ({ jsonrpc: "2.0", id: "x", result })).fn);
  await assert.rejects(bad({ sync_info: {} }).chainId(), RpcError);
  await assert.rejects(bad({ code_hash: 7, block_height: 1, block_hash: "H" }).viewAccount("e.testnet"), /without a code_hash/);
  await assert.rejects(bad({ code_hash: "0OIl", block_height: 1, block_hash: "H" }).viewAccount("e.testnet"), /without a code_hash/);
  await assert.rejects(bad({ code_hash: "2pS3pvSsJDoZAiDPMQ3jNK5PnDZDk2qcBDhCzXLNQuU5" }).viewAccount("e.testnet"), /missing block reference/);
});

test("txStatus sends the object-form tx request; ftBalanceOf queries ft_balance_of on the token", async () => {
  const HASH = "8xNqvK3m5pQ2rT7uW9yZaBcDeFgHiJkLmNoPqRsTuVwX";
  const { fn, calls } = fakeFetch((b) =>
    b.method === "tx"
      ? { jsonrpc: "2.0", id: "x", result: { status: { SuccessValue: "IjAi" }, receipts_outcome: [{ outcome: { logs: ["LF_FT_REFUND:AmountMismatch"], gas_burnt: 2428027470130 } }] } }
      : { jsonrpc: "2.0", id: "x", result: { result: bytes('"1001"'), logs: [], block_height: 9, block_hash: "H" } },
  );
  const rpc = new NearRpc("https://rpc.testnet.near.org", fn);
  const r = await rpc.txStatus(HASH, "buyer.testnet");
  assert.deepEqual(calls[0].params, { tx_hash: HASH, sender_account_id: "buyer.testnet", wait_until: "FINAL" });
  assert.equal(calls[0].method, "tx");
  assert.deepEqual((r.status as Record<string, string>).SuccessValue, "IjAi");
  await assert.rejects(rpc.txStatus("not a hash", "buyer.testnet"), RpcError);
  const bal = await rpc.ftBalanceOf("ft.testnet", "buyer.testnet");
  assert.equal(bal.value, "1001");
  const p = calls[1].params as Record<string, string>;
  assert.equal(p.account_id, "ft.testnet");
  assert.equal(p.method_name, "ft_balance_of");
  assert.equal(Buffer.from(p.args_base64, "base64").toString("utf8"), '{"account_id":"buyer.testnet"}');
});
