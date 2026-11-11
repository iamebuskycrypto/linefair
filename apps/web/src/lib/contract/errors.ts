// Contract error / refund code -> user copy (apps/web/ARCHITECTURE.md §8).
// Pure. Codes are matched as exact tokens, never by free text. Every panic
// reverts the whole call, so every card can truthfully say nothing changed.
//
// Sources (contracts/escrow/src): lib.rs (ERR_* panics, LF_FT_REFUND logs),
// terms_json.rs (ParseError), terms.rs (TermsError), agreement.rs
// (AcceptError, LineOpError), line.rs (LineError), funding.rs (FundingMsgError).
// Current source of truth: main 8ec0816 (lf-012 f3), copied read-only into
// apps/web/fixtures/contract-main (see MANIFEST.json); errors.test.ts checks
// every code there has a mapping here.

export type Severity = "user" | "client_bug" | "operator" | "incident";

export interface ErrorCopy {
  /** Exact code token, e.g. `ERR_LINE:NotEligible`. */
  readonly code: string;
  readonly title: string;
  /** Recommended next action (docs/19: error cards always include one). */
  readonly action: string;
  readonly severity: Severity;
  /** True when the code is not in the table and generic copy was used. */
  readonly unknown: boolean;
}

const NOTHING_CHANGED = "Nothing was changed.";

type Entry = [title: string, action: string, severity: Severity];

