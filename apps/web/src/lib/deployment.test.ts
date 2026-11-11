// Startup deployment check: expected values vs the main 8ec0816 fixtures, and
// fail-closed behaviour against a test double of the JSON-RPC endpoint (no
// network; responses are hand-written in the documented shapes and prove only
// this module's logic, not chain behaviour).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { base58, codeHashFromSha256Hex, EXPECTED_CODE_HASH, EXPECTED_DEPLOYMENT, verifyDeployment } from "./deployment.ts";
import { NearRpc, type FetchFn } from "./near/rpc.ts";
import type { AppConfig } from "./config.ts";

const FIXTURE = new URL("../../fixtures/contract-main/", import.meta.url);
const MANIFEST = JSON.parse(readFileSync(new URL("MANIFEST.json", FIXTURE), "utf8")) as Record<string, unknown>;
const ABI = JSON.parse(readFileSync(new URL("abi/linefair_escrow_abi.json", FIXTURE), "utf8")) as { metadata: { wasm_hash: string } };
const LIB = readFileSync(new URL("src/lib.rs", FIXTURE), "utf8");

test("expected values are the main 8ec0816 (F3) release build recorded in the fixtures", () => {
  assert.equal(EXPECTED_DEPLOYMENT.sourceCommit, MANIFEST.source_commit);
  assert.equal(EXPECTED_DEPLOYMENT.wasmSha256, MANIFEST.wasm_sha256);
  assert.equal(EXPECTED_DEPLOYMENT.wasmSha256, "470db97b62cd04701e68f6a87d7589dd8af9b8d122b96e4f5e12788d4405f2e1");
  assert.equal(EXPECTED_DEPLOYMENT.contractVersion, MANIFEST.contract_version);
  assert.ok(LIB.includes(`pub const CONTRACT_VERSION: &str = "${EXPECTED_DEPLOYMENT.contractVersion}";`));
  // base58 printed by cargo-near for this build, the ABI metadata and MANIFEST agree
  assert.equal(EXPECTED_CODE_HASH, "5nN5ua65yntBYmNZC6JEtdWYBbbuBkVxuHC7GZxpBgcQ");
  assert.equal(EXPECTED_CODE_HASH, ABI.metadata.wasm_hash);
  assert.equal(EXPECTED_CODE_HASH, MANIFEST.wasm_code_hash_base58);
  assert.ok(/pub const MAX_CREATORS: usize = 10;/.test(LIB));
});

test("base58: NEAR's empty code hash, leading zeros, previous build", () => {
  assert.equal(codeHashFromSha256Hex("0".repeat(64)), "11111111111111111111111111111111");
  assert.equal(base58(Uint8Array.from([0, 0, 1])), "112");
  assert.equal(base58(Uint8Array.from([255])), "5Q");
  assert.equal(codeHashFromSha256Hex("c3c896cbdf05f8562a663c6c98df65bb7fcb6dc38e7e5c52d68d4c871afaefc2"), "EBFuNotxobEuwVGj9Ha46KddtdPKYZHEYNwStPc9VWXb");
  assert.throws(() => codeHashFromSha256Hex("1B024EC1"), /64 lowercase hex/);
});

const CFG: AppConfig = { network: "testnet", rpcUrl: "https://rpc.testnet.near.org", explorerUrl: "https://testnet.nearblocks.io", escrowId: "escrow.lf-demo.testnet", ftId: "ft.lf-demo.testnet" };

interface Chain {
  chainId?: string;
  codeHash?: string;
  version?: unknown;
  config?: Record<string, unknown>;
  fail?: "status" | "view_account" | "contract_version" | "get_config" | "transport";
  panic?: string;
}

const GOOD_CONFIG = {
  network_id: "testnet",
  allowlisted_ft_id: "ft.lf-demo.testnet",
  operator_treasury_id: "treasury.lf-demo.testnet",
  max_agreements: 25,
  agreements_created: "0",
  creator_allowlist: ["buyer.lf-demo.testnet"],
};

