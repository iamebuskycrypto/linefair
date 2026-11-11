// LF-009 withdrawals — ABI-VERIFIED against main b66913f (lf-009); re-checked
// unchanged against the main 2ccd058 (lf-010a) fixture (LF-010A changed only
// new/create_agreement/get_config; the tests below now run on that fixture).
//
// Source: contracts/escrow/src/lib.rs on main b66913f, copied read-only into
// apps/web/fixtures/contract-main, and the cargo-near ABI of that build
// (WASM sha256 c3c896cbdf05f8562a663c6c98df65bb7fcb6dc38e7e5c52d68d4c871afaefc2,
// MANIFEST.json). withdrawals.test.ts / abi.test.ts check every method,
// argument, field and log prefix below against those fixtures.
//
// Contract facts this module relies on (lib.rs / line.rs):
// - withdraw(agreement_id U64, line_id u32, beneficiary "BUYER"|"SUPPLIER")
//   is #[payable]: exactly 1 yoctoNEAR, prepaid gas >= GAS_FT_TRANSFER +
//   GAS_WITHDRAW_CALLBACK + GAS_WITHDRAW_SELF (10 + 15 + 30 Tgas), caller
//   must be the immutable buyer_id / supplier_id. It always takes the WHOLE
//   claimable amount; the recipient is always that account.
// - The transaction result is the callback's WithdrawalResultView
//   {withdrawal_id, outcome: PAID|FAILED|PENDING|IGNORED}. This module treats
//   it only as "reported by the transaction"; the views decide.
// - A callback that does not complete (inconclusive) leaves the slot PENDING
//   forever: no retry, no timer, no balance-based reconciliation (docs/27 R-2).
//
// Slot state machine (per beneficiary per line; ALLOCATED lines only):
//   EMPTY | FAILED --withdraw--> PENDING            claimable -> pending
//   PENDING --callback Successful--> PAID           pending -> paid (final)
//   PENDING --callback Failed------> FAILED         pending -> claimable (once)
//   PENDING --no/inconclusive callback--> PENDING forever

import { u128, type StateLabel } from "./states.ts";
import type { CustodySummaryView, LineView, WithdrawalResultView, WithdrawalView } from "./types.ts";
import { parseStrictJson } from "../terms.ts";
import { toPlain } from "../near/rpc.ts";
import { describeError } from "./errors.ts";

export const LF009_STATUS = "abi-verified" as "spec-only" | "abi-verified";
export const LF009_SOURCE = "main b66913f (linefair-escrow 0.1.0 (lf-009)); ABI of WASM c3c896cb…efc2";

/** Exact ABI shapes (abi.test.ts / withdrawals.test.ts compare with the fixture). */
export const LF009_METHODS = {
  withdraw: { kind: "call", modifiers: ["payable"], args: ["agreement_id", "line_id", "beneficiary"] },
  on_withdrawal_transfer: { kind: "call", modifiers: ["private"], args: ["agreement_id", "line_id", "beneficiary", "withdrawal_id", "epoch"] },
  get_withdrawal: { kind: "view", modifiers: [], args: ["agreement_id", "line_id", "beneficiary"] },
  custody_summary: { kind: "view", modifiers: [], args: [] },
} as const;

/**
 * Differences between the frozen LF-009 spec prose (lf-009/withdrawals@0a9e9f5)
 * that the earlier spec-only version of this file followed, and the merged
 * ABI. Recorded when the gate was flipped (2026-11-05); the ABI wins.
 */
export const LF009_SPEC_VS_ABI: readonly string[] = [
  "withdraw returns the callback's WithdrawalResultView {withdrawal_id, outcome}, not a bare U64 withdrawal id",
  "custody_summary has last_withdrawal_id (spec prose: next_withdrawal_id) and ft_contract_id (spec prose: FT id)",
  "WithdrawalView names the token field ft_contract_id and also carries agreement_id, line_id and beneficiary",
  "on_withdrawal_transfer returns WithdrawalResultView",
  "ERR_WITHDRAW also has OpenCountOverflow and CallbackNotPrivate",
  "logs also include LF_WITHDRAWAL_INCONCLUSIVE:<id> and LF_INCIDENT:OpenCountUnderflow:<id>; IGNORED logs carry a reason code",
];

