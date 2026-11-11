// Field-level conversions, mirroring terms_json.rs (parse_u64, parse_u128,
// parse_hex32, encode_hex_lower) and near-account-id 2.6.0 `validation::validate`.

import { U128_MAX, U64_MAX } from "./types.ts";

/** `^(0|[1-9][0-9]*)$` over ASCII digits only. */
export function isCanonicalDecimal(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return s.length === 1 || s.charCodeAt(0) !== 0x30;
}

export type DecimalResult =
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly code: "NonCanonicalDecimal" | "DecimalOverflow" };

function parseCanonical(s: string, max: bigint): DecimalResult {
  if (!isCanonicalDecimal(s)) return { ok: false, code: "NonCanonicalDecimal" };
  // Only ASCII digits remain, so BigInt() is exact; the only failure left is range.
  const v = BigInt(s);
  if (v > max) return { ok: false, code: "DecimalOverflow" };
  return { ok: true, value: v };
}

export function parseU64(s: string): DecimalResult {
  return parseCanonical(s, U64_MAX);
}

export function parseU128(s: string): DecimalResult {
  return parseCanonical(s, U128_MAX);
}

function nibble(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

/** Exactly 64 lowercase hex characters -> 32 bytes, else null. */
export function parseHex32(s: string): Uint8Array | null {
  if (s.length !== 64) return null;
  const out = new Uint8Array(32);
  for (let k = 0; k < 32; k++) {
    const hi = nibble(s.charCodeAt(2 * k));
    const lo = nibble(s.charCodeAt(2 * k + 1));
    if (hi < 0 || lo < 0) return null;
    out[k] = (hi << 4) | lo;
  }
  return out;
}

const HEX = "0123456789abcdef";

export function encodeHexLower(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += HEX[b >> 4] + HEX[b & 0x0f];
  return s;
}

/** Strict decoder for lowercase or uppercase hex of any even length (test/vector use only). */
export function decodeHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(s.length / 2);
  for (let k = 0; k < out.length; k++) {
    const hi = nibble(s.toLowerCase().charCodeAt(2 * k));
    const lo = nibble(s.toLowerCase().charCodeAt(2 * k + 1));
    if (hi < 0 || lo < 0) throw new Error("invalid hex");
    out[k] = (hi << 4) | lo;
  }
  return out;
}

const UTF8 = new TextEncoder();

/**
 * near-account-id 2.6.0 `validation::validate`: UTF-8 byte length 2..=64;
 * chars `a-z 0-9 - _ .`; no leading, trailing or consecutive separators.
 */
export function isValidAccountId(s: string): boolean {
  const len = UTF8.encode(s).length;
  if (len < 2 || len > 64) return false;
  let lastSep = true; // "we can safely assume that last char was a separator"
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let sep: boolean;
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)) sep = false;
    else if (c === 0x2d || c === 0x5f || c === 0x2e) sep = true;
    else return false;
    if (sep && lastSep) return false;
    lastSep = sep;
  }
  return !lastSep;
}
