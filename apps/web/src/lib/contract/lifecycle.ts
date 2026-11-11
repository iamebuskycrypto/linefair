// Real-user lifecycle actions (founder authorization 2026-11-05): accept_terms,
// accept_appointment, funding (token ft_transfer_call), submit_delivery,
// accept_line, open_dispute and advance_case. Pure derivations over contract
// view JSON; the contract is the authority and re-checks everything with its
// own clock. These functions only decide what the UI offers to whom, and how
// a fresh re-read is described after a transaction.
//
// Contract rules mirrored (main 8ec0816 incl. F3, fixtures/contract-main):
// - agreement.rs accept: role for the method (buyer/supplier -> accept_terms,
//   primary/backup -> accept_appointment), then now < acceptance_deadline,
//   then exact hash, then not already accepted.
// - agreement.rs fund_line via lib.rs ft_on_transfer: agreement AGREED or
//   ACTIVE, sender == buyer, line UNFUNDED, now < funding_deadline,
//   amount == principal; otherwise refund + LF_FT_REFUND:<code>.
//   F3 (approved, not on main yet): also now + review <= delivery + grace.
// - line.rs submit_delivery: supplier, line FUNDED, now < delivery + grace,
//   commitment != 0.
// - line.rs accept_line / open_dispute: buyer, line SUBMITTED,
//   submitted_at <= now < submitted_at + review (half-open).
// - line.rs advance_case: anyone; SUBMITTED after review end (NO_RESPONSE,
//   T0 = submitted_at + review) or FUNDED after delivery + grace
//   (NON_DELIVERY, T0 = delivery + grace). T0 is fixed, never the call time.

import { u128 } from "./states.ts";
import type { AgreementView, LineView } from "./types.ts";
import type { Role } from "./settlement.ts";
import { describeRefund, type RefundCopy } from "./errors.ts";

/** What one action looks like for the connected account. */
export type ActionAvail =
  /** The line/agreement state does not allow this action at all. */
  | { readonly kind: "hidden" }
  /** The state allows it, but only for another role: no button, a short note. */
  | { readonly kind: "other_role"; readonly note: string }
  /** Right role, but a precondition fails: disabled button with the reason. */
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "enabled" };

const hidden: ActionAvail = { kind: "hidden" };
const enabled: ActionAvail = { kind: "enabled" };
const disabled = (reason: string): ActionAvail => ({ kind: "disabled", reason });
const other = (note: string): ActionAvail => ({ kind: "other_role", note });

export const LIFECYCLE_COPY = {
  doNotSign: "Terms could not be verified. Do not sign.",
  noChainTime: "Chain time could not be read, so the deadline cannot be checked. Re-read and try again.",
  connect: "Connect your testnet wallet to act on this agreement.",
  fixedT0:
    "The dispute start time T0 is fixed at the missed deadline shown here. Calling later does not move it, and calling earlier is rejected by the contract.",
  tooLate: "Too late to fund: the supplier would have less than the review window to deliver.",
} as const;

// ---------------------------------------------------------------- terms check

export type TermsCheck = { readonly ok: true; readonly hash: string } | { readonly ok: false; readonly reason: string };

/**
 * The stored terms re-encoded in this browser (`local`), the stored
 * `terms_hash` and the contract's own `compute_terms_hash(terms)` must all be
 * equal. Any null (could not compute or read) or difference blocks signing.
 */
export function checkTerms(local: string | null, stored: string, contract: string | null): TermsCheck {
  if (!/^[0-9a-f]{64}$/.test(stored)) return { ok: false, reason: `${LIFECYCLE_COPY.doNotSign} The stored terms hash is malformed.` };
  if (local === null) return { ok: false, reason: `${LIFECYCLE_COPY.doNotSign} The stored terms could not be re-encoded in this browser.` };
  if (contract === null) return { ok: false, reason: `${LIFECYCLE_COPY.doNotSign} The contract's compute_terms_hash could not be read.` };
  if (local !== stored) return { ok: false, reason: `${LIFECYCLE_COPY.doNotSign} The terms re-encoded in this browser do not match the stored hash.` };
  if (contract !== stored) return { ok: false, reason: `${LIFECYCLE_COPY.doNotSign} The contract's compute_terms_hash does not match the stored hash.` };
  return { ok: true, hash: stored };
}

