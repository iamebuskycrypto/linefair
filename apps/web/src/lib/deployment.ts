// The ONE place that records which escrow build this frontend accepts, and
// the fail-closed startup check against the configured testnet contract
// (mirrors the post-deploy checks of the founder's deploy/testnet_preflight.py:
// RPC chain id, on-chain code hash == release WASM, exact contract_version,
// get_config network). Read-only public RPC queries; no keys.
//
// Expected values come from main 8ec0816 (F3 funding guard on top of LF-010A,
// docs/30, docs/31): release WASM built with `cargo near build non-reproducible-wasm
// --locked` from a `git archive` export (evidence/frontend/main-wasm-abi-build-
// 20261105T185734Z.log.txt), byte-identical to the qualified clean-checkout build.
// SUPERSEDED (rejected at startup): 2ccd058 / lf-010a / 1b024ec1…f53a. deployment.test.ts cross-checks every value with
// apps/web/fixtures/contract-main (MANIFEST.json, lib.rs, ABI metadata).

import type { AppConfig } from "./config.ts";
import type { ConfigView } from "./contract/types.ts";
import type { NearRpc } from "./near/rpc.ts";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Bitcoin-alphabet base58 of raw bytes (NEAR `CryptoHash` display form). */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** NEAR `view_account.code_hash` for a WASM whose SHA-256 is `hex` (64 lowercase hex). */
export function codeHashFromSha256Hex(hex: string): string {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("expected 64 lowercase hex characters");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return base58(bytes);
}

export const EXPECTED_DEPLOYMENT = {
  /** main commit the release WASM and the fixtures were built from. */
  sourceCommit: "8ec081679b4b5d4e1dbaaca54acd93cad0583b3b",
  /** `contract_version()`; never the `+test-starve-callback` build (AI review F12). */
  contractVersion: "linefair-escrow 0.1.0 (lf-012 f3)",
  /** SHA-256 of the release WASM (248 501 bytes). */
  wasmSha256: "470db97b62cd04701e68f6a87d7589dd8af9b8d122b96e4f5e12788d4405f2e1",
} as const;

/** base58 of `EXPECTED_DEPLOYMENT.wasmSha256`, as `view_account` reports it. */
export const EXPECTED_CODE_HASH = codeHashFromSha256Hex(EXPECTED_DEPLOYMENT.wasmSha256);

export interface DeploymentObservation {
  chainId?: string;
  codeHash?: string;
  contractVersion?: string;
  networkId?: string;
  ftId?: string;
}

export type DeploymentCheck =
  | { ok: true; escrowConfig: ConfigView; observed: DeploymentObservation }
  | { ok: false; failures: string[]; observed: DeploymentObservation };

/** Verified escrow configuration, available to every screen once the startup check passed. */
export interface VerifiedDeployment {
  readonly escrowId: string;
  readonly escrowConfig: ConfigView;
  readonly creatorAllowlist: readonly string[];
}

const MAX_CREATORS = 10; // lib.rs MAX_CREATORS (deployment.test.ts re-reads it)

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Every check runs; any failure, missing value or RPC error fails the whole
 * check (fail closed). Only a full pass returns `ok: true`.
 */
export async function verifyDeployment(
  rpc: NearRpc,
  config: AppConfig,
  expected: { contractVersion: string; codeHash: string } = { contractVersion: EXPECTED_DEPLOYMENT.contractVersion, codeHash: EXPECTED_CODE_HASH },
): Promise<DeploymentCheck> {
  const failures: string[] = [];
  const observed: DeploymentObservation = {};
  if (config.escrowId === "") return { ok: false, failures: ["No escrow contract is configured."], observed };

  try {
    observed.chainId = await rpc.chainId();
    if (observed.chainId !== config.network) failures.push(`The RPC endpoint serves chain "${observed.chainId}", expected "${config.network}".`);
  } catch (e) {
    failures.push(`Could not read the RPC network status: ${msg(e)}`);
  }

  try {
    observed.codeHash = (await rpc.viewAccount(config.escrowId)).value.code_hash;
    if (observed.codeHash !== expected.codeHash) {
      failures.push(`The code deployed on ${config.escrowId} (code hash ${observed.codeHash}) is not the expected LineFair release build (${expected.codeHash}).`);
    }
  } catch (e) {
    failures.push(`Could not read the escrow account ${config.escrowId}: ${msg(e)}`);
  }

  try {
    observed.contractVersion = (await rpc.contractVersion(config.escrowId)).value;
    if (observed.contractVersion !== expected.contractVersion) {
      failures.push(`contract_version() is "${String(observed.contractVersion)}", expected exactly "${expected.contractVersion}".`);
    }
  } catch (e) {
    failures.push(`Could not read contract_version(): ${msg(e)}`);
  }

  let escrowConfig: ConfigView | null = null;
  try {
    const c = (await rpc.getConfig(config.escrowId)).value;
    observed.networkId = c.network_id;
    observed.ftId = c.allowlisted_ft_id;
    if (c.network_id !== config.network) failures.push(`get_config().network_id is "${String(c.network_id)}", expected "${config.network}".`);
    if (c.allowlisted_ft_id !== config.ftId) {
      failures.push(`The escrow's token is ${String(c.allowlisted_ft_id)}, but this build is configured for ${config.ftId === "" ? "no token" : config.ftId}.`);
    }
    const list = (c as { creator_allowlist?: unknown }).creator_allowlist;
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_CREATORS || !list.every((a) => typeof a === "string")) {
      failures.push("get_config().creator_allowlist is missing or malformed.");
    }
    escrowConfig = c;
  } catch (e) {
    failures.push(`Could not read get_config(): ${msg(e)}`);
  }

  if (failures.length > 0 || escrowConfig === null) return { ok: false, failures, observed };
  return { ok: true, escrowConfig, observed };
}
