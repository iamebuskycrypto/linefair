// Defensive reading of the outcome a wallet returns after signAndSendTransaction.
// The outcome is INFORMATIONAL ONLY: every LineFair screen judges success from a
// fresh contract read, never from this value (ARCHITECTURE.md §6.4).
//
// Why this exists (found live 2026-11-11, escrow2 withdrawal Cus2jjk5…): the
// Intear module returns `Object.fromEntries(outcome)`, which converts only the
// top level. Nested fields such as `status` and `transaction` can arrive as
// `Map` objects (postMessage keeps Maps), so `"SuccessValue" in status` was
// false and `outcome.transaction.hash` was undefined, and the app showed "no
// withdrawal result" next to a correctly PAID contract record.

export interface WalletOutcome {
  /** base58 transaction hash, or null if absent or malformed (never the string "undefined"). */
  readonly txHash: string | null;
  /** JSON of `status.Failure`, if the wallet reported one. */
  readonly failure: string | null;
  /** base64 `status.SuccessValue`, if present. */
  readonly successValue: string | null;
}

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const MAX_DEPTH = 32;

/** Recursively converts Maps to plain objects; arrays and objects are walked. */
export function toPlainDeep(v: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (v instanceof Map) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of v) if (typeof k === "string") o[k] = toPlainDeep(x, depth + 1);
    return o;
  }
  if (Array.isArray(v)) return v.map((x) => toPlainDeep(x, depth + 1));
  if (v !== null && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = toPlainDeep(x, depth + 1);
    return o;
  }
  return v;
}

export function readWalletOutcome(raw: unknown): WalletOutcome {
  const none: WalletOutcome = { txHash: null, failure: null, successValue: null };
  const o = toPlainDeep(raw);
  if (o === null || typeof o !== "object" || Array.isArray(o)) return none;
  const rec = o as Record<string, unknown>;
  const tx = rec.transaction;
  const hash = tx !== null && typeof tx === "object" ? (tx as Record<string, unknown>).hash : undefined;
  const txHash = typeof hash === "string" && TX_HASH.test(hash) ? hash : null;
  const status = rec.status;
  if (status === null || typeof status !== "object" || Array.isArray(status)) return { ...none, txHash };
  const s = status as Record<string, unknown>;
  if ("Failure" in s) return { txHash, failure: JSON.stringify(s.Failure) ?? "unknown failure", successValue: null };
  if (typeof s.SuccessValue === "string") return { txHash, failure: null, successValue: s.SuccessValue };
  return { ...none, txHash };
}
