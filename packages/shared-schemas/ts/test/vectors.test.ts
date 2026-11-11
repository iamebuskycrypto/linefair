// TS-01 … TS-17 (packages/shared-schemas/TS_ENCODER_TEST_PLAN.md §6) against
// the Rust-generated vectors. The vector file is read-only: expectations come
// from it and are never adjusted here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  acceleratedTestTiming,
  encodeHexLower,
  parseAndValidate,
  parseTermsJson,
  termsHashHex,
  termsPreimage,
  termsToJsonText,
  validateTerms,
  type AgreementTermsV1,
  type NetworkId,
  type ValidationContext,
} from "../src/index.ts";

interface HashedVector {
  id: string;
  label: string;
  network: NetworkId;
  escrow_id: string;
  terms: unknown;
  preimage_hex: string;
  digest_hex: string;
  validation: string;
  accelerated_test_timing: boolean;
}
interface Malformed {
  id: string;
  label: string;
  json_text: string;
  expect: { accept: boolean; stage: "parse" | "validate"; code: string };
}
interface Equivalence {
  label: string;
  json_text: string;
  digest_hex: string;
}
interface VectorFile {
  encoding: { domain_ascii: string; separator_hex: string };
  context: { network: NetworkId; escrow_id: string; allowlisted_ft_id: string; operator_treasury_id: string; now_ns: string };
  golden: HashedVector;
  field_mutations: HashedVector[];
  reordered_lines: HashedVector[];
  binding: HashedVector[];
  identical_preimage: HashedVector;
  json_equivalence: Equivalence[];
  malformed: Malformed[];
}

const VECTORS_URL = new URL("../../vectors/terms_v1.json", import.meta.url);
const raw = readFileSync(VECTORS_URL, "utf8");
// The vector *file* (not terms input) is read with JSON.parse. That is lossless
// here because every u64/u128 inside it is a string; asserted below.
const V = JSON.parse(raw) as VectorFile;

const ctx: ValidationContext = {
  now_ns: BigInt(V.context.now_ns),
  escrow_id: V.context.escrow_id,
  allowlisted_ft_id: V.context.allowlisted_ft_id,
  operator_treasury_id: V.context.operator_treasury_id,
};

const GOLDEN_DIGEST = "9257a5bfea49918f0a1b1a3308ad553a384079e73da987df495f55002869a33c";

function noUnsafeNumbers(v: unknown, path: string): void {
  if (typeof v === "number") assert.ok(Number.isSafeInteger(v), `unsafe number at ${path}`);
  else if (Array.isArray(v)) v.forEach((x, i) => noUnsafeNumbers(x, `${path}[${i}]`));
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) noUnsafeNumbers(x, `${path}.${k}`);
}

function parseVectorTerms(v: HashedVector): AgreementTermsV1 {
  noUnsafeNumbers(v.terms, v.label);
  const r = parseTermsJson(JSON.stringify(v.terms));
  assert.ok(r.ok, `${v.label}: strict parse failed: ${r.ok ? "" : `${r.code} ${r.detail}`}`);
  return r.terms;
}

const results: { section: string; index: number; label: string; outcome: string }[] = [];

async function checkHashed(section: string, index: number, v: HashedVector): Promise<string> {
  const t = parseVectorTerms(v);
  const pre = encodeHexLower(termsPreimage(v.network, v.escrow_id, t));
  assert.equal(pre, v.preimage_hex, `${section}[${index}] ${v.label}: preimage`);
  const d = await termsHashHex(v.network, v.escrow_id, t);
  assert.equal(d, v.digest_hex, `${section}[${index}] ${v.label}: digest`);
  const e = validateTerms(t, ctx);
  assert.equal(e === null ? "ok" : e.code, v.validation, `${section}[${index}] ${v.label}: validation`);
  assert.equal(acceleratedTestTiming(t), v.accelerated_test_timing, `${section}[${index}] ${v.label}: accelerated`);
  // TS-17 round trip: serialize -> strict parse -> same digest
  const again = parseTermsJson(termsToJsonText(t));
  assert.ok(again.ok);
  assert.equal(await termsHashHex(v.network, v.escrow_id, again.terms), d, `${v.label}: round trip`);
  results.push({ section, index, label: v.label, outcome: `digest ${d.slice(0, 8)}… validation ${v.validation}` });
  return d;
}

