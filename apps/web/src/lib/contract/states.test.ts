// Unit tests for money-state derivation. Fixtures are hand-written LineView
// objects shaped like lib.rs output; they are test data, not chain data.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agreementOutstanding,
  agreementStatusLabel,
  agreementSummaryLabel,
  fallbackSplit,
  lineLedgerTotal,
  lineStateLabel,
  reconcile,
  u128,
  withdrawalLabel,
  type StateLabel,
} from "./states.ts";
import type { AgreementView, LineView } from "./types.ts";

const P = 500_000_000n;

function line(over: Partial<LineView> = {}): LineView {
  return {
    line_id: 0,
    status: "UNFUNDED",
    locked: "0",
    buyer_claimable: "0",
    supplier_claimable: "0",
    buyer_pending: "0",
    supplier_pending: "0",
    buyer_paid: "0",
    supplier_paid: "0",
    buyer_withdrawal: "EMPTY",
    supplier_withdrawal: "EMPTY",
    submitted_at_ns: "0",
    evidence_commitment: "0".repeat(64),
    dispute_reason: "NONE",
    dispute_t0_ns: "0",
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
    dispute_phase: "NONE",
    primary_start_ns: null,
    backup_start_ns: null,
    fallback_start_ns: null,
    ...over,
  };
}

const key = (s: StateLabel) => s.key;

test("agreement status labels incl. ACTIVE; unknown is an incident", () => {
  assert.equal(agreementStatusLabel("PROPOSED").label, "Agreement awaiting approval");
  assert.equal(key(agreementStatusLabel("EXPIRED")), "expired");
  assert.equal(key(agreementStatusLabel("AGREED")), "agreed");
  assert.equal(key(agreementStatusLabel("ACTIVE")), "active");
  assert.equal(agreementStatusLabel("CLOSED").tone, "negative");
});

test("UNFUNDED: not funded warning; in-flight tx never says secured", () => {
  const l = lineStateLabel(line(), { principal: P });
  assert.equal(l.label, "Not funded");
  assert.match(l.detail ?? "", /not payment-protected/);
  const f = lineStateLabel(line(), { principal: P, fundingTxInFlight: true });
  assert.equal(f.label, "Funding transaction processing");
  assert.doesNotMatch(`${f.label} ${f.detail}`, /^Secured/);
});

test("FUNDED: secured only when locked == principal", () => {
  assert.equal(lineStateLabel(line({ status: "FUNDED", locked: P.toString() }), { principal: P }).label, "Secured in escrow");
  assert.equal(key(lineStateLabel(line({ status: "FUNDED", locked: (P - 1n).toString() }), { principal: P })), "incident");
  const nd = lineStateLabel(line({ status: "FUNDED", locked: P.toString(), non_delivery_t0_ns: "1800000000000000000" }), { principal: P });
  assert.equal(key(nd), "non_delivery_eligible");
  assert.doesNotMatch(nd.label, /Refunded/);
});

test("SUBMITTED: under review; review ended copy never says auto-approved", () => {
  const s = line({ status: "SUBMITTED", locked: P.toString(), submitted_at_ns: "1" });
  assert.equal(lineStateLabel(s, { principal: P }).label, "Under review");
  const ended = lineStateLabel({ ...s, no_response_t0_ns: "2" }, { principal: P });
  assert.equal(key(ended), "review_ended");
  assert.match(ended.detail ?? "", /funds are not automatically paid/);
  assert.doesNotMatch(`${ended.label} ${ended.detail}`, /approved/i);
});

test("DISPUTED: every reason labelled; NONE or unknown is an incident", () => {
  for (const r of ["BUYER_DISPUTE", "NO_RESPONSE", "NON_DELIVERY"]) {
    const d = lineStateLabel(line({ status: "DISPUTED", locked: P.toString(), dispute_reason: r }), { principal: P });
    assert.equal(d.label, "Disputed — secured", r);
  }
  assert.equal(key(lineStateLabel(line({ status: "DISPUTED", locked: P.toString(), dispute_reason: "NONE" }), { principal: P })), "incident");
  assert.equal(key(lineStateLabel(line({ status: "DISPUTED", locked: "1", dispute_reason: "NO_RESPONSE" }), { principal: P })), "incident");
});

