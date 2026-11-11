// LF-009 claim states, ABI-verified against main b66913f (lf-009).
// The gate below compares withdrawals.ts with the committed fixture (ABI +
// lib.rs); a future fixture that changes any LF-009 name fails here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CLAIM_COPY,
  claimPanel,
  claimState,
  LF009_METHODS,
  LF009_STATUS,
  parseWithdrawResult,
  recordMismatch,
  WITHDRAW_LOG_PREFIXES,
  WITHDRAW_OUTCOMES,
  type ClaimInputs,
  type ClaimSnapshot,
  type Registration,
  type TxRecord,
  withdrawErrorText,
  WITHDRAWAL_MESSAGES,
} from "./withdrawals.ts";
import { moneyRows } from "./settlement.ts";
import { withdrawalLabel } from "./states.ts";
import type { CustodySummaryView, LineView, WithdrawalView } from "./types.ts";

const FIXTURE = new URL("../../../fixtures/contract-main/", import.meta.url);
const ABI = JSON.parse(readFileSync(new URL("abi/linefair_escrow_abi.json", FIXTURE), "utf8")) as {
  body: { functions: { name: string; kind: string; modifiers?: string[]; params?: { args: { name: string }[] }; result?: { type_schema: unknown } }[] };
};
const FNS = new Map(ABI.body.functions.map((f) => [f.name, f]));
const lineRs = readFileSync(new URL("src/line.rs", FIXTURE), "utf8");
const libRs = readFileSync(new URL("src/lib.rs", FIXTURE), "utf8");
/** Production part of lib.rs (before the unit-test module). */
const libProd = libRs.slice(0, libRs.indexOf("#[cfg(test)]\nmod tests"));

