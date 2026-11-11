import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acceptAvail,
  acceptanceRows,
  acceptVerdict,
  advanceInfo,
  checkTerms,
  decodeU128Json,
  deliverAvail,
  fundabilityWarnings,
  fundAvail,
  fundingOutcome,
  fundingWindow,
  lineActionVerdict,
  LIFECYCLE_COPY,
  methodFor,
  parseFundingOutcome,
  reviewAvail,
  reviewEnd,
  submissionCutoff,
  type ActionAvail,
  type TermsCheck,
} from "./lifecycle.ts";
import { roleOf, type Role } from "./settlement.ts";
import type { AgreementView, LineView } from "./types.ts";
import { describeRefund, REFUND_COPY } from "./errors.ts";

const H = "9257a5bfea49918f0a1b1a3308ad553a384079e73da987df495f55002869a33c";
const MIN = 60_000_000_000n;
const P = 1_001n;
// acceptance 1000·MIN, funding 2000·MIN, delivery line0 5000·MIN, line1 2500·MIN, review 600·MIN, grace 0
const ACC = 1000n * MIN;
const FUND = 2000n * MIN;
const REVIEW = 600n * MIN;

const ACCOUNTS = {
  buyer: "buyer.test.near",
  supplier: "supplier.test.near",
  primary_arbitrator: "primary.test.near",
  backup_arbitrator: "backup.test.near",
} as const;
const STRANGER = "stranger.test.near";

function line(over: Partial<LineView> = {}): LineView {
  return {
    line_id: 0, status: "UNFUNDED", locked: "0",
    buyer_claimable: "0", supplier_claimable: "0", buyer_pending: "0", supplier_pending: "0", buyer_paid: "0", supplier_paid: "0",
    buyer_withdrawal: "EMPTY", supplier_withdrawal: "EMPTY", submitted_at_ns: "0", evidence_commitment: "0".repeat(64),
    dispute_reason: "NONE", dispute_t0_ns: "0", no_response_t0_ns: null, non_delivery_t0_ns: null,
    allocation_mode: "NONE", allocation_buyer_amount: "0", allocation_supplier_amount: "0", allocation_source_id: "0", allocation_finalized_at_ns: "0",
    proposal_status: "NONE", proposal_id: "0", proposal_proposer: "NONE", proposal_buyer_amount: "0", proposal_supplier_amount: "0", proposal_created_at_ns: "0",
    dispute_phase: "NONE", primary_start_ns: null, backup_start_ns: null, fallback_start_ns: null,
    ...over,
  };
}

function agreement(status: string, l: LineView[] = [line()], acc: Partial<AgreementView["acceptances"]> = {}): AgreementView {
  return {
    agreement_id: "7",
    status,
    terms_hash: H,
    acceptances: { buyer: false, supplier: false, primary_arbitrator: false, backup_arbitrator: false, ...acc },
    accelerated_test_timing: false,
    created_at_ns: "1",
    terms: {
      schema_version: 1, deadline_rules_version: 1,
      buyer_id: ACCOUNTS.buyer, supplier_id: ACCOUNTS.supplier, primary_arbitrator_id: ACCOUNTS.primary_arbitrator, backup_arbitrator_id: ACCOUNTS.backup_arbitrator,
      ft_contract_id: "ft.test.near", agreement_nonce: "1",
      acceptance_deadline_ns: ACC.toString(), funding_deadline_ns: FUND.toString(), delivery_grace_period_ns: "0",
      review_window_ns: REVIEW.toString(), negotiation_window_ns: MIN.toString(), primary_window_ns: MIN.toString(), backup_window_ns: MIN.toString(),
      lines: [
        { line_id: 0, principal: P.toString(), delivery_deadline_ns: (5000n * MIN).toString(), acceptance_criteria_commitment: "01".repeat(32), fallback_buyer_bps: 5000, fallback_supplier_bps: 5000 },
        { line_id: 1, principal: "500", delivery_deadline_ns: (2500n * MIN).toString(), acceptance_criteria_commitment: "02".repeat(32), fallback_buyer_bps: 5000, fallback_supplier_bps: 5000 },
      ],
    },
    lines: l,
  } as AgreementView;
}

const OK: TermsCheck = { ok: true, hash: H };
const BAD: TermsCheck = { ok: false, reason: `${LIFECYCLE_COPY.doNotSign} x` };
const ROLES: (Role | null)[] = ["buyer", "supplier", "primary_arbitrator", "backup_arbitrator", null];
const acct = (r: Role | null) => (r === null ? STRANGER : ACCOUNTS[r]);
const kind = (a: ActionAvail) => a.kind;