test("ALLOCATED is a decision, not a payment", () => {
  const a = lineStateLabel(line({ status: "ALLOCATED", supplier_claimable: P.toString() }), { principal: P });
  assert.equal(key(a), "allocated");
  assert.doesNotMatch(a.label, /Paid/);
  assert.equal(key(lineStateLabel(line({ status: "ALLOCATED", locked: "1" }), { principal: P })), "incident");
  assert.equal(key(lineStateLabel(line({ status: "WITHDRAWN" }), { principal: P })), "incident");
});

test("withdrawal slots: ready / processing / paid / retry, with consistency checks", () => {
  const base = { status: "ALLOCATED" };
  assert.equal(withdrawalLabel(line({ ...base, supplier_claimable: "5" }), "supplier").label, "Ready to withdraw");
  assert.equal(key(withdrawalLabel(line(base), "buyer")), "none");
  const pend = withdrawalLabel(line({ ...base, supplier_withdrawal: "PENDING", supplier_pending: "5" }), "supplier");
  assert.equal(pend.label, "Payment outcome unconfirmed. Do not retry this withdrawal.");
  assert.match(pend.detail ?? "", /Do not retry/);
  assert.equal(withdrawalLabel(line({ ...base, supplier_withdrawal: "PAID", supplier_paid: "5" }), "supplier").label, "Paid");
  assert.equal(withdrawalLabel(line({ ...base, buyer_withdrawal: "FAILED", buyer_claimable: "5" }), "buyer").label, "The transfer failed. Your funds are available to withdraw again.");
  // inconsistent combinations are incidents, never Paid / Ready
  assert.equal(key(withdrawalLabel(line({ ...base, supplier_withdrawal: "PENDING" }), "supplier")), "incident");
  assert.equal(key(withdrawalLabel(line({ ...base, supplier_withdrawal: "PAID" }), "supplier")), "incident");
  assert.equal(key(withdrawalLabel(line({ ...base, supplier_withdrawal: "PAID", supplier_paid: "5", supplier_pending: "1" }), "supplier")), "incident");
  assert.equal(key(withdrawalLabel(line({ ...base, supplier_withdrawal: "FAILED" }), "supplier")), "incident");
  assert.equal(key(withdrawalLabel(line({ ...base, supplier_pending: "1" }), "supplier")), "incident");
  assert.equal(key(withdrawalLabel(line({ ...base, supplier_withdrawal: "INCONCLUSIVE", supplier_pending: "5" }), "supplier")), "incident");
});

test("the word Paid is produced only by a consistent PAID slot", () => {
  const statuses = ["UNFUNDED", "FUNDED", "SUBMITTED", "DISPUTED", "ALLOCATED", "X"];
  const slots = ["EMPTY", "PENDING", "PAID", "FAILED", "X"];
  const amounts = ["0", "7"];
  let paidLabels = 0;
  for (const status of statuses)
    for (const slot of slots)
      for (const claimable of amounts)
        for (const pending of amounts)
          for (const paid of amounts) {
            const l = line({
              status,
              locked: status === "ALLOCATED" || status === "UNFUNDED" ? "0" : P.toString(),
              dispute_reason: status === "DISPUTED" ? "BUYER_DISPUTE" : "NONE",
              supplier_withdrawal: slot,
              supplier_claimable: claimable,
              supplier_pending: pending,
              supplier_paid: paid,
            });
            assert.doesNotMatch(lineStateLabel(l, { principal: P }).label, /\bPaid\b/);
            const w = withdrawalLabel(l, "supplier");
            if (/\bPaid\b/.test(w.label)) {
              paidLabels++;
              assert.equal(slot, "PAID");
              assert.equal(paid, "7");
              assert.equal(pending, "0");
            }
          }
  assert.ok(paidLabels > 0);
});

test("u128 parsing is strict", () => {
  assert.equal(u128("340282366920938463463374607431768211455"), (1n << 128n) - 1n);
  for (const bad of ["", "01", "-1", "1.0", "1e3", " 1", "340282366920938463463374607431768211456"]) {
    assert.throws(() => u128(bad), Error, bad);
  }
});

