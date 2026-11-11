// TS-local cases (TS_ENCODER_TEST_PLAN.md TS-18, TS-19, TS-21 and §3 edge
// behaviour). These are NOT Rust-generated: each records the serde_json /
// Rust behaviour it mirrors, and stays "local" until the Rust generator emits
// the same case.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildFundingMsgV1,
  isValidAccountId,
  parseAndValidate,
  parseStrictJson,
  parseTermsJson,
  parseU128,
  parseU64,
  termsHashHex,
  termsPreimage,
  U128_MAX,
  U64_MAX,
  type ValidationContext,
} from "../src/index.ts";

const V = JSON.parse(readFileSync(new URL("../../vectors/terms_v1.json", import.meta.url), "utf8"));
const GOLDEN_TEXT: string = JSON.stringify(V.golden.terms);
const GOLDEN_DIGEST = "9257a5bfea49918f0a1b1a3308ad553a384079e73da987df495f55002869a33c";
const ctx: ValidationContext = {
  now_ns: BigInt(V.context.now_ns),
  escrow_id: V.context.escrow_id,
  allowlisted_ft_id: V.context.allowlisted_ft_id,
  operator_treasury_id: V.context.operator_treasury_id,
};

function golden(): Record<string, unknown> & { lines: Record<string, unknown>[] } {
  return JSON.parse(GOLDEN_TEXT);
}

function code(text: string): string {
  const r = parseAndValidate(text, ctx);
  return r.ok ? "ok" : `${r.stage}:${r.code}`;
}

test("TS-18 decimal boundaries (mirrors terms_json.rs unit tests)", () => {
  assert.deepEqual(parseU64("18446744073709551615"), { ok: true, value: U64_MAX });
  assert.deepEqual(parseU64("18446744073709551616"), { ok: false, code: "DecimalOverflow" });
  assert.deepEqual(parseU64("99999999999999999999999"), { ok: false, code: "DecimalOverflow" });
  assert.deepEqual(parseU128("340282366920938463463374607431768211455"), { ok: true, value: U128_MAX });
  assert.deepEqual(parseU128("340282366920938463463374607431768211456"), { ok: false, code: "DecimalOverflow" });
  for (const bad of ["", "00", "007", "+5", "-5", "1e3", " 5", "5 ", "5.0", "0x10", "١", "1_000", "01"]) {
    const r = bad === "01" ? parseU128(bad) : parseU64(bad);
    assert.deepEqual(r, { ok: false, code: "NonCanonicalDecimal" }, JSON.stringify(bad));
  }
  assert.deepEqual(parseU64("0"), { ok: true, value: 0n });
});

test("TS-18 Rule A: principals (MAX-1, 1) pass, (MAX, 1) fail", () => {
  const g = golden();
  g.lines = g.lines.slice(0, 2);
  g.lines[0].principal = (U128_MAX - 1n).toString();
  g.lines[1].principal = "1";
  assert.equal(code(JSON.stringify(g)), "ok");
  g.lines[0].principal = U128_MAX.toString();
  assert.equal(code(JSON.stringify(g)), "validate:PrincipalSumOverflow");
});

test("TS-18 u64 overflow checks in validate", () => {
  const g = golden();
  g.lines[0].delivery_deadline_ns = U64_MAX.toString();
  g.lines[1].delivery_deadline_ns = U64_MAX.toString();
  g.lines[2].delivery_deadline_ns = U64_MAX.toString();
  g.delivery_grace_period_ns = "1";
  assert.equal(code(JSON.stringify(g)), "validate:SubmissionCutoffOverflow");
  g.delivery_grace_period_ns = "0";
  assert.equal(code(JSON.stringify(g)), "validate:PhaseScheduleOverflow");
});