/** `beneficiary` argument strings (lib.rs beneficiary_from: exact, uppercase). */
export type BeneficiaryArg = "BUYER" | "SUPPLIER";
export type Who = "buyer" | "supplier";

export function beneficiaryArg(who: Who): BeneficiaryArg {
  return who === "buyer" ? "BUYER" : "SUPPLIER";
}

/** Receipt log prefixes emitted by the LF-009 code (codes and ids only). */
export const WITHDRAW_LOG_PREFIXES = [
  "LF_WITHDRAWAL_PAID:",
  "LF_WITHDRAWAL_FAILED:",
  "LF_WITHDRAWAL_IGNORED:",
  "LF_WITHDRAWAL_INCONCLUSIVE:",
  "LF_INCIDENT:CustodyUnderflow:",
  "LF_INCIDENT:OpenCountUnderflow:",
] as const;

/** Outcomes the callback can report (lib.rs WithdrawalResultView doc). */
export const WITHDRAW_OUTCOMES = ["PAID", "FAILED", "PENDING", "IGNORED"] as const;

export type ClaimKey = "not_allocated" | "none" | "claimable" | "pending" | "paid" | "failed_restored" | "incident";

export interface ClaimState extends StateLabel {
  readonly key: ClaimKey;
  /** The party's allocated share (base units); 0 before allocation. */
  readonly share: bigint;
  /** Whether the ledger alone would allow a withdraw (the panel adds account, record and registration checks). */
  readonly withdrawable: boolean;
}

/**
 * Founder decision 2026-11-05: the exact withdrawal-state messages. Each is
 * shown only when the contract state it names has been read from the
 * contract itself (never from a transaction result, browser event or token
 * balance):
 * - failedRestored: slot FAILED with the whole share claimable again, from a fresh snapshot;
 * - notRegistered: the token's storage_balance_of(recipient) returned null;
 * - unconfirmed: slot PENDING (also after the transaction finished or failed);
 * - paid: slot PAID, confirmed by a second, later snapshot of the same record.
 * withdrawals.test.ts and scripts/browser-dom-check.ts compare by exact equality.
 */
export const WITHDRAWAL_MESSAGES = {
  failedRestored: "The transfer failed. Your funds are available to withdraw again.",
  notRegistered: "Your account must be registered with this token before you can withdraw.",
  unconfirmed: "Payment outcome unconfirmed. Do not retry this withdrawal.",
  paid: "Payment completed successfully.",
} as const;

export const CLAIM_COPY = {
  claimable: "Allocated to you and held by the escrow. Not paid until you withdraw it and the contract confirms the token transfer.",
  pending:
    "A token transfer was started and the contract has not confirmed its outcome. The amount is frozen to prevent a duplicate payment. It stays in this state until the contract's own confirmation arrives; there is no automatic retry and no time-out. Do not retry; contact support with the transaction ID.",
  paid: "The contract confirmed the token transfer to the recipient named below.",
  failedRestored: "No tokens left the escrow: the contract restored the full amount to your claim.",
  failedCause:
    "A common cause: the recipient account is not registered on the token contract. NEP-141 tokens only accept transfers to registered accounts; registration is a storage_deposit call on the token by or for the recipient.",
  inconclusive:
    "Limitation of this version: the transaction has finished, but the contract never recorded the outcome of the token transfer (its confirmation step did not complete). The amount stays frozen as pending permanently. This app cannot resolve it: there is no retry, no time-out and no balance-based correction, and the claim must not be treated as paid or as ready to withdraw. Contact support with the withdrawal id and the transaction ID; the transfer receipt in the explorer shows what happened.",
} as const;

function incident(why: string, share: bigint): ClaimState {
  return {
    key: "incident",
    label: "Claim state inconsistent — incident",
    detail: `The contract reported a withdrawal state this app does not recognise or that is inconsistent. Do not act on it; report it. (${why})`,
    tone: "negative",
    share,
    withdrawable: false,
  };
}