test("ledger total, agreement outstanding (E excludes paid), fallback split", () => {
  const l = line({ status: "ALLOCATED", buyer_claimable: "3", supplier_pending: "4", supplier_paid: "5" });
  assert.equal(lineLedgerTotal(l), 12n);
  const a = { lines: [l, line({ status: "FUNDED", locked: "10" })] } as unknown as AgreementView;
  assert.equal(agreementOutstanding(a), 17n);
  assert.deepEqual(fallbackSplit(300_000_000n, 4000), { supplier: 120_000_000n, buyer: 180_000_000n });
  assert.deepEqual(fallbackSplit(1n, 5000), { supplier: 0n, buyer: 1n });
  const max = (1n << 128n) - 1n;
  const s = fallbackSplit(max, 9999);
  assert.equal(s.buyer + s.supplier, max);
  assert.throws(() => fallbackSplit(1n, 10_001));
});

test("reconciliation is observation-only copy", () => {
  assert.equal(reconcile(10n, 10n).key, "balanced");
  const s = reconcile(10n, 15n);
  assert.equal(s.key, "surplus");
  assert.equal(s.surplus, 5n);
  assert.match(s.detail ?? "", /never credited or swept/);
  assert.equal(reconcile(10n, 9n).key, "shortfall");
});

test("ALLOCATED and fully paid per the contract ledger -> 'Settled — paid out'; partial payment stays a decision", () => {
  const paid = lineStateLabel(line({ status: "ALLOCATED", supplier_paid: P.toString(), supplier_withdrawal: "PAID" }), { principal: P });
  assert.equal(key(paid), "paid_out");
  assert.match(paid.label, /paid out/);
  const half = P / 2n;
  const part = lineStateLabel(line({ status: "ALLOCATED", supplier_paid: half.toString(), buyer_claimable: (P - half).toString() }), { principal: P });
  assert.equal(key(part), "allocated");
  assert.match(part.detail ?? "", /not paid until/);
  const pend = lineStateLabel(line({ status: "ALLOCATED", supplier_pending: P.toString(), supplier_withdrawal: "PENDING" }), { principal: P });
  assert.equal(key(pend), "allocated", "a PENDING withdrawal is never shown as paid out");
});

test("agreementSummaryLabel: 'Completed' only when every line is fully paid per the ledger; names the contract status", () => {
  const P = 1_000n;
  const paidLine = (id: number, b: bigint, s: bigint) => line({ line_id: id, status: "ALLOCATED", buyer_paid: b.toString(), supplier_paid: s.toString(), buyer_withdrawal: b > 0n ? "PAID" : "EMPTY", supplier_withdrawal: s > 0n ? "PAID" : "EMPTY" });
  const ag = (lines: LineView[], status = "ACTIVE") => ({ status, lines, terms: { lines: lines.map(() => ({ principal: P.toString() })) } }) as unknown as AgreementView;
  const done = agreementSummaryLabel(ag([paidLine(0, 0n, P), paidLine(1, 300n, 700n)]));
  assert.equal(done.key, "completed");
  assert.match(done.detail ?? "", /Contract status: Active/);
  // one share still claimable -> plain contract status
  assert.equal(agreementSummaryLabel(ag([paidLine(0, 0n, P), line({ line_id: 1, status: "ALLOCATED", supplier_claimable: P.toString() })])).key, "active");
  // a PENDING withdrawal is never "completed"
  assert.equal(agreementSummaryLabel(ag([line({ line_id: 0, status: "ALLOCATED", supplier_pending: P.toString(), supplier_withdrawal: "PENDING" })])).key, "active");
  // funded but unsettled line -> active
  assert.equal(agreementSummaryLabel(ag([paidLine(0, 0n, P), line({ line_id: 1, status: "FUNDED", locked: P.toString() })])).key, "active");
  // non-ACTIVE statuses pass through unchanged
  assert.equal(agreementSummaryLabel(ag([], "PROPOSED")).key, "proposed");
});