test("validate order: remaining TermsError codes are reachable", () => {
  const cases: [string, (g: ReturnType<typeof golden>) => void][] = [
    ["validate:AcceptanceDeadlineNotInFuture", (g) => (g.acceptance_deadline_ns = V.context.now_ns)],
    ["validate:FundingDeadlineBeforeAcceptance", (g) => (g.funding_deadline_ns = "1800086399999999999")],
    ["validate:DeliveryDeadlineBeforeFunding", (g) => (g.lines[0].delivery_deadline_ns = "1800172799999999999")],
    ["validate:RoleIsReservedAccount", (g) => (g.buyer_id = V.context.operator_treasury_id)],
    ["validate:RolesNotDistinct", (g) => (g.backup_arbitrator_id = g.primary_arbitrator_id)],
    ["validate:WindowOutOfRange", (g) => (g.review_window_ns = "2592000000000001")],
    ["ok", (g) => (g.review_window_ns = "60000000000")],
    ["ok", (g) => (g.delivery_grace_period_ns = "2592000000000000")],
  ];
  for (const [want, mutate] of cases) {
    const g = golden();
    mutate(g);
    assert.equal(code(JSON.stringify(g)), want, want);
  }
});

test("TS-19 key-order permutation digests to golden", async () => {
  const g = golden();
  const keys = Object.keys(g).reverse();
  const shuffled: Record<string, unknown> = {};
  for (const k of keys) shuffled[k] = g[k];
  shuffled.lines = g.lines.map((l) => Object.fromEntries(Object.entries(l).reverse()));
  const r = parseTermsJson(JSON.stringify(shuffled));
  assert.ok(r.ok);
  assert.equal(await termsHashHex("testnet", "escrow.lf-demo.testnet", r.terms), GOLDEN_DIGEST);
});

test("§3 JSON edge: integer lexemes serde_json rejects for u16/u32", () => {
  for (const lx of ["-0", "1e2", "1E2", "5000.0", "-1", "65536", "0.5", "1e0"]) {
    assert.equal(code(GOLDEN_TEXT.replace('"schema_version":1', `"schema_version":${lx}`)), "parse:Json", lx);
  }
  assert.equal(code(GOLDEN_TEXT.replace('"line_id":0', '"line_id":4294967296')), "parse:Json");
  // 4294967295 parses as u32 and is then a LineIdMismatch.
  assert.equal(code(GOLDEN_TEXT.replace('"line_id":0', '"line_id":4294967295')), "validate:LineIdMismatch");
});

test("§3 JSON edge: grammar strictness", () => {
  assert.equal(code("﻿" + GOLDEN_TEXT), "parse:Json", "BOM");
  assert.equal(code(` \t\r\n${GOLDEN_TEXT} \n`), "ok", "RFC 8259 whitespace");
  assert.equal(code(` ${GOLDEN_TEXT}`), "parse:Json", "NBSP is not JSON whitespace");
  assert.equal(code(GOLDEN_TEXT.replace(',"lines"', ',,"lines"')), "parse:Json");
  assert.equal(code(GOLDEN_TEXT.slice(0, -1) + ",}"), "parse:Json", "trailing comma");
  assert.equal(code(GOLDEN_TEXT.replace('"buyer_id"', "'buyer_id'")), "parse:Json", "single quotes");
  assert.equal(code(GOLDEN_TEXT.replace("buyer.lf", "buyer\\u0000.lf")), "parse:InvalidAccountId", "escaped NUL decodes, then fails AccountId");
  assert.equal(code(GOLDEN_TEXT.replace("buyer.lf", "buyer\u0001.lf")), "parse:Json", "raw control char");
  assert.equal(code(GOLDEN_TEXT.replace("buyer.lf", "buyer\\ud800.lf")), "parse:Json", "lone leading surrogate escape");
  assert.equal(code(GOLDEN_TEXT.replace("buyer.lf", "buyer\\udc00.lf")), "parse:Json", "lone trailing surrogate escape");
  assert.equal(code(GOLDEN_TEXT.replace("buyer.lf", "buyer\ud800.lf")), "parse:Json", "raw unpaired surrogate");
  assert.equal(code(GOLDEN_TEXT.replace("buyer.lf", "buyer\\x41.lf")), "parse:Json", "invalid escape");
});

