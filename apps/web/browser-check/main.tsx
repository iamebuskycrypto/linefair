// Offline DOM check: renders the REAL ArbitrationPanel and LF-009 ClaimCard
// (from claimPanel over FIXTURE views, not chain data), the LF-010A creation
// gate, the fail-closed StartupGate, and (founder authorization 2026-11-05)
// the acceptance panel, the per-line fund / deliver / review / advance
// actions, funding outcomes, post-transaction re-read results and the wallet
// return banner (reads over a scripted RPC test double) in a
// real browser, so that
// scripts/browser-dom-check.ts can assert what each role sees. No wallet
// library is loaded (StaticAppProvider) and the RPC fetch always throws, so
// nothing can be read or signed from this page.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { StaticAppProvider, type AppContextValue } from "../src/app/context.tsx";
import { ArbitrationPanel } from "../src/app/screens/ArbitrationPanel.tsx";
import { ClaimCard } from "../src/app/screens/WithdrawalPanel.tsx";
import { claimPanel, type ClaimSnapshot, type Registration, type TxRecord } from "../src/lib/contract/withdrawals.ts";
import type { AgreementView, LineView, WithdrawalView } from "../src/lib/contract/types.ts";
import { NearRpc, type FetchFn } from "../src/lib/near/rpc.ts";
import { CreateAgreementControl, CreatorNotice } from "../src/app/screens/CreateControl.tsx";
import { StartupGate } from "../src/app/StartupGate.tsx";
import { creationGate } from "../src/lib/creation.ts";
import { EXPECTED_CODE_HASH, EXPECTED_DEPLOYMENT } from "../src/lib/deployment.ts";
import type { AppConfig } from "../src/lib/config.ts";
import { AcceptancePanel, ActionResult, FundingOutcomeCard, LineLifecycle, type ActionResultView } from "../src/app/screens/LifecycleActions.tsx";
import { WalletReturnBanner } from "../src/app/WalletReturn.tsx";
import { fundingOutcome, LIFECYCLE_COPY, type TermsCheck } from "../src/lib/contract/lifecycle.ts";
import { savePending } from "../src/lib/near/walletReturn.ts";
import { describeErrorCode } from "../src/lib/contract/errors.ts";

const T0 = 1_800_000_000_000_000_000n; // 2027-01-15 08:00 UTC
const MIN = 60_000_000_000n;
const P = 1_001n;

const terms = {
  schema_version: 1,
  deadline_rules_version: 1,
  buyer_id: "buyer.test.near",
  supplier_id: "supplier.test.near",
  primary_arbitrator_id: "primary.test.near",
  backup_arbitrator_id: "backup.test.near",
  ft_contract_id: "ft.test.near",
  agreement_nonce: "1",
  acceptance_deadline_ns: "1",
  funding_deadline_ns: "2",
  delivery_grace_period_ns: "0",
  review_window_ns: MIN.toString(),
  negotiation_window_ns: MIN.toString(),
  primary_window_ns: MIN.toString(),
  backup_window_ns: MIN.toString(),
  lines: [{ line_id: 0, principal: P.toString(), delivery_deadline_ns: "3", acceptance_criteria_commitment: "01".repeat(32), fallback_buyer_bps: 6667, fallback_supplier_bps: 3333 }],
};

function line(over: Partial<LineView>): LineView {
  return {
    line_id: 0, status: "DISPUTED", locked: P.toString(),
    buyer_claimable: "0", supplier_claimable: "0", buyer_pending: "0", supplier_pending: "0", buyer_paid: "0", supplier_paid: "0",
    buyer_withdrawal: "EMPTY", supplier_withdrawal: "EMPTY", submitted_at_ns: "1", evidence_commitment: "1".repeat(64),
    dispute_reason: "BUYER_DISPUTE", dispute_t0_ns: T0.toString(), no_response_t0_ns: null, non_delivery_t0_ns: null,
    allocation_mode: "NONE", allocation_buyer_amount: "0", allocation_supplier_amount: "0", allocation_source_id: "0", allocation_finalized_at_ns: "0",
    proposal_status: "NONE", proposal_id: "0", proposal_proposer: "NONE", proposal_buyer_amount: "0", proposal_supplier_amount: "0", proposal_created_at_ns: "0",
    dispute_phase: "NEGOTIATION",
    primary_start_ns: (T0 + MIN).toString(), backup_start_ns: (T0 + 2n * MIN).toString(), fallback_start_ns: (T0 + 3n * MIN).toString(),
    ...over,
  };
}