// ---------------------------------------------------------------- terms check

test("checkTerms: all three equal is the only pass; every mismatch says Do not sign", () => {
  assert.deepEqual(checkTerms(H, H, H), { ok: true, hash: H });
  const other = "a".repeat(64);
  for (const [l, s, c] of [[null, H, H], [H, H, null], [other, H, H], [H, H, other], [H, "A".repeat(64), H], [H, "x", H]] as const) {
    const r = checkTerms(l, s, c);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.reason.startsWith("Terms could not be verified. Do not sign."));
  }
});

// ---------------------------------------------------------------- acceptance

test("acceptance rows mirror the contract's acceptances and the method per role", () => {
  const rows = acceptanceRows(agreement("PROPOSED", [line()], { supplier: true, backup_arbitrator: true }));
  assert.deepEqual(rows.map((r) => [r.role, r.accountId, r.accepted, r.method]), [
    ["buyer", ACCOUNTS.buyer, false, "accept_terms"],
    ["supplier", ACCOUNTS.supplier, true, "accept_terms"],
    ["primary_arbitrator", ACCOUNTS.primary_arbitrator, false, "accept_appointment"],
    ["backup_arbitrator", ACCOUNTS.backup_arbitrator, true, "accept_appointment"],
  ]);
  assert.equal(methodFor("buyer"), "accept_terms");
  assert.equal(methodFor("backup_arbitrator"), "accept_appointment");
});

test("acceptAvail: role x status x time x verification matrix", () => {
  const now = ACC - 1n;
  for (const status of ["PROPOSED", "EXPIRED", "AGREED", "ACTIVE", "WEIRD"]) {
    for (const role of ROLES) {
      for (const accepted of [false, true]) {
        const a = agreement(status, [line()], role === null ? {} : { [role]: accepted });
        const r = acceptAvail(a, role, acct(role), now, OK, null);
        if (status === "AGREED" || status === "ACTIVE") assert.equal(r.kind, "hidden");
        else if (status === "EXPIRED") assert.equal(r.kind, role === null ? "hidden" : "disabled");
        else if (status === "WEIRD") assert.equal(r.kind, "disabled");
        else if (role === null) assert.equal(r.kind, "other_role");
        else assert.equal(r.kind, accepted ? "disabled" : "enabled", `${status} ${role} ${accepted}`);
      }
    }
  }
  const a = agreement("PROPOSED");
  assert.equal(kind(acceptAvail(a, null, null, ACC - 1n, OK, null)), "other_role");
  assert.equal(kind(acceptAvail(a, "buyer", ACCOUNTS.buyer, ACC, OK, null)), "disabled", "half-open: now == deadline is closed");
  assert.equal(kind(acceptAvail(a, "buyer", ACCOUNTS.buyer, null, OK, null)), "disabled");
  const bad = acceptAvail(a, "supplier", ACCOUNTS.supplier, ACC - 1n, BAD, null);
  assert.ok(bad.kind === "disabled" && bad.reason.startsWith("Terms could not be verified. Do not sign."));
  const inv = acceptAvail(a, "primary_arbitrator", ACCOUNTS.primary_arbitrator, ACC - 1n, OK, "Each dispute window must be between 60 seconds and 30 days.");
  assert.ok(inv.kind === "disabled" && inv.reason.includes("Do not sign") && inv.reason.includes("dispute window"));
});

test("acceptVerdict confirms only what the fresh read records", () => {
  assert.equal(acceptVerdict(agreement("PROPOSED", [line()], { buyer: false }), "buyer").confirmed, false);
  const yes = acceptVerdict(agreement("PROPOSED", [line()], { buyer: true }), "buyer");
  assert.equal(yes.confirmed, true);
  const all = acceptVerdict(agreement("AGREED", [line()], { buyer: true, supplier: true, primary_arbitrator: true, backup_arbitrator: true }), "backup_arbitrator");
  assert.match(all.text, /All four parties have accepted/);
});

// ---------------------------------------------------------------- funding

const REG = { escrowRegistered: true, buyerBalance: P } as const;

