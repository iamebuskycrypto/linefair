// LF-007 mutual settlement and per-line money states. Pure functions over
// `LineView` (main b28d33b, lf-008). The contract is the authority: these functions
// only decide what the UI offers and how it labels contract state. Every
// rejection the contract can still produce is mapped in errors.ts.
//
// Contract rules mirrored (line.rs propose_split / accept_split,
// require_settleable; agreement.rs party):
// - Only buyer or supplier (never arbitrators) may propose or accept.
// - Line DISPUTED, no final allocation, chain time >= dispute_t0_ns.
// - buyer + supplier == principal exactly (zero legs allowed).
// - One active proposal per line; a new proposal supersedes the old one
//   (new per-line id). Only the proposer's counterparty may accept, naming
//   the exact id and both amounts.
// - Acceptance allocates MUTUAL; locked -> claimable. No token moves.

import { u128, type StateLabel } from "./states.ts";
import type { LineView } from "./types.ts";
import type { AgreementTermsJsonV1 } from "../terms.ts";
import { parseUnits } from "../format.ts";

export type Party = "buyer" | "supplier";
export type Role = Party | "primary_arbitrator" | "backup_arbitrator";

/** The connected account's role in these terms, or null. Roles are distinct (validated at creation). */
export function roleOf(terms: Pick<AgreementTermsJsonV1, "buyer_id" | "supplier_id" | "primary_arbitrator_id" | "backup_arbitrator_id">, accountId: string | null): Role | null {
  if (accountId === null) return null;
  if (accountId === terms.buyer_id) return "buyer";
  if (accountId === terms.supplier_id) return "supplier";
  if (accountId === terms.primary_arbitrator_id) return "primary_arbitrator";
  if (accountId === terms.backup_arbitrator_id) return "backup_arbitrator";
  return null;
}

export interface Proposal {
  readonly id: string;
  readonly proposer: Party;
  /** Exact contract strings (canonical decimals), used verbatim in accept_split. */
  readonly buyerAmount: string;
  readonly supplierAmount: string;
  readonly createdAtNs: bigint;
}

export interface ProposalState extends StateLabel {
  /** none | open | not_accepted (OPEN on an allocated line) | accepted | incident */
  readonly key: "none" | "open" | "not_accepted" | "accepted" | "incident";
  readonly proposal?: Proposal;
}

const PROPOSER: Record<string, Party> = { BUYER: "buyer", SUPPLIER: "supplier" };

function incident(why: string): ProposalState {
  return {
    key: "incident",
    label: "Proposal state inconsistent — incident",
    detail: `The contract reported a settlement state this app does not recognise or that is inconsistent. Do not act on it; report it. (${why})`,
    tone: "negative",
  };
}

/** Settlement proposal of one line, with consistency checks against the line. */
export function proposalState(line: LineView, principal: bigint): ProposalState {
  const status = line.proposal_status;
  if (status === "NONE") {
    if (line.proposal_id !== "0" || line.proposal_proposer !== "NONE") return incident("NONE status with a proposal id or proposer");
    return { key: "none", label: "No settlement proposal", tone: "neutral" };
  }
  if (status !== "OPEN" && status !== "ACCEPTED") return incident(`unknown proposal status ${status}`);
  const proposer = PROPOSER[line.proposal_proposer];
  if (proposer === undefined) return incident(`proposal without a buyer/supplier proposer (${line.proposal_proposer})`);
  const id = u128(line.proposal_id);
  if (id === 0n) return incident("proposal id 0");
  const b = u128(line.proposal_buyer_amount);
  const s = u128(line.proposal_supplier_amount);
  if (b + s !== principal) return incident("proposal amounts do not sum to the line amount");
  const proposal: Proposal = {
    id: line.proposal_id,
    proposer,
    buyerAmount: line.proposal_buyer_amount,
    supplierAmount: line.proposal_supplier_amount,
    createdAtNs: u128(line.proposal_created_at_ns),
  };
  const by = proposer === "buyer" ? "the buyer" : "the supplier";
  if (status === "ACCEPTED") {
    if (
      line.status !== "ALLOCATED" ||
      line.allocation_mode !== "MUTUAL" ||
      line.allocation_source_id !== line.proposal_id ||
      line.allocation_buyer_amount !== line.proposal_buyer_amount ||
      line.allocation_supplier_amount !== line.proposal_supplier_amount
    ) {
      return incident("ACCEPTED proposal that is not the line's MUTUAL allocation");
    }
    return { key: "accepted", label: `Proposal #${proposal.id} accepted`, detail: `Proposed by ${by} and accepted by the other party. This is the line's final allocation.`, tone: "info", proposal };
  }
  // OPEN
  if (line.status === "DISPUTED") {
    if (line.allocation_mode !== "NONE") return incident("OPEN proposal on a DISPUTED line that has an allocation");
    return {
      key: "open",
      label: `Proposal #${proposal.id} open`,
      detail: `Proposed by ${by}. Awaiting acceptance by the other party. Nothing is allocated until it is accepted.`,
      tone: "info",
      proposal,
    };
  }
  if (line.status === "ALLOCATED") {
    // docs: an OPEN proposal on an ALLOCATED line can no longer be accepted.
    return {
      key: "not_accepted",
      label: `Proposal #${proposal.id} not accepted`,
      detail: "The line was decided another way before this proposal was accepted. It can no longer be accepted.",
      tone: "neutral",
      proposal,
    };
  }
  return incident(`OPEN proposal on a ${line.status} line`);
}