const agreement = (l: LineView): AgreementView =>
  ({ agreement_id: "0", status: "ACTIVE", terms_hash: "0".repeat(64), acceptances: { buyer: true, supplier: true, primary_arbitrator: true, backup_arbitrator: true }, accelerated_test_timing: true, created_at_ns: "1", terms, lines: [l] }) as unknown as AgreementView;

const offlineRpc = new NearRpc("http://127.0.0.1:9", async () => {
  throw new Error("offline DOM check: no network");
});

function ctx(accountId: string | null): AppContextValue {
  return {
    config: { network: "testnet", rpcUrl: "https://rpc.testnet.near.org", explorerUrl: "https://testnet.nearblocks.io", escrowId: "escrow.testnet", ftId: "ft.testnet" },
    rpc: offlineRpc,
    wallet: { accountId, status: accountId === null ? "disconnected" : "connected", notice: null, connect() {}, disconnect() {}, dismissNotice() {} },
    deployment: null,
  };
}

// LF-010A creation gate: [id, connected account, buyer field] against this allowlist
const ALLOWLIST = ["buyer.test.near"];
const CREATE: [id: string, allowlist: string[] | null, account: string | null, buyer: string][] = [
  ["create-preview", null, "buyer.test.near", "buyer.test.near"],
  ["create-connect", ALLOWLIST, null, "buyer.test.near"],
  ["create-not-allowlisted", ALLOWLIST, "supplier.test.near", "supplier.test.near"],
  ["create-not-buyer", ALLOWLIST, "buyer.test.near", "someone.test.near"],
  ["create-allowed", ALLOWLIST, "buyer.test.near", "buyer.test.near"],
];

// StartupGate over a scripted JSON-RPC test double (no network)
const GATE_CFG: AppConfig = { network: "testnet", rpcUrl: "https://rpc.testnet.near.org", explorerUrl: "https://testnet.nearblocks.io", escrowId: "escrow.lf-demo.testnet", ftId: "ft.lf-demo.testnet" };
function scripted(o: { chainId?: string; codeHash?: string; version?: string; networkId?: string; down?: boolean }): NearRpc {
  const enc = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
  const fn: FetchFn = async (_u, init) => {
    if (o.down === true) throw new Error("offline DOM check: no network");
    const b = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
    const view = (v: unknown) => ({ result: enc(v), logs: [], block_height: 5, block_hash: "H" });
    const result =
      b.method === "status"
        ? { chain_id: o.chainId ?? "testnet" }
        : b.params.request_type === "view_account"
          ? { amount: "0", code_hash: o.codeHash ?? EXPECTED_CODE_HASH, block_height: 5, block_hash: "H" }
          : b.params.method_name === "contract_version"
            ? view(o.version ?? EXPECTED_DEPLOYMENT.contractVersion)
            : view({ network_id: o.networkId ?? "testnet", allowlisted_ft_id: "ft.lf-demo.testnet", operator_treasury_id: "t.lf-demo.testnet", max_agreements: 25, agreements_created: "0", creator_allowlist: ["buyer.lf-demo.testnet"] });
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: "x", result }) };
  };
  return new NearRpc("https://rpc.testnet.near.org", fn);
}
const STARTUP: [id: string, rpc: NearRpc][] = [
  ["startup-ok", scripted({})],
  ["startup-wrong-code", scripted({ codeHash: "EBFuNotxobEuwVGj9Ha46KddtdPKYZHEYNwStPc9VWXb" })],
  ["startup-starve-build", scripted({ version: "linefair-escrow 0.1.0 (lf-012 f3) +test-starve-callback" })],
  ["startup-wrong-network", scripted({ networkId: "mainnet" })],
  ["startup-wrong-chain", scripted({ chainId: "mainnet" })],
  ["startup-unreachable", scripted({ down: true })],
];

