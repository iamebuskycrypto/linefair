// Strict JSON edge -> AgreementTermsV1, mirroring terms_json.rs
// (`parse_terms_json` = serde_json::from_str into AgreementTermsJsonV1 with
// deny_unknown_fields, then `TryFrom` in fixed field order).
//
// Two passes, because serde reports every structural/type error (`Json`)
// before any field conversion runs:
//   pass 1: grammar, object shape, exact key sets, value kinds, u16/u32 ranges
//   pass 2: account ids, decimals, commitments, in TryFrom order; first failure wins.
//
// Known, deliberate strictness difference from Rust (reported, not hidden):
// serde's derived struct visitor also accepts a JSON *array* in field order
// (`visit_seq`). This parser accepts only the object form, the form the
// schema (`schemas/agreement-terms-v1.schema.json`) and docs/20 define.
// Rejecting a form Rust would accept can never make the UI sign a hash for
// different terms; it can only refuse to proceed.

import { JsonSyntaxError, parseStrictJson, type JsonValue } from "./json.ts";
import { isValidAccountId, parseHex32, parseU128, parseU64 } from "./fields.ts";
import { U16_MAX, U32_MAX, type AgreementTermsV1, type LineTermsV1 } from "./types.ts";

export type ParseCode =
  | "Json"
  | "InvalidAccountId"
  | "NonCanonicalDecimal"
  | "DecimalOverflow"
  | "InvalidCommitmentHex";

export interface ParseFailure {
  readonly ok: false;
  readonly stage: "parse";
  readonly code: ParseCode;
  /** JSON key (as in Rust `field`), or a short description for `Json`. */
  readonly detail: string;
}

export type ParseResult = { readonly ok: true; readonly terms: AgreementTermsV1 } | ParseFailure;

export const TERMS_KEYS = [
  "schema_version",
  "deadline_rules_version",
  "buyer_id",
  "supplier_id",
  "primary_arbitrator_id",
  "backup_arbitrator_id",
  "ft_contract_id",
  "agreement_nonce",
  "acceptance_deadline_ns",
  "funding_deadline_ns",
  "delivery_grace_period_ns",
  "review_window_ns",
  "negotiation_window_ns",
  "primary_window_ns",
  "backup_window_ns",
  "lines",
] as const;

export const LINE_KEYS = [
  "line_id",
  "principal",
  "delivery_deadline_ns",
  "acceptance_criteria_commitment",
  "fallback_buyer_bps",
  "fallback_supplier_bps",
] as const;

class ShapeError extends Error {}

function shape(msg: string): never {
  throw new ShapeError(msg);
}

type Obj = ReadonlyMap<string, JsonValue>;

function exactObject(v: JsonValue, keys: readonly string[], what: string): Obj {
  if (v.kind !== "object") shape(`${what}: expected object, found ${v.kind}`);
  for (const k of v.entries.keys()) {
    if (!keys.includes(k)) shape(`${what}: unknown field \`${k}\``);
  }
  for (const k of keys) {
    if (!v.entries.has(k)) shape(`${what}: missing field \`${k}\``);
  }
  return v.entries;
}

function get(o: Obj, k: string): JsonValue {
  const v = o.get(k);
  if (v === undefined) return shape(`missing field \`${k}\``);
  return v;
}

function str(o: Obj, k: string): string {
  const v = get(o, k);
  if (v.kind !== "string") shape(`${k}: invalid type ${v.kind}, expected a string`);
  return v.value;
}

/**
 * serde unsigned integer from a JSON number: the lexeme must be a
 * non-negative integer without fraction or exponent (serde_json turns those,
 * `-0` and > u64 values into f64 -> invalid type) and within `max`.
 */
function uint(o: Obj, k: string, max: number): number {
  const v = get(o, k);
  if (v.kind !== "number") shape(`${k}: invalid type ${v.kind}, expected an integer`);
  const lx = v.lexeme;
  let n = 0;
  if (lx.length === 0 || lx.length > 10 || (lx.length > 1 && lx.charCodeAt(0) === 0x30)) {
    shape(`${k}: invalid value ${lx}`);
  }
  for (let i = 0; i < lx.length; i++) {
    const c = lx.charCodeAt(i);
    if (c < 0x30 || c > 0x39) shape(`${k}: invalid value ${lx}`);
    n = n * 10 + (c - 0x30);
  }
  if (n > max) shape(`${k}: invalid value ${lx}, out of range`);
  return n;
}

