// LF-007 settlement derivation tests. Fixtures are hand-written LineView
// objects in the shape of main b28d33b's get_agreement (field list checked
// against the ABI in abi.test.ts); they prove UI logic only, not chain behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allocationState,
  moneyRows,
  parseSplitInput,
  proposalState,
  recheckBeforeAccept,
  roleOf,
  splitAvailability,
  type Proposal,
} from "./settlement.ts";
import type { LineView } from "./types.ts";

const P = 1_000_000n;
const T0 = 1_800_000_000_000_000_000n;

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
    dispute_phase: "NONE",
    primary_start_ns: null,
    backup_start_ns: null,
    fallback_start_ns: null,
    ...over,
  };
}

const open = (proposer: "BUYER" | "SUPPLIER", id = "1", b = "300000", s = "700000") =>
  line({ proposal_status: "OPEN", proposal_id: id, proposal_proposer: proposer, proposal_buyer_amount: b, proposal_supplier_amount: s, proposal_created_at_ns: (T0 + 5n).toString() });

const allocatedMutual = (id = "2") =>
  line({
    status: "ALLOCATED",
    locked: "0",
    buyer_claimable: "300000",
    supplier_claimable: "700000",
    allocation_mode: "MUTUAL",
    allocation_buyer_amount: "300000",
    allocation_supplier_amount: "700000",
    allocation_source_id: id,
    allocation_finalized_at_ns: (T0 + 9n).toString(),
    proposal_status: "ACCEPTED",
    proposal_id: id,
    proposal_proposer: "SUPPLIER",
    proposal_buyer_amount: "300000",
    proposal_supplier_amount: "700000",
    proposal_created_at_ns: (T0 + 5n).toString(),
  });

const TERMS = { buyer_id: "b.test", supplier_id: "s.test", primary_arbitrator_id: "p.test", backup_arbitrator_id: "k.test" };

test("roleOf maps the four distinct accounts; others and disconnected are null", () => {
  assert.equal(roleOf(TERMS, "b.test"), "buyer");
  assert.equal(roleOf(TERMS, "s.test"), "supplier");
  assert.equal(roleOf(TERMS, "p.test"), "primary_arbitrator");
  assert.equal(roleOf(TERMS, "k.test"), "backup_arbitrator");
  assert.equal(roleOf(TERMS, "x.test"), null);
  assert.equal(roleOf(TERMS, null), null);
});

test("proposalState: none, open, accepted, not accepted after another allocation", () => {
  assert.equal(proposalState(line(), P).key, "none");
  const o = proposalState(open("BUYER"), P);
  assert.equal(o.key, "open");
  assert.equal(o.proposal?.proposer, "buyer");
  assert.equal(o.proposal?.buyerAmount, "300000");
  assert.match(o.detail ?? "", /Nothing is allocated until it is accepted/);
  const a = proposalState(allocatedMutual(), P);
  assert.equal(a.key, "accepted");
  // OPEN proposal left on a line allocated another way (e.g. a later LF-008 ruling)
  const na = proposalState(
    { ...open("SUPPLIER"), status: "ALLOCATED", locked: "0", buyer_claimable: "400000", supplier_claimable: "600000", allocation_mode: "PRIMARY_RULING", allocation_buyer_amount: "400000", allocation_supplier_amount: "600000" },
    P,
  );
  assert.equal(na.key, "not_accepted");
  assert.match(na.detail ?? "", /can no longer be accepted/);
});