const SCENARIOS: [id: string, phase: string, account: string | null][] = [
  ["negotiation-buyer", "NEGOTIATION", "buyer.test.near"],
  ["negotiation-primary", "NEGOTIATION", "primary.test.near"],
  ["primary-primary", "PRIMARY", "primary.test.near"],
  ["primary-backup", "PRIMARY", "backup.test.near"],
  ["primary-supplier", "PRIMARY", "supplier.test.near"],
  ["backup-backup", "BACKUP", "backup.test.near"],
  ["backup-primary", "BACKUP", "primary.test.near"],
  ["fallback-stranger", "FALLBACK", "stranger.test.near"],
  ["fallback-disconnected", "FALLBACK", null],
];

const allocated = (over: Partial<LineView>) =>
  line({ status: "ALLOCATED", locked: "0", dispute_phase: "NONE", primary_start_ns: null, backup_start_ns: null, fallback_start_ns: null, allocation_mode: "FALLBACK", allocation_buyer_amount: "668", allocation_supplier_amount: "333", buyer_claimable: "668", supplier_claimable: "333", ...over });

type Slot = "EMPTY" | "PENDING" | "PAID" | "FAILED";
const SUP = "supplier.test.near";
const ledger: Record<Slot, Partial<LineView>> = {
  EMPTY: {},
  PENDING: { supplier_withdrawal: "PENDING", supplier_claimable: "0", supplier_pending: "333" },
  PAID: { supplier_withdrawal: "PAID", supplier_claimable: "0", supplier_paid: "333" },
  FAILED: { supplier_withdrawal: "FAILED" },
};
function rec(slot: Slot): WithdrawalView {
  const on = slot !== "EMPTY";
  return {
    agreement_id: "0", line_id: 0, beneficiary: "SUPPLIER", state: slot, withdrawal_id: on ? "4" : "0", epoch: on ? 1 : 0, amount: on ? "333" : "0",
    started_at_ns: on ? T0.toString() : "0", resolved_at_ns: slot === "PAID" || slot === "FAILED" ? (T0 + MIN).toString() : "0", recipient: SUP, ft_contract_id: "ft.test.near",
  };
}
const snapOf = (slot: Slot, h: bigint, over: Partial<LineView> = {}): ClaimSnapshot => ({
  blockHeight: h,
  line: allocated({ ...ledger[slot], ...over }),
  withdrawal: rec(slot),
  custody: { outstanding_liabilities: "1001", open_withdrawals: slot === "PENDING" ? "1" : "0", last_withdrawal_id: "4", ft_contract_id: "ft.test.near" },
});
const ended = (over: Partial<Extract<TxRecord, { phase: "ended" }>> = {}): TxRecord => ({ phase: "ended", txHash: "8xFixtureTxHash", reported: null, error: null, rereadDone: true, ...over });

const CLAIMS: [id: string, slot: Slot, opts: { connected?: string | null; registration?: Registration; tx?: TxRecord | null; confirm?: boolean; over?: Partial<LineView> }][] = [
  ["claim-claimable-owner", "EMPTY", {}],
  ["claim-claimable-other", "EMPTY", { connected: "buyer.test.near" }],
  ["claim-claimable-disconnected", "EMPTY", { connected: null }],
  ["claim-claimable-unregistered", "EMPTY", { registration: "not_registered" }],
  ["claim-pending", "PENDING", {}],
  ["claim-inconclusive", "PENDING", { tx: ended({ error: '{"ActionError":{"kind":"FunctionCallError"}}' }) }],
  ["claim-reported-paid-record-pending", "PENDING", { tx: ended({ reported: { withdrawal_id: "4", outcome: "PAID" } }) }],
  ["claim-confirming", "PAID", {}],
  ["claim-paid", "PAID", { confirm: true }],
  ["claim-paid-reported", "PAID", { confirm: true, tx: ended({ reported: { withdrawal_id: "4", outcome: "PAID" } }) }],
  ["claim-failed", "FAILED", { tx: ended({ reported: { withdrawal_id: "4", outcome: "FAILED" } }) }],
  ["claim-failed-unregistered", "FAILED", { registration: "not_registered" }],
  ["claim-paid-inconsistent", "PAID", { confirm: true, over: { supplier_paid: "332", supplier_pending: "1" } }],
];