const MODE_LABEL: Record<string, string> = {
  BUYER_ACCEPTED: "Accepted by the buyer",
  MUTUAL: "Mutual settlement",
  PRIMARY_RULING: "Primary arbitrator ruling",
  BACKUP_RULING: "Backup arbitrator ruling",
  FALLBACK: "Contractual fallback split",
};

/**
 * Allocation of an ALLOCATED line, with conservation checks: allocation sums
 * to principal and each party's claimable + pending + paid equals its share.
 */
export function allocationState(line: LineView, principal: bigint): StateLabel {
  const mode = line.allocation_mode;
  if (line.status !== "ALLOCATED") {
    if (mode !== "NONE") return { key: "incident", label: "Allocation state inconsistent — incident", detail: `allocation ${mode} on a ${line.status} line`, tone: "negative" };
    return { key: "none", label: "Not allocated", tone: "neutral" };
  }
  const label = MODE_LABEL[mode];
  if (label === undefined) return { key: "incident", label: "Allocation state inconsistent — incident", detail: `unknown allocation mode ${mode}`, tone: "negative" };
  const b = u128(line.allocation_buyer_amount);
  const s = u128(line.allocation_supplier_amount);
  const bHeld = u128(line.buyer_claimable) + u128(line.buyer_pending) + u128(line.buyer_paid);
  const sHeld = u128(line.supplier_claimable) + u128(line.supplier_pending) + u128(line.supplier_paid);
  if (b + s !== principal || bHeld !== b || sHeld !== s || u128(line.locked) !== 0n) {
    return { key: "incident", label: "Allocation state inconsistent — incident", detail: "allocation does not match the line amount or the ledger", tone: "negative" };
  }
  if (mode === "MUTUAL" && line.allocation_source_id === "0") {
    return { key: "incident", label: "Allocation state inconsistent — incident", detail: "MUTUAL allocation without a proposal id", tone: "negative" };
  }
  const paidOut = u128(line.buyer_claimable) + u128(line.buyer_pending) + u128(line.supplier_claimable) + u128(line.supplier_pending) === 0n && u128(line.buyer_paid) + u128(line.supplier_paid) === principal;
  const tail = paidOut ? "Final; every allocated share has been paid out." : "Final; each party withdraws its own share. Allocated is not paid until its withdrawal is confirmed.";
  const detail = mode === "MUTUAL" ? `From proposal #${line.allocation_source_id}. ${tail}` : tail;
  return { key: mode.toLowerCase(), label, detail, tone: "info" };
}

export interface SplitAvailability {
  readonly canPropose: boolean;
  readonly canAccept: boolean;
  /** Why an action is not offered (shown as help text). */
  readonly reason?: string;
}

/**
 * What the UI offers to `role` on this line at chain time `nowNs`. Advisory:
 * the contract decides, and its rejection is mapped to copy.
 */
export function splitAvailability(line: LineView, principal: bigint, role: Role | null, nowNs: bigint | null): SplitAvailability {
  const no = (reason: string): SplitAvailability => ({ canPropose: false, canAccept: false, reason });
  if (line.status === "ALLOCATED") return no("This line already has a final allocation.");
  if (line.status !== "DISPUTED") return no("Settlement proposals are possible only while the line is disputed.");
  if (role === null) return no("Connect the buyer or supplier account to propose or accept a split.");
  if (role !== "buyer" && role !== "supplier") return no("Only the buyer and the supplier can propose or accept a split. Arbitrators cannot.");
  if (nowNs === null) return no("Chain time is not known yet.");
  if (nowNs < u128(line.dispute_t0_ns)) return no("The dispute has not started yet (chain time is before T0).");
  const p = proposalState(line, principal);
  if (p.key === "incident") return no("The proposal state is inconsistent; do not act on it.");
  const canAccept = p.key === "open" && p.proposal !== undefined && p.proposal.proposer !== role;
  return {
    canPropose: true,
    canAccept,
    ...(p.key === "open" && !canAccept ? { reason: "You made the open proposal; only the other party can accept it. A new proposal replaces it." } : {}),
  };
}

