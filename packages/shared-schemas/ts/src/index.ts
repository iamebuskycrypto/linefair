// Public API of the LineFair TypeScript canonical terms encoder (v1).
// The Rust contract (contracts/escrow) is the reference; see
// packages/shared-schemas/TS_ENCODER_TEST_PLAN.md.

import { parseTermsJson, type ParseFailure } from "./terms/parse.ts";
import { validateTerms, type TermsError, type TermsErrorCode } from "./terms/validate.ts";
import type { AgreementTermsV1, ValidationContext } from "./terms/types.ts";

export * from "./terms/types.ts";
export { parseStrictJson, JsonSyntaxError, type JsonValue } from "./terms/json.ts";
export {
  isCanonicalDecimal,
  parseU64,
  parseU128,
  parseHex32,
  encodeHexLower,
  isValidAccountId,
} from "./terms/fields.ts";
export { parseTermsJson, TERMS_KEYS, LINE_KEYS, type ParseCode, type ParseFailure, type ParseResult } from "./terms/parse.ts";
export { validateTerms, acceleratedTestTiming, type TermsError, type TermsErrorCode, type Role, type Window } from "./terms/validate.ts";
export { termsPreimage, termsHashHex, sha256, assertNetwork, TERMS_DOMAIN_V1, DOMAIN_SEPARATOR } from "./terms/encode.ts";
export { termsToJson, termsToJsonText } from "./terms/serialize.ts";
export { buildFundingMsgV1 } from "./funding.ts";

export interface ValidateFailure {
  readonly ok: false;
  readonly stage: "validate";
  readonly code: TermsErrorCode;
  readonly error: TermsError;
}

export type TermsOutcome =
  | { readonly ok: true; readonly terms: AgreementTermsV1 }
  | ParseFailure
  | ValidateFailure;

/** `terms_json.rs::parse_and_validate`: parse, then validate (stage + code as in Rust). */
export function parseAndValidate(text: string, ctx: ValidationContext): TermsOutcome {
  const p = parseTermsJson(text);
  if (!p.ok) return p;
  const e = validateTerms(p.terms, ctx);
  if (e !== null) return { ok: false, stage: "validate", code: e.code, error: e };
  return p;
}