function chain(c: Chain): { rpc: NearRpc; calls: string[] } {
  const calls: string[] = [];
  const enc = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
  const fn: FetchFn = async (_u, init) => {
    if (c.fail === "transport") throw new Error("connection refused");
    const b = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
    const p = b.params;
    const what = b.method === "status" ? "status" : p.request_type === "view_account" ? "view_account" : String(p.method_name);
    calls.push(what);
    let result: unknown;
    if (c.fail === what) return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }) };
    if (what === "status") result = { chain_id: c.chainId ?? "testnet", sync_info: { latest_block_height: 1 } };
    else if (what === "view_account") result = { amount: "6000000000000000000000000", locked: "0", code_hash: c.codeHash ?? EXPECTED_CODE_HASH, storage_usage: 248807, block_height: 5, block_hash: "H" };
    else if (what === "contract_version" && c.panic !== undefined) result = { error: c.panic, logs: [], block_height: 5, block_hash: "H" };
    else if (what === "contract_version") result = { result: enc(c.version ?? EXPECTED_DEPLOYMENT.contractVersion), logs: [], block_height: 5, block_hash: "H" };
    else if (what === "get_config") result = { result: enc(c.config ?? GOOD_CONFIG), logs: [], block_height: 5, block_hash: "H" };
    else throw new Error(`unexpected ${what}`);
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: "x", result }) };
  };
  return { rpc: new NearRpc(CFG.rpcUrl, fn), calls };
}

test("passes only when chain id, code hash, version, network, token and allowlist all match", async () => {
  const { rpc, calls } = chain({});
  const r = await verifyDeployment(rpc, CFG);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.escrowConfig.creator_allowlist, ["buyer.lf-demo.testnet"]);
  assert.deepEqual(calls, ["status", "view_account", "contract_version", "get_config"]);
  assert.equal(r.observed.codeHash, EXPECTED_CODE_HASH);
});

test("every mismatch or read failure fails closed with a specific reason", async () => {
  const cases: [string, Chain, RegExp][] = [
    ["mainnet RPC", { chainId: "mainnet" }, /serves chain "mainnet", expected "testnet"/],
    ["no code deployed", { codeHash: "11111111111111111111111111111111" }, /not the expected LineFair release build/],
    ["previous lf-009 build", { codeHash: "EBFuNotxobEuwVGj9Ha46KddtdPKYZHEYNwStPc9VWXb" }, /not the expected LineFair release build/],
    ["starve test build", { version: "linefair-escrow 0.1.0 (lf-012 f3) +test-starve-callback" }, /expected exactly "linefair-escrow 0\.1\.0 \(lf-012 f3\)"/],
    ["superseded lf-010a build", { codeHash: "2pS3pvSsJDoZAiDPMQ3jNK5PnDZDk2qcBDhCzXLNQuU5" }, /not the expected LineFair release build/],
    ["superseded lf-010a version", { version: "linefair-escrow 0.1.0 (lf-010a)" }, /contract_version\(\) is "linefair-escrow 0\.1\.0 \(lf-010a\)"/],
    ["old version", { version: "linefair-escrow 0.1.0 (lf-009)" }, /contract_version\(\) is "linefair-escrow 0\.1\.0 \(lf-009\)"/],
    ["non-string version", { version: 7 }, /contract_version\(\) is "7"/],
    ["sandbox network_id", { config: { ...GOOD_CONFIG, network_id: "sandbox" } }, /network_id is "sandbox", expected "testnet"/],
    ["other token", { config: { ...GOOD_CONFIG, allowlisted_ft_id: "other.testnet" } }, /token is other\.testnet/],
    ["no allowlist (pre-LF-010A view)", { config: { ...GOOD_CONFIG, creator_allowlist: undefined } }, /creator_allowlist is missing/],
    ["empty allowlist", { config: { ...GOOD_CONFIG, creator_allowlist: [] } }, /creator_allowlist is missing or malformed/],
    ["status RPC error", { fail: "status" }, /Could not read the RPC network status/],
    ["escrow account missing", { fail: "view_account" }, /Could not read the escrow account/],
    ["version view panics", { panic: "MethodNotFound" }, /Could not read contract_version/],
    ["get_config error", { fail: "get_config" }, /Could not read get_config/],
    ["RPC unreachable", { fail: "transport" }, /RPC unreachable/],
  ];
  for (const [name, c, re] of cases) {
    const r = await verifyDeployment(chain(c).rpc, CFG);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.ok(r.failures.some((f) => re.test(f)), `${name}: ${JSON.stringify(r.failures)}`);
  }
  // no contract configured is never a pass
  const none = await verifyDeployment(chain({}).rpc, { ...CFG, escrowId: "" });
  assert.equal(none.ok, false);
  // an unset VITE_FT_ID is never a pass either (parseConfig also refuses it)
  const noFt = await verifyDeployment(chain({}).rpc, { ...CFG, ftId: "" });
  assert.ok(!noFt.ok && noFt.failures.some((f) => /configured for no token/.test(f)));
});