export type SplitInput =
  | { ok: true; buyer: bigint; supplier: bigint }
  | { ok: false; buyerError?: string; supplierError?: string; sumError?: string };

/**
 * Strict form input: token-unit decimals (never rounded, no signs or
 * exponents) for both legs; they must sum to the principal exactly.
 */
export function parseSplitInput(buyerText: string, supplierText: string, principal: bigint, decimals: number): SplitInput {
  const b = parseUnits(buyerText, decimals);
  const s = parseUnits(supplierText, decimals);
  if (!b.ok || !s.ok) {
    return {
      ok: false,
      ...(b.ok ? {} : { buyerError: b.error }),
      ...(s.ok ? {} : { supplierError: s.error }),
    };
  }
  if (b.value + s.value !== principal) {
    return { ok: false, sumError: "The two amounts must add up to the line amount exactly." };
  }
  return { ok: true, buyer: b.value, supplier: s.value };
}

export type AcceptRecheck =
  | { ok: true; proposal: Proposal }
  | { ok: false; reason: "changed" | "gone" | "own" | "not_party" | "inconsistent"; message: string; current?: Proposal };

/**
 * Re-check right before signing accept_split: the freshly read proposal must
 * be the one the user reviewed (same id and both amounts) and still open, and
 * not the user's own. On success, the fresh exact strings are what is signed.
 */
export function recheckBeforeAccept(fresh: LineView, principal: bigint, reviewed: Proposal, role: Role | null): AcceptRecheck {
  if (role !== "buyer" && role !== "supplier") return { ok: false, reason: "not_party", message: "Only the buyer or supplier can accept a split." };
  const p = proposalState(fresh, principal);
  if (p.key === "incident") return { ok: false, reason: "inconsistent", message: "The proposal state is inconsistent. Do not sign; report it." };
  if (p.key !== "open" || p.proposal === undefined) {
    return { ok: false, reason: "gone", message: "This proposal is no longer open. Nothing was signed. Review the line again." };
  }
  const cur = p.proposal;
  if (cur.id !== reviewed.id || cur.buyerAmount !== reviewed.buyerAmount || cur.supplierAmount !== reviewed.supplierAmount || cur.proposer !== reviewed.proposer) {
    return { ok: false, reason: "changed", message: "The proposal changed since you reviewed it. Nothing was signed. Review the new proposal.", current: cur };
  }
  if (cur.proposer === role) return { ok: false, reason: "own", message: "You cannot accept your own proposal." };
  return { ok: true, proposal: cur };
}

export interface MoneyRow {
  readonly key: "locked" | "claimable" | "pending" | "paid" | "incident";
  readonly party?: Party;
  readonly label: string;
  readonly amount: bigint;
}

/**
 * Non-zero money buckets of a line. "Paid" appears only when the party's
 * withdrawal slot is PAID (authenticated callback); a paid amount without a
 * PAID slot is an incident row, never "Paid".
 */
export function moneyRows(line: LineView): MoneyRow[] {
  const rows: MoneyRow[] = [];
  const locked = u128(line.locked);
  if (locked > 0n) rows.push({ key: "locked", label: "Locked in escrow", amount: locked });
  for (const party of ["buyer", "supplier"] as const) {
    const who = party === "buyer" ? "Buyer" : "Supplier";
    const claimable = u128(party === "buyer" ? line.buyer_claimable : line.supplier_claimable);
    const pending = u128(party === "buyer" ? line.buyer_pending : line.supplier_pending);
    const paid = u128(party === "buyer" ? line.buyer_paid : line.supplier_paid);
    const slot = party === "buyer" ? line.buyer_withdrawal : line.supplier_withdrawal;
    if (claimable > 0n) {
      rows.push({
        key: "claimable",
        party,
        label: slot === "FAILED" ? `${who}: claimable — transfer failed, amount restored` : `${who}: claimable — allocated, not paid`,
        amount: claimable,
      });
    }
    if (pending > 0n) rows.push({ key: "pending", party, label: `${who}: withdrawal processing — outcome unconfirmed`, amount: pending });
    if (paid > 0n) {
      rows.push(
        slot === "PAID"
          ? { key: "paid", party, label: `${who}: paid — confirmed by the contract`, amount: paid }
          : { key: "incident", party, label: `${who}: paid amount without a confirmed PAID state — incident`, amount: paid },
      );
    }
  }
  return rows;
}