const TABLE: Record<string, Entry> = {
  // create_agreement / compute_terms_hash
  ERR_CREATOR_NOT_ALLOWLISTED: [
    "This account is not an authorized testnet creator. Agreement creation on this contract is limited to the accounts fixed when it was deployed.",
    "Nothing was changed. Ask an authorized creator to create the agreement; this account can still act as supplier or arbitrator when an agreement names it.",
    "user",
  ],
  ERR_NOT_BUYER: ["Only the buyer named in the terms can create this agreement.", "Connect the buyer account and try again.", "user"],
  ERR_AGREEMENT_CAP_REACHED: ["The demo contract has reached its agreement limit.", "Contact the operator; no new agreement can be created.", "operator"],
  ERR_DUPLICATE_TERMS: ["Identical terms were already registered.", "Change the agreement nonce and create it again.", "user"],
  ERR_AGREEMENT_TOO_LARGE: ["The agreement exceeds the contract's storage limit.", "Report this to the operator.", "operator"],
  ERR_STORAGE_ACCOUNTING: ["The contract's storage accounting check failed.", "Report this to the operator.", "incident"],
  ERR_AGREEMENT_ID_OVERFLOW: ["The contract cannot assign another agreement id.", "Report this to the operator.", "incident"],
  ERR_AGREEMENT_NOT_FOUND: ["No agreement exists with this id.", "Check the link or agreement id.", "user"],
  ERR_TERMS_HASH_FORMAT: ["The terms hash sent was not 64 lowercase hex characters.", "This is an app bug. Do not sign; report it.", "client_bug"],
  ERR_EVIDENCE_COMMITMENT_FORMAT: ["The evidence commitment was not 64 lowercase hex characters.", "This is an app bug. Do not sign; report it.", "client_bug"],

  // accept_terms / accept_appointment (agreement.rs AcceptError)
  "ERR_ACCEPT:NotAuthorizedForMethod": ["This account cannot accept here.", "Buyer and supplier accept the terms; the two arbitrators accept the appointment. Connect the right account.", "user"],
  "ERR_ACCEPT:AcceptanceDeadlinePassed": ["The acceptance deadline has passed.", "This proposal can no longer be accepted. Create a new agreement.", "user"],
  "ERR_ACCEPT:TermsHashMismatch": ["The terms you accepted differ from the registered terms.", "Do not sign. Reload the agreement and verify the terms again.", "user"],
  "ERR_ACCEPT:AlreadyAccepted": ["This account has already accepted.", "No action needed.", "user"],

  // line entry points (agreement.rs LineOpError + line.rs LineError)
  "ERR_LINE:LineNotFound": ["This line does not exist in the agreement.", "Refresh the agreement.", "client_bug"],
  "ERR_LINE:AgreementNotAgreed": ["The agreement is not active yet.", "All four parties must accept the terms first.", "user"],
  "ERR_LINE:NotAuthorized": ["This account is not allowed to perform this action on the line.", "Connect the account named in the terms for this role.", "user"],
  "ERR_LINE:WrongState": ["The line is not in a state that allows this action.", "Refresh the line to see its current state.", "user"],
  "ERR_LINE:FundingDeadlinePassed": ["The funding deadline has passed.", "This line can no longer be funded.", "user"],
  // F3: in practice surfaced as the refund log LF_FT_REFUND:DeliveryTimeTooShort (funding only via ft_on_transfer).
  "ERR_LINE:DeliveryTimeTooShort": ["Too late to fund: the supplier would have less than the review window to deliver.", "This line can no longer be funded. The deposit is refunded in full.", "user"],
  "ERR_LINE:SubmissionDeadlinePassed": ["The delivery cutoff has passed.", "Delivery can no longer be submitted on chain. The line can be moved into the non-delivery dispute process.", "user"],
  "ERR_LINE:ReviewWindowClosed": ["The review window has closed.", "The buyer can no longer accept or dispute. The line can be moved into the no-response dispute process.", "user"],
  "ERR_LINE:BeforeWindowStart": [
    "This action is not open yet: chain time is before the start of its window (for a settlement, before the line's dispute start time T0).",
    "Wait until the time shown on the line, then try again.",
    "user",
  ],
  "ERR_LINE:DeadlineOverflow": ["A deadline computation overflowed.", "Report this; the terms should have prevented it.", "incident"],
  // Founder-approved canonical codes for advance_case (docs/06, 2026-11-03):
  "ERR_LINE:NotEligible": [
    "Not eligible yet: the fixed deadline for moving this line into the dispute process has not been reached.",
    "Wait until the deadline shown on the line, then try again.",
    "user",
  ],
  "ERR_LINE:NotAdvanceable": [
    "This line cannot be advanced. Only a submitted line after its review window, or a funded line after its delivery cutoff, can be moved into the dispute process; it may already have been advanced.",
    "Refresh the line to see its current state.",
    "user",
  ],
  "ERR_LINE:AmountMismatch": ["The amount does not equal the line principal exactly.", "Use the exact principal shown.", "user"],
  "ERR_LINE:ZeroCommitment": ["An all-zero commitment is not allowed.", "This is an app bug. Do not sign; report it.", "client_bug"],
  "ERR_LINE:AlreadyFinalized": [
    "A final allocation for this line already exists, so no proposal can be made or accepted.",
    "Refresh the line to see the recorded allocation; no further decision is possible.",
    "user",
  ],
  "ERR_LINE:NothingToWithdraw": ["There is nothing to withdraw for this account on this line.", "Refresh the line.", "user"],
  "ERR_LINE:WithdrawalAlreadyPending": [
    "A withdrawal for this claim is already in progress and its outcome is not confirmed.",
    "Do not retry. Re-read the claim; if it stays processing, contact support with the withdrawal id and transaction ID.",
    "user",
  ],

  // LF-009 withdraw (lib.rs fail("ERR_WITHDRAW", ...)). Each is checked before
  // any state change, so the claim is untouched.
  "ERR_WITHDRAW:DepositMustBeOneYocto": [
    "A withdrawal must attach exactly 1 yoctoNEAR.",
    "This is an app bug. Nothing was changed and your claim is untouched; report it.",
    "client_bug",
  ],
  "ERR_WITHDRAW:InsufficientGas": [
    "Not enough gas was attached for the token transfer and its confirmation (at least 55 Tgas).",
    "Nothing was changed and your claim is untouched. This app attaches 100 Tgas; report it if it repeats.",
    "client_bug",
  ],
  "ERR_WITHDRAW:BadBeneficiary": [
    "The withdrawal named neither BUYER nor SUPPLIER.",
    "This is an app bug. Nothing was changed and your claim is untouched; report it.",
    "client_bug",
  ],
  "ERR_WITHDRAW:IdOverflow": ["The contract cannot assign another withdrawal id.", "Report this to the operator. Nothing was changed.", "incident"],
  "ERR_WITHDRAW:OpenCountOverflow": ["The contract cannot track another open withdrawal.", "Report this to the operator. Nothing was changed.", "incident"],
  "ERR_WITHDRAW:CallbackNotPrivate": [
    "Only the escrow itself may deliver a withdrawal outcome; this call was rejected.",
    "Nothing was changed. Report the transaction ID.",
    "incident",
  ],

  // LF-007 mutual settlement: propose_split / accept_split (line.rs LineError,
  // lib.rs ERR_AMOUNT_FORMAT). Every rejection reverts; no proposal or money moved.
  "ERR_LINE:AllocationSumMismatch": [
    "The buyer and supplier amounts do not add up to the line amount exactly.",
    "Enter two amounts whose sum equals the line amount; nothing is rounded.",
    "user",
  ],
  "ERR_LINE:NoActiveProposal": [
    "There is no open proposal on this line to accept.",
    "Refresh the line. Either party can make a new proposal.",
    "user",
  ],
  "ERR_LINE:StaleProposal": [
    "The proposal you accepted has been replaced by a newer one.",
    "Nothing was accepted. Reload the line, read the current proposal and decide again.",
    "user",
  ],
  "ERR_LINE:ProposalMismatch": [
    "The amounts you accepted differ from the open proposal.",
    "Nothing was accepted. Reload the line and accept only the amounts shown by the contract.",
    "user",
  ],
  "ERR_LINE:OwnProposal": [
    "You cannot accept your own proposal.",
    "The other party (buyer or supplier) must accept it. You can replace it with a new proposal.",
    "user",
  ],
  "ERR_LINE:ProposalNonceOverflow": [
    "The line's proposal counter is exhausted.",
    "Report this to the operator; it is not reachable in normal use.",
    "incident",
  ],

  // LF-008 timed arbitration and fallback (line.rs submit_ruling /
  // trigger_fallback). Every rejection reverts; nothing is allocated.
  "ERR_LINE:NotRulingWindow": [
    "This arbitrator's ruling window is not open at the current chain time. The primary arbitrator may rule only in the primary window, the backup arbitrator only in the backup window.",
    "Nothing was decided. Check the dispute timeline on the line; the times shown are when each window opens and closes.",
    "user",
  ],
  "ERR_LINE:FallbackNotEligible": [
    "The fallback split is not available yet: it opens only after the backup arbitrator's window has ended.",
    "Nothing was decided. Wait until the fallback time shown on the line, then try again.",
    "user",
  ],

  // Internal LineError codes not reachable from any current public method with
  // valid input. Copy exists so drift tests can require a mapping for every
  // code; each is shown as an incident or app bug, never as success.
  "ERR_LINE:InvalidDecisionMode": ["The contract rejected the decision type.", "This is an app or contract bug. Report the code.", "incident"],
  // FallbackMismatch is produced only by the private pure finalize path; LF-008
  // trigger_fallback computes the amounts itself, so it is unreachable.
  "ERR_LINE:FallbackMismatch": ["The fallback amounts do not match the agreed fallback split.", "Report the code; the call was reverted and nothing was changed.", "incident"],
  "ERR_LINE:NonMonotonicWithdrawalId": ["Withdrawal id check failed.", "Report the code with the transaction ID.", "incident"],
  "ERR_LINE:WithdrawalNotPending": ["No withdrawal is pending for this claim.", "Refresh the line; report the code if it repeats.", "incident"],
  "ERR_LINE:WithdrawalIdMismatch": ["The withdrawal result does not match the pending withdrawal.", "Report the code with the transaction ID.", "incident"],
  "ERR_LINE:EpochOverflow": ["The withdrawal counter is exhausted.", "Report the code to the operator.", "incident"],
  "ERR_LINE:Ledger": ["The contract's ledger check rejected this change.", "Report the code; the ledger was not changed.", "incident"],
  "ERR_LINE:Split": ["The contract's split computation failed.", "Report the code; the ledger was not changed.", "incident"],
  "ERR_LINE:InvariantViolated": ["A contract safety check failed.", "Report the code; the call was reverted and nothing was changed.", "incident"],

  // ERR_AMOUNT_FORMAT:<ParseError::code()> from lib.rs amount() / parse_u64 in
  // propose_split / accept_split. Only these two are produced by those parsers.
  "ERR_AMOUNT_FORMAT:NonCanonicalDecimal": [
    "An amount or proposal id was not a plain whole number of base units (no sign, spaces, decimals or leading zeros).",
    "This is an app bug: the form should have caught it. Do not sign; report it.",
    "client_bug",
  ],
  "ERR_AMOUNT_FORMAT:DecimalOverflow": [
    "An amount or proposal id is larger than the contract allows.",
    "Check the amounts; each is at most the line amount.",
    "user",
  ],
};

