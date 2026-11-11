// LF-008 arbitration/fallback derivation tests. LineView fixtures are
// hand-written in the shape of main b28d33b's get_agreement (fields checked
// against the ABI in abi.test.ts); they prove UI logic only, not chain
// behaviour. The fallback split is checked against the Rust test vectors
// parsed from the read-only fixture copies of ledger.rs and line.rs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  disputeTimeline,
  fallbackAvailability,
  fallbackPreview,
  recheckBeforeDecision,
  rulingAvailability,
} from "./arbitration.ts";
import { fallbackSplit } from "./states.ts";
import type { LineView } from "./types.ts";
import { formatNsLocal, formatNsUtc } from "../format.ts";

const P = 1_000_000n;
const T0 = 1_800_000_000_000_000_000n;
const H = 3_600_000_000_000n;
const W = { negotiation_window_ns: (48n * H).toString(), primary_window_ns: (72n * H).toString(), backup_window_ns: (72n * H).toString() };
const PS = T0 + 48n * H;
const BS = PS + 72n * H;
const FS = BS + 72n * H;

function line(over: Partial<LineView> = {}): LineView {
  return {
    line_id: 0,
    status: "DISPUTED",
    locked: P.toString(),
    buyer_claimable: "0",
    supplier_claimable: "0",
    buyer_pending: "0",
    supplier_pending: "0",
    buyer_paid: "0",
    supplier_paid: "0",
    buyer_withdrawal: "EMPTY",
    supplier_withdrawal: "EMPTY",
    submitted_at_ns: "1",
    evidence_commitment: "1".repeat(64),
    dispute_reason: "BUYER_DISPUTE",
    dispute_t0_ns: T0.toString(),
    no_response_t0_ns: null,
    non_delivery_t0_ns: null,
    allocation_mode: "NONE",
    allocation_buyer_amount: "0",
    allocation_supplier_amount: "0",
    allocation_source_id: "0",
    allocation_finalized_at_ns: "0",
    proposal_status: "NONE",
    proposal_id: "0",
    proposal_proposer: "NONE",
    proposal_buyer_amount: "0",
    proposal_supplier_amount: "0",
    proposal_created_at_ns: "0",
    dispute_phase: "NEGOTIATION",
    primary_start_ns: PS.toString(),
    backup_start_ns: BS.toString(),
    fallback_start_ns: FS.toString(),
    ...over,
  };
}

test("timeline: four half-open phases from T0, current phase taken from the view", () => {
  for (const [phase, idx] of [["NEGOTIATION", 0], ["PRIMARY", 1], ["BACKUP", 2], ["FALLBACK", 3]] as const) {
    const t = disputeTimeline(line({ dispute_phase: phase }), W);
    assert.ok(t.ok, phase);
    assert.equal(t.current, phase);
    assert.deepEqual(t.steps.map((s) => s.position), ["past", "past", "past", "past"].map((_, i) => (i < idx ? "past" : i === idx ? "current" : "upcoming")));
    assert.deepEqual(
      t.steps.map((s) => [s.key, s.startNs, s.endNs]),
      [["NEGOTIATION", T0, PS], ["PRIMARY", PS, BS], ["BACKUP", BS, FS], ["FALLBACK", FS, null]],
    );
  }
});

test("timeline: inconsistent or unknown phase data is an incident, never a phase", () => {
  assert.equal(disputeTimeline(line({ dispute_phase: "WHATEVER" }), W).ok, false);
  assert.equal(disputeTimeline(line({ dispute_phase: "BEFORE_T0" }), W).ok, false);
  assert.equal(disputeTimeline(line({ dispute_phase: "NONE" }), W).ok, false);
  assert.equal(disputeTimeline(line({ primary_start_ns: null }), W).ok, false);
  // start times that do not equal T0 + the hashed windows
  const off = disputeTimeline(line({ backup_start_ns: (BS + 1n).toString() }), W);
  assert.equal(off.ok, false);
  assert.equal(off.label.key, "incident");
  // phase fields on a non-disputed line
  assert.equal(disputeTimeline(line({ status: "FUNDED", dispute_phase: "PRIMARY" }), W).label.key, "incident");
  const none = disputeTimeline(line({ status: "FUNDED", dispute_phase: "NONE", primary_start_ns: null, backup_start_ns: null, fallback_start_ns: null }), W);
  assert.equal(none.ok, false);
  assert.equal(none.label.key, "none");
});