test("TS-01 vector file sanity and section counts", () => {
  assert.equal(V.encoding.domain_ascii, "linefair/agreement/v1");
  assert.equal(V.encoding.separator_hex, "00");
  assert.equal(V.context.network, "testnet");
  assert.ok(V.golden && !Array.isArray(V.golden));
  assert.equal(V.field_mutations.length, 22);
  assert.equal(V.reordered_lines.length, 2);
  assert.equal(V.binding.length, 3);
  assert.ok(V.identical_preimage && !Array.isArray(V.identical_preimage));
  assert.equal(V.json_equivalence.length, 2);
  assert.equal(V.malformed.length, 39);
});

test("TS-02/03/04 golden preimage, digest, validation", async () => {
  const d = await checkHashed("golden", 0, V.golden);
  assert.equal(d, GOLDEN_DIGEST);
  assert.equal(V.golden.validation, "ok");
  assert.equal(V.golden.accelerated_test_timing, false);
});

test("TS-05/06/07 field mutations: preimage, digest, validation, distinct", async () => {
  const seen = new Set<string>([GOLDEN_DIGEST]);
  for (const [i, v] of V.field_mutations.entries()) {
    const d = await checkHashed("field_mutations", i, v);
    assert.ok(!seen.has(d), `field_mutations[${i}] ${v.label}: digest not distinct`);
    seen.add(d);
  }
  assert.equal(seen.size, 23);
});

test("TS-08 reordered lines", async () => {
  for (const [i, v] of V.reordered_lines.entries()) {
    const d = await checkHashed("reordered_lines", i, v);
    assert.notEqual(d, GOLDEN_DIGEST);
  }
  assert.equal(V.reordered_lines[0].validation, "LineIdMismatch");
  assert.equal(V.reordered_lines[1].validation, "ok");
});

test("TS-09/10 binding: network and escrow id", async () => {
  const ds: string[] = [];
  for (const [i, v] of V.binding.entries()) {
    const d = await checkHashed("binding", i, v);
    assert.notEqual(d, GOLDEN_DIGEST);
    ds.push(d);
  }
  assert.equal(new Set(ds).size, 3);
  assert.equal(V.binding[0].network, "sandbox");
});

test("TS-11 identical preimage (T078)", async () => {
  const d = await checkHashed("identical_preimage", 0, V.identical_preimage);
  assert.equal(d, GOLDEN_DIGEST);
  assert.equal(V.identical_preimage.preimage_hex, V.golden.preimage_hex);
});

test("TS-12 JSON equivalence (strict parse of json_text)", async () => {
  for (const [i, e] of V.json_equivalence.entries()) {
    const r = parseTermsJson(e.json_text);
    assert.ok(r.ok, `json_equivalence[${i}] ${e.label}: parse`);
    const d = await termsHashHex(V.context.network, V.context.escrow_id, r.terms);
    assert.equal(d, e.digest_hex, `json_equivalence[${i}] ${e.label}`);
    assert.equal(d, GOLDEN_DIGEST);
    results.push({ section: "json_equivalence", index: i, label: e.label, outcome: `digest ${d.slice(0, 8)}…` });
  }
});

test("TS-13/14/15 malformed: same stage and code as Rust", () => {
  let parseStage = 0;
  let validateStage = 0;
  const mismatches: string[] = [];
  for (const [i, m] of V.malformed.entries()) {
    assert.equal(m.expect.accept, false);
    const r = parseAndValidate(m.json_text, ctx);
    const got = r.ok ? "ACCEPTED" : `${r.stage}:${r.code}`;
    const want = `${m.expect.stage}:${m.expect.code}`;
    if (m.expect.stage === "parse") parseStage++;
    else validateStage++;
    if (got !== want) mismatches.push(`malformed[${i}] ${m.label}: TS ${got} vs Rust ${want}`);
    results.push({ section: "malformed", index: i, label: m.label, outcome: `TS ${got} | Rust ${want} | ${got === want ? "MATCH" : "MISMATCH"}` });
  }
  console.log(`malformed: parse-stage ${parseStage}, validate-stage ${validateStage}, total ${V.malformed.length}`);
  assert.deepEqual(mismatches, []);
  assert.equal(parseStage + validateStage, 39);
});

test("TS-16 duplicate key rejected although JSON.parse accepts it", () => {
  const m = V.malformed.find((x) => x.label === "duplicate key");
  assert.ok(m);
  assert.doesNotThrow(() => JSON.parse(m.json_text));
  const r = parseTermsJson(m.json_text);
  assert.ok(!r.ok && r.code === "Json");
});

test("per-case table", () => {
  for (const r of results) console.log(`${r.section}[${r.index}] ${r.label} -> ${r.outcome}`);
  // 1 golden + 22 + 2 + 3 + 1 + 2 json_equivalence + 39 malformed
  assert.equal(results.length, 70);
});
