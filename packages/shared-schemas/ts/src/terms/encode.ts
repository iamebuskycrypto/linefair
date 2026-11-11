// Canonical terms preimage + SHA-256, mirroring hash.rs `terms_preimage` /
// `terms_hash` (docs/20 §Canonical terms encoding v1, FROZEN):
//
//   "linefair/agreement/v1" || 0x00 || bstr(network_id) || bstr(escrow_id)
//   || Borsh(AgreementTermsV1)
//   bstr(x) = u32 LE byte length || UTF-8 bytes
//
// Encoding never validates terms (a 0- or 4-line struct still encodes); it
// only asserts that every integer fits its Borsh width, which the parser
// already guarantees, so a hand-built struct cannot silently wrap.

import { encodeHexLower, isValidAccountId } from "./fields.ts";
import { U128_MAX, U16_MAX, U32_MAX, U64_MAX, type AgreementTermsV1, type NetworkId } from "./types.ts";

export const TERMS_DOMAIN_V1 = "linefair/agreement/v1";
export const DOMAIN_SEPARATOR = 0x00;

const UTF8 = new TextEncoder();

class ByteWriter {
  private buf = new Uint8Array(512);
  private len = 0;

  private reserve(n: number): DataView {
    if (this.len + n > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.len, n);
    this.len += n;
    return view;
  }

  bytes(b: Uint8Array): void {
    const start = this.len;
    this.reserve(b.length);
    this.buf.set(b, start);
  }

  u8(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError(`u8 out of range: ${v}`);
    this.reserve(1).setUint8(0, v);
  }

  u16(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > U16_MAX) throw new RangeError(`u16 out of range: ${v}`);
    this.reserve(2).setUint16(0, v, true);
  }

  u32(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > U32_MAX) throw new RangeError(`u32 out of range: ${v}`);
    this.reserve(4).setUint32(0, v, true);
  }

  u64(v: bigint): void {
    if (typeof v !== "bigint" || v < 0n || v > U64_MAX) throw new RangeError(`u64 out of range: ${v}`);
    this.reserve(8).setBigUint64(0, v, true);
  }

  u128(v: bigint): void {
    if (typeof v !== "bigint" || v < 0n || v > U128_MAX) throw new RangeError(`u128 out of range: ${v}`);
    const dv = this.reserve(16);
    dv.setBigUint64(0, v & U64_MAX, true); // low 8 bytes first (little endian)
    dv.setBigUint64(8, v >> 64n, true);
  }

  bstr(s: string): void {
    const b = UTF8.encode(s);
    this.u32(b.length);
    this.bytes(b);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Throws unless `network` is exactly "sandbox" or "testnet" (no mainnet, OQ-13). */
export function assertNetwork(network: string): asserts network is NetworkId {
  if (network !== "sandbox" && network !== "testnet") {
    throw new Error(`unsupported network "${network}": only sandbox and testnet exist`);
  }
}

/** The exact bytes that are hashed (`hash.rs::terms_preimage`). */
export function termsPreimage(network: NetworkId, escrowId: string, t: AgreementTermsV1): Uint8Array {
  assertNetwork(network);
  if (!isValidAccountId(escrowId)) throw new Error("escrow id is not a valid NEAR account id");
  const w = new ByteWriter();
  w.bytes(UTF8.encode(TERMS_DOMAIN_V1));
  w.u8(DOMAIN_SEPARATOR);
  w.bstr(network);
  w.bstr(escrowId);
  // Borsh(AgreementTermsV1), field order = terms.rs
  w.u16(t.schema_version);
  w.u16(t.deadline_rules_version);
  w.bstr(t.buyer_id);
  w.bstr(t.supplier_id);
  w.bstr(t.primary_arbitrator_id);
  w.bstr(t.backup_arbitrator_id);
  w.bstr(t.ft_contract_id);
  w.u64(t.agreement_nonce);
  w.u64(t.acceptance_deadline_ns);
  w.u64(t.funding_deadline_ns);
  w.u64(t.delivery_grace_period_ns);
  w.u64(t.review_window_ns);
  w.u64(t.negotiation_window_ns);
  w.u64(t.primary_window_ns);
  w.u64(t.backup_window_ns);
  w.u32(t.lines.length);
  for (const l of t.lines) {
    w.u32(l.line_id);
    w.u128(l.principal);
    w.u64(l.delivery_deadline_ns);
    if (l.acceptance_criteria_commitment.length !== 32) throw new RangeError("commitment must be 32 bytes");
    w.bytes(l.acceptance_criteria_commitment);
    w.u16(l.fallback_buyer_bps);
    w.u16(l.fallback_supplier_bps);
  }
  return w.finish();
}

/** SHA-256 via WebCrypto (browser and Node >= 20 both expose `crypto.subtle`). */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes); // own ArrayBuffer, never a shared view
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy));
}

/** Canonical terms hash v1 as 64 lowercase hex characters. */
export async function termsHashHex(network: NetworkId, escrowId: string, t: AgreementTermsV1): Promise<string> {
  return encodeHexLower(await sha256(termsPreimage(network, escrowId, t)));
}