interface RawLine {
  line_id: number;
  principal: string;
  delivery_deadline_ns: string;
  acceptance_criteria_commitment: string;
  fallback_buyer_bps: number;
  fallback_supplier_bps: number;
}

interface Raw {
  schema_version: number;
  deadline_rules_version: number;
  ids: [string, string, string, string, string];
  u64s: string[]; // agreement_nonce .. backup_window_ns, in key order
  lines: RawLine[];
}

const ID_KEYS = TERMS_KEYS.slice(2, 7);
const U64_KEYS = TERMS_KEYS.slice(7, 15);

function pass1(doc: JsonValue): Raw {
  const o = exactObject(doc, TERMS_KEYS, "terms");
  const schema_version = uint(o, "schema_version", U16_MAX);
  const deadline_rules_version = uint(o, "deadline_rules_version", U16_MAX);
  const ids = ID_KEYS.map((k) => str(o, k)) as Raw["ids"];
  const u64s = U64_KEYS.map((k) => str(o, k));
  const linesV = get(o, "lines");
  if (linesV.kind !== "array") shape(`lines: invalid type ${linesV.kind}, expected a sequence`);
  const lines = linesV.items.map((item, idx): RawLine => {
    const l = exactObject(item, LINE_KEYS, `lines[${idx}]`);
    return {
      line_id: uint(l, "line_id", U32_MAX),
      principal: str(l, "principal"),
      delivery_deadline_ns: str(l, "delivery_deadline_ns"),
      acceptance_criteria_commitment: str(l, "acceptance_criteria_commitment"),
      fallback_buyer_bps: uint(l, "fallback_buyer_bps", U16_MAX),
      fallback_supplier_bps: uint(l, "fallback_supplier_bps", U16_MAX),
    };
  });
  return { schema_version, deadline_rules_version, ids, u64s, lines };
}

function fail(code: ParseCode, detail: string): ParseFailure {
  return { ok: false, stage: "parse", code, detail };
}

/** Pass 2: `TryFrom<&AgreementTermsJsonV1>` in the exact Rust order. */
function pass2(r: Raw): ParseResult {
  for (let k = 0; k < ID_KEYS.length; k++) {
    if (!isValidAccountId(r.ids[k])) return fail("InvalidAccountId", ID_KEYS[k]);
  }
  const u64v: bigint[] = [];
  for (let k = 0; k < U64_KEYS.length; k++) {
    const d = parseU64(r.u64s[k]);
    if (!d.ok) return fail(d.code, U64_KEYS[k]);
    u64v.push(d.value);
  }
  const lines: LineTermsV1[] = [];
  for (const l of r.lines) {
    const p = parseU128(l.principal);
    if (!p.ok) return fail(p.code, "principal");
    const dd = parseU64(l.delivery_deadline_ns);
    if (!dd.ok) return fail(dd.code, "delivery_deadline_ns");
    const c = parseHex32(l.acceptance_criteria_commitment);
    if (c === null) return fail("InvalidCommitmentHex", "acceptance_criteria_commitment");
    lines.push({
      line_id: l.line_id,
      principal: p.value,
      delivery_deadline_ns: dd.value,
      acceptance_criteria_commitment: c,
      fallback_buyer_bps: l.fallback_buyer_bps,
      fallback_supplier_bps: l.fallback_supplier_bps,
    });
  }
  const [buyer_id, supplier_id, primary_arbitrator_id, backup_arbitrator_id, ft_contract_id] = r.ids;
  const [
    agreement_nonce,
    acceptance_deadline_ns,
    funding_deadline_ns,
    delivery_grace_period_ns,
    review_window_ns,
    negotiation_window_ns,
    primary_window_ns,
    backup_window_ns,
  ] = u64v as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  return {
    ok: true,
    terms: {
      schema_version: r.schema_version,
      deadline_rules_version: r.deadline_rules_version,
      buyer_id,
      supplier_id,
      primary_arbitrator_id,
      backup_arbitrator_id,
      ft_contract_id,
      agreement_nonce,
      acceptance_deadline_ns,
      funding_deadline_ns,
      delivery_grace_period_ns,
      review_window_ns,
      negotiation_window_ns,
      primary_window_ns,
      backup_window_ns,
      lines,
    },
  };
}

/** `terms_json.rs::parse_terms_json`: JSON text -> terms (no semantic validation). */
export function parseTermsJson(text: string): ParseResult {
  let raw: Raw;
  try {
    raw = pass1(parseStrictJson(text));
  } catch (e) {
    if (e instanceof JsonSyntaxError || e instanceof ShapeError) return fail("Json", e.message);
    throw e;
  }
  return pass2(raw);
}
