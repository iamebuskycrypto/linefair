// Public runtime configuration. PUBLIC VALUES ONLY: network, RPC URL,
// contract account ids, explorer URL. Never keys, seed phrases or tokens.
// Values come from Vite `VITE_*` build variables (see .env.example) with the
// defaults below. NEAR testnet only: anything else is refused (CLAUDE.md).

import { isValidAccountId } from "./terms.ts";

export interface AppConfig {
  readonly network: "testnet";
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  /** Escrow contract account. Empty: no contract configured (nothing is deployed yet). */
  readonly escrowId: string;
  /** Allowlisted NEP-141 test token account. Empty until configured. */
  readonly ftId: string;
}

export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; errors: string[] };

export const DEFAULTS = {
  network: "testnet",
  rpcUrl: "https://rpc.testnet.near.org",
  explorerUrl: "https://testnet.nearblocks.io",
  escrowId: "",
  ftId: "",
} as const;

type Env = Readonly<Record<string, string | boolean | undefined>>;

function read(env: Env, key: string, fallback: string): string {
  const v = env[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : fallback;
}

/** Keys that must never appear in client config (defence in depth). */
const FORBIDDEN = /(SECRET|PRIVATE|SEED|MNEMONIC|PASSWORD|KEY)/i;

export function parseConfig(env: Env): ConfigResult {
  const errors: string[] = [];
  for (const k of Object.keys(env)) {
    if (k.startsWith("VITE_") && FORBIDDEN.test(k)) errors.push(`${k}: secret-like variables are not allowed in client config`);
  }
  const network = read(env, "VITE_NEAR_NETWORK", DEFAULTS.network);
  if (network !== "testnet") errors.push(`VITE_NEAR_NETWORK must be "testnet" (got "${network}"); mainnet is never supported`);
  const rpcUrl = read(env, "VITE_NEAR_RPC_URL", DEFAULTS.rpcUrl);
  const explorerUrl = read(env, "VITE_NEAR_EXPLORER_URL", DEFAULTS.explorerUrl);
  for (const [k, u] of [["VITE_NEAR_RPC_URL", rpcUrl], ["VITE_NEAR_EXPLORER_URL", explorerUrl]] as const) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(u);
    } catch {
      errors.push(`${k} is not a URL`);
    }
    if (parsed !== null) {
      if (parsed.protocol !== "https:") errors.push(`${k} must use https`);
      if (/mainnet|\.near\.org$/.test(parsed.hostname) && !/testnet/.test(parsed.hostname)) {
        errors.push(`${k} does not look like a testnet endpoint`);
      }
      if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "") {
        errors.push(`${k} must not carry credentials or query parameters`);
      }
    }
  }
  const escrowId = read(env, "VITE_ESCROW_ID", DEFAULTS.escrowId);
  const ftId = read(env, "VITE_FT_ID", DEFAULTS.ftId);
  for (const [k, id] of [["VITE_ESCROW_ID", escrowId], ["VITE_FT_ID", ftId]] as const) {
    if (id === "") continue;
    if (!isValidAccountId(id)) errors.push(`${k} is not a valid NEAR account id`);
    else if (!id.endsWith(".testnet")) errors.push(`${k} must be a .testnet account`);
  }
  if (escrowId !== "" && escrowId === ftId) errors.push("VITE_ESCROW_ID and VITE_FT_ID must differ");
  if (escrowId !== "" && ftId === "") errors.push("VITE_FT_ID must be set when VITE_ESCROW_ID is set");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { network: "testnet", rpcUrl, explorerUrl, escrowId, ftId } };
}

export function explorerTxUrl(cfg: AppConfig, txHash: string): string {
  return `${cfg.explorerUrl}/txns/${encodeURIComponent(txHash)}`;
}

export function explorerAccountUrl(cfg: AppConfig, accountId: string): string {
  return `${cfg.explorerUrl}/address/${encodeURIComponent(accountId)}`;
}