test("ruling form: only the arbitrator whose window the contract reports open", () => {
  const cases: [string, "primary_arbitrator" | "backup_arbitrator", boolean][] = [
    ["NEGOTIATION", "primary_arbitrator", false],
    ["NEGOTIATION", "backup_arbitrator", false],
    ["PRIMARY", "primary_arbitrator", true],
    ["PRIMARY", "backup_arbitrator", false],
    ["BACKUP", "primary_arbitrator", false],
    ["BACKUP", "backup_arbitrator", true],
    ["FALLBACK", "primary_arbitrator", false],
    ["FALLBACK", "backup_arbitrator", false],
  ];
  for (const [phase, role, can] of cases) {
    const r = rulingAvailability(line({ dispute_phase: phase }), role);
    assert.equal(r.canRule, can, `${phase} ${role}`);
    if (!can) assert.ok(r.reason !== null);
  }
  assert.match(rulingAvailability(line({ dispute_phase: "BACKUP" }), "primary_arbitrator").reason ?? "", /has ended/);
  assert.match(rulingAvailability(line({ dispute_phase: "PRIMARY" }), "backup_arbitrator").reason ?? "", /not open yet/);
  for (const role of ["buyer", "supplier", null] as const) {
    for (const phase of ["PRIMARY", "BACKUP"]) {
      const r = rulingAvailability(line({ dispute_phase: phase }), role);
      assert.equal(r.canRule, false);
      assert.equal(r.reason, null, "no ruling UI at all for non-arbitrators");
    }
  }
  assert.equal(rulingAvailability(line({ status: "ALLOCATED", dispute_phase: "NONE" }), "primary_arbitrator").canRule, false);
});

test("fallback: anyone, only once the contract reports FALLBACK on a DISPUTED line", () => {
  assert.equal(fallbackAvailability(line({ dispute_phase: "FALLBACK" }), true).canTrigger, true);
  assert.equal(fallbackAvailability(line({ dispute_phase: "FALLBACK" }), false).canTrigger, false);
  for (const ph of ["NEGOTIATION", "PRIMARY", "BACKUP"]) assert.equal(fallbackAvailability(line({ dispute_phase: ph }), true).canTrigger, false);
  assert.equal(fallbackAvailability(line({ status: "ALLOCATED", dispute_phase: "NONE" }), true).canTrigger, false);
});

test("re-check before signing: a decided line or a moved phase blocks signing", () => {
  assert.deepEqual(recheckBeforeDecision(line({ dispute_phase: "PRIMARY" }), "primary"), { ok: true });
  assert.equal(recheckBeforeDecision(line({ dispute_phase: "BACKUP" }), "primary").ok, false);
  assert.equal(recheckBeforeDecision(line({ dispute_phase: "BACKUP" }), "fallback").ok, false);
  assert.deepEqual(recheckBeforeDecision(line({ dispute_phase: "FALLBACK" }), "fallback"), { ok: true });
  const done = recheckBeforeDecision(line({ status: "ALLOCATED", dispute_phase: "NONE" }), "fallback");
  assert.equal(done.ok, false);
  if (!done.ok) assert.match(done.message, /Nothing was signed/);
});

// ---- fallback split vs the Rust vectors -----------------------------------

