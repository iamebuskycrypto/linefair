// Money-state derivation (apps/web/ARCHITECTURE.md §5). Pure functions over
// contract view JSON. This module is the ONLY place that turns contract state
// strings into user-facing money labels, so it can be tested exhaustively.
//
// Hard rules enforced here (CLAUDE.md, docs/19, docs/27):
// - "Paid" comes only from a PAID withdrawal slot with paid > 0 and pending 0.
// - "Secured in escrow" only for a FUNDED line whose locked == principal.
// - A PENDING slot is always "Payment outcome unconfirmed. Do not retry this
//   withdrawal." (founder decision 2026-11-05), never retryable.
// - Any unknown or internally inconsistent state is an incident, never success.
// - Amounts are BigInt only.

import type { AgreementView, LineView } from "./types.ts";

export type Tone = "neutral" | "info" | "positive" | "warning" | "negative";

export interface StateLabel {
  /** Stable key for tests and styling. */
  readonly key: string;
  readonly label: string;
  readonly detail?: string;
  readonly tone: Tone;
}

const U128_MAX = (1n << 128n) - 1n;

/** Strict U128 view value: canonical decimal string only. Throws otherwise. */
export function u128(s: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a canonical u128 decimal: ${JSON.stringify(s)}`);
  const v = BigInt(s);
  if (v > U128_MAX) throw new Error("u128 overflow");
  return v;
}

export const COPY = {
  notFunded:
    "Not funded: this deliverable is not payment-protected. Do not begin work on the assumption that escrow exists.",
  reviewEnded:
    "The review window has ended. This line enters the agreed dispute process; funds are not automatically paid.",
  nonDelivery:
    "The delivery deadline has passed without a submission. Anyone can move this line into the agreed non-delivery dispute process. Funds stay secured; nothing is refunded automatically.",
  pending:
    "The token transfer has been started but its outcome is not confirmed by the contract. This claim is frozen to prevent a duplicate payment. Do not retry; contact support with the transaction ID.",
  failed: "No tokens left the escrow: the contract restored the full amount to your claim.",
  incident: "The contract reported a state this app does not recognise or that is inconsistent. Do not act on it; report it.",
} as const;

export function agreementStatusLabel(status: string): StateLabel {
  switch (status) {
    case "PROPOSED":
      return { key: "proposed", label: "Agreement awaiting approval", tone: "info" };
    case "EXPIRED":
      return {
        key: "expired",
        label: "Proposal expired",
        detail: "The acceptance deadline passed before all four parties accepted. No line can be funded.",
        tone: "neutral",
      };
    case "AGREED":
      return { key: "agreed", label: "Agreed — no line funded yet", tone: "info" };
    case "ACTIVE":
      return { key: "active", label: "Active", detail: "At least one line has been funded.", tone: "info" };
    default:
      return { key: "unknown", label: `Unknown agreement status (${status})`, detail: COPY.incident, tone: "negative" };
  }
}

const REASONS: Record<string, string> = {
  BUYER_DISPUTE: "Disputed by the buyer during review",
  NO_RESPONSE: "No buyer response within the review window",
  NON_DELIVERY: "No delivery before the delivery cutoff",
};

export interface LineContext {
  /** Principal from the agreement terms (base units). */
  readonly principal: bigint;
  /** A funding transaction was sent from this browser and not yet observed in state. */
  readonly fundingTxInFlight?: boolean;
}

/** Work/money state of one line (not the per-beneficiary withdrawal). */
export function lineStateLabel(line: LineView, ctx: LineContext): StateLabel {
  const locked = u128(line.locked);
  switch (line.status) {
    case "UNFUNDED":
      if (locked !== 0n) return incident("UNFUNDED line with locked funds");
      if (ctx.fundingTxInFlight) {
        return {
          key: "funding_processing",
          label: "Funding transaction processing",
          detail: "Not yet credited. This line is secured only after the contract shows it as funded.",
          tone: "info",
        };
      }
      return { key: "not_funded", label: "Not funded", detail: COPY.notFunded, tone: "warning" };
    case "FUNDED":
      if (locked !== ctx.principal) return incident("FUNDED line whose locked amount differs from its principal");
      if (line.non_delivery_t0_ns !== null) {
        return { key: "non_delivery_eligible", label: "Delivery deadline passed", detail: COPY.nonDelivery, tone: "warning" };
      }
      return { key: "secured", label: "Secured in escrow", tone: "positive" };
    case "SUBMITTED":
      if (locked !== ctx.principal) return incident("SUBMITTED line whose locked amount differs from its principal");
      if (line.no_response_t0_ns !== null) {
        return { key: "review_ended", label: "Review window ended", detail: COPY.reviewEnded, tone: "warning" };
      }
      return { key: "under_review", label: "Under review", detail: "Delivery submitted. Funds remain secured.", tone: "info" };
    case "DISPUTED": {
      const reason = REASONS[line.dispute_reason];
      if (reason === undefined) return incident(`DISPUTED line with reason ${line.dispute_reason}`);
      if (locked !== ctx.principal) return incident("DISPUTED line whose locked amount differs from its principal");
      return { key: "disputed", label: "Disputed — secured", detail: reason, tone: "warning" };
    }
    case "ALLOCATED": {
      if (locked !== 0n) return incident("ALLOCATED line with locked funds");
      // "Paid out" only from the contract's own ledger: nothing claimable or
      // pending, and the PAID totals equal the line amount (PAID is set only by
      // the escrow's authenticated transfer callback).
      const open = u128(line.buyer_claimable) + u128(line.buyer_pending) + u128(line.supplier_claimable) + u128(line.supplier_pending);
      const paid = u128(line.buyer_paid) + u128(line.supplier_paid);
      if (open === 0n && paid === ctx.principal) {
        return { key: "paid_out", label: "Settled — paid out", detail: "Every allocated share has been paid; the contract confirmed each token transfer.", tone: "positive" };
      }
      return {
        key: "allocated",
        label: "Decision recorded",
        detail: "Each party withdraws its own share separately. Allocated is not paid until the contract confirms that share's withdrawal.",
        tone: "info",
      };
    }
    default:
      return incident(`unknown line status ${line.status}`);
  }
}

export type Beneficiary = "buyer" | "supplier";

/**
 * Withdrawal state of one beneficiary on one line (ARCHITECTURE.md §5.2).
 * Slot-local checks only; the UI uses the stricter share-based
 * withdrawals.ts claimState (LF-009 spec), which agrees on every label.
 */
export function withdrawalLabel(line: LineView, who: Beneficiary): StateLabel {
  const slot = who === "buyer" ? line.buyer_withdrawal : line.supplier_withdrawal;
  const claimable = u128(who === "buyer" ? line.buyer_claimable : line.supplier_claimable);
  const pending = u128(who === "buyer" ? line.buyer_pending : line.supplier_pending);
  const paid = u128(who === "buyer" ? line.buyer_paid : line.supplier_paid);
  switch (slot) {
    case "EMPTY":
      if (pending !== 0n || paid !== 0n) return incident("EMPTY withdrawal slot with pending or paid amounts");
      if (claimable > 0n) {
        return { key: "ready", label: "Ready to withdraw", detail: "Allocated to you, not yet paid.", tone: "info" };
      }
      return { key: "none", label: "Nothing to withdraw", tone: "neutral" };
    case "PENDING":
      if (pending === 0n) return incident("PENDING withdrawal slot with no pending amount");
      // Same text as withdrawals.ts WITHDRAWAL_MESSAGES.unconfirmed (withdrawals.test.ts asserts equality).
      return { key: "processing", label: "Payment outcome unconfirmed. Do not retry this withdrawal.", detail: COPY.pending, tone: "warning" };
    case "PAID":
      if (paid === 0n || pending !== 0n) return incident("PAID slot without a confirmed paid amount");
      return { key: "paid", label: "Paid", detail: "Confirmed by the contract's transfer callback.", tone: "positive" };
    case "FAILED":
      if (claimable === 0n || pending !== 0n) return incident("FAILED slot without a restored claim");
      // Same text as withdrawals.ts WITHDRAWAL_MESSAGES.failedRestored (withdrawals.test.ts asserts equality).
      return { key: "failed_restored", label: "The transfer failed. Your funds are available to withdraw again.", detail: COPY.failed, tone: "warning" };
    default:
      return incident(`unknown withdrawal slot ${slot}`);
  }
}

function incident(why: string): StateLabel {
  return { key: "incident", label: "State inconsistent — incident", detail: `${COPY.incident} (${why})`, tone: "negative" };
}

/** Per-line ledger total; equals principal for every funded line (conservation). */
export function lineLedgerTotal(line: LineView): bigint {
  return [
    line.locked,
    line.buyer_claimable,
    line.supplier_claimable,
    line.buyer_pending,
    line.supplier_pending,
    line.buyer_paid,
    line.supplier_paid,
  ]
    .map(u128)
    .reduce((a, b) => a + b, 0n);
}

/**
 * Agreement-level summary for display. The contract has no "completed" state
 * (a fully settled agreement stays ACTIVE), so this derives "Completed" only
 * from the contract's own per-line ledger: every line ALLOCATED, nothing
 * locked, claimable or pending, and PAID totals equal to each line amount.
 * The real contract status is always named in the detail.
 */
export function agreementSummaryLabel(a: AgreementView): StateLabel {
  const base = agreementStatusLabel(a.status);
  if (a.status !== "ACTIVE" || a.lines.length === 0) return base;
  const allPaid = a.lines.every((l) => {
    const t = a.terms.lines[l.line_id];
    if (t === undefined || l.status !== "ALLOCATED") return false;
    const open = u128(l.locked) + u128(l.buyer_claimable) + u128(l.supplier_claimable) + u128(l.buyer_pending) + u128(l.supplier_pending);
    return open === 0n && u128(l.buyer_paid) + u128(l.supplier_paid) === u128(t.principal);
  });
  if (!allPaid) return base;
  return {
    key: "completed",
    label: "Completed — all lines paid out",
    detail: "Contract status: Active (the contract has no separate completed state). Every line is settled and every allocated share has been paid, confirmed by the contract.",
    tone: "positive",
  };
}

/** Outstanding liabilities of one agreement as the contract defines E: locked + claimable + pending. */
export function agreementOutstanding(a: AgreementView): bigint {
  let e = 0n;
  for (const l of a.lines) {
    e += u128(l.locked) + u128(l.buyer_claimable) + u128(l.supplier_claimable) + u128(l.buyer_pending) + u128(l.supplier_pending);
  }
  return e;
}

/** Fallback split preview (docs/07 §Allocation formula): supplier floor(P·S/10000), buyer the remainder. */
export function fallbackSplit(principal: bigint, supplierBps: number): { buyer: bigint; supplier: bigint } {
  if (!Number.isInteger(supplierBps) || supplierBps < 0 || supplierBps > 10_000) throw new RangeError("bps out of range");
  const supplier = (principal * BigInt(supplierBps)) / 10_000n;
  return { supplier, buyer: principal - supplier };
}

export interface Reconciliation extends StateLabel {
  readonly surplus: bigint;
}

/** Rule B observation (ARCHITECTURE.md §5.3). Never feeds any withdrawal state. */
export function reconcile(outstandingE: bigint, tokenBalanceO: bigint): Reconciliation {
  if (tokenBalanceO === outstandingE) return { key: "balanced", label: "Balanced", tone: "positive", surplus: 0n };
  if (tokenBalanceO > outstandingE) {
    return {
      key: "surplus",
      label: "Uncredited surplus",
      detail: "Token balance exceeds recorded liabilities (direct transfers or refunds in flight). Observation only: never credited or swept.",
      tone: "neutral",
      surplus: tokenBalanceO - outstandingE,
    };
  }
  return {
    key: "shortfall",
    label: "Shortfall — incident",
    detail: "Token balance is below recorded liabilities. Treat as an incident (docs/13).",
    tone: "negative",
    surplus: tokenBalanceO - outstandingE,
  };
}
