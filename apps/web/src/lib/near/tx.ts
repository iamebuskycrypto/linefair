// Function-call descriptors for LineFair transactions (ARCHITECTURE.md §4, §6).
// Pure: builds what the wallet is asked to sign; signing lives in wallet.ts.
// Every LineFair escrow method is non-payable (deposit 0) except LF-009
// `withdraw`. The only deposits the UI ever attaches are exactly 1 yoctoNEAR
// on the token's ft_transfer_call and exactly 1 yoctoNEAR on `withdraw`
// (forwarded by the escrow to ft_transfer).

import { buildFundingMsgV1, type AgreementTermsJsonV1 } from "../terms.ts";

export interface FunctionCallSpec {
  readonly receiverId: string;
  readonly methodName: string;
  readonly args: Record<string, unknown>;
  readonly gas: bigint;
  readonly deposit: bigint;
}

const TGAS = 1_000_000_000_000n;

/**
 * Gas constants. Sandbox measurements (evidence/m1, evidence/lf005):
 * create_agreement ~2.2 Tgas, accept_terms ~2.0 Tgas, ft_transfer_call
 * success >= 9.5 Tgas. Attached gas is a generous multiple; unused gas is
 * refunded. Re-measure on testnet at LF-014 (docs/21 finding 2).
 */
export const GAS = {
  createAgreement: 30n * TGAS,
  accept: 30n * TGAS,
  lineAction: 30n * TGAS,
  fund: 30n * TGAS,
  /**
   * LF-009 withdraw. The contract rejects (ERR_WITHDRAW:InsufficientGas, before
   * any state change) below GAS_FT_TRANSFER + GAS_WITHDRAW_CALLBACK +
   * GAS_WITHDRAW_SELF = 10 + 15 + 30 = 55 Tgas (lib.rs on main b66913f, unchanged in 2ccd058;
   * abi.test.ts re-derives it). Sandbox burn ~6.6 Tgas (evidence/lf009).
   */
  withdraw: 100n * TGAS,
} as const;

/** lib.rs withdraw floor (abi.test.ts parses the constants from the fixture). */
export const WITHDRAW_MIN_GAS = 55n * TGAS;

export const ONE_YOCTO = 1n;

export function createAgreementCall(escrowId: string, terms: AgreementTermsJsonV1): FunctionCallSpec {
  return { receiverId: escrowId, methodName: "create_agreement", args: { terms }, gas: GAS.createAgreement, deposit: 0n };
}

export function acceptTermsCall(escrowId: string, agreementId: string, termsHash: string): FunctionCallSpec {
  return { receiverId: escrowId, methodName: "accept_terms", args: { agreement_id: agreementId, terms_hash: termsHash }, gas: GAS.accept, deposit: 0n };
}

export function acceptAppointmentCall(escrowId: string, agreementId: string, termsHash: string): FunctionCallSpec {
  return {
    receiverId: escrowId,
    methodName: "accept_appointment",
    args: { agreement_id: agreementId, terms_hash: termsHash },
    gas: GAS.accept,
    deposit: 0n,
  };
}

// --- line actions (LF-006 / LF-006b / LF-007 / LF-008 / LF-009). Argument names and JSON
// types follow the cargo-near ABI of main b66913f (abi.test.ts):
// agreement_id U64 -> decimal string, line_id u32 -> JSON integer,
// amounts / proposal_id -> strict canonical decimal strings (lib.rs amount()).

const CANONICAL_DEC = /^(0|[1-9][0-9]*)$/;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

/** Canonical decimal string of a value within `max`; throws otherwise (never builds a call the contract would reject on format). */
function canonical(field: string, v: string | bigint, max: bigint): string {
  const s = typeof v === "bigint" ? v.toString() : v;
  if (!CANONICAL_DEC.test(s)) throw new RangeError(`${field} must be a canonical decimal string`);
  if (BigInt(s) > max) throw new RangeError(`${field} out of range`);
  return s;
}

function lineId(v: number): number {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) throw new RangeError("line_id must be a u32");
  return v;
}

function lineCall(escrowId: string, methodName: string, args: Record<string, unknown>): FunctionCallSpec {
  return { receiverId: escrowId, methodName, args, gas: GAS.lineAction, deposit: 0n };
}

export function submitDeliveryCall(escrowId: string, agreementId: string, line: number, evidenceCommitment: string): FunctionCallSpec {
  if (!/^[0-9a-f]{64}$/.test(evidenceCommitment)) throw new RangeError("evidence_commitment must be 64 lowercase hex");
  return lineCall(escrowId, "submit_delivery", {
    agreement_id: canonical("agreement_id", agreementId, U64_MAX),
    line_id: lineId(line),
    evidence_commitment: evidenceCommitment,
  });
}

export function acceptLineCall(escrowId: string, agreementId: string, line: number): FunctionCallSpec {
  return lineCall(escrowId, "accept_line", { agreement_id: canonical("agreement_id", agreementId, U64_MAX), line_id: lineId(line) });
}

export function openDisputeCall(escrowId: string, agreementId: string, line: number): FunctionCallSpec {
  return lineCall(escrowId, "open_dispute", { agreement_id: canonical("agreement_id", agreementId, U64_MAX), line_id: lineId(line) });
}