/**
 * Claim state of one beneficiary on one line, from the ledger only. Strict:
 * the whole share sits in exactly one bucket that matches the slot state
 * (one allocation per line, withdraw takes the whole claimable), so anything
 * else is an incident. "Paid" ONLY for slot PAID with paid == share.
 */
export function claimState(line: LineView, who: Who): ClaimState {
  const slot = who === "buyer" ? line.buyer_withdrawal : line.supplier_withdrawal;
  const claimable = u128(who === "buyer" ? line.buyer_claimable : line.supplier_claimable);
  const pending = u128(who === "buyer" ? line.buyer_pending : line.supplier_pending);
  const paid = u128(who === "buyer" ? line.buyer_paid : line.supplier_paid);
  if (line.status !== "ALLOCATED") {
    if (slot !== "EMPTY" || claimable !== 0n || pending !== 0n || paid !== 0n) return incident(`claim on a ${line.status} line`, 0n);
    return { key: "not_allocated", label: "Not allocated yet", tone: "neutral", share: 0n, withdrawable: false };
  }
  const share = u128(who === "buyer" ? line.allocation_buyer_amount : line.allocation_supplier_amount);
  const only = (bucket: "claimable" | "pending" | "paid") =>
    (bucket === "claimable" ? claimable === share : claimable === 0n) &&
    (bucket === "pending" ? pending === share : pending === 0n) &&
    (bucket === "paid" ? paid === share : paid === 0n);
  switch (slot) {
    case "EMPTY":
      if (!only("claimable")) return incident("EMPTY slot whose share is not wholly claimable", share);
      if (share === 0n) return { key: "none", label: "Nothing allocated to you", tone: "neutral", share, withdrawable: false };
      return { key: "claimable", label: "Claimable — allocated, not paid", detail: CLAIM_COPY.claimable, tone: "info", share, withdrawable: true };
    case "PENDING":
      if (share === 0n || !only("pending")) return incident("PENDING slot whose share is not wholly pending", share);
      return { key: "pending", label: WITHDRAWAL_MESSAGES.unconfirmed, detail: CLAIM_COPY.pending, tone: "warning", share, withdrawable: false };
    case "PAID":
      if (share === 0n || !only("paid")) return incident("PAID slot without the whole share confirmed paid", share);
      // Ledger-only label from ONE read: never the confirmed-paid message (claimPanel adds the second-snapshot rule).
      return { key: "paid", label: "PAID recorded — not yet confirmed", detail: CLAIM_COPY.paid, tone: "info", share, withdrawable: false };
    case "FAILED":
      if (share === 0n || !only("claimable")) return incident("FAILED slot without the whole share restored", share);
      return { key: "failed_restored", label: WITHDRAWAL_MESSAGES.failedRestored, detail: CLAIM_COPY.failedRestored, tone: "warning", share, withdrawable: true };
    default:
      return incident(`unknown withdrawal slot ${slot}`, share);
  }
}

/**
 * The `get_withdrawal` record must agree with the ledger read in the SAME
 * block. Returns the first inconsistency, or null.
 */
export function recordMismatch(line: LineView, who: Who, view: WithdrawalView, expectedRecipient: string, ftId: string): string | null {
  const slot = who === "buyer" ? line.buyer_withdrawal : line.supplier_withdrawal;
  const share = line.status === "ALLOCATED" ? u128(who === "buyer" ? line.allocation_buyer_amount : line.allocation_supplier_amount) : 0n;
  if (view.beneficiary !== beneficiaryArg(who)) return `record is for ${view.beneficiary}`;
  if (view.line_id !== line.line_id) return `record is for line ${view.line_id}`;
  if (view.state !== slot) return `record state ${view.state} differs from line slot ${slot}`;
  if (view.recipient !== expectedRecipient) return "record recipient differs from the account in the terms";
  if (view.ft_contract_id !== ftId) return "record token differs from the agreement's token";
  const id = u128(view.withdrawal_id);
  const amount = u128(view.amount);
  const started = u128(view.started_at_ns);
  const resolved = u128(view.resolved_at_ns);
  switch (view.state) {
    case "EMPTY":
      if (id !== 0n || amount !== 0n || view.epoch !== 0 || started !== 0n || resolved !== 0n) return "EMPTY record with withdrawal data";
      return null;
    case "PENDING":
      if (id === 0n || amount !== share || started === 0n || resolved !== 0n) return "PENDING record does not match the pending share";
      return null;
    case "PAID":
    case "FAILED":
      if (id === 0n || amount !== share || started === 0n || resolved < started) return `${view.state} record does not match the share`;
      return null;
    default:
      return `unknown record state ${view.state}`;
  }
}