/** Exact panic-code token (ARCHITECTURE.md §8). */
const CODE_RE = /\b(ERR_[A-Z_]+(?::[A-Za-z]+)?)\b/;

/** First `ERR_*` code in a panic / execution-error string, or null. */
export function extractErrorCode(message: string): string | null {
  const m = CODE_RE.exec(message);
  return m === null ? null : m[1];
}

export function describeErrorCode(code: string): ErrorCopy {
  const hit = TABLE[code];
  if (hit !== undefined) return { code, title: hit[0], action: hit[1], severity: hit[2], unknown: false };
  if (code.startsWith("ERR_TERMS_PARSE:")) {
    return {
      code,
      title: "The contract rejected the terms format.",
      action: "This is an app bug: the local check should have caught it. Do not sign; report it.",
      severity: "client_bug",
      unknown: false,
    };
  }
  if (code.startsWith("ERR_TERMS_INVALID:")) {
    return {
      code,
      title: termsInvalidTitle(code.slice("ERR_TERMS_INVALID:".length)),
      action: "Correct the highlighted field in the draft and try again.",
      severity: "user",
      unknown: false,
    };
  }
  if (code.startsWith("ERR_AMOUNT_FORMAT:")) {
    // Remaining ParseError codes (Json, InvalidAccountId, InvalidCommitmentHex)
    // are not produced by the amount parsers; treat as an app bug if ever seen.
    return {
      code,
      title: "The contract rejected an amount format.",
      action: "This is an app bug. Do not sign; report it.",
      severity: "client_bug",
      unknown: false,
    };
  }
  if (code.startsWith("ERR_INIT_")) {
    return { code, title: "Deployment-time error.", action: "Not expected in the app; report it.", severity: "operator", unknown: false };
  }
  return {
    code,
    title: `The contract rejected this action (${code}). ${NOTHING_CHANGED}`,
    action: "Refresh and check the line state. If it repeats, report the code.",
    severity: code.startsWith("ERR_LINE:") ? "user" : "incident",
    unknown: true,
  };
}