test("§3 JSON edge: escapes decode before the AccountId / key check (serde behaviour)", async () => {
  const esc = GOLDEN_TEXT.replace('"buyer.lf', '"\\u0062uyer.lf').replace('"schema_version"', '"schema\\u005fversion"');
  const r = parseTermsJson(esc);
  assert.ok(r.ok);
  assert.equal(await termsHashHex("testnet", "escrow.lf-demo.testnet", r.terms), GOLDEN_DIGEST);
});

test("§3 JSON edge: positional array form is rejected (stricter than serde visit_seq, see parse.ts)", () => {
  const g = golden();
  const positional = JSON.stringify([...Object.values(g).slice(0, 15), g.lines.map((l) => Object.values(l))]);
  assert.equal(code(positional), "parse:Json");
});

test("§3 JSON edge: depth limit and nested garbage", () => {
  const deep = "[".repeat(200) + "]".repeat(200);
  assert.throws(() => parseStrictJson(deep), /recursion limit/);
  assert.equal(code(GOLDEN_TEXT.replace('"buyer.lf-demo.testnet"', "[[[[]]]]")), "parse:Json");
});

test("§3 conversion precedence follows TryFrom order", () => {
  const g = golden();
  g.agreement_nonce = "01"; // NonCanonicalDecimal (later field)
  g.supplier_id = "Bad"; // InvalidAccountId (earlier field)
  assert.equal(code(JSON.stringify(g)), "parse:InvalidAccountId");
  const h = golden();
  h.lines[0].acceptance_criteria_commitment = "zz"; // line 0, last converted field
  h.lines[1].principal = "x"; // line 1
  assert.equal(code(JSON.stringify(h)), "parse:InvalidCommitmentHex");
  const k = golden();
  k.lines[2].principal = "x"; // conversion error
  (k as Record<string, unknown>).extra = 1; // structural error wins (serde runs first)
  assert.equal(code(JSON.stringify(k)), "parse:Json");
});

test("account ids (near-account-id 2.6.0 rules)", () => {
  for (const ok of ["ab", "a-b_c.d", "0", "a".repeat(64), "buyer.lf-demo.testnet", "a1.b2"].filter((s) => s.length >= 2)) {
    assert.ok(isValidAccountId(ok), ok);
  }
  for (const bad of ["a", "", "a".repeat(65), "-a", "a-", "a..b", "a-.b", "A", "a b", "é.testnet", "a.", ".a"]) {
    assert.ok(!isValidAccountId(bad), JSON.stringify(bad));
  }
});

test("encoder refuses mainnet and invalid escrow ids", () => {
  const r = parseTermsJson(GOLDEN_TEXT);
  assert.ok(r.ok);
  assert.throws(() => termsPreimage("mainnet" as "testnet", "escrow.near", r.terms), /only sandbox and testnet/);
  assert.throws(() => termsPreimage("testnet", "Escrow", r.terms), /valid NEAR account/);
  assert.throws(() => termsPreimage("testnet", "escrow.lf-demo.testnet", { ...r.terms, agreement_nonce: -1n }), RangeError);
  assert.throws(() => termsPreimage("testnet", "escrow.lf-demo.testnet", { ...r.terms, schema_version: 70000 }), RangeError);
});

test("TS-21 funding message v1 builder", () => {
  const h = GOLDEN_DIGEST;
  assert.equal(buildFundingMsgV1("0", 2, h), `{"version":1,"agreement_id":"0","line_id":2,"terms_hash":"${h}"}`);
  assert.equal(buildFundingMsgV1("18446744073709551615", 0, h), `{"version":1,"agreement_id":"18446744073709551615","line_id":0,"terms_hash":"${h}"}`);
  assert.throws(() => buildFundingMsgV1("18446744073709551616", 0, h));
  assert.throws(() => buildFundingMsgV1("01", 0, h));
  assert.throws(() => buildFundingMsgV1("1", 3, h));
  assert.throws(() => buildFundingMsgV1("1", 0, h.toUpperCase()));
});