/** Token registration of the recipient (NEP-145 storage_balance_of on the token). */
export type Registration = "checking" | "registered" | "not_registered" | "unknown";

/** This session's latest withdraw transaction for one claim. */
export type TxRecord =
  | { readonly phase: "signing" }
  | {
      readonly phase: "ended";
      readonly txHash: string | null;
      /** Parsed transaction result, or null when the wallet returned none / it could not be parsed. */
      readonly reported: WithdrawalResultView | null;
      /** Wallet or execution error message, if the transaction failed. */
      readonly error: string | null;
      /** True once the bounded post-transaction re-reads have finished. */
      readonly rereadDone: boolean;
    };

/** One consistent read: get_agreement line + get_withdrawal + custody_summary at the same block. */
export interface ClaimSnapshot {
  readonly blockHeight: bigint;
  readonly line: LineView;
  readonly withdrawal: WithdrawalView | null;
  readonly custody: CustodySummaryView;
}

export interface ClaimInputs {
  readonly who: Who;
  /** Immutable recipient from the terms (buyer_id / supplier_id). */
  readonly recipient: string;
  /** terms.ft_contract_id */
  readonly ftId: string;
  /** Latest snapshot; undefined while not read. */
  readonly snap: ClaimSnapshot | undefined;
  /** A later, independent snapshot; used only to confirm PAID. undefined = not taken. */
  readonly confirm: ClaimSnapshot | undefined;
  readonly connected: string | null;
  readonly registration: Registration;
  readonly tx: TxRecord | null;
}

export type PanelKey = ClaimKey | "reading" | "confirming" | "inconclusive";

export interface ClaimNotice {
  readonly tone: "info" | "warning" | "negative";
  readonly text: string;
}

export interface ClaimPanel extends StateLabel {
  readonly key: PanelKey;
  readonly share: bigint;
  readonly recipient: string;
  readonly withdrawalId: string | null;
  readonly amount: bigint | null;
  readonly startedAtNs: bigint | null;
  readonly resolvedAtNs: bigint | null;
  readonly action: { readonly kind: "withdraw" | "retry" | "none"; readonly enabled: boolean; readonly reason: string | null };
  readonly notices: readonly ClaimNotice[];
  /** What the transaction itself reported, and whether the contract record agrees. */
  readonly reported: { readonly text: string; readonly agrees: boolean } | null;
}

export function storageDepositHint(ftId: string, recipient: string): string {
  return `Register first: ${recipient} (or anyone for it) calls storage_deposit on ${ftId} with account_id ${recipient}, attaching at least the token's storage_balance_bounds().min in NEAR. This app does not send that transaction.`;
}

const NO_ACTION = { kind: "none", enabled: false, reason: null } as const;

/**
 * Everything the UI shows for one claim. Pure. Only contract-confirmed state
 * is labelled; the transaction's own result is shown separately as
 * "reported by the transaction".
 */