/** Map a raw wallet/RPC error message to copy. */
export function describeError(message: string): ErrorCopy {
  const code = extractErrorCode(message);
  if (code === null) {
    return {
      code: "UNKNOWN",
      title: "The transaction did not complete and the reason is not known.",
      action: "Check the transaction in the explorer before trying again; it may still be processing.",
      severity: "incident",
      unknown: true,
    };
  }
  return describeErrorCode(code);
}

const TERMS_INVALID: Record<string, string> = {
  UnsupportedSchemaVersion: "Unsupported terms schema version.",
  UnsupportedDeadlineRulesVersion: "Unsupported deadline rules version.",
  FtNotAllowlisted: "The token is not the one this escrow accepts.",
  RolesNotDistinct: "Buyer, supplier and both arbitrators must be four different accounts.",
  RoleIsReservedAccount: "A role uses the escrow, token or operator treasury account.",
  AcceptanceDeadlineNotInFuture: "The acceptance deadline is not in the future. Choose a later acceptance deadline.",
  FundingDeadlineBeforeAcceptance: "The funding deadline is before the acceptance deadline.",
  DeliveryGraceOutOfRange: "The delivery grace period must be between 0 and 30 days.",
  WindowOutOfRange: "Each dispute window must be between 60 seconds and 30 days.",
  LineCountOutOfRange: "An agreement has 1 to 3 lines.",
  LineIdMismatch: "Line ids must be 0, 1, 2 in order.",
  ZeroPrincipal: "Each line needs an amount greater than zero.",
  BpsOutOfRange: "Fallback percentages must be between 0 % and 100 %.",
  BpsSumInvalid: "Buyer and supplier fallback shares must add up to exactly 100 %.",
  DeliveryDeadlineBeforeFunding: "A delivery deadline is before the funding deadline.",
  SubmissionCutoffOverflow: "Delivery deadline plus grace period is too large.",
  PhaseScheduleOverflow: "The dispute schedule after a delivery deadline is too large.",
  PrincipalSumOverflow: "The total of all line amounts is too large.",
};

