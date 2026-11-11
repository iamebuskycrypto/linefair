// Error mapping tests. Code lists are cross-checked against read-only copies
// of the Rust sources on main (apps/web/fixtures/contract-main, commit and
// sha256 recorded in MANIFEST.json) so this table cannot invent codes or
// silently miss one. This branch's own contracts/ is older and is not used.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  describeError,
  describeErrorCode,
  describeRefund,
  extractErrorCode,
  KNOWN_ERROR_CODES,
  KNOWN_REFUND_CODES,
  ANTICIPATED_REFUND_CODES,
  KNOWN_TERMS_INVALID_CODES,
  REFUND_COPY,
} from "./errors.ts";

const FIXTURE = new URL("../../../fixtures/contract-main/", import.meta.url);
const SRC = new URL("src/", FIXTURE);
const rs = (f: string) => readFileSync(new URL(f, SRC), "utf8");
const MANIFEST = JSON.parse(readFileSync(new URL("MANIFEST.json", FIXTURE), "utf8")) as {
  source_commit: string;
  contract_version: string;
  files_sha256: Record<string, string>;
};

/** String literals returned by a `fn code(...)` match in a Rust file, limited to one enum's arms. */
function codesOf(file: string, enumName: string): string[] {
  const re = new RegExp(`${enumName}::\\w+(?:\\s*(?:\\{[^}]*\\}|\\([^)]*\\)))?\\s*=>\\s*"([A-Za-z]+)"`, "g");
  return [...rs(file).matchAll(re)].map((m) => m[1]);
}

test("contract fixture is the unmodified main 8ec0816 (lf-012 f3) copy", () => {
  assert.equal(MANIFEST.source_commit, "8ec081679b4b5d4e1dbaaca54acd93cad0583b3b");
  assert.equal(MANIFEST.contract_version, "linefair-escrow 0.1.0 (lf-012 f3)");
  assert.ok(rs("lib.rs").includes(`"${MANIFEST.contract_version}"`));
  for (const [file, sha] of Object.entries(MANIFEST.files_sha256)) {
    const got = createHash("sha256").update(readFileSync(new URL(file, FIXTURE))).digest("hex");
    assert.equal(got, sha, `${file} differs from MANIFEST.json`);
  }
});

/** Body of `fn code(...)` inside `impl <typeName>` — the only place codes are produced. */
function codeFnBody(file: string, typeName: string): string {
  const src = rs(file);
  const start = src.indexOf(`impl ${typeName} {`);
  assert.ok(start >= 0, `impl ${typeName} not found in ${file}`);
  const fnAt = src.indexOf("fn code(", start);
  assert.ok(fnAt >= 0, `${typeName}::code not found`);
  const end = src.indexOf("\n    }\n", fnAt);
  return src.slice(fnAt, end);
}

