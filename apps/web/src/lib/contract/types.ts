// View types mirrored exactly from contracts/escrow/src/lib.rs on main
// 2ccd058 (lf-010a; ConfigView gained creator_allowlist) (`AgreementView`, `LineView`, `AcceptancesView`, `ConfigView`,
// and the LF-009 `WithdrawalView`, `CustodySummaryView`, `WithdrawalResultView`).
// abi.test.ts compares these field lists with the cargo-near ABI of that build
// (apps/web/fixtures/contract-main/abi).
// JSON U64/U128 arrive as decimal strings and are parsed with BigInt only.

import type { AgreementTermsJsonV1 } from "../terms.ts";

/** `line.rs::LineStatus::as_str`. */
export type LineStatus = "UNFUNDED" | "FUNDED" | "SUBMITTED" | "DISPUTED" | "ALLOCATED";
/** `line.rs::SlotState::as_str`. */
export type SlotState = "EMPTY" | "PENDING" | "PAID" | "FAILED";
/** `line.rs::DisputeReason::as_str`. */
export type DisputeReason = "NONE" | "BUYER_DISPUTE" | "NO_RESPONSE" | "NON_DELIVERY";
/** `line.rs::AllocationMode::as_str`. PRIMARY_RULING / BACKUP_RULING / FALLBACK come from LF-008 `submit_ruling` / `trigger_fallback`. */
export type AllocationMode = "NONE" | "BUYER_ACCEPTED" | "MUTUAL" | "PRIMARY_RULING" | "BACKUP_RULING" | "FALLBACK";
/** `line.rs::ProposalStatus::as_str` (LF-007). */
export type ProposalStatus = "NONE" | "OPEN" | "ACCEPTED";
/** `line.rs::Proposer::as_str` (LF-007). */
export type Proposer = "NONE" | "BUYER" | "SUPPLIER";
/**
 * `deadlines.rs::DisputePhase::as_str` as exposed by `LineView.dispute_phase`
 * (LF-008). `NONE` for every non-DISPUTED line. `BEFORE_T0` exists in the
 * enum but is unreachable for a stored DISPUTED line (deadlines.rs comment).
 */
export type DisputePhase = "NONE" | "BEFORE_T0" | "NEGOTIATION" | "PRIMARY" | "BACKUP" | "FALLBACK";
/** `agreement.rs::AgreementStatus::as_str` (lib.rs doc comment lists all four). */
export type AgreementStatus = "PROPOSED" | "EXPIRED" | "AGREED" | "ACTIVE";

export interface AcceptancesView {
  buyer: boolean;
  supplier: boolean;
  primary_arbitrator: boolean;
  backup_arbitrator: boolean;
}

export interface LineView {
  line_id: number;
  /** Typed as string: an unknown value must be shown as unknown, never coerced. */
  status: string;
  locked: string;
  buyer_claimable: string;
  supplier_claimable: string;
  buyer_pending: string;
  supplier_pending: string;
  buyer_paid: string;
  supplier_paid: string;
  buyer_withdrawal: string;
  supplier_withdrawal: string;
  submitted_at_ns: string;
  evidence_commitment: string;
  dispute_reason: string;
  dispute_t0_ns: string;
  no_response_t0_ns: string | null;
  non_delivery_t0_ns: string | null;
  // LF-007. String-typed for the same reason as `status`.
  /** `NONE` until ALLOCATED; see `AllocationMode`. */
  allocation_mode: string;
  allocation_buyer_amount: string;
  allocation_supplier_amount: string;
  /** Accepted proposal id for MUTUAL; "0" otherwise. */
  allocation_source_id: string;
  allocation_finalized_at_ns: string;
  /** See `ProposalStatus`. An OPEN proposal on an ALLOCATED line can no longer be accepted. */
  proposal_status: string;
  /** Per-line nonce of the latest proposal ("0" = none yet). */
  proposal_id: string;
  /** See `Proposer`. */
  proposal_proposer: string;
  proposal_buyer_amount: string;
  proposal_supplier_amount: string;
  proposal_created_at_ns: string;
  // LF-008, computed by the contract at view time from the fixed T0 and the
  // hashed windows N, A, B (block timestamp of the queried block).
  /** See `DisputePhase`. String-typed: an unknown value is shown as unknown. */
  dispute_phase: string;
  /** `T0 + N`: primary arbitrator window start. DISPUTED lines only, else null. */
  primary_start_ns: string | null;
  /** `T0 + N + A`: backup arbitrator window start. */
  backup_start_ns: string | null;
  /** `T0 + N + A + B`: permissionless fallback eligible from here. */
  fallback_start_ns: string | null;
}

/** Runtime list of `LineView` keys, checked against the ABI in abi.test.ts. */
export const LINE_VIEW_FIELDS = [
  "line_id", "status", "locked",
  "buyer_claimable", "supplier_claimable", "buyer_pending", "supplier_pending", "buyer_paid", "supplier_paid",
  "buyer_withdrawal", "supplier_withdrawal", "submitted_at_ns", "evidence_commitment",
  "dispute_reason", "dispute_t0_ns", "no_response_t0_ns", "non_delivery_t0_ns",
  "allocation_mode", "allocation_buyer_amount", "allocation_supplier_amount", "allocation_source_id", "allocation_finalized_at_ns",
  "proposal_status", "proposal_id", "proposal_proposer", "proposal_buyer_amount", "proposal_supplier_amount", "proposal_created_at_ns",
  "dispute_phase", "primary_start_ns", "backup_start_ns", "fallback_start_ns",
] as const satisfies readonly (keyof LineView)[];