test("LF-009 gate: abi-verified, and every method name, kind, modifier and argument equals the main ABI", () => {
  assert.equal(LF009_STATUS, "abi-verified");
  for (const [name, spec] of Object.entries(LF009_METHODS)) {
    const f = FNS.get(name);
    assert.ok(f, `${name} missing from the ABI`);
    assert.equal(f.kind, spec.kind, `${name} kind`);
    assert.deepEqual(f.modifiers ?? [], [...spec.modifiers], `${name} modifiers`);
    assert.deepEqual(f.params?.args.map((a) => a.name) ?? [], [...spec.args], `${name} args`);
  }
  // exact result types
  assert.deepEqual(FNS.get("withdraw")?.result?.type_schema, { $ref: "#/definitions/Promise" });
  assert.deepEqual(FNS.get("on_withdrawal_transfer")?.result?.type_schema, { $ref: "#/definitions/WithdrawalResultView" });
  assert.deepEqual(FNS.get("get_withdrawal")?.result?.type_schema, { anyOf: [{ $ref: "#/definitions/WithdrawalView" }, { type: "null" }] });
  assert.deepEqual(FNS.get("custody_summary")?.result?.type_schema, { $ref: "#/definitions/CustodySummaryView" });
  // the withdraw promise resolves to the callback's result (lib.rs returns `.then(on_withdrawal_transfer)`)
  assert.match(libProd, /pub fn withdraw\([^)]*\) -> Promise \{[\s\S]*?\.then\([\s\S]*?\.on_withdrawal_transfer\(/);
  // no other withdrawal-related method exists
  const extra = [...FNS.keys()].filter((n) => /withdraw|custody/.test(n) && !(n in LF009_METHODS));
  assert.deepEqual(extra, []);
});

test("log prefixes and callback outcomes are exactly those in lib.rs (production code)", () => {
  const logs = [...libProd.matchAll(/"(LF_WITHDRAWAL_[A-Z]+:|LF_INCIDENT:[A-Za-z]+:)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(logs)].sort(), [...WITHDRAW_LOG_PREFIXES].sort());
  const outcomes = new Set([...libProd.matchAll(/result\("([A-Z]+)"\)/g)].map((m) => m[1]));
  assert.deepEqual([...outcomes].sort(), [...WITHDRAW_OUTCOMES].sort());
});

test("slot strings used by the claim mapping are exactly line.rs SlotState::as_str on main", () => {
  const body = lineRs.slice(lineRs.indexOf("impl SlotState"));
  const names = [...body.slice(0, body.indexOf("\n}\n")).matchAll(/SlotState::\w+ => "([A-Z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ["EMPTY", "PENDING", "PAID", "FAILED"]);
});

// Founder decision 2026-11-05: the four exact withdrawal-state messages.
const FAILED_MSG = "The transfer failed. Your funds are available to withdraw again.";
const UNREG_MSG = "Your account must be registered with this token before you can withdraw.";
const PENDING_MSG = "Payment outcome unconfirmed. Do not retry this withdrawal.";
const PAID_MSG = "Payment completed successfully.";

test("founder decision 2026-11-05: WITHDRAWAL_MESSAGES are exactly the approved strings", () => {
  assert.deepEqual(WITHDRAWAL_MESSAGES, { failedRestored: FAILED_MSG, notRegistered: UNREG_MSG, unconfirmed: PENDING_MSG, paid: PAID_MSG });
  // no secondary copy repeats or contradicts them
  for (const text of Object.values(CLAIM_COPY)) {
    for (const m of [FAILED_MSG, UNREG_MSG, PENDING_MSG, PAID_MSG]) assert.ok(!text.includes(m), text);
    assert.doesNotMatch(text, /completed successfully|try again|retry it|automatically retried/i);
  }
});

const SHARE_B = 300n;
const SHARE_S = 700n;
const BUYER = "buyer.test.near";
const SUPPLIER = "supplier.test.near";
const FT = "ft.test.near";

function allocated(over: Partial<LineView> = {}): LineView {
  return {
    line_id: 0,
    status: "ALLOCATED",
    locked: "0",
    buyer_claimable: SHARE_B.toString(),
    supplier_claimable: SHARE_S.toString(),
    buyer_pending: "0",
    supplier_pending: "0",
    buyer_paid: "0",
    supplier_paid: "0",
    buyer_withdrawal: "EMPTY",
    supplier_withdrawal: "EMPTY",
    submitted_at_ns: "1",
    evidence_commitment: "1".repeat(64),
    dispute_reason: "BUYER_DISPUTE",
    dispute_t0_ns: "5",
    no_response_t0_ns: null,
    non_delivery_t0_ns: null,
    allocation_mode: "FALLBACK",
    allocation_buyer_amount: SHARE_B.toString(),
    allocation_supplier_amount: SHARE_S.toString(),
    allocation_source_id: "0",
    allocation_finalized_at_ns: "9",
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

test("claimState transitions: claimable -> pending -> paid, pending -> failed (restored)", () => {
  assert.equal(claimState(allocated(), "supplier").key, "claimable");
  assert.equal(claimState(allocated(), "supplier").withdrawable, true);
  const pending = allocated({ supplier_withdrawal: "PENDING", supplier_claimable: "0", supplier_pending: "700" });
  const p = claimState(pending, "supplier");
  assert.equal(p.key, "pending");
  assert.equal(p.label, PENDING_MSG);
  assert.match(p.detail ?? "", /no automatic retry and no time-out/);
  assert.equal(p.withdrawable, false);
  const paid = claimState(allocated({ supplier_withdrawal: "PAID", supplier_claimable: "0", supplier_paid: "700" }), "supplier");
  assert.equal(paid.key, "paid");
  assert.notEqual(paid.label, PAID_MSG, "one ledger read never yields the confirmed-paid message");
  const failed = claimState(allocated({ supplier_withdrawal: "FAILED" }), "supplier");
  assert.equal(failed.key, "failed_restored");
  assert.equal(failed.label, FAILED_MSG);
  assert.equal(failed.withdrawable, true);
  assert.equal(withdrawalLabel(pending, "supplier").label, p.label);
  assert.equal(withdrawalLabel(allocated({ supplier_withdrawal: "FAILED" }), "supplier").label, failed.label);
  const rows = moneyRows(allocated({ supplier_withdrawal: "FAILED" }));
  assert.ok(rows.some((r) => r.party === "supplier" && /amount restored/.test(r.label)));
  assert.ok(!rows.some((r) => r.key === "paid" || /paid —/.test(r.label)));
  const zero = allocated({ buyer_claimable: "0", allocation_buyer_amount: "0", supplier_claimable: "1000", allocation_supplier_amount: "1000" });
  assert.equal(claimState(zero, "buyer").key, "none");
  assert.equal(claimState(allocated({ status: "DISPUTED", locked: "1000", buyer_claimable: "0", supplier_claimable: "0" }), "buyer").key, "not_allocated");
});

test("claimState: Paid only for slot PAID with the whole share paid; every other mix is an incident", () => {
  const slots = ["EMPTY", "PENDING", "PAID", "FAILED", "INCONCLUSIVE", ""];
  const amounts = ["0", "1", "699", "700"];
  let paidSeen = 0;
  for (const slot of slots) {
    for (const c of amounts) {
      for (const pe of amounts) {
        for (const pa of amounts) {
          const s = claimState(allocated({ supplier_withdrawal: slot, supplier_claimable: c, supplier_pending: pe, supplier_paid: pa }), "supplier");
          if (s.key === "paid" || /\bPaid\b/.test(s.label)) {
            paidSeen++;
            assert.deepEqual([slot, c, pe, pa], ["PAID", "0", "0", "700"]);
          }
          if (s.key === "pending") assert.deepEqual([slot, c, pe, pa], ["PENDING", "0", "700", "0"]);
          if (s.key === "failed_restored") assert.deepEqual([slot, c, pe, pa], ["FAILED", "700", "0", "0"]);
          if (s.key === "claimable") assert.deepEqual([slot, c, pe, pa], ["EMPTY", "700", "0", "0"]);
          if (BigInt(c) + BigInt(pe) + BigInt(pa) !== SHARE_S) assert.equal(s.key, "incident", `${slot} ${c}/${pe}/${pa}`);
        }
      }
    }
  }
  assert.equal(paidSeen, 1);
  assert.equal(claimState(allocated({ status: "DISPUTED", supplier_withdrawal: "PAID" }), "supplier").key, "incident");
});

// ---- claimPanel: record + ledger + custody + session ----

type SlotName = "EMPTY" | "PENDING" | "PAID" | "FAILED";

/** Consistent line + record for the supplier slot in `slot`. */
function supplierLine(slot: SlotName): LineView {
  switch (slot) {
    case "EMPTY":
      return allocated();
    case "PENDING":
      return allocated({ supplier_withdrawal: "PENDING", supplier_claimable: "0", supplier_pending: "700" });
    case "PAID":
      return allocated({ supplier_withdrawal: "PAID", supplier_claimable: "0", supplier_paid: "700" });
    case "FAILED":
      return allocated({ supplier_withdrawal: "FAILED" });
  }
}

function record(slot: SlotName, over: Partial<WithdrawalView> = {}): WithdrawalView {
  const active = slot !== "EMPTY";
  return {
    agreement_id: "0",
    line_id: 0,
    beneficiary: "SUPPLIER",
    state: slot,
    withdrawal_id: active ? "2" : "0",
    epoch: active ? 1 : 0,
    amount: active ? "700" : "0",
    started_at_ns: active ? "1000" : "0",
    resolved_at_ns: slot === "PAID" || slot === "FAILED" ? "2000" : "0",
    recipient: SUPPLIER,
    ft_contract_id: FT,
    ...over,
  };
}

function custody(over: Partial<CustodySummaryView> = {}): CustodySummaryView {
  return { outstanding_liabilities: "1000", open_withdrawals: "1", last_withdrawal_id: "2", ft_contract_id: FT, ...over };
}

function snap(slot: SlotName, h = 10n, over: { line?: Partial<LineView>; rec?: Partial<WithdrawalView> | null; cust?: Partial<CustodySummaryView> } = {}): ClaimSnapshot {
  return {
    blockHeight: h,
    line: { ...supplierLine(slot), ...over.line },
    withdrawal: over.rec === null ? null : record(slot, over.rec),
    custody: custody(over.cust),
  };
}

function inputs(over: Partial<ClaimInputs> = {}): ClaimInputs {
  return {
    who: "supplier",
    recipient: SUPPLIER,
    ftId: FT,
    snap: snap("EMPTY"),
    confirm: undefined,
    connected: SUPPLIER,
    registration: "registered",
    tx: null,
    ...over,
  };
}

const ENDED = (over: Partial<Extract<TxRecord, { phase: "ended" }>> = {}): TxRecord => ({ phase: "ended", txHash: "tx1", reported: null, error: null, rereadDone: true, ...over });

test("claimPanel CLAIMABLE: withdraw only for the connected beneficiary, registration gates and warns", () => {
  const ok = claimPanel(inputs());
  assert.equal(ok.key, "claimable");
  assert.deepEqual(ok.action, { kind: "withdraw", enabled: true, reason: null });
  assert.equal(ok.notices.length, 0);
  assert.equal(ok.share, 700n);
  const off = claimPanel(inputs({ connected: null }));
  assert.equal(off.action.enabled, false);
  assert.match(off.action.reason ?? "", /Connect supplier\.test\.near/);
  for (const other of [BUYER, "primary.test.near", "stranger.test.near"]) {
    const p = claimPanel(inputs({ connected: other }));
    assert.equal(p.action.enabled, false, other);
    assert.match(p.action.reason ?? "", /Only supplier\.test\.near can withdraw/);
  }
  const unreg = claimPanel(inputs({ registration: "not_registered" }));
  assert.equal(unreg.action.enabled, false);
  assert.equal(unreg.notices.filter((n) => n.text === UNREG_MSG).length, 1);
  assert.equal(unreg.notices[0]?.text, UNREG_MSG);
  assert.equal(unreg.notices[0]?.tone, "warning");
  assert.ok(unreg.notices.some((n) => n.tone === "info" && /ft\.test\.near/.test(n.text) && /storage_deposit/.test(n.text) && /storage_balance_bounds/.test(n.text)));
  // registered / unknown / checking never show the registration message
  for (const registration of ["registered", "unknown", "checking"] as const) {
    assert.ok(!claimPanel(inputs({ registration })).notices.some((n) => n.text === UNREG_MSG), registration);
  }
  const unknown = claimPanel(inputs({ registration: "unknown" }));
  assert.equal(unknown.action.enabled, true);
  assert.ok(unknown.notices.some((n) => /Could not confirm/.test(n.text)));
  assert.equal(claimPanel(inputs({ registration: "checking" })).action.enabled, false);
  assert.equal(claimPanel(inputs({ tx: { phase: "signing" } })).action.enabled, false);
  // right after a transaction, until the bounded re-reads finish, a lagging read can never re-enable the button
  const lag = claimPanel(inputs({ tx: ENDED({ rereadDone: false }) }));
  assert.equal(lag.action.enabled, false);
  assert.match(lag.action.reason ?? "", /Re-reading/);
  assert.equal(claimPanel(inputs({ tx: ENDED({ error: "ERR_WITHDRAW:InsufficientGas" }) })).action.enabled, true);
  // the buyer's own claim on the same line is independent
  const buyer = claimPanel(inputs({ who: "buyer", recipient: BUYER, connected: BUYER, snap: { ...snap("EMPTY"), withdrawal: { ...record("EMPTY"), beneficiary: "BUYER", recipient: BUYER } } }));
  assert.equal(buyer.key, "claimable");
  assert.equal(buyer.share, 300n);
});

test("claimPanel PENDING: no retry, id and start time shown; inconclusive after the transaction ended", () => {
  const p = claimPanel(inputs({ snap: snap("PENDING") }));
  assert.equal(p.key, "pending");
  assert.equal(p.label, PENDING_MSG);
  assert.deepEqual(p.action, { kind: "none", enabled: false, reason: null });
  assert.equal(p.withdrawalId, "2");
  assert.equal(p.startedAtNs, 1000n);
  assert.equal(p.resolvedAtNs, null);
  // tx ended, re-reads still running: still plain pending
  const rereading = claimPanel(inputs({ snap: snap("PENDING"), tx: ENDED({ rereadDone: false }) }));
  assert.equal(rereading.key, "pending");
  assert.equal(rereading.label, PENDING_MSG);
  // tx ended (finished or failed) and the record is still PENDING: inconclusive
  for (const tx of [ENDED(), ENDED({ error: '{"ActionError":{}}' }), ENDED({ reported: { withdrawal_id: "2", outcome: "PAID" } })]) {
    const i = claimPanel(inputs({ snap: snap("PENDING"), tx }));
    assert.equal(i.key, "inconclusive");
    assert.equal(i.label, PENDING_MSG);
    assert.equal(i.action.kind, "none");
    assert.ok(i.notices.some((n) => n.tone === "negative" && n.text === CLAIM_COPY.inconclusive));
    assert.ok(!/\bPaid\b|Ready to withdraw/.test(i.label));
    assert.equal(i.reported?.agrees ?? false, false);
  }
  const rep = claimPanel(inputs({ snap: snap("PENDING"), tx: ENDED({ reported: { withdrawal_id: "2", outcome: "PAID" } }) }));
  assert.match(rep.reported?.text ?? "", /^Reported by the transaction: PAID \(withdrawal #2\)\. Not final/);
});

test("claimPanel PAID: only after a fresh, later re-read confirms the same PAID record", () => {
  const first = claimPanel(inputs({ snap: snap("PAID") }));
  assert.equal(first.key, "confirming");
  assert.equal(first.label, "Confirming the contract record…");
  assert.equal(first.action.kind, "none");
  const ok = claimPanel(inputs({ snap: snap("PAID", 10n), confirm: snap("PAID", 11n) }));
  assert.equal(ok.key, "paid");
  assert.equal(ok.label, PAID_MSG);
  assert.equal(ok.tone, "positive");
  assert.equal(ok.amount, 700n);
  assert.equal(ok.recipient, SUPPLIER);
  assert.equal(ok.withdrawalId, "2");
  assert.equal(ok.resolvedAtNs, 2000n);
  assert.equal(claimPanel(inputs({ snap: snap("PAID", 10n), confirm: snap("PAID", 10n) })).key, "paid");
  // a confirmation that disagrees is an incident, never Paid
  for (const confirm of [
    snap("PAID", 9n),
    snap("PENDING", 11n),
    snap("PAID", 11n, { rec: { withdrawal_id: "1" }, cust: {} }),
    snap("PAID", 11n, { rec: { epoch: 2 } }),
    snap("PAID", 11n, { rec: null }),
    snap("PAID", 11n, { rec: { amount: "699" } }),
  ]) {
    const p = claimPanel(inputs({ snap: snap("PAID", 10n), confirm }));
    assert.equal(p.key, "incident", JSON.stringify(confirm.withdrawal));
    assert.notEqual(p.label, PAID_MSG);
  }
  const reported = claimPanel(inputs({ snap: snap("PAID", 10n), confirm: snap("PAID", 11n), tx: ENDED({ reported: { withdrawal_id: "2", outcome: "PAID" } }) }));
  assert.deepEqual(reported.reported, { text: "Reported by the transaction: PAID (withdrawal #2). The contract record agrees.", agrees: true });
  const confirming = claimPanel(inputs({ snap: snap("PAID"), tx: ENDED({ reported: { withdrawal_id: "2", outcome: "PAID" } }) }));
  assert.equal(confirming.reported?.agrees, false);
  assert.equal(confirming.label, "Confirming the contract record…");
});

test("claimPanel FAILED: amount restored, retry allowed, cause and storage_deposit shown", () => {
  const f = claimPanel(inputs({ snap: snap("FAILED") }));
  assert.equal(f.key, "failed_restored");
  assert.equal(f.label, FAILED_MSG);
  assert.deepEqual(f.action, { kind: "retry", enabled: true, reason: null });
  assert.ok(f.notices.some((n) => n.text === CLAIM_COPY.failedCause && /not registered/.test(n.text) && /storage_deposit/.test(n.text)));
  const unreg = claimPanel(inputs({ snap: snap("FAILED"), registration: "not_registered" }));
  assert.equal(unreg.action.enabled, false);
  assert.equal(unreg.label, FAILED_MSG);
  assert.ok(unreg.notices.some((n) => n.text === UNREG_MSG));
  assert.ok(unreg.notices.some((n) => /storage_deposit on ft\.test\.near with account_id supplier\.test\.near/.test(n.text)));
  const rep = claimPanel(inputs({ snap: snap("FAILED"), tx: ENDED({ reported: { withdrawal_id: "2", outcome: "FAILED" } }) }));
  assert.equal(rep.reported?.agrees, true);
  const ignored = claimPanel(inputs({ snap: snap("FAILED"), tx: ENDED({ reported: { withdrawal_id: "3", outcome: "IGNORED" } }) }));
  assert.match(ignored.reported?.text ?? "", /changed nothing/);
});

test("claimPanel: record/ledger/custody inconsistencies are incidents with no action", () => {
  const cases: [string, ClaimSnapshot][] = [
    ["record state differs", { ...snap("PENDING"), withdrawal: record("PAID") }],
    ["record for buyer", snap("EMPTY", 10n, { rec: { beneficiary: "BUYER" } })],
    ["record for other line", snap("EMPTY", 10n, { rec: { line_id: 1 } })],
    ["recipient differs", snap("PENDING", 10n, { rec: { recipient: "evil.test.near" } })],
    ["token differs", snap("PENDING", 10n, { rec: { ft_contract_id: "other.test.near" } })],
    ["EMPTY record with id", snap("EMPTY", 10n, { rec: { withdrawal_id: "1" } })],
    ["PENDING amount differs", snap("PENDING", 10n, { rec: { amount: "699" } })],
    ["PENDING resolved", snap("PENDING", 10n, { rec: { resolved_at_ns: "5" } })],
    ["PAID id 0", snap("PAID", 10n, { rec: { withdrawal_id: "0" } })],
    ["FAILED amount differs", snap("FAILED", 10n, { rec: { amount: "1" } })],
    ["no record", snap("EMPTY", 10n, { rec: null })],
    ["custody token differs", snap("EMPTY", 10n, { cust: { ft_contract_id: "other.test.near" } })],
    ["id above last id", snap("PENDING", 10n, { cust: { last_withdrawal_id: "1" } })],
    ["pending but no open withdrawal", snap("PENDING", 10n, { cust: { open_withdrawals: "0" } })],
    ["ledger split", snap("PAID", 10n, { line: { supplier_paid: "699", supplier_pending: "1" } })],
  ];
  for (const [name, s] of cases) {
    const p = claimPanel(inputs({ snap: s, confirm: s }));
    assert.equal(p.key, "incident", name);
    assert.equal(p.action.kind, "none", name);
    assert.equal(p.tone, "negative", name);
  }
  assert.equal(recordMismatch(supplierLine("PENDING"), "supplier", record("PENDING"), SUPPLIER, FT), null);
});

test("claimPanel exhaustive: Paid / Ready never appear outside a confirmed PAID; actions only for the beneficiary", () => {
  const slots: string[] = ["EMPTY", "PENDING", "PAID", "FAILED", "INCONCLUSIVE"];
  const amounts = ["0", "700"];
  const regs: Registration[] = ["registered", "not_registered", "unknown", "checking"];
  const txs: (TxRecord | null)[] = [null, { phase: "signing" }, ENDED(), ENDED({ rereadDone: false }), ENDED({ reported: { withdrawal_id: "2", outcome: "PAID" } })];
  let n = 0;
  let paidSeen = 0;
  let pendingSeen = 0;
  let failedSeen = 0;
  let unregSeen = 0;
  for (const ls of slots) {
    for (const rs of slots) {
      for (const c of amounts) {
        for (const pe of amounts) {
          for (const pa of amounts) {
            const line = allocated({ supplier_withdrawal: ls, supplier_claimable: c, supplier_pending: pe, supplier_paid: pa });
            const active = rs !== "EMPTY";
            const rec = record("PENDING", {
              state: rs,
              withdrawal_id: active ? "2" : "0",
              epoch: active ? 1 : 0,
              amount: active ? "700" : "0",
              started_at_ns: active ? "1000" : "0",
              resolved_at_ns: rs === "PAID" || rs === "FAILED" ? "2000" : "0",
            });
            const s: ClaimSnapshot = { blockHeight: 10n, line, withdrawal: rec, custody: custody() };
            for (const confirm of [undefined, { ...s, blockHeight: 11n }]) {
              for (const connected of [SUPPLIER, BUYER, null]) {
                for (const registration of regs) {
                  for (const tx of txs) {
                    const p = claimPanel(inputs({ snap: s, confirm, connected, registration, tx }));
                    n++;
                    assert.ok(!/Ready to withdraw/.test(p.label));
                    const texts = [p.label, p.detail ?? "", ...p.notices.map((x) => x.text), p.reported?.text ?? ""];
                    if (p.key === "paid" || texts.some((t) => t.includes(PAID_MSG))) {
                      paidSeen++;
                      assert.equal(p.key, "paid");
                      assert.equal(p.label, PAID_MSG);
                      assert.equal(texts.filter((t) => t.includes(PAID_MSG)).length, 1, "only the label");
                      assert.deepEqual([ls, rs, c, pe, pa], ["PAID", "PAID", "0", "0", "700"]);
                      assert.notEqual(confirm, undefined);
                    }
                    // exact founder messages, by state
                    if (p.key === "pending" || p.key === "inconclusive") {
                      pendingSeen++;
                      assert.equal(p.label, PENDING_MSG);
                    } else assert.notEqual(p.label, PENDING_MSG);
                    if (p.key === "failed_restored") {
                      failedSeen++;
                      assert.equal(p.label, FAILED_MSG);
                      assert.deepEqual([ls, rs, c, pe, pa], ["FAILED", "FAILED", "700", "0", "0"]);
                    } else assert.notEqual(p.label, FAILED_MSG);
                    const unregNotices = p.notices.filter((x) => x.text === UNREG_MSG).length;
                    if (registration === "not_registered" && (p.key === "claimable" || p.key === "failed_restored")) {
                      unregSeen++;
                      assert.equal(unregNotices, 1);
                    } else assert.equal(unregNotices, 0);
                    if (ls === "PAID" && rs === "PAID" && c === "0" && pe === "0" && pa === "700" && confirm === undefined) {
                      assert.equal(p.key, "confirming");
                      assert.equal(p.label, "Confirming the contract record…");
                    }
                    for (const t of texts) {
                      for (const m of [FAILED_MSG, UNREG_MSG, PENDING_MSG, PAID_MSG]) {
                        if (t !== m) assert.ok(!t.includes(m), `${m} embedded in ${t}`);
                      }
                    }
                    if (p.action.enabled) {
                      assert.ok(p.key === "claimable" || p.key === "failed_restored", p.key);
                      assert.equal(connected, SUPPLIER);
                      assert.notEqual(registration, "not_registered");
                      assert.notEqual(registration, "checking");
                      assert.ok(tx === null || tx.phase !== "signing");
                      assert.ok(tx === null || tx.phase !== "ended" || tx.rereadDone);
                    }
                    if (p.key === "pending" || p.key === "inconclusive" || p.key === "paid" || p.key === "confirming" || p.key === "incident") {
                      assert.equal(p.action.kind, "none");
                    }
                    if (p.key === "inconclusive") assert.ok(tx !== null && tx.phase === "ended" && tx.rereadDone);
                    if (ls !== rs) assert.equal(p.key, "incident", `${ls}/${rs}`);
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  assert.equal(n, 5 * 5 * 8 * 2 * 3 * 4 * 5);
  // confirmed PAID: 1 ledger/record combination x confirm present x 3 connections x 4 registrations x 5 txs
  assert.equal(paidSeen, 3 * 4 * 5);
  assert.ok(pendingSeen > 0 && failedSeen > 0 && unregSeen > 0);
});

test("claimPanel before the first read and on a line that is not allocated", () => {
  const r = claimPanel(inputs({ snap: undefined }));
  assert.equal(r.key, "reading");
  assert.equal(r.action.kind, "none");
  const d = claimPanel(inputs({ snap: { ...snap("EMPTY"), line: allocated({ status: "DISPUTED", locked: "1000", supplier_claimable: "0", buyer_claimable: "0" }) } }));
  assert.equal(d.key, "not_allocated");
  assert.equal(d.action.kind, "none");
});

test("withdrawErrorText: known codes keep their copy; an unknown failure never invites a retry", () => {
  assert.equal(
    withdrawErrorText("Smart contract panicked: ERR_WITHDRAW:InsufficientGas"),
    "Not enough gas was attached for the token transfer and its confirmation (at least 55 Tgas). Nothing was changed and your claim is untouched. This app attaches 100 Tgas; report it if it repeats.",
  );
  const unknown = withdrawErrorText('{"ActionError":{"kind":"FunctionCallError"}}');
  assert.equal(unknown, "The withdrawal transaction did not complete normally and the reason is not known. Only the contract record shown for this claim decides the outcome.");
  assert.doesNotMatch(unknown, /try again|retry|completed successfully/i);
});

test("parseWithdrawResult: strict WithdrawalResultView only", () => {
  const b64 = (s: string) => btoa(s);
  assert.deepEqual(parseWithdrawResult(b64('{"withdrawal_id":"7","outcome":"PAID"}')), { withdrawal_id: "7", outcome: "PAID" });
  for (const o of WITHDRAW_OUTCOMES) assert.equal(parseWithdrawResult(b64(`{"withdrawal_id":"1","outcome":"${o}"}`))?.outcome, o);
  for (const bad of [
    '{"withdrawal_id":7,"outcome":"PAID"}',
    '{"withdrawal_id":"07","outcome":"PAID"}',
    '{"withdrawal_id":"18446744073709551616","outcome":"PAID"}',
    '{"withdrawal_id":"7","outcome":"paid"}',
    '{"withdrawal_id":"7","outcome":"DONE"}',
    '{"withdrawal_id":"7","outcome":"PAID","x":1}',
    '{"withdrawal_id":"7"}',
    '"7"',
    "null",
    '{"withdrawal_id":"7","outcome":"PAID","outcome":"FAILED"}',
  ]) {
    assert.equal(parseWithdrawResult(b64(bad)), null, bad);
  }
  assert.equal(parseWithdrawResult("%%%"), null);
  assert.equal(parseWithdrawResult(""), null);
});