test("fundingWindow: min(funding deadline − 1, delivery + grace − review); F3 binding flagged", () => {
  const a = agreement("AGREED");
  const w0 = fundingWindow(a, 0); // 5000 − 600 = 4400 > 2000 − 1
  assert.equal(w0.deadlineNs, FUND);
  assert.equal(w0.lastCreditableNs, FUND - 1n);
  assert.equal(w0.f3Binding, false);
  const w1 = fundingWindow(a, 1); // 2500 − 600 = 1900 < 2000
  assert.equal(w1.lastCreditableNs, 1900n * MIN);
  assert.equal(w1.f3Binding, true);
  const tight = agreement("AGREED");
  tight.terms.lines[1].delivery_deadline_ns = (100n * MIN).toString(); // < review
  assert.equal(fundingWindow(tight, 1).lastCreditableNs, null);
  // equality accepted: delivery + grace − review == funding − 1 → F3 not binding
  const eq = agreement("AGREED");
  eq.terms.lines[1].delivery_deadline_ns = (FUND - 1n + REVIEW).toString();
  assert.equal(fundingWindow(eq, 1).lastCreditableNs, FUND - 1n);
  assert.equal(fundingWindow(eq, 1).f3Binding, false);
});

test("fundAvail: only the buyer, only UNFUNDED, only AGREED/ACTIVE, before the effective cutoff, with registration and balance", () => {
  const now = FUND - 10n;
  for (const status of ["PROPOSED", "EXPIRED", "AGREED", "ACTIVE"]) {
    for (const ls of ["UNFUNDED", "FUNDED", "SUBMITTED", "DISPUTED", "ALLOCATED"]) {
      for (const role of ROLES) {
        const l = line({ status: ls, locked: ls === "UNFUNDED" || ls === "ALLOCATED" ? "0" : P.toString() });
        const r = fundAvail(agreement(status, [l]), l, role, acct(role), now, OK, REG);
        if (ls !== "UNFUNDED" || status === "EXPIRED") assert.equal(r.kind, "hidden", `${status} ${ls} ${role}`);
        else if (role !== "buyer") assert.equal(r.kind, "other_role");
        else if (status === "PROPOSED") assert.equal(r.kind, "disabled");
        else assert.equal(r.kind, "enabled", `${status} ${ls}`);
      }
    }
  }
  const a = agreement("AGREED");
  const l = a.lines[0];
  const dis = (r: ActionAvail) => (r.kind === "disabled" ? r.reason : `not disabled: ${r.kind}`);
  assert.match(dis(fundAvail(a, l, "buyer", ACCOUNTS.buyer, FUND, OK, REG)), /funding deadline has passed/);
  assert.match(dis(fundAvail(a, l, "buyer", ACCOUNTS.buyer, null, OK, REG)), /Chain time/);
  assert.match(dis(fundAvail(a, l, "buyer", ACCOUNTS.buyer, now, BAD, REG)), /Do not sign/);
  assert.match(dis(fundAvail(a, l, "buyer", ACCOUNTS.buyer, now, OK, { escrowRegistered: false, buyerBalance: P })), /not registered on the token/);
  assert.match(dis(fundAvail(a, l, "buyer", ACCOUNTS.buyer, now, OK, { escrowRegistered: null, buyerBalance: P })), /registration/);
  assert.match(dis(fundAvail(a, l, "buyer", ACCOUNTS.buyer, now, OK, { escrowRegistered: true, buyerBalance: P - 1n })), /below the exact line amount/);
  assert.match(dis(fundAvail(a, l, "buyer", ACCOUNTS.buyer, now, OK, { escrowRegistered: true, buyerBalance: null })), /balance could not be read/);
  assert.equal(fundAvail(a, l, "buyer", ACCOUNTS.buyer, now, OK, { escrowRegistered: true, buyerBalance: P + 1n }).kind, "enabled");
  // F3: line 1 is creditable until 1900·MIN inclusive.
  const l1 = line({ line_id: 1 });
  const a2 = agreement("AGREED", [line(), l1]);
  const reg1 = { escrowRegistered: true, buyerBalance: 500n };
  assert.equal(fundAvail(a2, l1, "buyer", ACCOUNTS.buyer, 1900n * MIN, OK, reg1).kind, "enabled");
  assert.equal(dis(fundAvail(a2, l1, "buyer", ACCOUNTS.buyer, 1900n * MIN + 1n, OK, reg1)), LIFECYCLE_COPY.tooLate);
  assert.equal(LIFECYCLE_COPY.tooLate, "Too late to fund: the supplier would have less than the review window to deliver.");
  assert.equal(fundAvail(a2, l1, null, null, 0n, OK, reg1).kind, "other_role");
});