// ---------------------------------------------------------------- acceptance

export type AcceptMethod = "accept_terms" | "accept_appointment";

export interface AcceptanceRow {
  readonly role: Role;
  readonly title: string;
  readonly accountId: string;
  readonly accepted: boolean;
  readonly method: AcceptMethod;
}

const ROLE_TITLE: Record<Role, string> = {
  buyer: "Buyer",
  supplier: "Supplier",
  primary_arbitrator: "Primary arbitrator",
  backup_arbitrator: "Backup arbitrator",
};

export function methodFor(role: Role): AcceptMethod {
  return role === "buyer" || role === "supplier" ? "accept_terms" : "accept_appointment";
}

/** Who has accepted, exactly as the contract's `acceptances` reports it. */
export function acceptanceRows(a: AgreementView): AcceptanceRow[] {
  const t = a.terms;
  const acc = a.acceptances;
  return [
    { role: "buyer", accountId: t.buyer_id, accepted: acc.buyer },
    { role: "supplier", accountId: t.supplier_id, accepted: acc.supplier },
    { role: "primary_arbitrator", accountId: t.primary_arbitrator_id, accepted: acc.primary_arbitrator },
    { role: "backup_arbitrator", accountId: t.backup_arbitrator_id, accepted: acc.backup_arbitrator },
  ].map((r) => ({ ...r, role: r.role as Role, title: ROLE_TITLE[r.role as Role], method: methodFor(r.role as Role) }));
}

/**
 * accept_terms / accept_appointment availability for the connected account.
 * `validationIssue`: the local validator's verdict on the stored terms at
 * chain time (compute_terms_hash does not validate), null when they pass.
 */
export function acceptAvail(
  a: AgreementView,
  role: Role | null,
  accountId: string | null,
  nowNs: bigint | null,
  terms: TermsCheck,
  validationIssue: string | null,
): ActionAvail {
  switch (a.status) {
    case "AGREED":
    case "ACTIVE":
      return hidden;
    case "EXPIRED":
      return role === null ? hidden : disabled("The acceptance deadline passed before all four parties accepted. This proposal can no longer be accepted.");
    case "PROPOSED":
      break;
    default:
      return disabled(`Unknown agreement status (${a.status}). Do not act on it; report it.`);
  }
  if (accountId === null) return other(LIFECYCLE_COPY.connect);
  if (role === null) return other("Only the four accounts named in the terms accept. The connected account is not one of them.");
  const row = acceptanceRows(a).find((r) => r.role === role);
  if (row?.accepted === true) return disabled("You have already accepted (contract record).");
  if (nowNs === null) return disabled(LIFECYCLE_COPY.noChainTime);
  if (nowNs >= u128(a.terms.acceptance_deadline_ns)) return disabled("The acceptance deadline has passed (chain time).");
  if (!terms.ok) return disabled(terms.reason);
  if (validationIssue !== null) return disabled(`${LIFECYCLE_COPY.doNotSign} The terms fail the contract's rules locally: ${validationIssue}`);
  return enabled;
}

// ---------------------------------------------------------------- funding

export interface FundingWindow {
  /** Hashed funding deadline (exclusive). */
  readonly deadlineNs: bigint;
  /** F3: delivery + grace − review (inclusive last creditable time); null when negative. */
  readonly f3LastNs: bigint | null;
  /** Last nanosecond at which a deposit can still be credited; null = never. */
  readonly lastCreditableNs: bigint | null;
  /** True when the F3 rule, not the funding deadline, decides the cutoff. */
  readonly f3Binding: boolean;
}

/**
 * Effective funding cutoff of one line: min(funding_deadline − 1 ns,
 * delivery + grace − review). The second term is the founder-approved F3 rule
 * (on main since 8ec0816: the contract credits iff now + review <= delivery + grace,
 * inclusive, so this is exactly the last creditable nanosecond).
 */
