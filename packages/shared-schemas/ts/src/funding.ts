// FT funding message v1 (schemas/ft-funding-message-v1.schema.json, FROZEN;
// contracts/escrow/src/funding.rs). Minified, exact key order:
//   {"version":1,"agreement_id":"<u64>","line_id":<0..2>,"terms_hash":"<hex64>"}
// No shared Rust vectors exist for this message yet: TS-local tests only (TS-21).

import { isCanonicalDecimal } from "./terms/fields.ts";
import { U64_MAX } from "./terms/types.ts";

const HEX64 = /^[0-9a-f]{64}$/;

export function buildFundingMsgV1(agreementId: string, lineId: number, termsHash: string): string {
  if (!isCanonicalDecimal(agreementId) || BigInt(agreementId) > U64_MAX) {
    throw new Error("agreement_id must be a canonical u64 decimal string");
  }
  if (lineId !== 0 && lineId !== 1 && lineId !== 2) throw new Error("line_id must be 0, 1 or 2");
  if (!HEX64.test(termsHash)) throw new Error("terms_hash must be 64 lowercase hex characters");
  return `{"version":1,"agreement_id":"${agreementId}","line_id":${lineId},"terms_hash":"${termsHash}"}`;
}