test("fundingOutcome: Secured only for FUNDED with locked == principal; refund log on UNFUNDED says nothing was credited and why", () => {
  const funded = line({ status: "FUNDED", locked: P.toString() });
  assert.equal(fundingOutcome(funded, P, null).key, "secured");
  assert.equal(fundingOutcome(funded, P, { usedAmount: "0", logs: ["LF_FT_REFUND:AmountMismatch"], failure: null }).key, "secured", "contract record wins over the report");
  assert.equal(fundingOutcome(line({ status: "FUNDED", locked: "1000" }), P, null).key, "incident");
  const un = line();
  const ref = fundingOutcome(un, P, { usedAmount: "0", logs: ["LF_FT_REFUND:FundingDeadlinePassed"], failure: null });
  assert.equal(ref.key, "refunded");
  if (ref.key === "refunded") {
    assert.equal(ref.refund.code, "FundingDeadlinePassed");
    assert.equal(ref.refund.title, REFUND_COPY);
    assert.match(ref.title, /Nothing was credited/);
  }
  const f3 = fundingOutcome(un, P, { usedAmount: "0", logs: ["LF_FT_REFUND:DeliveryTimeTooShort"], failure: null });
  assert.ok(f3.key === "refunded" && f3.refund.reason === LIFECYCLE_COPY.tooLate && !f3.refund.incident);
  assert.equal(fundingOutcome(un, P, { usedAmount: "0", logs: [], failure: null }).key, "not_credited");
  assert.equal(fundingOutcome(un, P, { usedAmount: null, logs: [], failure: '{"ActionError":{}}' }).key, "not_credited");
  assert.equal(fundingOutcome(un, P, null).key, "processing");
  const rep = fundingOutcome(un, P, { usedAmount: P.toString(), logs: [], failure: null });
  assert.equal(rep.key, "processing", "a report of P used is not 'Secured' until the contract shows it");
  assert.match(rep.reported ?? "", /Reported by the transaction/);
  assert.equal(fundingOutcome(line({ status: "SUBMITTED", locked: P.toString() }), P, null).key, "moved_on");
  assert.equal(fundingOutcome(line({ locked: "5" }), P, null).key, "incident");
  // No outcome other than 'secured' ever carries the title "Secured in escrow".
  for (const o of [ref, f3, rep]) assert.notEqual(o.title, "Secured in escrow");
});

test("parseFundingOutcome reads logs from every receipt and the used amount from SuccessValue", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const o = {
    status: { SuccessValue: b64('"0"') },
    transaction_outcome: { outcome: { logs: [] } },
    receipts_outcome: [{ outcome: { logs: ['EVENT_JSON:{"standard":"nep141"}'] } }, { outcome: { logs: ["LF_FT_REFUND:AmountMismatch"] } }],
  };
  const r = parseFundingOutcome(o);
  assert.equal(r.usedAmount, "0");
  assert.equal(r.failure, null);
  assert.equal(describeRefund(r.logs)?.code, "AmountMismatch");
  assert.equal(parseFundingOutcome({ status: { SuccessValue: b64('"1001"') } }).usedAmount, "1001");
  assert.equal(parseFundingOutcome({ status: { Failure: { ActionError: {} } } }).failure, '{"ActionError":{}}');
  assert.deepEqual(parseFundingOutcome(null), { usedAmount: null, logs: [], failure: null });
  assert.equal(decodeU128Json(b64("1001")), null, "a bare number is not a U128 JSON string");
  assert.equal(decodeU128Json(b64('"01"')), null);
  assert.equal(decodeU128Json("!!"), null);
});

// ---------------------------------------------------------------- delivery / review / advance

test("deliverAvail: supplier only, FUNDED only, before delivery + grace (half-open)", () => {
  const cutoff = 5000n * MIN;
  for (const ls of ["UNFUNDED", "FUNDED", "SUBMITTED", "DISPUTED", "ALLOCATED"]) {
    for (const role of ROLES) {
      const l = line({ status: ls, locked: P.toString() });
      const r = deliverAvail(agreement("ACTIVE", [l]), l, role, acct(role), cutoff - 1n);
      if (ls !== "FUNDED") assert.equal(r.kind, "hidden");
      else assert.equal(r.kind, role === "supplier" ? "enabled" : "other_role", `${role}`);
    }
  }
  const l = line({ status: "FUNDED", locked: P.toString() });
  const a = agreement("ACTIVE", [l]);
  assert.equal(submissionCutoff(a, 0), cutoff);
  assert.equal(deliverAvail(a, l, "supplier", ACCOUNTS.supplier, cutoff).kind, "disabled");
  assert.equal(deliverAvail(a, l, "supplier", ACCOUNTS.supplier, null).kind, "disabled");
  const late = line({ status: "FUNDED", locked: P.toString(), non_delivery_t0_ns: cutoff.toString() });
  assert.equal(deliverAvail(a, late, "supplier", ACCOUNTS.supplier, cutoff - 1n).kind, "disabled", "view eligibility wins over a lagging clock");
});