export function claimPanel(i: ClaimInputs): ClaimPanel {
  const base = {
    share: 0n,
    recipient: i.recipient,
    withdrawalId: null,
    amount: null,
    startedAtNs: null,
    resolvedAtNs: null,
    action: NO_ACTION,
    notices: [] as ClaimNotice[],
    reported: null,
  };
  const panelIncident = (why: string, share: bigint): ClaimPanel => {
    const c = incident(why, share);
    return { ...base, share, key: "incident", label: c.label, detail: c.detail ?? "", tone: c.tone };
  };
  if (i.snap === undefined) return { ...base, key: "reading", label: "Reading the contract record…", tone: "neutral" };

  const { line, withdrawal, custody } = i.snap;
  const c = claimState(line, i.who);
  if (c.key === "incident") return panelIncident(c.detail ?? "", c.share);
  if (c.key === "not_allocated") return { ...base, key: c.key, label: c.label, tone: c.tone };
  if (withdrawal === null) return panelIncident("get_withdrawal returned no record for an allocated line", c.share);
  const mismatch = recordMismatch(line, i.who, withdrawal, i.recipient, i.ftId);
  if (mismatch !== null) return panelIncident(mismatch, c.share);
  if (custody.ft_contract_id !== i.ftId) return panelIncident("custody summary token differs from the agreement's token", c.share);
  const id = u128(withdrawal.withdrawal_id);
  if (id > u128(custody.last_withdrawal_id)) return panelIncident("withdrawal id above the contract's last withdrawal id", c.share);
  if (c.key === "pending" && u128(custody.open_withdrawals) === 0n) return panelIncident("PENDING record while the contract reports no open withdrawal", c.share);

  const record = {
    ...base,
    share: c.share,
    withdrawalId: id === 0n ? null : withdrawal.withdrawal_id,
    amount: id === 0n ? null : u128(withdrawal.amount),
    startedAtNs: id === 0n ? null : u128(withdrawal.started_at_ns),
    resolvedAtNs: u128(withdrawal.resolved_at_ns) === 0n ? null : u128(withdrawal.resolved_at_ns),
  };
  const notices: ClaimNotice[] = [];
  const rep = (k: ClaimKey | null) => reportedBy(i.tx, withdrawal, k);
  const ended = i.tx !== null && i.tx.phase === "ended";

  switch (c.key) {
    case "none":
      return { ...record, key: "none", label: c.label, tone: c.tone, notices, reported: rep(c.key) };
    case "claimable":
    case "failed_restored": {
      if (c.key === "failed_restored") notices.push({ tone: "info", text: CLAIM_COPY.failedCause });
      const reason = actionBlocked(i);
      if (i.registration === "not_registered") {
        notices.push({ tone: "warning", text: WITHDRAWAL_MESSAGES.notRegistered });
        notices.push({
          tone: "info",
          text: `${i.recipient} has no storage registration on the token ${i.ftId}, so a token transfer to it would fail. ${storageDepositHint(i.ftId, i.recipient)}`,
        });
      } else if (i.registration === "unknown") {
        notices.push({ tone: "warning", text: `Could not confirm that ${i.recipient} is registered on the token ${i.ftId}. If it is not, the transfer fails and the amount is restored.` });
      }
      return {
        ...record,
        key: c.key,
        label: c.label,
        detail: c.detail ?? "",
        tone: c.tone,
        action: { kind: c.key === "claimable" ? "withdraw" : "retry", enabled: reason === null, reason },
        notices,
        reported: rep(c.key),
      };
    }
    case "pending":
      if (ended && i.tx.rereadDone) {
        notices.push({ tone: "negative", text: CLAIM_COPY.inconclusive });
        return { ...record, key: "inconclusive", label: WITHDRAWAL_MESSAGES.unconfirmed, detail: CLAIM_COPY.pending, tone: "warning", notices, reported: rep("pending") };
      }
      if (ended) notices.push({ tone: "info", text: "The transaction has finished; re-reading the contract record…" });
      return { ...record, key: "pending", label: c.label, detail: c.detail ?? "", tone: c.tone, notices, reported: rep("pending") };
    case "paid": {
      if (i.confirm === undefined) return { ...record, key: "confirming", label: "Confirming the contract record…", tone: "info", notices, reported: rep(null) };
      const w2 = i.confirm.withdrawal;
      const c2 = claimState(i.confirm.line, i.who);
      if (
        i.confirm.blockHeight < i.snap.blockHeight ||
        w2 === null ||
        c2.key !== "paid" ||
        recordMismatch(i.confirm.line, i.who, w2, i.recipient, i.ftId) !== null ||
        w2.withdrawal_id !== withdrawal.withdrawal_id ||
        w2.amount !== withdrawal.amount ||
        w2.epoch !== withdrawal.epoch
      ) {
        return panelIncident("a fresh re-read did not confirm the PAID record", c.share);
      }
      return { ...record, key: "paid", label: WITHDRAWAL_MESSAGES.paid, detail: c.detail ?? "", tone: "positive", notices, reported: rep("paid") };
    }
  }
}