export function fundingWindow(a: AgreementView, lineId: number): FundingWindow {
  const t = a.terms;
  const l = t.lines[lineId];
  if (l === undefined) throw new RangeError(`line ${lineId} is not in the terms`);
  const deadlineNs = u128(t.funding_deadline_ns);
  const end = u128(l.delivery_deadline_ns) + u128(t.delivery_grace_period_ns);
  const review = u128(t.review_window_ns);
  const f3LastNs = end >= review ? end - review : null;
  const dl = deadlineNs - 1n; // funding is open while now < deadline
  let lastCreditableNs: bigint | null = dl < 0n || f3LastNs === null ? null : dl;
  if (lastCreditableNs !== null && f3LastNs !== null && f3LastNs < lastCreditableNs) lastCreditableNs = f3LastNs;
  return { deadlineNs, f3LastNs, lastCreditableNs, f3Binding: f3LastNs === null || f3LastNs < dl };
}

export interface FundingChecks {
  /** Token `storage_balance_of(escrow)`: true registered, false null, undefined not read. */
  readonly escrowRegistered: boolean | null;
  /** Buyer's token `ft_balance_of`; null when it could not be read. */
  readonly buyerBalance: bigint | null;
}

export function fundAvail(
  a: AgreementView,
  line: LineView,
  role: Role | null,
  accountId: string | null,
  nowNs: bigint | null,
  terms: TermsCheck,
  checks: FundingChecks,
): ActionAvail {
  if (line.status !== "UNFUNDED") return hidden;
  if (a.status === "EXPIRED") return hidden;
  const t = a.terms.lines[line.line_id];
  if (t === undefined) return disabled("This line is not in the terms. Do not act on it; report it.");
  if (accountId === null) return other(LIFECYCLE_COPY.connect);
  if (role !== "buyer") return other(`Only the buyer (${a.terms.buyer_id}) can fund this line.`);
  if (a.status === "PROPOSED") return disabled("All four parties must accept the terms before any line can be funded.");
  if (a.status !== "AGREED" && a.status !== "ACTIVE") return disabled(`Unknown agreement status (${a.status}). Do not act on it; report it.`);
  if (nowNs === null) return disabled(LIFECYCLE_COPY.noChainTime);
  const w = fundingWindow(a, line.line_id);
  if (nowNs >= w.deadlineNs) return disabled("The funding deadline has passed. This line can no longer be funded.");
  if (w.lastCreditableNs === null || nowNs > w.lastCreditableNs) return disabled(LIFECYCLE_COPY.tooLate);
  if (!terms.ok) return disabled(terms.reason);
  if (checks.escrowRegistered === null) return disabled("The escrow's registration on the token could not be read. Re-read and try again.");
  if (!checks.escrowRegistered) {
    return disabled("The escrow is not registered on the token, so the deposit would be returned. The operator must register it (storage_deposit) first.");
  }
  if (checks.buyerBalance === null) return disabled("Your token balance could not be read. Re-read and try again.");
  if (checks.buyerBalance < u128(t.principal)) return disabled("Your token balance is below the exact line amount. Funding needs the whole amount in one transfer.");
  return enabled;
}

// ---------------------------------------------------------------- delivery

export function submissionCutoff(a: AgreementView, lineId: number): bigint {
  const l = a.terms.lines[lineId];
  if (l === undefined) throw new RangeError(`line ${lineId} is not in the terms`);
  return u128(l.delivery_deadline_ns) + u128(a.terms.delivery_grace_period_ns);
}

export function deliverAvail(a: AgreementView, line: LineView, role: Role | null, accountId: string | null, nowNs: bigint | null): ActionAvail {
  if (line.status !== "FUNDED") return hidden;
  const cutoff = submissionCutoff(a, line.line_id);
  if (role !== "supplier") {
    if (accountId === null) return other(LIFECYCLE_COPY.connect);
    return other(`Only the supplier (${a.terms.supplier_id}) can submit delivery for this line.`);
  }
  if (line.non_delivery_t0_ns !== null) return disabled("The delivery cutoff has passed. Delivery can no longer be submitted on chain; the line can be moved into the non-delivery dispute process.");
  if (nowNs === null) return disabled(LIFECYCLE_COPY.noChainTime);
  if (nowNs >= cutoff) return disabled("The delivery cutoff has passed. Delivery can no longer be submitted on chain; the line can be moved into the non-delivery dispute process.");
  return enabled;
}