// ---- lifecycle actions (founder authorization 2026-11-05) ----
// acceptance deadline T0, funding deadline T0+1000 min, review 600 min, grace 0;
// line 0 delivery T0+5000 min (F3 not binding), line 1 delivery T0+1500 min
// (F3 binding: last creditable T0+900 min).
const LC_H = "9257a5bfea49918f0a1b1a3308ad553a384079e73da987df495f55002869a33c";
const REV = 600n * MIN;
const lcTerms = {
  ...terms,
  acceptance_deadline_ns: T0.toString(),
  funding_deadline_ns: (T0 + 1000n * MIN).toString(),
  review_window_ns: REV.toString(),
  lines: [
    { ...terms.lines[0], line_id: 0, delivery_deadline_ns: (T0 + 5000n * MIN).toString() },
    { ...terms.lines[0], line_id: 1, principal: "500", delivery_deadline_ns: (T0 + 1500n * MIN).toString() },
  ],
};
const lcLine = (over: Partial<LineView>) =>
  line({ status: "UNFUNDED", locked: "0", dispute_reason: "NONE", dispute_t0_ns: "0", dispute_phase: "NONE", primary_start_ns: null, backup_start_ns: null, fallback_start_ns: null, submitted_at_ns: "0", evidence_commitment: "0".repeat(64), ...over });
const lcAgreement = (status: string, lines: LineView[], acc: Partial<AgreementView["acceptances"]> = {}): AgreementView =>
  ({ agreement_id: "5", status, terms_hash: LC_H, acceptances: { buyer: false, supplier: false, primary_arbitrator: false, backup_arbitrator: false, ...acc }, accelerated_test_timing: false, created_at_ns: "1", terms: lcTerms, lines }) as unknown as AgreementView;
const OK: TermsCheck = { ok: true, hash: LC_H };
const MISMATCH: TermsCheck = { ok: false, reason: `${LIFECYCLE_COPY.doNotSign} The contract's compute_terms_hash does not match the stored hash.` };

/** Scripted RPC: token views (registration, balance), tx status, get_agreement. */
function lcRpc(o: { registered?: boolean; balance?: string; agreement?: AgreementView; txLogs?: string[] }): NearRpc {
  const enc = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
  const fn: FetchFn = async (_u, init) => {
    const b = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
    const view = (v: unknown) => ({ result: enc(v), logs: [], block_height: 777, block_hash: "H" });
    let result: unknown;
    if (b.method === "tx") result = { status: { SuccessValue: btoa('"0"') }, transaction_outcome: { outcome: { logs: [] } }, receipts_outcome: [{ outcome: { logs: o.txLogs ?? [] } }] };
    else if (b.method === "block") result = { header: { height: 777, timestamp_nanosec: (T0 + 950n * MIN).toString(), hash: "H" } };
    else if (b.params.method_name === "storage_balance_of") result = view(o.registered === false ? null : { total: "1250000000000000000000", available: "0" });
    else if (b.params.method_name === "ft_balance_of") result = view(o.balance ?? "5000");
    else if (b.params.method_name === "get_agreement") result = view(o.agreement ?? null);
    else throw new Error(`offline DOM check: unexpected ${b.method} ${String(b.params.method_name)}`);
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: "x", result }) };
  };
  return new NearRpc("https://rpc.testnet.near.org", fn);
}
function lcCtx(accountId: string | null, rpc: NearRpc = offlineRpc): AppContextValue {
  return { ...ctx(accountId), rpc };
}

