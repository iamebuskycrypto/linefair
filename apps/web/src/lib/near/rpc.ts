// Read-only NEAR JSON-RPC client: `query` call_function / view_account,
// `block` and `status`.
// No signing, no keys. Uses fetch directly (no SDK dependency). View results
// are decoded with the strict JSON reader so an unsafe JSON number can never
// lose precision silently (U64/U128 must arrive as strings).

import { parseStrictJson, type JsonValue } from "../terms.ts";
import type { AgreementView, ConfigView, CustodySummaryView, StorageBalance, WithdrawalView } from "../contract/types.ts";

export type FetchFn = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class RpcError extends Error {
  readonly kind: "transport" | "rpc" | "contract" | "decode";
  constructor(kind: RpcError["kind"], message: string) {
    super(message);
    this.name = "RpcError";
    this.kind = kind;
  }
}

export interface Observed<T> {
  readonly value: T;
  readonly blockHeight: bigint;
  readonly blockHash: string;
}

/**
 * A JSON number from the RPC ENVELOPE that is not a safe integer (e.g. the
 * block header's `timestamp`, a u64 in ns). Kept as its exact lexeme and
 * never as a JS number; LineFair code reads none of these fields.
 */
export class UnsafeRpcNumber {
  readonly lexeme: string;
  constructor(lexeme: string) {
    this.lexeme = lexeme;
  }
}

/**
 * JsonValue -> plain JS. Contract view payloads (`envelope` false): numbers
 * must be safe integers (all LineFair numbers are u16/u32), anything else is
 * a decode error. RPC envelope (`envelope` true): other numbers become an
 * UnsafeRpcNumber, so an unused nearcore field cannot break a read.
 */
export function toPlain(v: JsonValue, envelope = false): unknown {
  switch (v.kind) {
    case "object": {
      const o: Record<string, unknown> = {};
      for (const [k, x] of v.entries) o[k] = toPlain(x, envelope);
      return o;
    }
    case "array":
      return v.items.map((x) => toPlain(x, envelope));
    case "string":
      return v.value;
    case "bool":
      return v.value;
    case "null":
      return null;
    case "number": {
      const integer = /^(0|-?[1-9][0-9]*)$/.test(v.lexeme);
      const n = integer ? Number.parseFloat(v.lexeme) : Number.NaN;
      if (integer && Number.isSafeInteger(n)) return n;
      if (envelope) return new UnsafeRpcNumber(v.lexeme);
      if (!integer) throw new RpcError("decode", `non-integer number ${v.lexeme}`);
      throw new RpcError("decode", `unsafe integer ${v.lexeme}`);
    }
  }
}

function strictParse(text: string, envelope = false): unknown {
  try {
    return toPlain(parseStrictJson(text), envelope);
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw new RpcError("decode", `invalid JSON: ${(e as Error).message}`);
  }
}