// ---------------------------------------------------------------- buyer review

export function reviewEnd(a: AgreementView, line: LineView): bigint {
  return u128(line.submitted_at_ns) + u128(a.terms.review_window_ns);
}

/** accept_line and open_dispute share one window and one role. */
export function reviewAvail(a: AgreementView, line: LineView, role: Role | null, accountId: string | null, nowNs: bigint | null): ActionAvail {
  if (line.status !== "SUBMITTED") return hidden;
  if (role !== "buyer") {
    if (accountId === null) return other(LIFECYCLE_COPY.connect);
    return other(`Only the buyer (${a.terms.buyer_id}) can accept or dispute this delivery.`);
  }
  if (line.no_response_t0_ns !== null) return disabled("The review window has ended. You can no longer accept or dispute; anyone can move the line into the no-response dispute process.");
  if (nowNs === null) return disabled(LIFECYCLE_COPY.noChainTime);
  if (nowNs < u128(line.submitted_at_ns)) return disabled("The review window has not started yet (chain time is before the submission time).");
  if (nowNs >= reviewEnd(a, line)) return disabled("The review window has ended. You can no longer accept or dispute; anyone can move the line into the no-response dispute process.");
  return enabled;
}

// ---------------------------------------------------------------- advance_case

export interface AdvanceInfo {
  readonly avail: ActionAvail;
  readonly reason: "NO_RESPONSE" | "NON_DELIVERY" | null;
  readonly t0Ns: bigint | null;
}

/**
 * Offered only when the contract's view reports eligibility
 * (`no_response_t0_ns` / `non_delivery_t0_ns`), never from a local clock.
 * Anyone may call it.
 */
export function advanceInfo(line: LineView, accountId: string | null): AdvanceInfo {
  let reason: AdvanceInfo["reason"] = null;
  let t0: string | null = null;
  if (line.status === "SUBMITTED" && line.no_response_t0_ns !== null) {
    reason = "NO_RESPONSE";
    t0 = line.no_response_t0_ns;
  } else if (line.status === "FUNDED" && line.non_delivery_t0_ns !== null) {
    reason = "NON_DELIVERY";
    t0 = line.non_delivery_t0_ns;
  }
  if (reason === null || t0 === null) return { avail: hidden, reason: null, t0Ns: null };
  const avail = accountId === null ? disabled("Connect any account to move this line into the dispute process. Anyone may do this.") : enabled;
  return { avail, reason, t0Ns: u128(t0) };
}

// ---------------------------------------------------------------- outcomes

/** What the funding transaction itself reported (never authoritative). */
export interface FundingReport {
  /** `ft_transfer_call` result: the amount the token kept (used); null if unknown. */
  readonly usedAmount: string | null;
  readonly logs: readonly string[];
  /** Transaction-level failure JSON, if any. */
  readonly failure: string | null;
}

export type FundingOutcome =
  | { readonly key: "secured"; readonly title: string; readonly reported: string | null }
  | { readonly key: "refunded"; readonly title: string; readonly refund: RefundCopy; readonly reported: string | null }
  | { readonly key: "not_credited"; readonly title: string; readonly detail: string; readonly reported: string | null }
  | { readonly key: "processing"; readonly title: string; readonly detail: string; readonly reported: string | null }
  | { readonly key: "moved_on"; readonly title: string; readonly reported: string | null }
  | { readonly key: "incident"; readonly title: string; readonly reported: string | null };

function reportText(r: FundingReport | null, principal: bigint): string | null {
  if (r === null) return null;
  if (r.failure !== null) return "Reported by the transaction: failed. Not final; the contract record below decides.";
  if (r.usedAmount === null) return "The transaction did not report a result yet. The contract record below decides.";
  const used = /^(0|[1-9][0-9]*)$/.test(r.usedAmount) ? BigInt(r.usedAmount) : null;
  if (used === principal) return `Reported by the transaction: the token kept ${r.usedAmount} base units. Not final on its own; the contract record below decides.`;
  return `Reported by the transaction: the token kept ${r.usedAmount} base units (the rest was returned). The contract record below decides.`;
}