export function termsInvalidTitle(code: string): string {
  return TERMS_INVALID[code] ?? `The terms were rejected (${code}).`;
}

// --- Funding refunds: logs, not panics (lib.rs ft_on_transfer) ---

export const REFUND_COPY =
  "Deposit was not accepted. Verify token, exact amount, and deadline before trying again. Check the token transaction before another attempt.";

const REFUND_REASONS: Record<string, string> = {
  UnexpectedToken: "The deposit came from a token other than the allowlisted test token.",
  MsgJson: "The funding message was not valid.",
  MsgVersion: "The funding message version is not supported.",
  MsgAgreementIdNonCanonical: "The funding message agreement id was not canonical.",
  MsgAgreementIdOverflow: "The funding message agreement id was out of range.",
  MsgLineIdOutOfRange: "The funding message line id was out of range.",
  MsgTermsHash: "The funding message terms hash was malformed.",
  AgreementNotFound: "No agreement exists with that id.",
  TermsHashMismatch: "The terms hash in the funding message does not match the agreement.",
  LineNotFound: "The line does not exist.",
  AgreementNotAgreed: "The agreement has not been accepted by all four parties.",
  NotAuthorized: "Only the buyer can fund a line.",
  WrongState: "The line is already funded or not fundable.",
  FundingDeadlinePassed: "The funding deadline has passed.",
  AmountMismatch: "The amount was not exactly the line principal.",
  CustodyOverflow: "Custody total overflow. Unreachable with a standard token: treat as an incident.",
  // F3 (founder-approved 2026-11-05; on main since 8ec0816, release WASM 470db97b…f2e1).
  DeliveryTimeTooShort: "Too late to fund: the supplier would have less than the review window to deliver.",
};

/** Refund codes mapped ahead of the fixture contract (see REFUND_REASONS). */
export const ANTICIPATED_REFUND_CODES: readonly string[] = [];

const REFUND_RE = /\bLF_FT_REFUND:([A-Za-z]+)\b/;

export interface RefundCopy {
  readonly code: string;
  readonly title: string;
  readonly reason: string;
  readonly note: string;
  readonly incident: boolean;
}

/** Find a funding refund among receipt logs. null when none is present. */
export function describeRefund(logs: readonly string[]): RefundCopy | null {
  for (const log of logs) {
    const m = REFUND_RE.exec(log);
    if (m === null) continue;
    const code = m[1];
    return {
      code,
      title: REFUND_COPY,
      reason: REFUND_REASONS[code] ?? `Reason code ${code}.`,
      note: "The token contract returns the unused amount to the buyer; the line stays not funded.",
      incident: code === "CustodyOverflow" || REFUND_REASONS[code] === undefined,
    };
  }
  return null;
}

/** Codes with explicit copy (for tests and the ARCHITECTURE.md table). */
export const KNOWN_ERROR_CODES: readonly string[] = Object.keys(TABLE);
export const KNOWN_REFUND_CODES: readonly string[] = Object.keys(REFUND_REASONS);
export const KNOWN_TERMS_INVALID_CODES: readonly string[] = Object.keys(TERMS_INVALID);