/** Every string literal returned by `<typeName>::code()` (arms of the match). */
function codeStrings(file: string, typeName: string): string[] {
  return [...codeFnBody(file, typeName).matchAll(/=>\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
}

test("drift: every LineError / LineOpError code on main has explicit ERR_LINE copy", () => {
  const line = codeStrings("line.rs", "LineError");
  const op = codeStrings("agreement.rs", "LineOpError");
  // sanity: the extraction really sees the LF-007 codes and the op codes
  for (const c of ["StaleProposal", "ProposalMismatch", "NoActiveProposal", "OwnProposal", "ProposalNonceOverflow", "AllocationSumMismatch"]) {
    assert.ok(line.includes(c), `extractor missed ${c}`);
  }
  assert.deepEqual(op, ["LineNotFound", "AgreementNotAgreed", "NotAuthorized"]);
  for (const c of ["NotRulingWindow", "FallbackNotEligible"]) assert.ok(line.includes(c), `extractor missed LF-008 ${c}`);
  assert.ok(line.includes("DeliveryTimeTooShort"), "extractor missed F3 DeliveryTimeTooShort");
  assert.equal(line.length, 31, `parsed ${line.length} LineError codes (main 8ec0816 has 31 arms: 30 + F3 DeliveryTimeTooShort)`);
  for (const c of [...line, ...op]) {
    const d = describeErrorCode(`ERR_LINE:${c}`);
    assert.equal(d.unknown, false, `ERR_LINE:${c} has no mapping`);
    assert.ok(KNOWN_ERROR_CODES.includes(`ERR_LINE:${c}`), `ERR_LINE:${c} not in table`);
  }
});

test("drift: every ParseError code is mapped under ERR_TERMS_PARSE and ERR_AMOUNT_FORMAT", () => {
  const parse = codeStrings("terms_json.rs", "ParseError");
  assert.deepEqual(parse, ["Json", "InvalidAccountId", "NonCanonicalDecimal", "DecimalOverflow", "InvalidCommitmentHex"]);
  for (const c of parse) {
    assert.equal(describeErrorCode(`ERR_TERMS_PARSE:${c}`).unknown, false);
    assert.equal(describeErrorCode(`ERR_AMOUNT_FORMAT:${c}`).unknown, false);
  }
  // the two the amount parsers can actually produce have specific copy
  assert.ok(KNOWN_ERROR_CODES.includes("ERR_AMOUNT_FORMAT:NonCanonicalDecimal"));
  assert.ok(KNOWN_ERROR_CODES.includes("ERR_AMOUNT_FORMAT:DecimalOverflow"));
});

test("drift: every panic area and literal code in lib.rs on main is mapped", () => {
  const lib = rs("lib.rs");
  const areas = new Set([...lib.matchAll(/fail\("(ERR_[A-Z_]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...areas].sort(), ["ERR_ACCEPT", "ERR_AMOUNT_FORMAT", "ERR_LINE", "ERR_TERMS_INVALID", "ERR_TERMS_PARSE", "ERR_WITHDRAW"]);
  // LF-009: every literal ERR_WITHDRAW code is mapped, and the table invents none
  const withdraw = [...new Set([...lib.matchAll(/fail\("ERR_WITHDRAW",\s*"([A-Za-z]+)"\)/g)].map((m) => `ERR_WITHDRAW:${m[1]}`))].sort();
  assert.deepEqual(withdraw, [
    "ERR_WITHDRAW:BadBeneficiary",
    "ERR_WITHDRAW:CallbackNotPrivate",
    "ERR_WITHDRAW:DepositMustBeOneYocto",
    "ERR_WITHDRAW:IdOverflow",
    "ERR_WITHDRAW:InsufficientGas",
    "ERR_WITHDRAW:OpenCountOverflow",
  ]);
  assert.deepEqual(KNOWN_ERROR_CODES.filter((c) => c.startsWith("ERR_WITHDRAW:")).sort(), withdraw);
  for (const c of withdraw) {
    const d = describeErrorCode(c);
    assert.equal(d.unknown, false, c);
    assert.match(`${d.title} ${d.action}`, /Nothing was changed|rejected/, c);
    assert.doesNotMatch(`${d.title} ${d.action}`, /\bpaid\b/i, c);
  }
  assert.equal(extractErrorCode("Smart contract panicked: ERR_WITHDRAW:InsufficientGas"), "ERR_WITHDRAW:InsufficientGas");
  const literals = new Set(
    [...lib.matchAll(/(?:panic_str\(|require!\([^;]*?,\s*)"(ERR_[A-Z_]+)"/g)].map((m) => m[1]),
  );
  assert.ok(literals.has("ERR_AGREEMENT_NOT_FOUND") && literals.has("ERR_NOT_BUYER"));
  // LF-010A: the creator gate is a literal panic_str code
  assert.ok(literals.has("ERR_CREATOR_NOT_ALLOWLISTED"));
  for (const c of literals) {
    if (c.startsWith("ERR_INIT_")) continue;
    assert.equal(describeErrorCode(c).unknown, false, `${c} has no mapping`);
  }
  // init-only codes (panic in `new`, i.e. the deployment transaction; the UI never calls new):
  // pinned so a new one is noticed, deliberately not in the user-facing table
  const init = [...literals].filter((c) => c.startsWith("ERR_INIT_")).sort();
  assert.deepEqual(init.filter((c) => c.startsWith("ERR_INIT_CREATOR_")), [
    "ERR_INIT_CREATOR_ALLOWLIST_DUPLICATE",
    "ERR_INIT_CREATOR_ALLOWLIST_RESERVED",
    "ERR_INIT_CREATOR_ALLOWLIST_SIZE",
  ]);
  for (const c of init) assert.equal(KNOWN_ERROR_CODES.includes(c), false, c);
});

test("LF-010A ERR_CREATOR_NOT_ALLOWLISTED: user copy, nothing changed, points to supplier/arbitrator roles", () => {
  const d = describeErrorCode("ERR_CREATOR_NOT_ALLOWLISTED");
  assert.equal(d.unknown, false);
  assert.equal(d.severity, "user");
  assert.match(d.title, /not an authorized testnet creator/);
  assert.match(d.action, /^Nothing was changed\./);
  assert.match(d.action, /supplier or arbitrator/);
  assert.equal(extractErrorCode("Smart contract panicked: ERR_CREATOR_NOT_ALLOWLISTED"), "ERR_CREATOR_NOT_ALLOWLISTED");
  assert.equal(describeError('{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ERR_CREATOR_NOT_ALLOWLISTED"}}}}').code, "ERR_CREATOR_NOT_ALLOWLISTED");
});

test("LF-007 settlement codes have specific copy", () => {
  for (const c of ["StaleProposal", "ProposalMismatch", "NotAuthorized", "NoActiveProposal", "AlreadyFinalized", "OwnProposal", "AllocationSumMismatch", "BeforeWindowStart", "WrongState", "LineNotFound"]) {
    const d = describeErrorCode(`ERR_LINE:${c}`);
    assert.equal(d.unknown, false, c);
  }
  assert.match(describeErrorCode("ERR_LINE:StaleProposal").action, /Nothing was accepted/);
  assert.match(describeErrorCode("ERR_LINE:ProposalMismatch").action, /Nothing was accepted/);
  assert.equal(describeErrorCode("ERR_LINE:ProposalNonceOverflow").severity, "incident");
  assert.equal(describeErrorCode("ERR_AGREEMENT_NOT_FOUND").unknown, false);
  assert.equal(extractErrorCode("Smart contract panicked: ERR_AMOUNT_FORMAT:NonCanonicalDecimal"), "ERR_AMOUNT_FORMAT:NonCanonicalDecimal");
  assert.equal(describeErrorCode("ERR_AMOUNT_FORMAT:NonCanonicalDecimal").severity, "client_bug");
});

test("LF-008 ruling/fallback codes have specific copy that never implies a decision", () => {
  const w = describeErrorCode("ERR_LINE:NotRulingWindow");
  assert.equal(w.unknown, false);
  assert.equal(w.severity, "user");
  assert.match(w.title, /primary arbitrator may rule only in the primary window/);
  assert.match(w.action, /Nothing was decided/);
  const f = describeErrorCode("ERR_LINE:FallbackNotEligible");
  assert.equal(f.unknown, false);
  assert.match(f.title, /not available yet/);
  assert.match(f.action, /Nothing was decided/);
  assert.equal(extractErrorCode("Smart contract panicked: ERR_LINE:NotRulingWindow"), "ERR_LINE:NotRulingWindow");
  // still an incident: unreachable from trigger_fallback, which computes the split itself
  assert.equal(describeErrorCode("ERR_LINE:FallbackMismatch").severity, "incident");
});

test("extractErrorCode takes the exact code token", () => {
  assert.equal(extractErrorCode("Smart contract panicked: ERR_LINE:NotEligible"), "ERR_LINE:NotEligible");
  assert.equal(
    extractErrorCode('{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ERR_LINE:NotAdvanceable"}}}}'),
    "ERR_LINE:NotAdvanceable",
  );
  assert.equal(extractErrorCode("Smart contract panicked: ERR_NOT_BUYER"), "ERR_NOT_BUYER");
  assert.equal(extractErrorCode("ERR_TERMS_INVALID:PrincipalSumOverflow"), "ERR_TERMS_INVALID:PrincipalSumOverflow");
  assert.equal(extractErrorCode("user rejected the request"), null);
});

test("advance_case codes (founder-approved 2026-11-03) have specific copy", () => {
  const early = describeErrorCode("ERR_LINE:NotEligible");
  assert.equal(early.unknown, false);
  assert.match(early.title, /Not eligible yet/);
  assert.match(early.action, /Wait/);
  const wrong = describeErrorCode("ERR_LINE:NotAdvanceable");
  assert.equal(wrong.unknown, false);
  assert.match(wrong.title, /cannot be advanced/);
  assert.match(wrong.title, /already have been advanced/);
  assert.notEqual(early.title, wrong.title);
  // both exist in the contract source exactly as mapped
  const lineCodes = codesOf("line.rs", "LineError");
  assert.ok(lineCodes.includes("NotEligible") && lineCodes.includes("NotAdvanceable"));
});

test("every ERR_LINE / ERR_ACCEPT / ERR_WITHDRAW entry exists in the Rust sources", () => {
  const line = new Set([...codesOf("line.rs", "LineError"), ...codesOf("agreement.rs", "LineOpError")]);
  const accept = new Set(codesOf("agreement.rs", "AcceptError"));
  assert.ok(line.size >= 20, `parsed ${line.size} line codes`);
  assert.equal(accept.size, 4);
  for (const c of KNOWN_ERROR_CODES) {
    if (c.startsWith("ERR_LINE:")) assert.ok(line.has(c.slice(9)), `${c} not in line.rs/agreement.rs`);
    else if (c.startsWith("ERR_ACCEPT:")) assert.ok(accept.has(c.slice(11)), `${c} not in agreement.rs`);
    else if (c.startsWith("ERR_AMOUNT_FORMAT:")) {
      assert.ok(rs("lib.rs").includes('fail("ERR_AMOUNT_FORMAT"'));
      assert.ok(codesOf("terms_json.rs", "ParseError").includes(c.slice(18)), `${c} not a ParseError code`);
    }
    else if (c.startsWith("ERR_WITHDRAW:")) assert.ok(rs("lib.rs").includes(`fail("ERR_WITHDRAW", "${c.slice(13)}")`), `${c} not in lib.rs`);
    else assert.ok(rs("lib.rs").includes(`"${c}"`), `${c} not in lib.rs`);
  }
  for (const c of accept) assert.ok(KNOWN_ERROR_CODES.includes(`ERR_ACCEPT:${c}`), `missing ERR_ACCEPT:${c}`);
});

test("every line error reachable from the LF-006/006b entry points has explicit copy", () => {
  const reachable = [
    "LineNotFound", "AgreementNotAgreed", "NotAuthorized", "WrongState", "FundingDeadlinePassed",
    "SubmissionDeadlinePassed", "ReviewWindowClosed", "BeforeWindowStart", "DeadlineOverflow",
    "NotEligible", "NotAdvanceable", "AmountMismatch", "ZeroCommitment",
  ];
  for (const c of reachable) assert.equal(describeErrorCode(`ERR_LINE:${c}`).unknown, false, c);
  // internal codes are incidents, never success
  assert.equal(describeErrorCode("ERR_LINE:InvariantViolated").severity, "incident");
  // a code the contract does not have falls back to generic copy that never claims success
  const g = describeErrorCode("ERR_LINE:SomethingNew");
  assert.equal(g.unknown, true);
  assert.match(g.title, /Nothing was changed/);
});

test("every TermsError code from terms.rs has field-level copy", () => {
  const codes = codesOf("terms.rs", "TermsError");
  assert.equal(codes.length, 18);
  assert.ok(codes.includes("PrincipalSumOverflow"));
  assert.deepEqual([...KNOWN_TERMS_INVALID_CODES].sort(), [...codes].sort());
  for (const c of codes) {
    const d = describeErrorCode(`ERR_TERMS_INVALID:${c}`);
    assert.equal(d.unknown, false);
    assert.doesNotMatch(d.title, /were rejected \(/, c);
  }
  assert.match(describeErrorCode("ERR_TERMS_INVALID:AcceptanceDeadlineNotInFuture").title, /later acceptance deadline/);
  assert.equal(describeErrorCode("ERR_TERMS_PARSE:Json").severity, "client_bug");
});

test("every funding refund code has a reason; unknown/overflow refunds are incidents", () => {
  const msgCodes = codesOf("funding.rs", "FundingMsgError");
  const lib = rs("lib.rs");
  const direct = [...lib.matchAll(/Err\("([A-Za-z]+)"\)|ok_or\("([A-Za-z]+)"\)/g)].map((m) => m[1] ?? m[2]);
  const line = ["LineNotFound", "AgreementNotAgreed", "NotAuthorized", "WrongState", "FundingDeadlinePassed", "AmountMismatch"];
  for (const c of [...msgCodes, ...direct, ...line]) assert.ok(KNOWN_REFUND_CODES.includes(c), `refund ${c}`);
  const r = describeRefund(["something", "LF_FT_REFUND:AmountMismatch"]);
  assert.ok(r);
  assert.equal(r.title, REFUND_COPY);
  assert.equal(r.incident, false);
  assert.equal(describeRefund(["LF_FT_REFUND:CustodyOverflow"])?.incident, true);
  assert.equal(describeRefund(["LF_FT_REFUND:Brand"])?.incident, true);
  assert.equal(describeRefund(["EVENT_JSON:{}"]), null);
});

test("unknown messages never imply success", () => {
  const d = describeError("network timeout");
  assert.equal(d.code, "UNKNOWN");
  assert.match(d.action, /may still be processing/);
  assert.equal(describeError("Smart contract panicked: ERR_SOMETHING_NEW").unknown, true);
});

test("F3: DeliveryTimeTooShort is in the fixture contract; no refund code is mapped ahead of it", () => {
  const lib = rs("lib.rs");
  const funding = rs("funding.rs");
  const line = rs("line.rs") + rs("agreement.rs");
  const notInFixture = KNOWN_REFUND_CODES.filter((c) => !lib.includes(`"${c}"`) && !funding.includes(`"${c}"`) && !line.includes(`"${c}"`));
  assert.deepEqual(notInFixture, []);
  assert.deepEqual(ANTICIPATED_REFUND_CODES, []);
  assert.ok(line.includes('"DeliveryTimeTooShort"'));
  const r = describeRefund(["LF_FT_REFUND:DeliveryTimeTooShort"]);
  assert.ok(r);
  assert.equal(r.title, REFUND_COPY);
  assert.equal(r.reason, "Too late to fund: the supplier would have less than the review window to deliver.");
  assert.equal(r.incident, false);
});