const FIXTURE_SRC = new URL("../../../fixtures/contract-main/src/", import.meta.url);
const rs = (f: string) => readFileSync(new URL(f, FIXTURE_SRC), "utf8");
const num = (s: string) => BigInt(s.replace(/_/g, "").replace(/u\d+$/, ""));

/** (P, S, buyer, supplier) from ledger.rs split_matches_independent_python_reference. */
function ledgerVectors(): [bigint, number, bigint, bigint][] {
  const src = rs("ledger.rs");
  const start = src.indexOf("fn split_matches_independent_python_reference");
  assert.ok(start >= 0);
  const body = src.slice(start, src.indexOf("for (p, s, buyer, supplier) in cases", start));
  const re = /\(\s*([0-9_]+),\s*([0-9_]+),\s*([0-9_]+),\s*([0-9_]+),?\s*\)/g;
  return [...body.matchAll(re)].map((m) => [num(m[1]), Number(num(m[2])), num(m[3]), num(m[4])]);
}

/** (P, S, (buyer, supplier)) from line.rs lf008_fallback_rounding. */
function lineVectors(): [bigint, number, bigint, bigint][] {
  const src = rs("line.rs");
  const start = src.indexOf("fn lf008_fallback_rounding");
  assert.ok(start >= 0);
  const body = src.slice(start, src.indexOf("let big", start));
  const re = /\(([0-9_]+(?:u128)?),\s*([0-9_]+(?:u16)?),\s*\(([0-9_]+(?:u128)?),\s*([0-9_]+(?:u128)?)\)\)/g;
  return [...body.matchAll(re)].map((m) => [num(m[1]), Number(num(m[2])), num(m[3]), num(m[4])]);
}

test("fallback split equals every Rust vector (ledger.rs python reference + line.rs LF-008 rounding)", () => {
  const lv = ledgerVectors();
  const fv = lineVectors();
  assert.equal(lv.length, 12, "ledger.rs has 12 reference cases");
  assert.equal(fv.length, 5, "line.rs lf008_fallback_rounding has 5 cases");
  for (const [p, s, buyer, supplier] of [...lv, ...fv]) {
    const got = fallbackPreview(p, s, 10_000 - s);
    assert.deepEqual([got.buyer, got.supplier], [buyer, supplier], `P=${p} S=${s}`);
  }
  // the docs/07 example, explicitly
  const ex = fallbackPreview(1_001n, 3_333, 6_667);
  assert.deepEqual([ex.buyer, ex.supplier], [668n, 333n]);
  // line.rs lf008_fallback_only_after_longstop: P = 300, supplier 4 000 bps -> 180 / 120
  const lo = fallbackPreview(300n, 4_000, 6_000);
  assert.deepEqual([lo.buyer, lo.supplier], [180n, 120n]);
});

test("fallback split: u128 extremes conserve and floor the supplier share", () => {
  const MAX = (1n << 128n) - 1n;
  for (let s = 0; s <= 10_000; s += 1_111) {
    const { buyer, supplier } = fallbackSplit(MAX, s);
    assert.equal(buyer + supplier, MAX);
    assert.equal(supplier, (MAX * BigInt(s)) / 10_000n);
  }
  assert.throws(() => fallbackPreview(1n, 3_333, 6_666), /10 000/);
  assert.throws(() => fallbackPreview(1n, 10_001, -1));
});

test("phase times render in exact UTC and in a named local zone", () => {
  const ns = 1_800_000_000_000_000_000n; // 2027-01-15T08:00:00Z
  assert.equal(formatNsUtc(ns), "2027-01-15 08:00 UTC");
  assert.equal(formatNsLocal(ns, "UTC"), "2027-01-15 08:00 UTC");
  assert.match(formatNsLocal(ns, "Europe/Berlin"), /^2027-01-15 09:00 (GMT\+1|CET)$/);
  assert.match(formatNsLocal(ns, "America/New_York"), /^2027-01-15 03:00 (GMT-5|EST)$/);
});