function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export class NearRpc {
  private readonly url: string;
  private readonly fetchFn: FetchFn;
  private nextId = 1;

  constructor(url: string, fetchFn?: FetchFn) {
    this.url = url;
    this.fetchFn = fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  }

  private async call(method: string, params: unknown): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: `lf-${this.nextId++}`, method, params });
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchFn(this.url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    } catch (e) {
      throw new RpcError("transport", `RPC unreachable: ${(e as Error).message}`);
    }
    if (!res.ok) throw new RpcError("transport", `RPC HTTP ${res.status}`);
    const json = strictParse(await res.text(), true) as { result?: Record<string, unknown>; error?: unknown };
    if (json.error !== undefined) throw new RpcError("rpc", JSON.stringify(json.error));
    if (json.result === undefined || json.result === null) throw new RpcError("decode", "RPC response without result");
    return json.result;
  }

  /**
   * `query` / `call_function` at final finality, or at an exact block height
   * (`atBlock`) so several views form one consistent snapshot. Contract
   * panics surface as kind "contract".
   */
  async view<T>(contractId: string, methodName: string, args: object = {}, atBlock?: bigint): Promise<Observed<T>> {
    const r = await this.call("query", {
      request_type: "call_function",
      ...(atBlock === undefined ? { finality: "final" } : { block_id: Number(atBlock) }),
      account_id: contractId,
      method_name: methodName,
      args_base64: base64Utf8(JSON.stringify(args)),
    });
    if (typeof r.error === "string") throw new RpcError("contract", r.error);
    if (!Array.isArray(r.result)) throw new RpcError("decode", "call_function result is not a byte array");
    const bytes = Uint8Array.from(r.result as number[]);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const height = r.block_height;
    if (typeof height !== "number" || typeof r.block_hash !== "string") throw new RpcError("decode", "missing block reference");
    if (atBlock !== undefined && BigInt(height) !== atBlock) throw new RpcError("decode", `asked for block ${atBlock}, got ${height}`);
    return { value: strictParse(text) as T, blockHeight: BigInt(height), blockHash: r.block_hash };
  }

  /** Latest final block: height and timestamp (ns) for chain-time pre-checks. */
  async finalBlock(): Promise<{ height: bigint; timestampNs: bigint; hash: string }> {
    const r = await this.call("block", { finality: "final" });
    const header = r.header as { height?: unknown; timestamp_nanosec?: unknown; hash?: unknown } | undefined;
    if (
      header === undefined ||
      typeof header.height !== "number" ||
      typeof header.timestamp_nanosec !== "string" ||
      !/^[0-9]+$/.test(header.timestamp_nanosec) ||
      typeof header.hash !== "string"
    ) {
      throw new RpcError("decode", "unexpected block header shape");
    }
    return { height: BigInt(header.height), timestampNs: BigInt(header.timestamp_nanosec), hash: header.hash };
  }

  /** `status` -> `chain_id` of the node behind the RPC URL (e.g. "testnet"). */
  async chainId(): Promise<string> {
    const r = await this.call("status", []);
    if (typeof r.chain_id !== "string") throw new RpcError("decode", "status without chain_id");
    return r.chain_id;
  }

  /**
   * `query` / `view_account` at final finality. `code_hash` is the base58
   * SHA-256 of the deployed WASM ("11111111111111111111111111111111" = none).
   */
  async viewAccount(accountId: string): Promise<Observed<{ code_hash: string }>> {
    const r = await this.call("query", { request_type: "view_account", finality: "final", account_id: accountId });
    if (typeof r.error === "string") throw new RpcError("rpc", r.error);
    if (typeof r.code_hash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.code_hash)) throw new RpcError("decode", "view_account without a code_hash");
    const height = r.block_height;
    if (typeof height !== "number" || typeof r.block_hash !== "string") throw new RpcError("decode", "missing block reference");
    return { value: { code_hash: r.code_hash }, blockHeight: BigInt(height), blockHash: r.block_hash };
  }

  getConfig(escrowId: string): Promise<Observed<ConfigView>> {
    return this.view<ConfigView>(escrowId, "get_config");
  }

  getAgreement(escrowId: string, agreementId: string, atBlock?: bigint): Promise<Observed<AgreementView | null>> {
    return this.view<AgreementView | null>(escrowId, "get_agreement", { agreement_id: agreementId }, atBlock);
  }

  /** Contract-side hash of terms (parse only, no validation). */
  computeTermsHash(escrowId: string, termsJson: object): Promise<Observed<string>> {
    return this.view<string>(escrowId, "compute_terms_hash", { terms: termsJson });
  }

  outstandingLiabilities(escrowId: string): Promise<Observed<string>> {
    return this.view<string>(escrowId, "outstanding_liabilities");
  }

  contractVersion(escrowId: string): Promise<Observed<string>> {
    return this.view<string>(escrowId, "contract_version");
  }

  /** LF-009 latest withdrawal of one slot; null when the agreement/line/beneficiary does not exist. */
  getWithdrawal(escrowId: string, agreementId: string, lineId: number, beneficiary: "BUYER" | "SUPPLIER", atBlock?: bigint): Promise<Observed<WithdrawalView | null>> {
    return this.view<WithdrawalView | null>(escrowId, "get_withdrawal", { agreement_id: agreementId, line_id: lineId, beneficiary }, atBlock);
  }

  /** LF-009 custody observation (E, open withdrawals, last id). Never used to infer a payout. */
  custodySummary(escrowId: string, atBlock?: bigint): Promise<Observed<CustodySummaryView>> {
    return this.view<CustodySummaryView>(escrowId, "custody_summary", {}, atBlock);
  }

  /** NEP-141 `ft_balance_of` on the TOKEN (U128 string). Precondition display only, never an outcome. */
  ftBalanceOf(ftId: string, accountId: string): Promise<Observed<string>> {
    return this.view<string>(ftId, "ft_balance_of", { account_id: accountId });
  }

  /**
   * JSON-RPC `tx` (transaction status with receipts) for a hash returned by
   * the wallet. Object-form params `tx_hash`, `sender_account_id`,
   * `wait_until` (nearcore RPC docs). NOT yet exercised against a node by
   * this app. "Reported by the transaction" only; the outcome of a LineFair
   * action is always judged by re-reading contract views.
   */
  async txStatus(txHash: string, senderId: string): Promise<Record<string, unknown>> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(txHash)) throw new RpcError("decode", "not a transaction hash");
    return this.call("tx", { tx_hash: txHash, sender_account_id: senderId, wait_until: "FINAL" });
  }

  /** NEP-145 on the TOKEN: null = the account is not registered (a transfer to it fails). */
  storageBalanceOf(ftId: string, accountId: string): Promise<Observed<StorageBalance | null>> {
    return this.view<StorageBalance | null>(ftId, "storage_balance_of", { account_id: accountId });
  }
}
