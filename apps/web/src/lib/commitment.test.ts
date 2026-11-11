import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { contentDigest, evidenceCommitmentHex, evidencePreimage, evidenceReceiptJson, EVIDENCE_DOMAIN_V1, newSalt, type EvidenceInput } from "./commitment.ts";
import { submitDeliveryCall } from "./near/tx.ts";

const digest = new Uint8Array(32).fill(0x11);
const salt = new Uint8Array(32).fill(0x22);
const input: EvidenceInput = { network: "testnet", escrowId: "escrow.testnet", agreementId: 7n, lineId: 2, version: 1, contentDigest: digest, salt };

/** Independent byte-by-byte construction of the docs/20 envelope (Node Buffer, not the module's writer). */
function expected(e: EvidenceInput): Buffer {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const bstr = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s, "utf8")]);
  return Buffer.concat([Buffer.from("linefair/evidence/v1"), Buffer.from([0]), bstr(e.network), bstr(e.escrowId), u64(e.agreementId), u32(e.lineId), u16(e.version), Buffer.from(e.contentDigest), Buffer.from(e.salt)]);
}

test("evidence preimage is exactly the docs/20 layout", () => {
  assert.equal(EVIDENCE_DOMAIN_V1, "linefair/evidence/v1");
  const p = evidencePreimage(input);
  assert.deepEqual(Buffer.from(p), expected(input));
  assert.equal(p.length, 20 + 1 + 4 + 7 + 4 + 14 + 8 + 4 + 2 + 32 + 32);
});

test("commitment = SHA-256(preimage), 64 lowercase hex, accepted by the submit_delivery builder", async () => {
  const c = await evidenceCommitmentHex(input);
  assert.equal(c, createHash("sha256").update(expected(input)).digest("hex"));
  assert.match(c, /^[0-9a-f]{64}$/);
  assert.equal(submitDeliveryCall("escrow.testnet", "7", 2, c).args.evidence_commitment, c);
  // TS-local known answer (no Rust vector exists for the evidence envelope).
  assert.equal(c, "bbc32e833925fcdb50a7b4a82e0a033ca4ae76b2d7ffef3cd05b8cdcc1b42b7a");
});

test("every bound field changes the commitment", async () => {
  const base = await evidenceCommitmentHex(input);
  const variants: EvidenceInput[] = [
    { ...input, network: "sandbox" },
    { ...input, escrowId: "escrow2.testnet" },
    { ...input, agreementId: 8n },
    { ...input, lineId: 1 },
    { ...input, version: 2 },
    { ...input, contentDigest: new Uint8Array(32).fill(0x12) },
    { ...input, salt: new Uint8Array(32).fill(0x23) },
  ];
  const all = new Set([base, ...(await Promise.all(variants.map(evidenceCommitmentHex)))]);
  assert.equal(all.size, variants.length + 1);
});

test("rejects malformed inputs; salt is 32 fresh CSPRNG bytes", async () => {
  for (const bad of [
    { ...input, network: "mainnet" as never },
    { ...input, escrowId: "Bad Id" },
    { ...input, agreementId: -1n },
    { ...input, agreementId: 1n << 64n },
    { ...input, lineId: -1 },
    { ...input, version: 70000 },
    { ...input, contentDigest: new Uint8Array(31) },
    { ...input, salt: new Uint8Array(16) },
  ]) assert.throws(() => evidencePreimage(bad));
  const a = newSalt();
  const b = newSalt();
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
  assert.deepEqual(Buffer.from(await contentDigest(new TextEncoder().encode("abc"))).toString("hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("private receipt carries salt and digest locally; the call carries only the commitment", async () => {
  const c = await evidenceCommitmentHex(input);
  const r = JSON.parse(evidenceReceiptJson(input, c, "invoice.pdf")) as Record<string, unknown>;
  assert.equal(r.salt, "22".repeat(32));
  assert.equal(r.content_digest_sha256, "11".repeat(32));
  assert.equal(r.commitment, c);
  const call = submitDeliveryCall("escrow.testnet", "7", 2, c);
  const wire = JSON.stringify(call.args);
  assert.ok(!wire.includes("22".repeat(32)) && !wire.includes("11".repeat(32)) && !wire.includes("invoice"));
  assert.deepEqual(Object.keys(call.args), ["agreement_id", "line_id", "evidence_commitment"]);
});