test("proposalState: inconsistent contract data is an incident, never an actionable proposal", () => {
  const bad: Partial<LineView>[] = [
    { proposal_status: "OPEN", proposal_id: "1", proposal_proposer: "NONE", proposal_buyer_amount: "1", proposal_supplier_amount: "999999" },
    { proposal_status: "OPEN", proposal_id: "0", proposal_proposer: "BUYER", proposal_buyer_amount: "1", proposal_supplier_amount: "999999" },
    { proposal_status: "OPEN", proposal_id: "1", proposal_proposer: "BUYER", proposal_buyer_amount: "1", proposal_supplier_amount: "1" },
    { proposal_status: "WITHDRAWN", proposal_id: "1", proposal_proposer: "BUYER" },
    { proposal_status: "NONE", proposal_id: "3" },
    { status: "FUNDED", proposal_status: "OPEN", proposal_id: "1", proposal_proposer: "BUYER", proposal_buyer_amount: "0", proposal_supplier_amount: P.toString() },
    { proposal_status: "ACCEPTED", proposal_id: "1", proposal_proposer: "BUYER", proposal_buyer_amount: "0", proposal_supplier_amount: P.toString() }, // still DISPUTED
  ];
  for (const b of bad) assert.equal(proposalState(line(b), P).key, "incident", JSON.stringify(b));
  // ACCEPTED but allocation source differs
  assert.equal(proposalState({ ...allocatedMutual("2"), allocation_source_id: "1" }, P).key, "incident");
  // non-canonical amounts are rejected outright
  assert.throws(() => proposalState(line({ proposal_status: "OPEN", proposal_id: "1", proposal_proposer: "BUYER", proposal_buyer_amount: "+1", proposal_supplier_amount: "1" }), P));
});

test("allocationState: modes, conservation checks, allocated is never paid", () => {
  const m = allocationState(allocatedMutual("2"), P);
  assert.equal(m.label, "Mutual settlement");
  assert.match(m.detail ?? "", /proposal #2/);
  assert.match(m.detail ?? "", /Allocated is not paid/);
  assert.equal(allocationState(line(), P).key, "none");
  assert.equal(allocationState({ ...allocatedMutual(), supplier_claimable: "699999" }, P).key, "incident");
  assert.equal(allocationState({ ...allocatedMutual(), allocation_mode: "SOMETHING" }, P).key, "incident");
  assert.equal(allocationState({ ...allocatedMutual(), allocation_source_id: "0" }, P).key, "incident");
  assert.equal(allocationState(line({ allocation_mode: "MUTUAL" }), P).key, "incident");
  // after a withdrawal begins, claimable+pending+paid still equals the share
  const pend = { ...allocatedMutual(), supplier_claimable: "0", supplier_pending: "700000", supplier_withdrawal: "PENDING" };
  assert.equal(allocationState(pend, P).label, "Mutual settlement");
});

test("splitAvailability: role and state gating mirrors the contract", () => {
  const now = T0 + 10n;
  assert.deepEqual(splitAvailability(line(), P, "buyer", now), { canPropose: true, canAccept: false });
  assert.deepEqual(splitAvailability(line(), P, "supplier", now), { canPropose: true, canAccept: false });
  for (const r of ["primary_arbitrator", "backup_arbitrator", null] as const) {
    const a = splitAvailability(line(), P, r, now);
    assert.equal(a.canPropose || a.canAccept, false);
  }
  // before T0 (contract: BeforeWindowStart)
  assert.equal(splitAvailability(line(), P, "buyer", T0 - 1n).canPropose, false);
  assert.equal(splitAvailability(line(), P, "buyer", T0).canPropose, true);
  assert.equal(splitAvailability(line(), P, "buyer", null).canPropose, false);
  // counterparty can accept; proposer cannot, but can replace
  assert.deepEqual(splitAvailability(open("BUYER"), P, "supplier", now), { canPropose: true, canAccept: true });
  const own = splitAvailability(open("BUYER"), P, "buyer", now);
  assert.equal(own.canAccept, false);
  assert.equal(own.canPropose, true);
  assert.match(own.reason ?? "", /only the other party/);
  // not disputed / already allocated
  for (const st of ["UNFUNDED", "FUNDED", "SUBMITTED"]) assert.equal(splitAvailability(line({ status: st }), P, "buyer", now).canPropose, false);
  const al = splitAvailability(allocatedMutual(), P, "buyer", now);
  assert.equal(al.canPropose || al.canAccept, false);
  assert.match(al.reason ?? "", /final allocation/);
});

test("parseSplitInput: strict decimals, never rounded, must sum to principal", () => {
  // 6 decimals, principal 1.000000 token
  assert.deepEqual(parseSplitInput("0.3", "0.7", P, 6), { ok: true, buyer: 300_000n, supplier: 700_000n });
  assert.deepEqual(parseSplitInput("0", "1", P, 6), { ok: true, buyer: 0n, supplier: P });
  const sum = parseSplitInput("0.3", "0.6", P, 6);
  assert.equal(sum.ok, false);
  assert.ok(!sum.ok && sum.sumError !== undefined);
  for (const bad of ["-0.3", "+0.3", "0.3000001", "3e-1", "", " ", "0x1", "0.3.0", "1 000"]) {
    const r = parseSplitInput(bad, "0.7", P, 6);
    assert.equal(r.ok, false, bad);
    assert.ok(!r.ok && r.buyerError !== undefined, bad);
  }
});

test("recheckBeforeAccept: signs only the exact reviewed, still-open counterparty proposal", () => {
  const reviewed = proposalState(open("BUYER", "4"), P).proposal as Proposal;
  const ok = recheckBeforeAccept(open("BUYER", "4"), P, reviewed, "supplier");
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.proposal.id, "4");
  // superseded by a newer proposal (contract would say StaleProposal)
  const ch = recheckBeforeAccept(open("BUYER", "5"), P, reviewed, "supplier");
  assert.ok(!ch.ok && ch.reason === "changed" && ch.current?.id === "5");
  // same id but different amounts cannot happen on chain, but is still refused
  assert.equal(recheckBeforeAccept(open("BUYER", "4", "1", "999999"), P, reviewed, "supplier").ok, false);
  // accepted or allocated meanwhile
  const gone = recheckBeforeAccept(allocatedMutual("4"), P, reviewed, "supplier");
  assert.ok(!gone.ok && gone.reason === "gone");
  // own proposal, arbitrator, disconnected
  assert.ok(!recheckBeforeAccept(open("BUYER", "4"), P, reviewed, "buyer").ok);
  assert.ok(!recheckBeforeAccept(open("BUYER", "4"), P, reviewed, "primary_arbitrator").ok);
  assert.ok(!recheckBeforeAccept(open("BUYER", "4"), P, reviewed, null).ok);
});