const B = "buyer.test.near", S = "supplier.test.near", PA = "primary.test.near", BA = "backup.test.near", X = "stranger.test.near";
const NOW_FUND = T0 + 950n * MIN; // line 0 fundable, line 1 past its F3 cutoff (T0+900 min)
const ACCEPT_NOW = T0 - MIN;

const ACCEPT: [id: string, status: string, account: string | null, acc: Partial<AgreementView["acceptances"]>, check: TermsCheck, now: bigint, issue: string | null][] = [
  ["accept-buyer", "PROPOSED", B, { supplier: true }, OK, ACCEPT_NOW, null],
  ["accept-supplier-done", "PROPOSED", S, { supplier: true }, OK, ACCEPT_NOW, null],
  ["accept-primary", "PROPOSED", PA, {}, OK, ACCEPT_NOW, null],
  ["accept-backup-mismatch", "PROPOSED", BA, {}, MISMATCH, ACCEPT_NOW, null],
  ["accept-invalid", "PROPOSED", B, {}, OK, ACCEPT_NOW, "Each dispute window must be between 60 seconds and 30 days."],
  ["accept-stranger", "PROPOSED", X, {}, OK, ACCEPT_NOW, null],
  ["accept-disconnected", "PROPOSED", null, {}, OK, ACCEPT_NOW, null],
  ["accept-deadline", "PROPOSED", B, {}, OK, T0, null],
  ["accept-expired", "EXPIRED", B, {}, OK, T0 + MIN, null],
  ["accept-agreed", "AGREED", B, { buyer: true, supplier: true, primary_arbitrator: true, backup_arbitrator: true }, OK, ACCEPT_NOW, null],
];

const L0U = lcLine({ line_id: 0 });
const L1U = lcLine({ line_id: 1 });
const FUND: [id: string, status: string, account: string | null, line: LineView, rpc: NearRpc, check: TermsCheck][] = [
  ["fund-buyer", "AGREED", B, L0U, lcRpc({}), OK],
  ["fund-buyer-unregistered", "AGREED", B, L0U, lcRpc({ registered: false }), OK],
  ["fund-buyer-low-balance", "AGREED", B, L0U, lcRpc({ balance: "1000" }), OK],
  ["fund-buyer-f3-too-late", "AGREED", B, L1U, lcRpc({}), OK],
  ["fund-buyer-mismatch", "AGREED", B, L0U, lcRpc({}), MISMATCH],
  ["fund-buyer-proposed", "PROPOSED", B, L0U, lcRpc({}), OK],
  ["fund-supplier", "AGREED", S, L0U, lcRpc({}), OK],
  ["fund-disconnected", "AGREED", null, L0U, lcRpc({}), OK],
];

const CUTOFF0 = T0 + 5000n * MIN;
const FUNDED0 = lcLine({ line_id: 0, status: "FUNDED", locked: P.toString() });
const SUB_AT = T0 + 2000n * MIN;
const SUBMITTED0 = lcLine({ line_id: 0, status: "SUBMITTED", locked: P.toString(), submitted_at_ns: SUB_AT.toString(), evidence_commitment: "ab".repeat(32) });
const LINES: [id: string, account: string | null, line: LineView, now: bigint][] = [
  ["deliver-supplier", S, FUNDED0, CUTOFF0 - MIN],
  ["deliver-buyer", B, FUNDED0, CUTOFF0 - MIN],
  ["deliver-supplier-late", S, lcLine({ line_id: 0, status: "FUNDED", locked: P.toString(), non_delivery_t0_ns: CUTOFF0.toString() }), CUTOFF0],
  ["review-buyer", B, SUBMITTED0, SUB_AT + MIN],
  ["review-supplier", S, SUBMITTED0, SUB_AT + MIN],
  ["review-buyer-ended", B, lcLine({ ...SUBMITTED0, no_response_t0_ns: (SUB_AT + REV).toString() }), SUB_AT + REV],
  ["advance-no-response-stranger", X, lcLine({ ...SUBMITTED0, no_response_t0_ns: (SUB_AT + REV).toString() }), SUB_AT + REV],
  ["advance-non-delivery-disconnected", null, lcLine({ line_id: 0, status: "FUNDED", locked: P.toString(), non_delivery_t0_ns: CUTOFF0.toString() }), CUTOFF0],
  ["advance-not-eligible", X, SUBMITTED0, SUB_AT + MIN],
];