test("reviewAvail: buyer only, SUBMITTED only, in [submitted_at, submitted_at + review)", () => {
  const sub = 3000n * MIN;
  const mk = (over: Partial<LineView> = {}) => line({ status: "SUBMITTED", locked: P.toString(), submitted_at_ns: sub.toString(), ...over });
  for (const ls of ["UNFUNDED", "FUNDED", "SUBMITTED", "DISPUTED", "ALLOCATED"]) {
    for (const role of ROLES) {
      const l = mk({ status: ls });
      const r = reviewAvail(agreement("ACTIVE", [l]), l, role, acct(role), sub);
      if (ls !== "SUBMITTED") assert.equal(r.kind, "hidden");
      else assert.equal(r.kind, role === "buyer" ? "enabled" : "other_role");
    }
  }
  const l = mk();
  const a = agreement("ACTIVE", [l]);
  assert.equal(reviewEnd(a, l), sub + REVIEW);
  assert.equal(reviewAvail(a, l, "buyer", ACCOUNTS.buyer, sub + REVIEW - 1n).kind, "enabled");
  assert.equal(reviewAvail(a, l, "buyer", ACCOUNTS.buyer, sub + REVIEW).kind, "disabled");
  assert.equal(reviewAvail(a, l, "buyer", ACCOUNTS.buyer, sub - 1n).kind, "disabled");
  assert.equal(reviewAvail(a, mk({ no_response_t0_ns: (sub + REVIEW).toString() }), "buyer", ACCOUNTS.buyer, sub).kind, "disabled");
  assert.equal(reviewAvail(a, l, null, null, sub).kind, "other_role");
});

test("advanceInfo: only from the view's eligibility fields; anyone connected; T0 is the view value", () => {
  const t0 = (3600n * MIN).toString();
  const cases: [Partial<LineView>, string | null][] = [
    [{ status: "SUBMITTED", no_response_t0_ns: t0 }, "NO_RESPONSE"],
    [{ status: "FUNDED", non_delivery_t0_ns: t0 }, "NON_DELIVERY"],
    [{ status: "SUBMITTED" }, null],
    [{ status: "FUNDED" }, null],
    [{ status: "DISPUTED", no_response_t0_ns: t0 }, null],
    [{ status: "SUBMITTED", non_delivery_t0_ns: t0 }, null],
  ];
  for (const [over, want] of cases) {
    const i = advanceInfo(line({ locked: P.toString(), ...over }), STRANGER);
    assert.equal(i.reason, want);
    assert.equal(i.avail.kind, want === null ? "hidden" : "enabled");
    if (want !== null) assert.equal(i.t0Ns, BigInt(t0));
  }
  assert.equal(advanceInfo(line({ status: "FUNDED", non_delivery_t0_ns: t0 }), null).avail.kind, "disabled");
  // every role (and a stranger) may advance
  for (const role of ROLES) assert.equal(advanceInfo(line({ status: "FUNDED", non_delivery_t0_ns: t0 }), acct(role)).avail.kind, "enabled");
});

test("lineActionVerdict confirms only the contract-recorded effect", () => {
  const c = "ab".repeat(32);
  assert.equal(lineActionVerdict("submit_delivery", line({ status: "SUBMITTED", evidence_commitment: c }), { evidenceCommitment: c }).confirmed, true);
  assert.equal(lineActionVerdict("submit_delivery", line({ status: "SUBMITTED", evidence_commitment: "cd".repeat(32) }), { evidenceCommitment: c }).confirmed, false);
  assert.equal(lineActionVerdict("submit_delivery", line({ status: "FUNDED" }), { evidenceCommitment: c }).confirmed, false);
  assert.equal(lineActionVerdict("accept_line", line({ status: "ALLOCATED", allocation_mode: "BUYER_ACCEPTED" })).confirmed, true);
  assert.equal(lineActionVerdict("accept_line", line({ status: "ALLOCATED", allocation_mode: "MUTUAL" })).confirmed, false);
  assert.equal(lineActionVerdict("open_dispute", line({ status: "DISPUTED", dispute_reason: "BUYER_DISPUTE" })).confirmed, true);
  assert.equal(lineActionVerdict("open_dispute", line({ status: "DISPUTED", dispute_reason: "NO_RESPONSE" })).confirmed, false);
  assert.equal(lineActionVerdict("advance_case", line({ status: "DISPUTED", dispute_reason: "NO_RESPONSE" })).confirmed, true);
  assert.equal(lineActionVerdict("advance_case", line({ status: "DISPUTED", dispute_reason: "NON_DELIVERY" })).confirmed, true);
  assert.equal(lineActionVerdict("advance_case", line({ status: "DISPUTED", dispute_reason: "BUYER_DISPUTE" })).confirmed, false);
  assert.match(lineActionVerdict("accept_line", line({ status: "SUBMITTED" })).text, /not proof/);
});