test("moneyRows: locked / claimable / pending / paid; paid only from a PAID slot", () => {
  assert.deepEqual(moneyRows(line()).map((r) => r.key), ["locked"]);
  assert.deepEqual(moneyRows(allocatedMutual()).map((r) => `${r.key}:${r.party}:${r.amount}`), ["claimable:buyer:300000", "claimable:supplier:700000"]);
  const pend = moneyRows({ ...allocatedMutual(), supplier_claimable: "0", supplier_pending: "700000", supplier_withdrawal: "PENDING" });
  assert.ok(pend.some((r) => r.key === "pending" && /outcome unconfirmed/.test(r.label)));
  assert.ok(!pend.some((r) => /paid —/.test(r.label)));
  const paid = moneyRows({ ...allocatedMutual(), supplier_claimable: "0", supplier_paid: "700000", supplier_withdrawal: "PAID" });
  assert.ok(paid.some((r) => r.key === "paid" && r.party === "supplier"));
  const bogus = moneyRows({ ...allocatedMutual(), supplier_claimable: "0", supplier_paid: "700000", supplier_withdrawal: "PENDING" });
  assert.ok(bogus.some((r) => r.key === "incident"));
  assert.ok(!bogus.some((r) => r.key === "paid"));
  // claimable is never labelled paid
  for (const r of moneyRows(allocatedMutual())) assert.doesNotMatch(r.label, /\bpaid —/);
});

test("allocationState detail: paid out only when the ledger shows every share PAID", () => {
  const paid = allocationState({ ...allocatedMutual(), buyer_claimable: "0", supplier_claimable: "0", buyer_paid: "300000", supplier_paid: "700000", buyer_withdrawal: "PAID", supplier_withdrawal: "PAID" }, P);
  assert.match(paid.detail ?? "", /every allocated share has been paid out/);
  assert.doesNotMatch(paid.detail ?? "", /not paid/);
  const one = allocationState({ ...allocatedMutual(), supplier_claimable: "0", supplier_paid: "700000", supplier_withdrawal: "PAID" }, P);
  assert.match(one.detail ?? "", /not paid until/);
});