/**
 * Funding outcome from a FRESH get_agreement read of the line, plus whatever
 * the transaction reported. "Secured in escrow" only when the contract says
 * FUNDED with locked == principal; a refund log on an UNFUNDED line shows
 * that nothing was credited and why.
 */
export function fundingOutcome(fresh: LineView, principal: bigint, report: FundingReport | null): FundingOutcome {
  const reported = reportText(report, principal);
  const locked = u128(fresh.locked);
  if (fresh.status === "FUNDED") {
    if (locked === principal) return { key: "secured", title: "Secured in escrow", reported };
    return { key: "incident", title: "State inconsistent — incident: the line is funded but its locked amount differs from the principal. Do not act on it; report it.", reported };
  }
  if (fresh.status !== "UNFUNDED") return { key: "moved_on", title: `The line has moved on (${fresh.status}); it was funded earlier.`, reported };
  if (locked !== 0n) return { key: "incident", title: "State inconsistent — incident: an unfunded line holds funds. Do not act on it; report it.", reported };
  const refund = report === null ? null : describeRefund(report.logs);
  if (refund !== null) return { key: "refunded", title: "Nothing was credited. The deposit was returned.", refund, reported };
  if (report !== null && (report.failure !== null || report.usedAmount === "0")) {
    return {
      key: "not_credited",
      title: "Nothing was credited.",
      detail: "The contract still shows this line as not funded. Check the token transaction in the explorer before another attempt.",
      reported,
    };
  }
  return {
    key: "processing",
    title: "Funding transaction processing",
    detail: "Not yet credited. This line is secured only after the contract shows it as funded. Re-read in a few seconds.",
    reported,
  };
}

/** Parse an RPC `tx` / wallet FinalExecutionOutcome into a funding report. Never throws. */
export function parseFundingOutcome(outcome: unknown): FundingReport {
  const logs: string[] = [];
  let usedAmount: string | null = null;
  let failure: string | null = null;
  if (outcome === null || typeof outcome !== "object") return { usedAmount, logs, failure };
  const o = outcome as { status?: unknown; receipts_outcome?: unknown; transaction_outcome?: unknown };
  const collect = (x: unknown) => {
    const ls = (x as { outcome?: { logs?: unknown } } | null)?.outcome?.logs;
    if (Array.isArray(ls)) for (const l of ls) if (typeof l === "string") logs.push(l);
  };
  collect(o.transaction_outcome);
  if (Array.isArray(o.receipts_outcome)) for (const r of o.receipts_outcome) collect(r);
  const st = o.status;
  if (st !== null && typeof st === "object") {
    if ("Failure" in st) failure = JSON.stringify((st as { Failure: unknown }).Failure);
    else if ("SuccessValue" in st && typeof (st as { SuccessValue: unknown }).SuccessValue === "string") {
      usedAmount = decodeU128Json((st as { SuccessValue: string }).SuccessValue);
    }
  }
  return { usedAmount, logs, failure };
}