test("exhaustive: no action is ever enabled for a role the contract would reject (docs/06 mirror)", () => {
  const statuses = ["UNFUNDED", "FUNDED", "SUBMITTED", "DISPUTED", "ALLOCATED"];
  const agreementStatuses = ["PROPOSED", "EXPIRED", "AGREED", "ACTIVE"];
  const times = [0n, ACC - 1n, ACC, FUND - 1n, FUND, 3000n * MIN, 5000n * MIN, 10_000n * MIN];
  let n = 0;
  for (const as of agreementStatuses) {
    for (const ls of statuses) {
      for (const role of ROLES) {
        for (const now of times) {
          for (const flag of [null, (4000n * MIN).toString()]) {
            const l = line({ status: ls, locked: ls === "UNFUNDED" || ls === "ALLOCATED" ? "0" : P.toString(), submitted_at_ns: (3000n * MIN).toString(), no_response_t0_ns: ls === "SUBMITTED" ? flag : null, non_delivery_t0_ns: ls === "FUNDED" ? flag : null });
            const a = agreement(as, [l]);
            const r = role === null ? null : role;
            if (fundAvail(a, l, r, acct(role), now, OK, REG).kind === "enabled") {
              assert.ok(role === "buyer" && ls === "UNFUNDED" && (as === "AGREED" || as === "ACTIVE") && now < FUND);
            }
            if (deliverAvail(a, l, r, acct(role), now).kind === "enabled") assert.ok(role === "supplier" && ls === "FUNDED" && now < 5000n * MIN && flag === null);
            if (reviewAvail(a, l, r, acct(role), now).kind === "enabled") {
              assert.ok(role === "buyer" && ls === "SUBMITTED" && now >= 3000n * MIN && now < 3000n * MIN + REVIEW && flag === null);
            }
            if (advanceInfo(l, acct(role)).avail.kind === "enabled") assert.ok((ls === "SUBMITTED" || ls === "FUNDED") && flag !== null);
            if (acceptAvail(a, r, acct(role), now, OK, null).kind === "enabled") {
              assert.ok(role !== null && as === "PROPOSED" && now < ACC);
              assert.equal(roleOf(a.terms, acct(role)), role);
            }
            n++;
          }
        }
      }
    }
  }
  assert.equal(n, 4 * 5 * 5 * 8 * 2);
});

// ---------------------------------------------------------------- draft fundability

test("fundabilityWarnings: lines with delivery + grace < funding + review are flagged; equality accepted", () => {
  const base = { acceptance_deadline_ns: ACC, funding_deadline_ns: FUND, delivery_grace_period_ns: 0n, review_window_ns: REVIEW };
  assert.deepEqual(fundabilityWarnings({ ...base, lines: [{ line_id: 0, delivery_deadline_ns: FUND + REVIEW }] }), []);
  const w = fundabilityWarnings({ ...base, lines: [{ line_id: 0, delivery_deadline_ns: FUND + REVIEW - 1n }, { line_id: 1, delivery_deadline_ns: 100n * MIN }, { line_id: 2, delivery_deadline_ns: ACC + REVIEW - 1n }] });
  assert.deepEqual(w.map((x) => x.lineId), [0, 1, 2]);
  assert.match(w[0].message, /earlier than the funding deadline/);
  assert.match(w[1].message, /can never be funded/);
  assert.match(w[2].message, /before the acceptance deadline/);
  // grace counts
  assert.deepEqual(fundabilityWarnings({ ...base, delivery_grace_period_ns: 1n, lines: [{ line_id: 0, delivery_deadline_ns: FUND + REVIEW - 1n }] }), []);
});