/** Permissionless (any signer). */
export function advanceCaseCall(escrowId: string, agreementId: string, line: number): FunctionCallSpec {
  return lineCall(escrowId, "advance_case", { agreement_id: canonical("agreement_id", agreementId, U64_MAX), line_id: lineId(line) });
}

/**
 * LF-007 propose_split (buyer or supplier). The contract requires
 * buyer + supplier == principal; pass `principal` so a call that cannot
 * succeed is never built. Returns the new proposal id (U64 string) on chain.
 */
export function proposeSplitCall(
  escrowId: string,
  agreementId: string,
  line: number,
  buyerAmount: bigint,
  supplierAmount: bigint,
  principal: bigint,
): FunctionCallSpec {
  if (buyerAmount < 0n || supplierAmount < 0n || buyerAmount + supplierAmount !== principal) {
    throw new RangeError("buyer_amount + supplier_amount must equal the line principal exactly");
  }
  return lineCall(escrowId, "propose_split", {
    agreement_id: canonical("agreement_id", agreementId, U64_MAX),
    line_id: lineId(line),
    buyer_amount: canonical("buyer_amount", buyerAmount, U128_MAX),
    supplier_amount: canonical("supplier_amount", supplierAmount, U128_MAX),
  });
}

/**
 * LF-007 accept_split (the proposer's counterparty). Pass the id and both
 * amounts exactly as re-read from `get_agreement` just before signing; the
 * contract rejects a stale id (StaleProposal) or different amounts
 * (ProposalMismatch).
 */
export function acceptSplitCall(
  escrowId: string,
  agreementId: string,
  line: number,
  proposalId: string,
  buyerAmount: string,
  supplierAmount: string,
): FunctionCallSpec {
  const id = canonical("proposal_id", proposalId, U64_MAX);
  if (id === "0") throw new RangeError("proposal_id 0 means no proposal");
  return lineCall(escrowId, "accept_split", {
    agreement_id: canonical("agreement_id", agreementId, U64_MAX),
    line_id: lineId(line),
    proposal_id: id,
    buyer_amount: canonical("buyer_amount", buyerAmount, U128_MAX),
    supplier_amount: canonical("supplier_amount", supplierAmount, U128_MAX),
  });
}

/**
 * LF-008 submit_ruling (primary arbitrator in [T0+N, T0+N+A), backup in
 * [T0+N+A, T0+N+A+B); the contract decides the role from the signer).
 * Same sum rule as propose_split: buyer + supplier == principal exactly.
 */
export function submitRulingCall(
  escrowId: string,
  agreementId: string,
  line: number,
  buyerAmount: bigint,
  supplierAmount: bigint,
  principal: bigint,
): FunctionCallSpec {
  if (buyerAmount < 0n || supplierAmount < 0n || buyerAmount + supplierAmount !== principal) {
    throw new RangeError("buyer_amount + supplier_amount must equal the line principal exactly");
  }
  return lineCall(escrowId, "submit_ruling", {
    agreement_id: canonical("agreement_id", agreementId, U64_MAX),
    line_id: lineId(line),
    buyer_amount: canonical("buyer_amount", buyerAmount, U128_MAX),
    supplier_amount: canonical("supplier_amount", supplierAmount, U128_MAX),
  });
}

/**
 * LF-008 trigger_fallback. Permissionless (any signer) from T0+N+A+B. No
 * amount parameters: the contract applies the hashed fallback split itself.
 */
export function triggerFallbackCall(escrowId: string, agreementId: string, line: number): FunctionCallSpec {
  return lineCall(escrowId, "trigger_fallback", { agreement_id: canonical("agreement_id", agreementId, U64_MAX), line_id: lineId(line) });
}

/** Funding: receiver is the TOKEN contract; 1 yoctoNEAR; one line per transaction (FD-03). */
export function fundLineCall(
  ftId: string,
  escrowId: string,
  agreementId: string,
  lineId: number,
  principal: bigint,
  termsHash: string,
): FunctionCallSpec {
  return {
    receiverId: ftId,
    methodName: "ft_transfer_call",
    args: { receiver_id: escrowId, amount: principal.toString(), msg: buildFundingMsgV1(agreementId, lineId, termsHash) },
    gas: GAS.fund,
    deposit: ONE_YOCTO,
  };
}

/**
 * LF-009 withdraw (payable: exactly 1 yoctoNEAR, 100 Tgas). Only the immutable
 * buyer_id (BUYER) or supplier_id (SUPPLIER) may sign; the contract always
 * withdraws the whole claimable amount to that same account. The transaction
 * result is the callback's WithdrawalResultView: shown as "reported by the
 * transaction" only, never as final (withdrawals.ts).
 */
export function withdrawCall(escrowId: string, agreementId: string, line: number, beneficiary: "BUYER" | "SUPPLIER"): FunctionCallSpec {
  if (beneficiary !== "BUYER" && beneficiary !== "SUPPLIER") throw new RangeError("beneficiary must be BUYER or SUPPLIER");
  return {
    receiverId: escrowId,
    methodName: "withdraw",
    args: { agreement_id: canonical("agreement_id", agreementId, U64_MAX), line_id: lineId(line), beneficiary },
    gas: GAS.withdraw,
    deposit: ONE_YOCTO,
  };
}