/** base64 of a JSON string holding a canonical decimal ("\"1001\"") -> "1001"; null otherwise. */
export function decodeU128Json(b64: string): string | null {
  let text: string;
  try {
    const bin = atob(b64);
    text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const m = /^"(0|[1-9][0-9]*)"$/.exec(text);
  return m === null ? null : m[1];
}

export type LineAction = "submit_delivery" | "accept_line" | "open_dispute" | "advance_case";

export interface ReReadVerdict {
  /** True only when the fresh contract record shows the action's effect. */
  readonly confirmed: boolean;
  readonly text: string;
}

/**
 * Does a FRESH read show the effect of the action? The transaction result is
 * "reported by the transaction" until this says confirmed.
 */
export function lineActionVerdict(action: LineAction, fresh: LineView, sent?: { evidenceCommitment?: string }): ReReadVerdict {
  const no = (what: string): ReReadVerdict => ({
    confirmed: false,
    text: `The contract does not show ${what} (line is ${fresh.status}). A transaction result alone is not proof; re-read again shortly, or check the transaction in the explorer.`,
  });
  switch (action) {
    case "submit_delivery":
      if (fresh.status === "SUBMITTED" && (sent?.evidenceCommitment === undefined || fresh.evidence_commitment === sent.evidenceCommitment)) {
        return { confirmed: true, text: "Confirmed by the contract: delivery submitted with your evidence commitment. The buyer's review window has started." };
      }
      if (fresh.status === "SUBMITTED") return { confirmed: false, text: "The line is submitted, but with a different evidence commitment than the one sent from this browser. Do not act on it; report it." };
      return no("the submission yet");
    case "accept_line":
      if (fresh.status === "ALLOCATED" && fresh.allocation_mode === "BUYER_ACCEPTED") {
        return { confirmed: true, text: "Confirmed by the contract: the line is accepted and the full amount is allocated to the supplier (claimable, not paid)." };
      }
      return no("the acceptance yet");
    case "open_dispute":
      if (fresh.status === "DISPUTED" && fresh.dispute_reason === "BUYER_DISPUTE") {
        return { confirmed: true, text: "Confirmed by the contract: the line is disputed. Funds stay secured; the dispute timeline starts at T0." };
      }
      return no("the dispute yet");
    case "advance_case":
      if (fresh.status === "DISPUTED" && (fresh.dispute_reason === "NO_RESPONSE" || fresh.dispute_reason === "NON_DELIVERY")) {
        return { confirmed: true, text: `Confirmed by the contract: the line is in the dispute process (${fresh.dispute_reason === "NO_RESPONSE" ? "no buyer response" : "non-delivery"}), with the fixed T0.` };
      }
      return no("the line in the dispute process yet");
  }
}

/** Did a fresh read record this role's acceptance? */
export function acceptVerdict(fresh: AgreementView, role: Role): ReReadVerdict {
  const row = acceptanceRows(fresh).find((r) => r.role === role);
  if (row?.accepted === true) {
    return {
      confirmed: true,
      text: fresh.status === "AGREED" || fresh.status === "ACTIVE" ? "Confirmed by the contract: your acceptance is recorded. All four parties have accepted; the agreement is agreed." : "Confirmed by the contract: your acceptance is recorded.",
    };
  }
  return { confirmed: false, text: "The contract does not show your acceptance yet. A transaction result alone is not proof; re-read again shortly." };
}

// ---------------------------------------------------------------- draft fundability (F3)

export interface FundabilityWarning {
  readonly lineId: number;
  readonly message: string;
}

/**
 * F3 fundability warnings for a draft (not validation errors: the contract
 * accepts such terms, but a line whose delivery + grace is earlier than
 * funding deadline + review window can be funded only until
 * delivery + grace − review, or never).
 */
export function fundabilityWarnings(t: {
  acceptance_deadline_ns: bigint;
  funding_deadline_ns: bigint;
  delivery_grace_period_ns: bigint;
  review_window_ns: bigint;
  lines: readonly { line_id: number; delivery_deadline_ns: bigint }[];
}): FundabilityWarning[] {
  const out: FundabilityWarning[] = [];
  for (const l of t.lines) {
    const end = l.delivery_deadline_ns + t.delivery_grace_period_ns;
    if (end >= t.funding_deadline_ns + t.review_window_ns) continue;
    const fix = "Move the delivery deadline to at least the funding deadline plus the review window.";
    let message: string;
    if (end < t.review_window_ns) {
      message = `Line ${l.line_id + 1} can never be funded: its delivery deadline plus grace is shorter than the review window. ${fix}`;
    } else if (end - t.review_window_ns < t.acceptance_deadline_ns) {
      message = `Line ${l.line_id + 1} can be funded only until delivery deadline + grace − review window, which is before the acceptance deadline: unless all four parties accept early, it can never be funded. ${fix}`;
    } else {
      message = `Line ${l.line_id + 1} can be funded only until delivery deadline + grace − review window, which is earlier than the funding deadline. ${fix}`;
    }
    out.push({ lineId: l.line_id, message });
  }
  return out;
}