/** Compile-time check that LINE_VIEW_FIELDS lists every key (no key missing). */
type _MissingLineFields = Exclude<keyof LineView, (typeof LINE_VIEW_FIELDS)[number]>;
export const LINE_VIEW_FIELDS_COMPLETE: _MissingLineFields extends never ? true : never = true;

export interface AgreementView {
  agreement_id: string;
  status: string;
  terms_hash: string;
  acceptances: AcceptancesView;
  accelerated_test_timing: boolean;
  created_at_ns: string;
  terms: AgreementTermsJsonV1;
  lines: LineView[];
}

export interface ConfigView {
  network_id: string;
  allowlisted_ft_id: string;
  operator_treasury_id: string;
  max_agreements: number;
  agreements_created: string;
  /** LF-010A: immutable list of accounts allowed to create agreements (as their buyer). */
  creator_allowlist: string[];
}

export const AGREEMENT_VIEW_FIELDS = [
  "agreement_id", "status", "terms_hash", "acceptances", "accelerated_test_timing", "created_at_ns", "terms", "lines",
] as const satisfies readonly (keyof AgreementView)[];
type _MissingAgreementFields = Exclude<keyof AgreementView, (typeof AGREEMENT_VIEW_FIELDS)[number]>;
export const AGREEMENT_VIEW_FIELDS_COMPLETE: _MissingAgreementFields extends never ? true : never = true;

export const CONFIG_VIEW_FIELDS = [
  "network_id", "allowlisted_ft_id", "operator_treasury_id", "max_agreements", "agreements_created", "creator_allowlist",
] as const satisfies readonly (keyof ConfigView)[];
type _MissingConfigFields = Exclude<keyof ConfigView, (typeof CONFIG_VIEW_FIELDS)[number]>;
export const CONFIG_VIEW_FIELDS_COMPLETE: _MissingConfigFields extends never ? true : never = true;

/** LF-009 `get_withdrawal` (lib.rs `WithdrawalView`): the latest withdrawal of one slot. */
export interface WithdrawalView {
  agreement_id: string;
  line_id: number;
  /** `BUYER` or `SUPPLIER`. */
  beneficiary: string;
  /** `SlotState::as_str`: EMPTY / PENDING (incl. inconclusive) / PAID / FAILED. */
  state: string;
  /** Contract-wide id of the latest withdrawal; "0" = none. */
  withdrawal_id: string;
  epoch: number;
  amount: string;
  started_at_ns: string;
  resolved_at_ns: string;
  /** Immutable recipient from the terms (never a parameter). */
  recipient: string;
  ft_contract_id: string;
}

export const WITHDRAWAL_VIEW_FIELDS = [
  "agreement_id", "line_id", "beneficiary", "state", "withdrawal_id", "epoch", "amount", "started_at_ns", "resolved_at_ns", "recipient", "ft_contract_id",
] as const satisfies readonly (keyof WithdrawalView)[];
type _MissingWithdrawalFields = Exclude<keyof WithdrawalView, (typeof WITHDRAWAL_VIEW_FIELDS)[number]>;
export const WITHDRAWAL_VIEW_FIELDS_COMPLETE: _MissingWithdrawalFields extends never ? true : never = true;

/** LF-009 `custody_summary` (lib.rs `CustodySummaryView`). Observation only. */
export interface CustodySummaryView {
  /** E = sum of locked + claimable + pending over all lines. */
  outstanding_liabilities: string;
  open_withdrawals: string;
  last_withdrawal_id: string;
  ft_contract_id: string;
}

export const CUSTODY_SUMMARY_VIEW_FIELDS = [
  "outstanding_liabilities", "open_withdrawals", "last_withdrawal_id", "ft_contract_id",
] as const satisfies readonly (keyof CustodySummaryView)[];
type _MissingCustodyFields = Exclude<keyof CustodySummaryView, (typeof CUSTODY_SUMMARY_VIEW_FIELDS)[number]>;
export const CUSTODY_SUMMARY_VIEW_FIELDS_COMPLETE: _MissingCustodyFields extends never ? true : never = true;

/**
 * LF-009 `WithdrawalResultView`: the result of `on_withdrawal_transfer`,
 * which is also the `withdraw` transaction's result. "Reported by the
 * transaction" only; the contract views are the authority.
 */
export interface WithdrawalResultView {
  withdrawal_id: string;
  /** PAID / FAILED / PENDING (incident or inconclusive) / IGNORED. */
  outcome: string;
}

export const WITHDRAWAL_RESULT_VIEW_FIELDS = ["withdrawal_id", "outcome"] as const satisfies readonly (keyof WithdrawalResultView)[];
type _MissingResultFields = Exclude<keyof WithdrawalResultView, (typeof WITHDRAWAL_RESULT_VIEW_FIELDS)[number]>;
export const WITHDRAWAL_RESULT_VIEW_FIELDS_COMPLETE: _MissingResultFields extends never ? true : never = true;

/** NEP-145 `storage_balance_of` on the token (near-contract-standards `StorageBalance`). */
export interface StorageBalance {
  total: string;
  available: string;
}