const funded = lcLine({ line_id: 0, status: "FUNDED", locked: P.toString() });
const OUTCOMES: [id: string, outcome: ReturnType<typeof fundingOutcome>][] = [
  ["outcome-secured", fundingOutcome(funded, P, { usedAmount: P.toString(), logs: [], failure: null })],
  ["outcome-refund-amount", fundingOutcome(L0U, P, { usedAmount: "0", logs: ["LF_FT_REFUND:AmountMismatch"], failure: null })],
  ["outcome-refund-f3", fundingOutcome(L0U, P, { usedAmount: "0", logs: ["LF_FT_REFUND:DeliveryTimeTooShort"], failure: null })],
  ["outcome-processing", fundingOutcome(L0U, P, { usedAmount: P.toString(), logs: [], failure: null })],
  ["outcome-not-credited", fundingOutcome(L0U, P, { usedAmount: null, logs: [], failure: '{"ActionError":{}}' })],
];

const TXH = "8xNqvK3m5pQ2rT7uW9yZaBcDeFgHiJkLmNoPqRsTuVwX";
const RESULTS: [id: string, r: ActionResultView][] = [
  ["result-confirmed", { txHash: TXH, reported: "Reported by the transaction: executed. Not final on its own; the contract record decides.", verdict: { confirmed: true, text: "Confirmed by the contract: delivery submitted with your evidence commitment. The buyer's review window has started." }, error: null, readAtBlock: 778n }],
  ["result-unconfirmed", { txHash: TXH, reported: "The wallet returned no transaction result. Only the contract record decides.", verdict: { confirmed: false, text: "The contract does not show the acceptance yet (line is SUBMITTED). A transaction result alone is not proof; re-read again shortly, or check the transaction in the explorer." }, error: null, readAtBlock: 778n }],
  ["result-rejected", { txHash: null, reported: null, verdict: { confirmed: false, text: "The contract does not show the dispute yet (line is SUBMITTED). A transaction result alone is not proof; re-read again shortly, or check the transaction in the explorer." }, error: describeErrorCode("ERR_LINE:ReviewWindowClosed"), readAtBlock: 779n }],
  ["result-funding-refunded", { txHash: TXH, reported: null, verdict: { confirmed: false, text: "" }, error: null, funding: fundingOutcome(L0U, P, { usedAmount: "0", logs: ["LF_FT_REFUND:FundingDeadlinePassed"], failure: null }), readAtBlock: 780n }],
];

// Wallet return: the page is loaded with ?transactionHashes=… (funding) or
// ?errorCode=… (acceptance) by scripts/browser-dom-check.ts. Seed the
// pending-action hint exactly as the runner does before signing.
const q = new URLSearchParams(window.location.search);
if (q.has("transactionHashes")) savePending({ kind: "fund", agreementId: "5", lineId: 0, signerId: B, atMs: 1 });
if (q.has("errorCode")) savePending({ kind: "accept_terms", agreementId: "5", lineId: null, signerId: B, atMs: 1 });
const returnRpc = q.has("transactionHashes")
  ? lcRpc({ agreement: lcAgreement("AGREED", [L0U, L1U], { buyer: true, supplier: true, primary_arbitrator: true, backup_arbitrator: true }), txLogs: ["LF_FT_REFUND:AmountMismatch"] })
  : lcRpc({ agreement: lcAgreement("PROPOSED", [L0U, L1U], {}) });