function actionBlocked(i: ClaimInputs): string | null {
  if (i.connected === null) return `Connect ${i.recipient} to withdraw.`;
  if (i.connected !== i.recipient) return `Only ${i.recipient} can withdraw this claim.`;
  if (i.tx !== null && i.tx.phase === "signing") return "A withdrawal is being signed.";
  if (i.tx !== null && i.tx.phase === "ended" && !i.tx.rereadDone) return "Re-reading the contract record after the transaction…";
  if (i.registration === "checking") return "Checking token registration…";
  if (i.registration === "not_registered") return "Register on the token first (see the storage_deposit notice above).";
  return null;
}

function reportedBy(tx: TxRecord | null, view: WithdrawalView, key: ClaimKey | null): ClaimPanel["reported"] {
  if (tx === null || tx.phase !== "ended") return null;
  const r = tx.reported;
  if (r === null) {
    return {
      text:
        tx.error !== null
          ? "The transaction reported an error and no withdrawal result. Only the contract record counts."
          : "The transaction returned no withdrawal result. Only the contract record counts.",
      agrees: false,
    };
  }
  const head = `Reported by the transaction: ${r.outcome} (withdrawal #${r.withdrawal_id}).`;
  const sameId = r.withdrawal_id === view.withdrawal_id;
  const agrees =
    sameId &&
    ((r.outcome === "PAID" && key === "paid") || (r.outcome === "FAILED" && key === "failed_restored") || (r.outcome === "PENDING" && key === "pending"));
  if (r.outcome === "IGNORED") return { text: `${head} The contract changed nothing for that id. Only the contract record counts.`, agrees: false };
  if (agrees) return { text: `${head} The contract record agrees.`, agrees: true };
  return { text: `${head} Not final: the contract record does not show this outcome, and only the contract record counts.`, agrees: false };
}

/**
 * Error text for a failed or unclear `withdraw` transaction. A known
 * `ERR_*` code is rejected before any state change (errors.ts copy). Without
 * a code the transfer may still have happened (inconclusive callback), so
 * the generic "check before trying again" copy is replaced: only the contract
 * record shown in the claim decides, and the claim itself says whether
 * another withdrawal is possible.
 */
export function withdrawErrorText(message: string): string {
  const d = describeError(message);
  if (d.unknown) return "The withdrawal transaction did not complete normally and the reason is not known. Only the contract record shown for this claim decides the outcome.";
  return `${d.title} ${d.action}`;
}

/**
 * Parse the `withdraw` transaction's SuccessValue (base64 of the JSON
 * WithdrawalResultView). Strict: exact keys, canonical id, known outcome.
 * null for anything else. The result is never a payment confirmation.
 */
export function parseWithdrawResult(successValueBase64: string): WithdrawalResultView | null {
  let text: string;
  try {
    const bin = atob(successValueBase64);
    text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
  let v: unknown;
  try {
    v = toPlain(parseStrictJson(text));
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "outcome,withdrawal_id") return null;
  if (typeof o.withdrawal_id !== "string" || !/^(0|[1-9][0-9]*)$/.test(o.withdrawal_id) || BigInt(o.withdrawal_id) >= 1n << 64n) return null;
  if (typeof o.outcome !== "string" || !(WITHDRAW_OUTCOMES as readonly string[]).includes(o.outcome)) return null;
  return { withdrawal_id: o.withdrawal_id, outcome: o.outcome };
}
