import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULTS, explorerTxUrl, parseConfig } from "./config.ts";

test("defaults: testnet, public RPC, no contract configured", () => {
  const r = parseConfig({ MODE: "production", DEV: false });
  assert.ok(r.ok);
  assert.equal(r.config.network, "testnet");
  assert.equal(r.config.rpcUrl, DEFAULTS.rpcUrl);
  assert.equal(DEFAULTS.rpcUrl, "https://rpc.testnet.fastnear.com");
  assert.equal(r.config.escrowId, "");
  assert.equal(r.config.ftId, "");
  assert.equal(explorerTxUrl(r.config, "abc"), "https://testnet.nearblocks.io/txns/abc");
});

test("mainnet and non-testnet endpoints are refused", () => {
  assert.equal(parseConfig({ VITE_NEAR_NETWORK: "mainnet" }).ok, false);
  assert.equal(parseConfig({ VITE_NEAR_NETWORK: "sandbox" }).ok, false);
  assert.equal(parseConfig({ VITE_NEAR_RPC_URL: "https://rpc.mainnet.near.org" }).ok, false);
  assert.equal(parseConfig({ VITE_NEAR_RPC_URL: "https://rpc.mainnet.fastnear.com" }).ok, false);
  assert.equal(parseConfig({ VITE_NEAR_RPC_URL: "http://rpc.testnet.near.org" }).ok, false);
  assert.equal(parseConfig({ VITE_NEAR_RPC_URL: "https://rpc.testnet.near.org?apikey=x" }).ok, false);
  assert.equal(parseConfig({ VITE_NEAR_RPC_URL: "not a url" }).ok, false);
});

test("account ids must be valid .testnet accounts and distinct", () => {
  const ok = parseConfig({ VITE_ESCROW_ID: "escrow.lf-demo.testnet", VITE_FT_ID: "ft-test.lf-demo.testnet" });
  assert.ok(ok.ok);
  assert.equal(ok.config.escrowId, "escrow.lf-demo.testnet");
  assert.equal(parseConfig({ VITE_ESCROW_ID: "escrow.near" }).ok, false);
  assert.equal(parseConfig({ VITE_ESCROW_ID: "Escrow.testnet" }).ok, false);
  assert.equal(parseConfig({ VITE_ESCROW_ID: "a.testnet", VITE_FT_ID: "a.testnet" }).ok, false);
  // an escrow without its token is refused (the startup check compares them)
  assert.equal(parseConfig({ VITE_ESCROW_ID: "escrow.lf-demo.testnet" }).ok, false);
});

test("secret-like variables are rejected outright", () => {
  const r = parseConfig({ VITE_PRIVATE_KEY: "x" });
  assert.equal(r.ok, false);
  assert.equal(parseConfig({ VITE_SEED_PHRASE: "x" }).ok, false);
});