function LocationNow() {
  // Re-rendered after the banner's effects ran: the address bar as the browser now reports it.
  const [href, setHref] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setHref(window.location.href), 300);
    return () => clearTimeout(t);
  }, []);
  return <span data-location-now={href} />;
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <main>
    {SCENARIOS.map(([id, phase, account]) => {
      const l = line({ dispute_phase: phase });
      return (
        <section className="panel" data-scenario={id} key={id}>
          <StaticAppProvider value={ctx(account)}>
            <ArbitrationPanel a={agreement(l)} line={l} principal={P} decimals={0} symbol="tFT" onRefresh={() => {}} />
          </StaticAppProvider>
        </section>
      );
    })}
    {CLAIMS.map(([id, slot, o]) => {
      const tx = o.tx ?? null;
      const panel = claimPanel({
        who: "supplier",
        recipient: SUP,
        ftId: "ft.test.near",
        snap: snapOf(slot, 100n, o.over),
        confirm: o.confirm === true ? snapOf(slot, 101n, o.over) : undefined,
        connected: o.connected === undefined ? SUP : o.connected,
        registration: o.registration ?? "registered",
        tx,
      });
      const hash = tx !== null && tx.phase === "ended" ? tx.txHash : null;
      return (
        <section className="panel" data-scenario={id} key={id}>
          <ClaimCard who="supplier" panel={panel} decimals={0} symbol="tFT" txHash={hash} txUrl={hash === null ? null : `https://testnet.nearblocks.io/txns/${hash}`} error={null} onWithdraw={() => {}} />
        </section>
      );
    })}
    {CREATE.map(([id, list, account, buyer]) => {
      const gate = creationGate(list, account, buyer);
      return (
        <section className="panel" data-scenario={id} key={id}>
          <CreatorNotice gate={gate} />
          <CreateAgreementControl gate={gate} blockers={[]} busy={false} onCreate={() => {}} />
        </section>
      );
    })}
    {ACCEPT.map(([id, status, account, acc, check, now, issue]) => (
      <section className="panel" data-scenario={id} key={id}>
        <StaticAppProvider value={lcCtx(account)}>
          <AcceptancePanel a={lcAgreement(status, [L0U, L1U], acc)} check={check} validationIssue={issue} nowNs={now} onRefresh={() => {}} />
        </StaticAppProvider>
      </section>
    ))}
    {FUND.map(([id, status, account, l, rpc, check]) => (
      <section className="panel" data-scenario={id} key={id}>
        <StaticAppProvider value={lcCtx(account, rpc)}>
          <LineLifecycle a={lcAgreement(status, [L0U, L1U])} line={l} principal={l.line_id === 0 ? P : 500n} decimals={0} symbol="tFT" check={check} nowNs={NOW_FUND} onRefresh={() => {}} />
        </StaticAppProvider>
      </section>
    ))}
    {LINES.map(([id, account, l, now]) => (
      <section className="panel" data-scenario={id} key={id}>
        <StaticAppProvider value={lcCtx(account)}>
          <LineLifecycle a={lcAgreement("ACTIVE", [l, L1U])} line={l} principal={P} decimals={0} symbol="tFT" check={OK} nowNs={now} onRefresh={() => {}} />
        </StaticAppProvider>
      </section>
    ))}
    {OUTCOMES.map(([id, o]) => (
      <section className="panel" data-scenario={id} key={id}>
        <FundingOutcomeCard outcome={o} decimals={0} symbol="tFT" principal={P} />
      </section>
    ))}
    {RESULTS.map(([id, r]) => (
      <section className="panel" data-scenario={id} key={id}>
        <StaticAppProvider value={lcCtx(B)}>
          <ActionResult r={r} decimals={0} symbol="tFT" principal={P} onReRead={() => {}} />
        </StaticAppProvider>
      </section>
    ))}
    <section className="panel" data-scenario="wallet-return" key="wallet-return">
      <StaticAppProvider value={lcCtx(B, returnRpc)}>
        <WalletReturnBanner />
        <LocationNow />
      </StaticAppProvider>
    </section>
    {STARTUP.map(([id, rpc]) => (
      <section className="panel" data-scenario={id} key={id}>
        <StartupGate config={GATE_CFG} rpc={rpc}>
          {(d) => <p data-app="rendered">App rendered; creators: {d?.creatorAllowlist.join(",")}</p>}
        </StartupGate>
      </section>
    ))}
  </main>,
);
