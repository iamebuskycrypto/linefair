// Delivery-evidence commitment (docs/20 §Commitments, docs/09 §Evidence
// hash/commitment). Computed in the browser; only the 32-byte commitment is
// sent on chain (submit_delivery). The file, its digest and the salt never
// leave the browser through this module, and are never logged.
//
//   SHA-256("linefair/evidence/v1" || 0x00 || bstr(network_id)
//           || bstr(escrow_contract_id) || u64 agreement_id || u32 line_id
//           || u16 evidence_version || content_digest[32] || salt[32])
//   bstr(x) = u32 LE byte length || UTF-8 bytes; integers little endian
//   (same conventions as the terms preimage, encode.ts).
//
// The contract checks only the format (64 lowercase hex) and that the value
// is not all zeros (ERR_EVIDENCE_COMMITMENT_FORMAT, ERR_LINE:ZeroCommitment).
// There is no shared Rust vector for this envelope yet: commitment.test.ts
// pins the byte layout with a TS-local known answer.

import { encodeHexLower, sha256, isValidAccountId, type NetworkId } from "./terms.ts";

export const EVIDENCE_DOMAIN_V1 = "linefair/evidence/v1";
export const EVIDENCE_VERSION_V1 = 1;
export const SALT_BYTES = 32;

const UTF8 = new TextEncoder();
const U64_MAX = (1n << 64n) - 1n;

export interface EvidenceInput {
  readonly network: NetworkId;
  readonly escrowId: string;
  readonly agreementId: bigint;
  readonly lineId: number;
  readonly version: number;
  /** SHA-256 of the evidence file's bytes (32 bytes). */
  readonly contentDigest: Uint8Array;
  /** CSPRNG salt, exactly 32 bytes. */
  readonly salt: Uint8Array;
}

export function evidencePreimage(e: EvidenceInput): Uint8Array {
  if (e.network !== "testnet" && e.network !== "sandbox") throw new RangeError("network must be testnet or sandbox");
  if (!isValidAccountId(e.escrowId)) throw new RangeError("escrow id is not a valid NEAR account id");
  if (e.agreementId < 0n || e.agreementId > U64_MAX) throw new RangeError("agreement_id must be a u64");
  if (!Number.isInteger(e.lineId) || e.lineId < 0 || e.lineId > 0xffff_ffff) throw new RangeError("line_id must be a u32");
  if (!Number.isInteger(e.version) || e.version < 0 || e.version > 0xffff) throw new RangeError("evidence_version must be a u16");
  if (e.contentDigest.length !== 32) throw new RangeError("content digest must be 32 bytes");
  if (e.salt.length !== SALT_BYTES) throw new RangeError("salt must be 32 bytes");
  const domain = UTF8.encode(EVIDENCE_DOMAIN_V1);
  const net = UTF8.encode(e.network);
  const esc = UTF8.encode(e.escrowId);
  const out = new Uint8Array(domain.length + 1 + 4 + net.length + 4 + esc.length + 8 + 4 + 2 + 32 + 32);
  const dv = new DataView(out.buffer);
  let o = 0;
  out.set(domain, o);
  o += domain.length;
  out[o++] = 0x00;
  dv.setUint32(o, net.length, true);
  o += 4;
  out.set(net, o);
  o += net.length;
  dv.setUint32(o, esc.length, true);
  o += 4;
  out.set(esc, o);
  o += esc.length;
  dv.setBigUint64(o, e.agreementId, true);
  o += 8;
  dv.setUint32(o, e.lineId, true);
  o += 4;
  dv.setUint16(o, e.version, true);
  o += 2;
  out.set(e.contentDigest, o);
  o += 32;
  out.set(e.salt, o);
  return out;
}

/** 64 lowercase hex commitment; never all zeros (probability 2^-256, still checked). */
export async function evidenceCommitmentHex(e: EvidenceInput): Promise<string> {
  const hex = encodeHexLower(await sha256(evidencePreimage(e)));
  if (/^0{64}$/.test(hex)) throw new Error("all-zero commitment");
  return hex;
}

/** 32 bytes from the platform CSPRNG (crypto.getRandomValues). */
export function newSalt(): Uint8Array {
  const s = new Uint8Array(SALT_BYTES);
  globalThis.crypto.getRandomValues(s);
  return s;
}

/** SHA-256 of a file's bytes, computed locally. */
export async function contentDigest(bytes: Uint8Array): Promise<Uint8Array> {
  return sha256(bytes);
}

/**
 * The private receipt the supplier keeps (downloaded locally, never sent):
 * everything needed to later prove the commitment to an adjudicator.
 */
export function evidenceReceiptJson(e: EvidenceInput, commitment: string, fileName: string): string {
  return JSON.stringify(
    {
      kind: "linefair-evidence-receipt-v1",
      warning: "PRIVATE. Keep this file with the evidence. Do not publish it: the salt links the commitment to the file.",
      domain: EVIDENCE_DOMAIN_V1,
      network_id: e.network,
      escrow_contract_id: e.escrowId,
      agreement_id: e.agreementId.toString(),
      line_id: e.lineId,
      evidence_version: e.version,
      file_name: fileName,
      content_digest_sha256: encodeHexLower(e.contentDigest),
      salt: encodeHexLower(e.salt),
      commitment,
    },
    null,
    2,
  );
}
