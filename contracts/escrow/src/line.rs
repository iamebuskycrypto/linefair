//! Per-line state machine (M1 S5 / LF-004b). `docs/06` §Line money and work
//! state, `docs/07`, `docs/27` §Founder decision (R-1), `docs/25` §Limits.
//!
//! ```text
//! UNFUNDED ─fund(exact P, buyer, once)─► FUNDED ─submit(supplier)─► SUBMITTED
//! SUBMITTED ─accept_line(buyer)────────────────► ALLOCATED (supplier = P)
//! SUBMITTED ─open_dispute(buyer)─► DISPUTED ─finalize(B + S = P, once)─► ALLOCATED
//! ALLOCATED: each beneficiary independently
//!   claimable ─begin_withdraw─► pending(id, epoch) ─Success─────────► paid
//!                                                  └DefiniteFailure─► claimable (once)
//! ```
//!
//! **Deadlines (S5b, `docs/08` §Deadline rules v1, via `deadlines`):** fund
//! needs `now < funding_deadline`; submit needs `now < delivery + grace`;
//! buyer accept/dispute need `submitted_at <= now < submitted_at + review`.
//! NON_DELIVERY / NO_RESPONSE eligibility and their fixed T0 are exposed as
//! read-only queries; the time-triggered dispute *transition* is LF-008.
//!
//! **Not enforced here (by design of the slice plan):**
//! - *who* may finalize a dispute and *when* (mutual proposals LF-007,
//!   arbitrator windows and fallback longstop LF-008), and the time-triggered
//!   NO_RESPONSE / NON_DELIVERY disputes;
//! - the FT predecessor check and the actual token transfer (LF-005, LF-009).
//!   `fund` is a pure ledger transition; nothing in this module holds tokens.
//!
//! **Inconclusive withdrawals** (`docs/27` item 5) have no transition: if the
//! callback never completes, `resolve_withdrawal` is never called, the slot
//! stays `Pending` with its full record, and every other method rejects the
//! amount. There is deliberately no `Inconclusive` outcome and no retry path.
//!
//! Every record is fixed-size (no `Option`, no growing collections) so later
//! transitions never change storage size (`docs/25` pre-allocation, T058).
//! Every transition works on a copy, re-checks all invariants, and commits
//! only on success.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};

use crate::deadlines::{self, DeadlineError, WindowPosition};
use crate::ledger::{Edge, LedgerError, LineLedgerV1, SplitError, split_bps};

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
pub enum LineStatus {
    Unfunded,
    Funded,
    Submitted,
    Disputed,
    /// Decision state, not payout state (`docs/06`).
    Allocated,
}

impl LineStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            LineStatus::Unfunded => "UNFUNDED",
            LineStatus::Funded => "FUNDED",
            LineStatus::Submitted => "SUBMITTED",
            LineStatus::Disputed => "DISPUTED",
            LineStatus::Allocated => "ALLOCATED",
        }
    }
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
pub enum DisputeReason {
    None,
    /// Buyer disputed a submitted delivery inside review (this slice).
    BuyerDispute,
    /// Review expired without a buyer decision (time-triggered, LF-008).
    NoResponse,
    /// Delivery cutoff missed (time-triggered, LF-008).
    NonDelivery,
}

impl DisputeReason {
    pub fn as_str(self) -> &'static str {
        match self {
            DisputeReason::None => "NONE",
            DisputeReason::BuyerDispute => "BUYER_DISPUTE",
            DisputeReason::NoResponse => "NO_RESPONSE",
            DisputeReason::NonDelivery => "NON_DELIVERY",
        }
    }
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
pub enum AllocationMode {
    None,
    /// Buyer accepted the delivery: 100 % to the supplier.
    BuyerAccepted,
    /// Mutual split; `source_id` is the accepted proposal id (LF-007).
    Mutual,
    PrimaryRuling,
    BackupRuling,
    /// Pre-agreed fallback bps (FD-04): amounts must equal `split_bps`.
    Fallback,
}

impl AllocationMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AllocationMode::None => "NONE",
            AllocationMode::BuyerAccepted => "BUYER_ACCEPTED",
            AllocationMode::Mutual => "MUTUAL",
            AllocationMode::PrimaryRuling => "PRIMARY_RULING",
            AllocationMode::BackupRuling => "BACKUP_RULING",
            AllocationMode::Fallback => "FALLBACK",
        }
    }
}

/// The final allocation of a line. Written once (single writer).
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
pub struct AllocationRecordV1 {
    pub mode: AllocationMode,
    pub buyer_amount: u128,
    pub supplier_amount: u128,
    /// Proposal id for `Mutual`; 0 otherwise.
    pub source_id: u64,
    pub finalized_at_ns: u64,
}

impl AllocationRecordV1 {
    const EMPTY: Self = AllocationRecordV1 {
        mode: AllocationMode::None,
        buyer_amount: 0,
        supplier_amount: 0,
        source_id: 0,
        finalized_at_ns: 0,
    };
}

/// Who made a split proposal (LF-007). `None` only in the empty record.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
pub enum Proposer {
    None,
    Buyer,
    Supplier,
}

impl Proposer {
    pub fn as_str(self) -> &'static str {
        match self {
            Proposer::None => "NONE",
            Proposer::Buyer => "BUYER",
            Proposer::Supplier => "SUPPLIER",
        }
    }
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
pub enum ProposalStatus {
    /// No proposal was ever made on this line.
    None,
    /// The line's single active proposal; a new proposal supersedes it.
    Open,
    /// Accepted by the counterparty; the line's allocation is this split.
    Accepted,
}

impl ProposalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ProposalStatus::None => "NONE",
            ProposalStatus::Open => "OPEN",
            ProposalStatus::Accepted => "ACCEPTED",
        }
    }
}

/// The line's single active mutual-split proposal (LF-007, `docs/20`
/// `SplitProposalV1`). Fixed size (50 B Borsh). `proposal_id` is the
/// per-line nonce: monotonic from 1, so every id ever issued is unique.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
pub struct SplitProposalV1 {
    pub status: ProposalStatus,
    pub proposer: Proposer,
    pub proposal_id: u64,
    pub buyer_amount: u128,
    pub supplier_amount: u128,
    pub created_at_ns: u64,
}

impl SplitProposalV1 {
    pub const EMPTY: Self = SplitProposalV1 {
        status: ProposalStatus::None,
        proposer: Proposer::None,
        proposal_id: 0,
        buyer_amount: 0,
        supplier_amount: 0,
        created_at_ns: 0,
    };
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
pub enum SlotState {
    /// No withdrawal ever started for this beneficiary on this line.
    Empty,
    /// Claim reserved; transfer outcome not yet known. Also the permanent
    /// state of an inconclusive withdrawal.
    Pending,
    /// Authenticated success callback.
    Paid,
    /// Authenticated definite failure; the claim was restored once.
    Failed,
}

impl SlotState {
    pub fn as_str(self) -> &'static str {
        match self {
            SlotState::Empty => "EMPTY",
            SlotState::Pending => "PENDING",
            SlotState::Paid => "PAID",
            SlotState::Failed => "FAILED",
        }
    }
}

/// One pre-allocated withdrawal slot per beneficiary per line (`docs/25`).
/// Holds the latest withdrawal; history lives in events (later slice).
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
pub struct WithdrawalSlotV1 {
    pub state: SlotState,
    /// Contract-wide unique, monotonic id (`docs/07`, `docs/27` R-1).
    pub withdrawal_id: u64,
    /// Per-slot counter, incremented by every new withdrawal (R-1).
    pub epoch: u32,
    pub amount: u128,
    pub started_at_ns: u64,
    pub resolved_at_ns: u64,
}

impl WithdrawalSlotV1 {
    const EMPTY: Self = WithdrawalSlotV1 {
        state: SlotState::Empty,
        withdrawal_id: 0,
        epoch: 0,
        amount: 0,
        started_at_ns: 0,
        resolved_at_ns: 0,
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Beneficiary {
    Buyer,
    Supplier,
}

/// Outcome delivered by the authenticated private callback (LF-009).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WithdrawalOutcome {
    /// `PromiseResult::Successful` from `ft_transfer`.
    Success,
    /// `PromiseResult::Failed`: the transfer definitely did not happen.
    DefiniteFailure,
}

/// What `begin_withdrawal` reserved. The recipient is not part of it: the
/// caller derives it from the immutable terms (buyer_id / supplier_id).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WithdrawalTicket {
    pub beneficiary: Beneficiary,
    pub withdrawal_id: u64,
    pub epoch: u32,
    pub amount: u128,
}

/// A dispute outcome submitted for finalization. Authorization (who/when) is
/// enforced by the caller in LF-007/LF-008.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DisputeDecision {
    pub mode: AllocationMode,
    pub buyer_amount: u128,
    pub supplier_amount: u128,
    pub source_id: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineError {
    WrongState {
        expected: LineStatus,
        found: LineStatus,
    },
    /// `now >= end` of the window for this action.
    DeadlinePassed(Deadline),
    /// `now < start` of the review window (chain time before submission).
    BeforeWindowStart,
    /// A deadline sum overflowed u64 (prevented by terms validation).
    DeadlineOverflow,
    /// `advance_case` before the line's NO_RESPONSE / NON_DELIVERY T0.
    NotEligible,
    /// F3: funding now would leave the supplier less than `review_window`
    /// before `delivery_deadline + grace`.
    DeliveryTimeTooShort,
    /// `advance_case` on a line that is not FUNDED or SUBMITTED.
    NotAdvanceable,
    AmountMismatch,
    ZeroCommitment,
    AlreadyFinalized,
    InvalidDecisionMode,
    AllocationSumMismatch,
    FallbackMismatch,
    NothingToWithdraw,
    WithdrawalAlreadyPending,
    NonMonotonicWithdrawalId,
    WithdrawalNotPending,
    WithdrawalIdMismatch,
    EpochOverflow,
    /// LF-008: an arbitrator ruled outside its own phase window.
    NotRulingWindow,
    /// LF-008: `trigger_fallback` before `T0 + N + A + B`.
    FallbackNotEligible,
    /// `accept_split` with no OPEN proposal on the line.
    NoActiveProposal,
    /// `accept_split` names an id other than the active proposal's.
    StaleProposal,
    /// `accept_split` amounts differ from the active proposal's.
    ProposalMismatch,
    /// The proposer tried to accept its own proposal.
    OwnProposal,
    /// The per-line proposal nonce would overflow u64.
    ProposalNonceOverflow,
    Ledger(LedgerError),
    Split(SplitError),
    InvariantViolated(&'static str),
}

impl LineError {
    pub fn code(self) -> &'static str {
        match self {
            LineError::WrongState { .. } => "WrongState",
            LineError::DeadlinePassed(Deadline::Funding) => "FundingDeadlinePassed",
            LineError::DeadlinePassed(Deadline::Submission) => "SubmissionDeadlinePassed",
            LineError::DeadlinePassed(Deadline::Review) => "ReviewWindowClosed",
            LineError::BeforeWindowStart => "BeforeWindowStart",
            LineError::DeadlineOverflow => "DeadlineOverflow",
            LineError::NotEligible => "NotEligible",
            LineError::DeliveryTimeTooShort => "DeliveryTimeTooShort",
            LineError::NotAdvanceable => "NotAdvanceable",
            LineError::AmountMismatch => "AmountMismatch",
            LineError::ZeroCommitment => "ZeroCommitment",
            LineError::AlreadyFinalized => "AlreadyFinalized",
            LineError::InvalidDecisionMode => "InvalidDecisionMode",
            LineError::AllocationSumMismatch => "AllocationSumMismatch",
            LineError::FallbackMismatch => "FallbackMismatch",
            LineError::NothingToWithdraw => "NothingToWithdraw",
            LineError::WithdrawalAlreadyPending => "WithdrawalAlreadyPending",
            LineError::NonMonotonicWithdrawalId => "NonMonotonicWithdrawalId",
            LineError::WithdrawalNotPending => "WithdrawalNotPending",
            LineError::WithdrawalIdMismatch => "WithdrawalIdMismatch",
            LineError::EpochOverflow => "EpochOverflow",
            LineError::NotRulingWindow => "NotRulingWindow",
            LineError::FallbackNotEligible => "FallbackNotEligible",
            LineError::NoActiveProposal => "NoActiveProposal",
            LineError::StaleProposal => "StaleProposal",
            LineError::ProposalMismatch => "ProposalMismatch",
            LineError::OwnProposal => "OwnProposal",
            LineError::ProposalNonceOverflow => "ProposalNonceOverflow",
            LineError::Ledger(_) => "Ledger",
            LineError::Split(_) => "Split",
            LineError::InvariantViolated(_) => "InvariantViolated",
        }
    }
}

impl From<DeadlineError> for LineError {
    fn from(_: DeadlineError) -> Self {
        LineError::DeadlineOverflow
    }
}

impl From<LedgerError> for LineError {
    fn from(e: LedgerError) -> Self {
        LineError::Ledger(e)
    }
}

/// Stored state of one line. Fixed-size in Borsh in every state.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
pub struct LineStateV1 {
    pub status: LineStatus,
    pub funded_at_ns: u64,
    pub submitted_at_ns: u64,
    /// Salted 32-byte delivery-evidence commitment (`docs/20`); zero until submitted.
    pub evidence_commitment: [u8; 32],
    pub dispute_reason: DisputeReason,
    pub dispute_t0_ns: u64,
    pub allocation: AllocationRecordV1,
    pub ledger: LineLedgerV1,
    pub buyer_withdrawal: WithdrawalSlotV1,
    pub supplier_withdrawal: WithdrawalSlotV1,
    /// LF-007: the single active (or accepted) mutual-split proposal.
    pub proposal: SplitProposalV1,
}

/// The immutable per-line terms a transition needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineParams {
    pub principal: u128,
    pub fallback_supplier_bps: u16,
    /// Agreement-level `funding_deadline_ns` (hashed terms).
    pub funding_deadline_ns: u64,
    /// This line's `delivery_deadline_ns` (hashed terms).
    pub delivery_deadline_ns: u64,
    /// Agreement-level `delivery_grace_period_ns` (hashed terms).
    pub delivery_grace_ns: u64,
    /// Agreement-level `review_window_ns` (hashed terms).
    pub review_window_ns: u64,
    /// LF-008: agreement-level dispute windows N, A, B (hashed terms).
    pub negotiation_window_ns: u64,
    pub primary_window_ns: u64,
    pub backup_window_ns: u64,
}

/// LF-008: which appointed arbitrator submits a ruling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arbitrator {
    Primary,
    Backup,
}

/// Which cutoff rejected an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deadline {
    Funding,
    Submission,
    Review,
}

impl Default for LineStateV1 {
    fn default() -> Self {
        Self::new()
    }
}

impl LineStateV1 {
    /// Pre-allocated, unfunded line.
    pub const fn new() -> Self {
        LineStateV1 {
            status: LineStatus::Unfunded,
            funded_at_ns: 0,
            submitted_at_ns: 0,
            evidence_commitment: [0; 32],
            dispute_reason: DisputeReason::None,
            dispute_t0_ns: 0,
            allocation: AllocationRecordV1::EMPTY,
            ledger: LineLedgerV1 {
                locked: 0,
                buyer_claimable: 0,
                supplier_claimable: 0,
                buyer_pending: 0,
                supplier_pending: 0,
                buyer_paid: 0,
                supplier_paid: 0,
            },
            buyer_withdrawal: WithdrawalSlotV1::EMPTY,
            supplier_withdrawal: WithdrawalSlotV1::EMPTY,
            proposal: SplitProposalV1::EMPTY,
        }
    }

    fn require(&self, expected: LineStatus) -> Result<(), LineError> {
        if self.status == expected {
            Ok(())
        } else {
            Err(LineError::WrongState {
                expected,
                found: self.status,
            })
        }
    }

    fn require_review_open(&self, p: LineParams, now_ns: u64) -> Result<(), LineError> {
        match deadlines::review_position(now_ns, self.submitted_at_ns, p.review_window_ns)? {
            WindowPosition::Open => Ok(()),
            WindowPosition::BeforeStart => Err(LineError::BeforeWindowStart),
            WindowPosition::Closed => Err(LineError::DeadlinePassed(Deadline::Review)),
        }
    }

    /// NON_DELIVERY eligibility (read-only): `Some(T0 = delivery + grace)`
    /// iff the line is FUNDED (never submitted) and `now >= T0`.
    pub fn non_delivery_t0(&self, p: LineParams, now_ns: u64) -> Result<Option<u64>, LineError> {
        if self.status != LineStatus::Funded {
            return Ok(None);
        }
        Ok(deadlines::non_delivery_t0(
            now_ns,
            p.delivery_deadline_ns,
            p.delivery_grace_ns,
        )?)
    }

    /// NO_RESPONSE eligibility (read-only): `Some(T0 = submitted_at + review)`
    /// iff the line is SUBMITTED (buyer neither accepted nor disputed) and `now >= T0`.
    pub fn no_response_t0(&self, p: LineParams, now_ns: u64) -> Result<Option<u64>, LineError> {
        if self.status != LineStatus::Submitted {
            return Ok(None);
        }
        Ok(deadlines::no_response_t0(
            now_ns,
            self.submitted_at_ns,
            p.review_window_ns,
        )?)
    }

    /// Run `f` on a copy; commit only if `f` and the invariant check pass.
    fn transact<T>(
        &mut self,
        p: LineParams,
        f: impl FnOnce(&mut LineStateV1) -> Result<T, LineError>,
    ) -> Result<T, LineError> {
        let mut next = *self;
        let out = f(&mut next)?;
        next.check_invariants(p)?;
        *self = next;
        Ok(out)
    }

    /// UNFUNDED → FUNDED with exactly `P` locked. One time only.
    /// (Sender = buyer and token = allowlisted FT are checked by the caller.)
    pub fn fund(&mut self, p: LineParams, amount: u128, now_ns: u64) -> Result<(), LineError> {
        self.transact(p, |l| {
            l.require(LineStatus::Unfunded)?;
            if !deadlines::funding_open(now_ns, p.funding_deadline_ns) {
                return Err(LineError::DeadlinePassed(Deadline::Funding));
            }
            // F3: never fund so late that the supplier has less than the
            // signed review window to deliver (deadlines are not extended).
            if !deadlines::funding_leaves_delivery_time(
                now_ns,
                p.delivery_deadline_ns,
                p.delivery_grace_ns,
                p.review_window_ns,
            )? {
                return Err(LineError::DeliveryTimeTooShort);
            }
            if amount != p.principal {
                return Err(LineError::AmountMismatch);
            }
            l.ledger = LineLedgerV1::funded(p.principal)?;
            l.status = LineStatus::Funded;
            l.funded_at_ns = now_ns;
            Ok(())
        })
    }

    /// FUNDED → SUBMITTED with the supplier's evidence commitment.
    pub fn submit_delivery(
        &mut self,
        p: LineParams,
        commitment: [u8; 32],
        now_ns: u64,
    ) -> Result<(), LineError> {
        self.transact(p, |l| {
            l.require(LineStatus::Funded)?;
            if !deadlines::submission_open(now_ns, p.delivery_deadline_ns, p.delivery_grace_ns)? {
                return Err(LineError::DeadlinePassed(Deadline::Submission));
            }
            if commitment == [0u8; 32] {
                return Err(LineError::ZeroCommitment);
            }
            l.evidence_commitment = commitment;
            l.submitted_at_ns = now_ns;
            l.status = LineStatus::Submitted;
            Ok(())
        })
    }

    /// SUBMITTED → ALLOCATED, locked → supplier claimable (T009).
    pub fn accept_line(&mut self, p: LineParams, now_ns: u64) -> Result<(), LineError> {
        self.transact(p, |l| {
            l.require(LineStatus::Submitted)?;
            l.require_review_open(p, now_ns)?;
            l.allocate(AllocationMode::BuyerAccepted, 0, p.principal, 0, now_ns)
        })
    }

    /// SUBMITTED → DISPUTED by the buyer; T0 = now (`docs/08` §T0 derivation).
    pub fn open_dispute(&mut self, p: LineParams, now_ns: u64) -> Result<(), LineError> {
        self.transact(p, |l| {
            l.require(LineStatus::Submitted)?;
            l.require_review_open(p, now_ns)?;
            l.status = LineStatus::Disputed;
            l.dispute_reason = DisputeReason::BuyerDispute;
            l.dispute_t0_ns = now_ns;
            Ok(())
        })
    }

    /// LF-006b `advance_case` (permissionless; `docs/06`, FD-07, OQ-07).
    /// SUBMITTED with `now ≥ submitted_at + review` → DISPUTED NO_RESPONSE;
    /// FUNDED with `now ≥ delivery + grace` → DISPUTED NON_DELIVERY. T0 is the
    /// fixed deadline, never `now`, so a late call cannot move it. No ledger,
    /// allocation or withdrawal change. Returns the reason applied.
    pub fn advance_case(&mut self, p: LineParams, now_ns: u64) -> Result<DisputeReason, LineError> {
        self.transact(p, |l| {
            let (reason, t0) = match l.status {
                LineStatus::Submitted => (
                    DisputeReason::NoResponse,
                    deadlines::no_response_t0(now_ns, l.submitted_at_ns, p.review_window_ns)?,
                ),
                LineStatus::Funded => (
                    DisputeReason::NonDelivery,
                    deadlines::non_delivery_t0(
                        now_ns,
                        p.delivery_deadline_ns,
                        p.delivery_grace_ns,
                    )?,
                ),
                _ => return Err(LineError::NotAdvanceable),
            };
            let t0 = t0.ok_or(LineError::NotEligible)?;
            l.status = LineStatus::Disputed;
            l.dispute_reason = reason;
            l.dispute_t0_ns = t0;
            Ok(reason)
        })
    }

    /// DISPUTED → ALLOCATED with `B + S = P` exactly. Single writer: any later
    /// finalization fails with `AlreadyFinalized` (T025 pure part).
    /// LF-008: private — reachable only through `submit_ruling` (role +
    /// phase checked) and `trigger_fallback` (longstop checked).
    fn finalize_dispute(
        &mut self,
        p: LineParams,
        d: DisputeDecision,
        now_ns: u64,
    ) -> Result<(), LineError> {
        self.transact(p, |l| {
            if l.status == LineStatus::Allocated {
                return Err(LineError::AlreadyFinalized);
            }
            l.require(LineStatus::Disputed)?;
            match d.mode {
                AllocationMode::PrimaryRuling | AllocationMode::BackupRuling => {}
                AllocationMode::Fallback => {
                    let (b, s) = split_bps(p.principal, p.fallback_supplier_bps)
                        .map_err(LineError::Split)?;
                    if (d.buyer_amount, d.supplier_amount) != (b, s) {
                        return Err(LineError::FallbackMismatch);
                    }
                }
                // LF-007: a Mutual allocation exists only through
                // `accept_split` of the exact active proposal.
                AllocationMode::Mutual | AllocationMode::None | AllocationMode::BuyerAccepted => {
                    return Err(LineError::InvalidDecisionMode);
                }
            }
            l.allocate(d.mode, d.buyer_amount, d.supplier_amount, 0, now_ns)
        })
    }

    /// LF-008: the dispute phase of this line at `now` (DISPUTED only).
    pub fn dispute_phase(
        &self,
        p: LineParams,
        now_ns: u64,
    ) -> Result<Option<deadlines::DisputePhase>, LineError> {
        if self.status != LineStatus::Disputed {
            return Ok(None);
        }
        Ok(Some(deadlines::dispute_phase(
            now_ns,
            self.dispute_t0_ns,
            p.negotiation_window_ns,
            p.primary_window_ns,
            p.backup_window_ns,
        )?))
    }

    /// LF-008: an appointed arbitrator allocates `B + S = P` (checked) inside
    /// its own window only: primary in `[T0+N, T0+N+A)`, backup in
    /// `[T0+N+A, T0+N+A+B)`. Single writer; ALLOCATED is immutable.
    pub fn submit_ruling(
        &mut self,
        p: LineParams,
        who: Arbitrator,
        buyer_amount: u128,
        supplier_amount: u128,
        now_ns: u64,
    ) -> Result<(), LineError> {
        if self.status == LineStatus::Allocated {
            return Err(LineError::AlreadyFinalized);
        }
        self.require(LineStatus::Disputed)?;
        let phase = self.dispute_phase(p, now_ns)?;
        let (want, mode) = match who {
            Arbitrator::Primary => (
                deadlines::DisputePhase::Primary,
                AllocationMode::PrimaryRuling,
            ),
            Arbitrator::Backup => (
                deadlines::DisputePhase::Backup,
                AllocationMode::BackupRuling,
            ),
        };
        if phase != Some(want) {
            return Err(LineError::NotRulingWindow);
        }
        self.finalize_dispute(
            p,
            DisputeDecision {
                mode,
                buyer_amount,
                supplier_amount,
                source_id: 0,
            },
            now_ns,
        )
    }

    /// LF-008: anyone, from `T0 + N + A + B`, applies the pre-agreed fallback
    /// split (`split_bps`: supplier = floor(P·S/10 000), buyer = remainder).
    /// No amount parameters, no discretion.
    pub fn trigger_fallback(&mut self, p: LineParams, now_ns: u64) -> Result<(), LineError> {
        if self.status == LineStatus::Allocated {
            return Err(LineError::AlreadyFinalized);
        }
        self.require(LineStatus::Disputed)?;
        if self.dispute_phase(p, now_ns)? != Some(deadlines::DisputePhase::Fallback) {
            return Err(LineError::FallbackNotEligible);
        }
        let (b, s) = split_bps(p.principal, p.fallback_supplier_bps).map_err(LineError::Split)?;
        self.finalize_dispute(
            p,
            DisputeDecision {
                mode: AllocationMode::Fallback,
                buyer_amount: b,
                supplier_amount: s,
                source_id: 0,
            },
            now_ns,
        )
    }

    /// Shared guard for both mutual-settlement methods: DISPUTED, not final,
    /// and chain time not before the fixed T0. Mutual settlement is allowed
    /// in every phase `[T0, ∞)` until a final allocation exists (`docs/08`).
    fn require_settleable(&self, now_ns: u64) -> Result<(), LineError> {
        if self.status == LineStatus::Allocated {
            return Err(LineError::AlreadyFinalized);
        }
        self.require(LineStatus::Disputed)?;
        if now_ns < self.dispute_t0_ns {
            return Err(LineError::BeforeWindowStart);
        }
        Ok(())
    }

    /// LF-007: DISPUTED line, buyer or supplier proposes `B + S = P`
    /// (checked). Stores it as the line's single active proposal with the
    /// next per-line nonce as its id, superseding any earlier proposal.
    /// No ledger move. Returns the new proposal id.
    pub fn propose_split(
        &mut self,
        p: LineParams,
        proposer: Proposer,
        buyer_amount: u128,
        supplier_amount: u128,
        now_ns: u64,
    ) -> Result<u64, LineError> {
        self.transact(p, |l| {
            l.require_settleable(now_ns)?;
            if proposer == Proposer::None {
                return Err(LineError::InvalidDecisionMode);
            }
            if buyer_amount.checked_add(supplier_amount) != Some(p.principal) {
                return Err(LineError::AllocationSumMismatch);
            }
            let id = l
                .proposal
                .proposal_id
                .checked_add(1)
                .ok_or(LineError::ProposalNonceOverflow)?;
            l.proposal = SplitProposalV1 {
                status: ProposalStatus::Open,
                proposer,
                proposal_id: id,
                buyer_amount,
                supplier_amount,
                created_at_ns: now_ns,
            };
            Ok(id)
        })
    }

    /// LF-007: the counterparty accepts the exact active proposal (id and
    /// both amounts must match). Single writer: allocates `Mutual` with
    /// `source_id = proposal_id`; the line becomes ALLOCATED and immutable.
    pub fn accept_split(
        &mut self,
        p: LineParams,
        acceptor: Proposer,
        proposal_id: u64,
        buyer_amount: u128,
        supplier_amount: u128,
        now_ns: u64,
    ) -> Result<(), LineError> {
        self.transact(p, |l| {
            l.require_settleable(now_ns)?;
            let pr = l.proposal;
            if pr.status != ProposalStatus::Open {
                return Err(LineError::NoActiveProposal);
            }
            if proposal_id != pr.proposal_id {
                return Err(LineError::StaleProposal);
            }
            if (buyer_amount, supplier_amount) != (pr.buyer_amount, pr.supplier_amount) {
                return Err(LineError::ProposalMismatch);
            }
            if acceptor == Proposer::None {
                return Err(LineError::InvalidDecisionMode);
            }
            if acceptor == pr.proposer {
                return Err(LineError::OwnProposal);
            }
            l.allocate(
                AllocationMode::Mutual,
                pr.buyer_amount,
                pr.supplier_amount,
                pr.proposal_id,
                now_ns,
            )?;
            l.proposal.status = ProposalStatus::Accepted;
            Ok(())
        })
    }

    /// Shared allocation step. Zero-value legs are skipped, never moved
    /// (founder S5 item 7; `ledger::apply` refuses 0).
    fn allocate(
        &mut self,
        mode: AllocationMode,
        buyer: u128,
        supplier: u128,
        source_id: u64,
        now_ns: u64,
    ) -> Result<(), LineError> {
        if self.allocation.mode != AllocationMode::None {
            return Err(LineError::AlreadyFinalized);
        }
        let sum = buyer
            .checked_add(supplier)
            .ok_or(LineError::AllocationSumMismatch)?;
        if sum != self.ledger.locked || sum == 0 {
            return Err(LineError::AllocationSumMismatch);
        }
        if buyer > 0 {
            self.ledger.apply(Edge::AllocateToBuyer, buyer)?;
        }
        if supplier > 0 {
            self.ledger.apply(Edge::AllocateToSupplier, supplier)?;
        }
        self.allocation = AllocationRecordV1 {
            mode,
            buyer_amount: buyer,
            supplier_amount: supplier,
            source_id,
            finalized_at_ns: now_ns,
        };
        self.status = LineStatus::Allocated;
        Ok(())
    }

    pub fn slot(&self, b: Beneficiary) -> &WithdrawalSlotV1 {
        match b {
            Beneficiary::Buyer => &self.buyer_withdrawal,
            Beneficiary::Supplier => &self.supplier_withdrawal,
        }
    }

    fn slot_mut(&mut self, b: Beneficiary) -> &mut WithdrawalSlotV1 {
        match b {
            Beneficiary::Buyer => &mut self.buyer_withdrawal,
            Beneficiary::Supplier => &mut self.supplier_withdrawal,
        }
    }

    fn claimable(&self, b: Beneficiary) -> u128 {
        match b {
            Beneficiary::Buyer => self.ledger.buyer_claimable,
            Beneficiary::Supplier => self.ledger.supplier_claimable,
        }
    }

    /// Reserve the beneficiary's whole claim: claimable → pending, before any
    /// transfer (`docs/27` R-1). At most one open withdrawal per beneficiary.
    pub fn begin_withdrawal(
        &mut self,
        p: LineParams,
        b: Beneficiary,
        withdrawal_id: u64,
        now_ns: u64,
    ) -> Result<WithdrawalTicket, LineError> {
        self.transact(p, |l| {
            l.require(LineStatus::Allocated)?;
            let slot = *l.slot(b);
            if slot.state == SlotState::Pending {
                return Err(LineError::WithdrawalAlreadyPending);
            }
            let amount = l.claimable(b);
            if amount == 0 {
                return Err(LineError::NothingToWithdraw);
            }
            if slot.state != SlotState::Empty && withdrawal_id <= slot.withdrawal_id {
                return Err(LineError::NonMonotonicWithdrawalId);
            }
            let epoch = slot.epoch.checked_add(1).ok_or(LineError::EpochOverflow)?;
            let edge = match b {
                Beneficiary::Buyer => Edge::BeginBuyerWithdrawal,
                Beneficiary::Supplier => Edge::BeginSupplierWithdrawal,
            };
            l.ledger.apply(edge, amount)?;
            *l.slot_mut(b) = WithdrawalSlotV1 {
                state: SlotState::Pending,
                withdrawal_id,
                epoch,
                amount,
                started_at_ns: now_ns,
                resolved_at_ns: 0,
            };
            Ok(WithdrawalTicket {
                beneficiary: b,
                withdrawal_id,
                epoch,
                amount,
            })
        })
    }

    /// Apply the authenticated callback outcome. Requires the slot to be
    /// `Pending` with the exact id and epoch; anything else (forged, replayed,
    /// stale or duplicate) is rejected and changes nothing.
    pub fn resolve_withdrawal(
        &mut self,
        p: LineParams,
        b: Beneficiary,
        withdrawal_id: u64,
        epoch: u32,
        outcome: WithdrawalOutcome,
        now_ns: u64,
    ) -> Result<(), LineError> {
        self.transact(p, |l| {
            let slot = *l.slot(b);
            if slot.state != SlotState::Pending {
                return Err(LineError::WithdrawalNotPending);
            }
            if slot.withdrawal_id != withdrawal_id || slot.epoch != epoch {
                return Err(LineError::WithdrawalIdMismatch);
            }
            let (edge, state) = match (b, outcome) {
                (Beneficiary::Buyer, WithdrawalOutcome::Success) => {
                    (Edge::ConfirmBuyerPaid, SlotState::Paid)
                }
                (Beneficiary::Supplier, WithdrawalOutcome::Success) => {
                    (Edge::ConfirmSupplierPaid, SlotState::Paid)
                }
                (Beneficiary::Buyer, WithdrawalOutcome::DefiniteFailure) => {
                    (Edge::RestoreBuyerClaim, SlotState::Failed)
                }
                (Beneficiary::Supplier, WithdrawalOutcome::DefiniteFailure) => {
                    (Edge::RestoreSupplierClaim, SlotState::Failed)
                }
            };
            l.ledger.apply(edge, slot.amount)?;
            let s = l.slot_mut(b);
            s.state = state;
            s.resolved_at_ns = now_ns;
            Ok(())
        })
    }

    /// Every structural invariant of a line (`tests/FINANCIAL_INVARIANTS.md`).
    pub fn check_invariants(&self, p: LineParams) -> Result<(), LineError> {
        use LineError::InvariantViolated as V;
        let l = &self.ledger;
        match self.status {
            LineStatus::Unfunded => {
                if *l != LineLedgerV1::default() {
                    return Err(V("unfunded ledger not empty"));
                }
            }
            LineStatus::Funded | LineStatus::Submitted | LineStatus::Disputed => {
                l.check_conservation(p.principal)
                    .map_err(|_| V("conservation"))?;
                if l.locked != p.principal {
                    return Err(V("pre-allocation value not fully locked"));
                }
            }
            LineStatus::Allocated => {
                l.check_conservation(p.principal)
                    .map_err(|_| V("conservation"))?;
                if l.locked != 0 {
                    return Err(V("allocated line still has locked value"));
                }
                let a = &self.allocation;
                if a.mode == AllocationMode::None
                    || a.buyer_amount.checked_add(a.supplier_amount) != Some(p.principal)
                {
                    return Err(V("allocation record"));
                }
                if l.buyer_allocated() != Some(a.buyer_amount)
                    || l.supplier_allocated() != Some(a.supplier_amount)
                {
                    return Err(V("buckets differ from allocation"));
                }
            }
        }
        if self.status != LineStatus::Allocated && self.allocation != AllocationRecordV1::EMPTY {
            return Err(V("allocation before ALLOCATED"));
        }
        // LF-007 proposal record.
        let pr = &self.proposal;
        match pr.status {
            ProposalStatus::None => {
                if *pr != SplitProposalV1::EMPTY {
                    return Err(V("empty proposal record not zero"));
                }
            }
            ProposalStatus::Open | ProposalStatus::Accepted => {
                if !matches!(self.status, LineStatus::Disputed | LineStatus::Allocated)
                    || pr.proposer == Proposer::None
                    || pr.proposal_id == 0
                    || pr.buyer_amount.checked_add(pr.supplier_amount) != Some(p.principal)
                {
                    return Err(V("proposal record"));
                }
            }
        }
        let mutual = self.allocation.mode == AllocationMode::Mutual;
        let accepted = pr.status == ProposalStatus::Accepted;
        if mutual != accepted
            || (accepted
                && (self.allocation.source_id != pr.proposal_id
                    || self.allocation.buyer_amount != pr.buyer_amount
                    || self.allocation.supplier_amount != pr.supplier_amount))
        {
            return Err(V("mutual allocation differs from accepted proposal"));
        }
        for (b, pending, paid) in [
            (Beneficiary::Buyer, l.buyer_pending, l.buyer_paid),
            (Beneficiary::Supplier, l.supplier_pending, l.supplier_paid),
        ] {
            let s = self.slot(b);
            match s.state {
                SlotState::Pending if pending != s.amount || s.amount == 0 => {
                    return Err(V("pending bucket differs from open withdrawal"));
                }
                SlotState::Empty | SlotState::Paid | SlotState::Failed if pending != 0 => {
                    return Err(V("pending value without open withdrawal"));
                }
                _ => {}
            }
            // Paid value exists exactly when the slot is Paid (a withdrawal
            // always takes the whole claim, so nothing can follow a payout).
            if (paid > 0) != (s.state == SlotState::Paid)
                || (s.state == SlotState::Paid && paid != s.amount)
            {
                return Err(V("paid bucket differs from paid withdrawal"));
            }
            if self.status != LineStatus::Allocated && s.state != SlotState::Empty {
                return Err(V("withdrawal before ALLOCATED"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: LineParams = LineParams {
        principal: 300,
        fallback_supplier_bps: 4_000,
        funding_deadline_ns: 10_000,
        delivery_deadline_ns: 20_000,
        delivery_grace_ns: 0,
        review_window_ns: 5_000,
        negotiation_window_ns: 1_000,
        primary_window_ns: 2_000,
        backup_window_ns: 3_000,
    };
    const T: u64 = 1_000;
    const C: [u8; 32] = [9; 32];

    fn funded() -> LineStateV1 {
        let mut l = LineStateV1::new();
        l.fund(P, 300, T).expect("fund");
        l
    }
    fn submitted() -> LineStateV1 {
        let mut l = funded();
        l.submit_delivery(P, C, T + 1).expect("submit");
        l
    }
    fn disputed() -> LineStateV1 {
        let mut l = submitted();
        l.open_dispute(P, T + 2).expect("dispute");
        l
    }
    /// LF-007: buyer proposes (b, s), supplier accepts the exact proposal.
    fn mutual(l: &mut LineStateV1, p: LineParams, b: u128, s: u128, now: u64) -> u64 {
        let id = l
            .propose_split(p, Proposer::Buyer, b, s, now)
            .expect("propose");
        l.accept_split(p, Proposer::Supplier, id, b, s, now)
            .expect("accept");
        id
    }
    fn decision(mode: AllocationMode, b: u128, s: u128) -> DisputeDecision {
        DisputeDecision {
            mode,
            buyer_amount: b,
            supplier_amount: s,
            source_id: 77,
        }
    }

    /// Asserts the transition fails with `err` and leaves the line unchanged.
    fn rejects<T: std::fmt::Debug>(
        l: &mut LineStateV1,
        err: LineError,
        f: impl FnOnce(&mut LineStateV1) -> Result<T, LineError>,
    ) {
        let before = *l;
        let r = f(l);
        assert_eq!(r.err(), Some(err));
        assert_eq!(*l, before, "line unchanged after rejection");
    }

    fn ws(expected: LineStatus, found: LineStatus) -> LineError {
        LineError::WrongState { expected, found }
    }

    // ---- funding ----------------------------------------------------------

    #[test]
    fn fund_exact_once() {
        let mut l = LineStateV1::new();
        assert_eq!(l.check_invariants(P), Ok(()));
        rejects(&mut l, LineError::AmountMismatch, |l| l.fund(P, 299, T));
        rejects(&mut l, LineError::AmountMismatch, |l| l.fund(P, 301, T));
        rejects(&mut l, LineError::AmountMismatch, |l| l.fund(P, 0, T));
        rejects(&mut l, LineError::AmountMismatch, |l| {
            l.fund(P, u128::MAX, T)
        });
        l.fund(P, 300, T).expect("exact");
        assert_eq!(l.status, LineStatus::Funded);
        assert_eq!(l.ledger.locked, 300);
        assert_eq!(l.funded_at_ns, T);
        // Second deposit on the same line (T033 pure part).
        rejects(&mut l, ws(LineStatus::Unfunded, LineStatus::Funded), |l| {
            l.fund(P, 300, T)
        });
    }

    #[test]
    fn fund_u128_max_principal() {
        let p = LineParams {
            principal: u128::MAX,
            fallback_supplier_bps: 3_333,
            ..P
        };
        let mut l = LineStateV1::new();
        l.fund(p, u128::MAX, T).expect("max");
        assert_eq!(l.ledger.locked, u128::MAX);
        assert_eq!(l.check_invariants(p), Ok(()));
    }

    // ---- prerequisites ------------------------------------------------------

    #[test]
    fn transitions_require_their_state() {
        let mut u = LineStateV1::new();
        rejects(&mut u, ws(LineStatus::Funded, LineStatus::Unfunded), |l| {
            l.submit_delivery(P, C, T)
        });
        rejects(
            &mut u,
            ws(LineStatus::Submitted, LineStatus::Unfunded),
            |l| l.accept_line(P, T),
        );
        rejects(
            &mut u,
            ws(LineStatus::Submitted, LineStatus::Unfunded),
            |l| l.open_dispute(P, T),
        );
        rejects(
            &mut u,
            ws(LineStatus::Disputed, LineStatus::Unfunded),
            |l| l.finalize_dispute(P, decision(AllocationMode::Mutual, 150, 150), T),
        );
        rejects(
            &mut u,
            ws(LineStatus::Allocated, LineStatus::Unfunded),
            |l| l.begin_withdrawal(P, Beneficiary::Supplier, 1, T),
        );

        let mut f = funded();
        rejects(&mut f, ws(LineStatus::Submitted, LineStatus::Funded), |l| {
            l.accept_line(P, T)
        });
        rejects(&mut f, ws(LineStatus::Submitted, LineStatus::Funded), |l| {
            l.open_dispute(P, T)
        });
        rejects(&mut f, ws(LineStatus::Disputed, LineStatus::Funded), |l| {
            l.finalize_dispute(P, decision(AllocationMode::Mutual, 150, 150), T)
        });

        let mut s = submitted();
        rejects(&mut s, ws(LineStatus::Funded, LineStatus::Submitted), |l| {
            l.submit_delivery(P, C, T)
        });
        rejects(
            &mut s,
            ws(LineStatus::Disputed, LineStatus::Submitted),
            |l| l.finalize_dispute(P, decision(AllocationMode::Mutual, 150, 150), T),
        );
        rejects(
            &mut s,
            ws(LineStatus::Allocated, LineStatus::Submitted),
            |l| l.begin_withdrawal(P, Beneficiary::Supplier, 1, T),
        );

        let mut d = disputed();
        rejects(
            &mut d,
            ws(LineStatus::Submitted, LineStatus::Disputed),
            |l| l.accept_line(P, T),
        );
        rejects(
            &mut d,
            ws(LineStatus::Submitted, LineStatus::Disputed),
            |l| l.open_dispute(P, T),
        );
    }

    #[test]
    fn submit_requires_nonzero_commitment() {
        let mut l = funded();
        rejects(&mut l, LineError::ZeroCommitment, |l| {
            l.submit_delivery(P, [0; 32], T)
        });
        l.submit_delivery(P, C, T + 5).expect("ok");
        assert_eq!((l.evidence_commitment, l.submitted_at_ns), (C, T + 5));
    }

    // ---- T009 accept ----------------------------------------------------------

    #[test]
    fn t009_accept_moves_locked_to_supplier_claimable_only() {
        let mut l = submitted();
        l.accept_line(P, T + 9).expect("accept");
        assert_eq!(l.status, LineStatus::Allocated);
        assert_eq!(l.ledger.locked, 0);
        assert_eq!(l.ledger.supplier_claimable, 300);
        assert_eq!(l.ledger.buyer_claimable, 0, "zero buyer leg not moved");
        assert_eq!(l.allocation.mode, AllocationMode::BuyerAccepted);
        assert_eq!(
            (l.allocation.buyer_amount, l.allocation.supplier_amount),
            (0, 300)
        );
        assert_eq!(l.allocation.finalized_at_ns, T + 9);
    }

    #[test]
    fn t022_dispute_an_accepted_line_rejected() {
        let mut l = submitted();
        // submitted() submits at T + 1; acting at T would precede submission
        // (S5b correctly rejects that as BeforeWindowStart).
        l.accept_line(P, T + 1).expect("accept");
        rejects(
            &mut l,
            ws(LineStatus::Submitted, LineStatus::Allocated),
            |l| l.open_dispute(P, T),
        );
        rejects(
            &mut l,
            ws(LineStatus::Submitted, LineStatus::Allocated),
            |l| l.accept_line(P, T),
        );
        rejects(&mut l, LineError::AlreadyFinalized, |l| {
            l.finalize_dispute(P, decision(AllocationMode::Mutual, 300, 0), T)
        });
    }

    // ---- T010 / T023 / T024 / T025 dispute finalization -------------------------

    #[test]
    fn t010_mutual_split_sums_to_principal() {
        let mut l = disputed();
        assert_eq!(
            (l.dispute_reason, l.dispute_t0_ns),
            (DisputeReason::BuyerDispute, T + 2)
        );
        // LF-007: via an accepted proposal (finalize_dispute rejects Mutual).
        let id = mutual(&mut l, P, 120, 180, T + 3);
        assert_eq!(
            (l.ledger.buyer_claimable, l.ledger.supplier_claimable),
            (120, 180)
        );
        assert_eq!(l.ledger.buyer_claimable + l.ledger.supplier_claimable, 300);
        assert_eq!(
            (id, l.allocation.source_id),
            (1, 1),
            "accepted proposal id recorded for Mutual"
        );
        assert_eq!(l.check_invariants(P), Ok(()));
    }

    #[test]
    fn t023_t024_split_sum_below_or_above_principal_rejected() {
        for (b, s) in [
            (120, 179),
            (0, 299),
            (1, 0),
            (120, 181),
            (300, 1),
            (u128::MAX, 1),
            (u128::MAX, u128::MAX),
        ] {
            let mut l = disputed();
            rejects(&mut l, LineError::AllocationSumMismatch, |l| {
                l.finalize_dispute(P, decision(AllocationMode::PrimaryRuling, b, s), T)
            });
        }
    }

    #[test]
    fn t025_single_writer_second_finalization_rejected() {
        let mut l = disputed();
        mutual(&mut l, P, 120, 180, T + 3);
        // Same proposal again, a different proposal, a ruling, the fallback.
        for d in [
            decision(AllocationMode::Mutual, 120, 180),
            DisputeDecision {
                source_id: 78,
                ..decision(AllocationMode::Mutual, 150, 150)
            },
            decision(AllocationMode::PrimaryRuling, 0, 300),
            decision(AllocationMode::BackupRuling, 300, 0),
            decision(AllocationMode::Fallback, 180, 120),
        ] {
            rejects(&mut l, LineError::AlreadyFinalized, |l| {
                l.finalize_dispute(P, d, T + 1)
            });
        }
        assert_eq!(
            (l.ledger.buyer_claimable, l.ledger.supplier_claimable),
            (120, 180)
        );
    }

    #[test]
    fn fallback_must_equal_agreed_split() {
        // P = 300, supplier bps 4 000 → supplier 120, buyer 180.
        let mut l = disputed();
        rejects(&mut l, LineError::FallbackMismatch, |l| {
            l.finalize_dispute(P, decision(AllocationMode::Fallback, 150, 150), T)
        });
        rejects(&mut l, LineError::FallbackMismatch, |l| {
            l.finalize_dispute(P, decision(AllocationMode::Fallback, 120, 180), T)
        });
        l.finalize_dispute(P, decision(AllocationMode::Fallback, 180, 120), T)
            .expect("fallback");
        assert_eq!(l.allocation.source_id, 0, "source id only kept for Mutual");
        // Rounding: P = 1 001, S = 3 333 → supplier 333, buyer 668.
        let p = LineParams {
            principal: 1_001,
            fallback_supplier_bps: 3_333,
            ..P
        };
        let mut l = LineStateV1::new();
        l.fund(p, 1_001, T).expect("f");
        l.submit_delivery(p, C, T).expect("s");
        l.open_dispute(p, T).expect("d");
        rejects(&mut l, LineError::FallbackMismatch, |l| {
            l.finalize_dispute(p, decision(AllocationMode::Fallback, 667, 334), T)
        });
        l.finalize_dispute(p, decision(AllocationMode::Fallback, 668, 333), T)
            .expect("exact");
    }

    #[test]
    fn invalid_decision_modes_rejected() {
        for m in [AllocationMode::None, AllocationMode::BuyerAccepted] {
            let mut l = disputed();
            rejects(&mut l, LineError::InvalidDecisionMode, |l| {
                l.finalize_dispute(P, decision(m, 0, 300), T)
            });
        }
    }

    #[test]
    fn zero_value_beneficiary_splits_supported() {
        // Founder S5 item 7: valid splits with a zero leg, no zero moves.
        for (mode, b, s, bps) in [
            (AllocationMode::Mutual, 0, 300, 4_000),
            (AllocationMode::PrimaryRuling, 300, 0, 4_000),
            (AllocationMode::Fallback, 0, 300, 10_000),
            (AllocationMode::Fallback, 300, 0, 0),
        ] {
            let p = LineParams {
                principal: 300,
                fallback_supplier_bps: bps,
                ..P
            };
            let mut l = LineStateV1::new();
            l.fund(p, 300, T).expect("f");
            l.submit_delivery(p, C, T).expect("s");
            l.open_dispute(p, T).expect("d");
            if mode == AllocationMode::Mutual {
                mutual(&mut l, p, b, s, T);
            } else {
                l.finalize_dispute(p, decision(mode, b, s), T)
                    .expect("zero leg");
            }
            assert_eq!(
                (l.ledger.buyer_claimable, l.ledger.supplier_claimable),
                (b, s)
            );
            // The zero-value beneficiary has nothing to withdraw.
            let zero_side = if b == 0 {
                Beneficiary::Buyer
            } else {
                Beneficiary::Supplier
            };
            rejects(&mut l, LineError::NothingToWithdraw, |l| {
                l.begin_withdrawal(p, zero_side, 1, T)
            });
            assert_eq!(l.slot(zero_side).state, SlotState::Empty);
            assert_eq!(l.check_invariants(p), Ok(()));
        }
    }

    // ---- withdrawals -------------------------------------------------------------

    fn allocated_120_180() -> LineStateV1 {
        let mut l = disputed();
        mutual(&mut l, P, 120, 180, T + 3);
        l
    }

    #[test]
    fn withdrawal_success_path() {
        let mut l = allocated_120_180();
        let t = l
            .begin_withdrawal(P, Beneficiary::Supplier, 10, T + 1)
            .expect("begin");
        assert_eq!(
            t,
            WithdrawalTicket {
                beneficiary: Beneficiary::Supplier,
                withdrawal_id: 10,
                epoch: 1,
                amount: 180
            }
        );
        assert_eq!(
            (l.ledger.supplier_claimable, l.ledger.supplier_pending),
            (0, 180)
        );
        assert_eq!(l.supplier_withdrawal.state, SlotState::Pending);
        l.resolve_withdrawal(
            P,
            Beneficiary::Supplier,
            10,
            1,
            WithdrawalOutcome::Success,
            T + 2,
        )
        .expect("paid");
        assert_eq!(
            (l.ledger.supplier_pending, l.ledger.supplier_paid),
            (0, 180)
        );
        assert_eq!(l.supplier_withdrawal.state, SlotState::Paid);
        assert_eq!(l.supplier_withdrawal.resolved_at_ns, T + 2);
        // Paid is immutable: nothing left to withdraw, callbacks have no effect.
        rejects(&mut l, LineError::NothingToWithdraw, |l| {
            l.begin_withdrawal(P, Beneficiary::Supplier, 11, T)
        });
        for o in [
            WithdrawalOutcome::Success,
            WithdrawalOutcome::DefiniteFailure,
        ] {
            rejects(&mut l, LineError::WithdrawalNotPending, |l| {
                l.resolve_withdrawal(P, Beneficiary::Supplier, 10, 1, o, T)
            });
        }
        assert_eq!(l.ledger.supplier_paid, 180);
        // The buyer's claim is untouched and independent.
        assert_eq!(l.ledger.buyer_claimable, 120);
        assert_eq!(l.buyer_withdrawal.state, SlotState::Empty);
    }

    #[test]
    fn definite_failure_restores_once_then_new_withdrawal() {
        let mut l = allocated_120_180();
        l.begin_withdrawal(P, Beneficiary::Buyer, 5, T)
            .expect("begin");
        l.resolve_withdrawal(
            P,
            Beneficiary::Buyer,
            5,
            1,
            WithdrawalOutcome::DefiniteFailure,
            T + 1,
        )
        .expect("fail");
        assert_eq!((l.ledger.buyer_claimable, l.ledger.buyer_pending), (120, 0));
        assert_eq!(l.buyer_withdrawal.state, SlotState::Failed);
        // Restored exactly once: replaying the failure has no effect.
        rejects(&mut l, LineError::WithdrawalNotPending, |l| {
            l.resolve_withdrawal(
                P,
                Beneficiary::Buyer,
                5,
                1,
                WithdrawalOutcome::DefiniteFailure,
                T,
            )
        });
        assert_eq!(l.ledger.buyer_claimable, 120);
        // A new withdrawal needs a strictly larger id and gets epoch 2.
        for stale in [5u64, 4, 0] {
            rejects(&mut l, LineError::NonMonotonicWithdrawalId, |l| {
                l.begin_withdrawal(P, Beneficiary::Buyer, stale, T)
            });
        }
        let t = l
            .begin_withdrawal(P, Beneficiary::Buyer, 6, T + 2)
            .expect("second");
        assert_eq!((t.withdrawal_id, t.epoch, t.amount), (6, 2, 120));
        // The stale callback for withdrawal 5 / epoch 1 cannot touch withdrawal 6.
        rejects(&mut l, LineError::WithdrawalIdMismatch, |l| {
            l.resolve_withdrawal(P, Beneficiary::Buyer, 5, 1, WithdrawalOutcome::Success, T)
        });
        rejects(&mut l, LineError::WithdrawalIdMismatch, |l| {
            l.resolve_withdrawal(P, Beneficiary::Buyer, 6, 1, WithdrawalOutcome::Success, T)
        });
        l.resolve_withdrawal(
            P,
            Beneficiary::Buyer,
            6,
            2,
            WithdrawalOutcome::Success,
            T + 3,
        )
        .expect("paid");
        assert_eq!(l.ledger.buyer_paid, 120);
    }

    #[test]
    fn one_open_withdrawal_per_beneficiary_and_no_cross_resolution() {
        let mut l = allocated_120_180();
        l.begin_withdrawal(P, Beneficiary::Buyer, 1, T)
            .expect("buyer");
        // Second withdrawal while pending (T042 pure part).
        rejects(&mut l, LineError::WithdrawalAlreadyPending, |l| {
            l.begin_withdrawal(P, Beneficiary::Buyer, 2, T)
        });
        // The other beneficiary is independent (T041 pure part).
        l.begin_withdrawal(P, Beneficiary::Supplier, 2, T)
            .expect("supplier");
        // A callback addressed to the wrong beneficiary does not match.
        rejects(&mut l, LineError::WithdrawalIdMismatch, |l| {
            l.resolve_withdrawal(
                P,
                Beneficiary::Supplier,
                1,
                1,
                WithdrawalOutcome::Success,
                T,
            )
        });
        // Forged ids / epochs.
        for (id, ep) in [(9u64, 1u32), (1, 0), (1, 2), (0, 0), (u64::MAX, u32::MAX)] {
            rejects(&mut l, LineError::WithdrawalIdMismatch, |l| {
                l.resolve_withdrawal(P, Beneficiary::Buyer, id, ep, WithdrawalOutcome::Success, T)
            });
        }
        assert_eq!(
            (l.ledger.buyer_pending, l.ledger.supplier_pending),
            (120, 180)
        );
        assert_eq!(l.check_invariants(P), Ok(()));
    }

    #[test]
    fn inconclusive_withdrawal_stays_pending_with_no_state_changing_path() {
        // The callback never completed: resolve_withdrawal is never called.
        let mut l = allocated_120_180();
        l.begin_withdrawal(P, Beneficiary::Supplier, 3, T)
            .expect("begin");
        let frozen = l;
        // No retry, no second withdrawal of that amount, no other transition.
        rejects(&mut l, LineError::WithdrawalAlreadyPending, |l| {
            l.begin_withdrawal(P, Beneficiary::Supplier, 4, T + 1_000)
        });
        rejects(&mut l, LineError::AlreadyFinalized, |l| {
            l.finalize_dispute(P, decision(AllocationMode::Mutual, 300, 0), T)
        });
        rejects(
            &mut l,
            ws(LineStatus::Submitted, LineStatus::Allocated),
            |l| l.open_dispute(P, T),
        );
        rejects(
            &mut l,
            ws(LineStatus::Unfunded, LineStatus::Allocated),
            |l| l.fund(P, 300, T),
        );
        assert_eq!(l, frozen);
        assert_eq!(l.supplier_withdrawal.state, SlotState::Pending);
        assert_eq!(l.supplier_withdrawal.amount, 180);
        assert_eq!(
            l.ledger.supplier_pending, 180,
            "amount still counted in the invariant"
        );
        assert_eq!(l.ledger.check_conservation(300), Ok(()));
        // The other beneficiary can still withdraw.
        l.begin_withdrawal(P, Beneficiary::Buyer, 5, T)
            .expect("buyer unaffected");
    }

    #[test]
    fn epoch_overflow_rejected() {
        let mut l = allocated_120_180();
        l.buyer_withdrawal = WithdrawalSlotV1 {
            state: SlotState::Failed,
            epoch: u32::MAX,
            withdrawal_id: 1,
            ..WithdrawalSlotV1::EMPTY
        };
        rejects(&mut l, LineError::EpochOverflow, |l| {
            l.begin_withdrawal(P, Beneficiary::Buyer, 2, T)
        });
    }

    // ---- invariants and storage ------------------------------------------------------

    #[test]
    fn corrupted_states_detected_by_invariants() {
        let mut a = funded();
        a.ledger.locked = 299;
        a.ledger.buyer_claimable = 1;
        assert!(matches!(
            a.check_invariants(P),
            Err(LineError::InvariantViolated(_))
        ));
        let mut b = allocated_120_180();
        b.ledger.buyer_pending = 1;
        b.ledger.buyer_claimable = 119;
        assert!(matches!(
            b.check_invariants(P),
            Err(LineError::InvariantViolated(_))
        ));
        let mut c = LineStateV1::new();
        c.ledger.locked = 1;
        assert!(matches!(
            c.check_invariants(P),
            Err(LineError::InvariantViolated(_))
        ));
        let mut d = allocated_120_180();
        d.allocation.supplier_amount = 181;
        assert!(matches!(
            d.check_invariants(P),
            Err(LineError::InvariantViolated(_))
        ));
        // A transition on a corrupted line is refused and leaves it unchanged.
        let mut e = allocated_120_180();
        e.ledger.supplier_paid = 1;
        e.ledger.supplier_claimable = 179;
        let before = e;
        let r = e.begin_withdrawal(P, Beneficiary::Buyer, 1, T);
        assert!(matches!(r, Err(LineError::InvariantViolated(_))), "{r:?}");
        assert_eq!(e, before);
    }

    #[test]
    fn borsh_size_is_identical_in_every_state() {
        let size = |l: &LineStateV1| near_sdk::borsh::to_vec(l).expect("enc").len();
        let mut states = vec![
            LineStateV1::new(),
            funded(),
            submitted(),
            disputed(),
            allocated_120_180(),
        ];
        let mut w = allocated_120_180();
        w.begin_withdrawal(P, Beneficiary::Buyer, 1, T).expect("b");
        states.push(w);
        w.resolve_withdrawal(
            P,
            Beneficiary::Buyer,
            1,
            1,
            WithdrawalOutcome::DefiniteFailure,
            T,
        )
        .expect("f");
        states.push(w);
        w.begin_withdrawal(P, Beneficiary::Buyer, 2, T).expect("b2");
        w.resolve_withdrawal(P, Beneficiary::Buyer, 2, 2, WithdrawalOutcome::Success, T)
            .expect("p");
        states.push(w);
        let sizes: Vec<_> = states.iter().map(size).collect();
        assert!(sizes.iter().all(|&s| s == sizes[0]), "{sizes:?}");
        assert_eq!(sizes[0], LINE_STATE_BORSH_BYTES);
    }

    // ---- M1 S5b: deadline predicates in the transitions ----------------------
    // P: funding 10 000, delivery 20 000, grace 0, review 5 000; T = 1 000.

    fn dl(d: Deadline) -> LineError {
        LineError::DeadlinePassed(d)
    }

    #[test]
    fn fund_rejected_at_and_after_funding_deadline() {
        for now in [10_000u64, 10_001, u64::MAX] {
            let mut l = LineStateV1::new();
            rejects(&mut l, dl(Deadline::Funding), |l| l.fund(P, 300, now));
        }
        let mut l = LineStateV1::new();
        l.fund(P, 300, 9_999)
            .expect("one ns before the funding deadline");
        assert_eq!(l.funded_at_ns, 9_999);
    }

    #[test]
    fn t053_t054_submit_boundary_with_hashed_grace() {
        for grace in [0u64, 1, 3_000] {
            let p = LineParams {
                delivery_grace_ns: grace,
                ..P
            };
            let cutoff = 20_000 + grace;
            // T053: deadline + grace − 1 ns → accepted.
            let mut l = LineStateV1::new();
            l.fund(p, 300, T).expect("fund");
            assert_eq!(l.non_delivery_t0(p, cutoff - 1), Ok(None));
            l.submit_delivery(p, C, cutoff - 1).expect("T053");
            assert_eq!(l.status, LineStatus::Submitted);
            // T054: exactly deadline + grace (and +1) → rejected; NON_DELIVERY
            // eligible with T0 = deadline + grace.
            for now in [cutoff, cutoff + 1] {
                let mut l = LineStateV1::new();
                l.fund(p, 300, T).expect("fund");
                rejects(&mut l, dl(Deadline::Submission), |l| {
                    l.submit_delivery(p, C, now)
                });
                assert_eq!(l.non_delivery_t0(p, now), Ok(Some(cutoff)), "grace {grace}");
            }
        }
    }

    #[test]
    fn t021_dispute_inside_review_rejected_at_review_end() {
        let s_at = T + 1; // submitted() submits at T + 1
        let end = s_at + 5_000;
        for now in [s_at, s_at + 1, end - 1] {
            let mut l = submitted();
            l.open_dispute(P, now).expect("inside review");
            assert_eq!(l.status, LineStatus::Disputed);
            assert_eq!(l.ledger.locked, 300, "disputed line stays locked");
            assert_eq!(l.dispute_t0_ns, now, "buyer dispute T0 = dispute time");
        }
        for now in [end, end + 1, u64::MAX] {
            let mut l = submitted();
            rejects(&mut l, dl(Deadline::Review), |l| l.open_dispute(P, now));
            assert_eq!(l.no_response_t0(P, now), Ok(Some(end)));
        }
        let mut l = submitted();
        rejects(&mut l, LineError::BeforeWindowStart, |l| {
            l.open_dispute(P, s_at - 1)
        });
    }

    #[test]
    fn accept_line_rejected_at_review_end() {
        let s_at = T + 1;
        let end = s_at + 5_000;
        let mut l = submitted();
        l.accept_line(P, end - 1).expect("one ns before review end");
        assert_eq!(l.ledger.supplier_claimable, 300);
        for now in [end, end + 1] {
            let mut l = submitted();
            rejects(&mut l, dl(Deadline::Review), |l| l.accept_line(P, now));
        }
        let mut l = submitted();
        rejects(&mut l, LineError::BeforeWindowStart, |l| {
            l.accept_line(P, s_at - 1)
        });
        l.accept_line(P, s_at).expect("review start is inclusive");
    }

    #[test]
    fn non_delivery_t0_only_for_funded_line() {
        let cutoff = 20_000;
        let late = [cutoff, cutoff + 10 * 24 * 3_600_000_000_000, u64::MAX];
        let u = LineStateV1::new();
        for now in late {
            assert_eq!(u.non_delivery_t0(P, now), Ok(None), "unfunded");
        }
        let f = funded();
        assert_eq!(f.non_delivery_t0(P, cutoff - 1), Ok(None));
        for now in late {
            assert_eq!(
                f.non_delivery_t0(P, now),
                Ok(Some(cutoff)),
                "T0 fixed when queried late"
            );
        }
        for l in [submitted(), disputed(), allocated_120_180()] {
            for now in late {
                assert_eq!(l.non_delivery_t0(P, now), Ok(None), "{:?}", l.status);
            }
        }
    }

    #[test]
    fn no_response_t0_only_for_submitted_line() {
        let end = T + 1 + 5_000;
        let late = [end, end + 10 * 24 * 3_600_000_000_000, u64::MAX];
        let s = submitted();
        assert_eq!(s.no_response_t0(P, end - 1), Ok(None));
        for now in late {
            assert_eq!(
                s.no_response_t0(P, now),
                Ok(Some(end)),
                "T0 fixed when queried late"
            );
        }
        let mut accepted = submitted();
        accepted.accept_line(P, end - 1).expect("accept");
        for l in [LineStateV1::new(), funded(), disputed(), accepted] {
            for now in late {
                assert_eq!(l.no_response_t0(P, now), Ok(None), "{:?}", l.status);
            }
        }
    }

    #[test]
    fn deadline_check_order_state_then_time_then_amount() {
        // State before time.
        let mut f = funded();
        rejects(&mut f, ws(LineStatus::Unfunded, LineStatus::Funded), |l| {
            l.fund(P, 300, u64::MAX)
        });
        // Time before amount.
        let mut u = LineStateV1::new();
        rejects(&mut u, dl(Deadline::Funding), |l| l.fund(P, 1, 10_000));
        // Time before commitment content.
        let mut f = funded();
        rejects(&mut f, dl(Deadline::Submission), |l| {
            l.submit_delivery(P, [0; 32], 20_000)
        });
        rejects(&mut f, LineError::ZeroCommitment, |l| {
            l.submit_delivery(P, [0; 32], 19_999)
        });
    }

    #[test]
    fn near_u64_max_line_deadlines() {
        let m = u64::MAX;
        let p = LineParams {
            funding_deadline_ns: m - 10_000,
            delivery_deadline_ns: m - 6_000,
            delivery_grace_ns: 1_000,
            review_window_ns: 5_000,
            ..P
        };
        let cutoff = m - 5_000;
        // Funding −1 / 0 / +1.
        let mut l = LineStateV1::new();
        rejects(&mut l, dl(Deadline::Funding), |l| {
            l.fund(p, 300, m - 10_000)
        });
        rejects(&mut l, dl(Deadline::Funding), |l| l.fund(p, 300, m - 9_999));
        l.fund(p, 300, m - 10_001).expect("fund");
        // Submission −1 / 0 / +1 at a cutoff 5 000 ns below u64::MAX.
        let base = l;
        for now in [cutoff, cutoff + 1] {
            let mut x = base;
            rejects(&mut x, dl(Deadline::Submission), |l| {
                l.submit_delivery(p, C, now)
            });
            assert_eq!(x.non_delivery_t0(p, now), Ok(Some(cutoff)));
        }
        l.submit_delivery(p, C, cutoff - 1).expect("submit");
        // Review ends exactly at u64::MAX − 1.
        let end = cutoff - 1 + 5_000;
        assert_eq!(end, m - 1);
        let mut x = l;
        x.open_dispute(p, end - 1)
            .expect("dispute one ns before end");
        for now in [end, m] {
            let mut x = l;
            rejects(&mut x, dl(Deadline::Review), |l| l.open_dispute(p, now));
            assert_eq!(x.no_response_t0(p, now), Ok(Some(end)));
        }
        // Defensive: parameters that validation would reject overflow safely.
        let bad = LineParams {
            delivery_deadline_ns: m,
            delivery_grace_ns: 1,
            ..p
        };
        let mut y = base;
        rejects(&mut y, LineError::DeadlineOverflow, |l| {
            l.submit_delivery(bad, C, 0)
        });
        assert_eq!(y.non_delivery_t0(bad, m), Err(LineError::DeadlineOverflow));
        let mut z = l;
        z.submitted_at_ns = m;
        rejects(&mut z, LineError::DeadlineOverflow, |l| l.accept_line(p, m));
    }

    // ---- LF-006b advance_case (pure) ----------------------------------------
    // P: delivery 20 000, grace 0, review 5 000; submitted() submits at T + 1.

    #[test]
    fn lf006b_no_response_boundaries() {
        let t0 = T + 1 + 5_000;
        let mut l = submitted();
        rejects(&mut l, LineError::NotEligible, |l| {
            l.advance_case(P, t0 - 1)
        });
        for now in [t0, t0 + 1] {
            let mut l = submitted();
            assert_eq!(l.advance_case(P, now), Ok(DisputeReason::NoResponse));
            assert_eq!(
                (l.status, l.dispute_reason, l.dispute_t0_ns),
                (LineStatus::Disputed, DisputeReason::NoResponse, t0)
            );
        }
    }

    #[test]
    fn lf006b_non_delivery_boundaries() {
        for grace in [0u64, 3_000] {
            let p = LineParams {
                delivery_grace_ns: grace,
                ..P
            };
            let t0 = 20_000 + grace;
            let mut base = LineStateV1::new();
            base.fund(p, 300, T).expect("fund");
            let mut l = base;
            rejects(&mut l, LineError::NotEligible, |l| {
                l.advance_case(p, t0 - 1)
            });
            for now in [t0, t0 + 1] {
                let mut l = base;
                assert_eq!(l.advance_case(p, now), Ok(DisputeReason::NonDelivery));
                assert_eq!(
                    (l.dispute_reason, l.dispute_t0_ns),
                    (DisputeReason::NonDelivery, t0),
                    "grace {grace}"
                );
            }
        }
    }

    #[test]
    fn lf006b_late_call_keeps_fixed_t0() {
        let t0 = T + 1 + 5_000;
        for late in [t0 + 10 * 24 * 3_600_000_000_000, u64::MAX] {
            let mut l = submitted();
            l.advance_case(P, late).expect("late advance");
            assert_eq!(
                l.dispute_t0_ns, t0,
                "T0 is the review deadline, not the call time"
            );
            let mut f = funded();
            f.advance_case(P, late).expect("late advance");
            assert_eq!(f.dispute_t0_ns, 20_000);
        }
    }

    #[test]
    fn lf006b_rejects_non_advanceable_states() {
        let late = u64::MAX;
        let mut u = LineStateV1::new();
        rejects(&mut u, LineError::NotAdvanceable, |l| {
            l.advance_case(P, late)
        });
        let mut d = disputed();
        rejects(&mut d, LineError::NotAdvanceable, |l| {
            l.advance_case(P, late)
        });
        let mut a = allocated_120_180();
        rejects(&mut a, LineError::NotAdvanceable, |l| {
            l.advance_case(P, late)
        });
    }

    #[test]
    fn lf006b_replay_rejected() {
        let mut l = submitted();
        l.advance_case(P, u64::MAX).expect("first");
        rejects(&mut l, LineError::NotAdvanceable, |l| {
            l.advance_case(P, u64::MAX)
        });
        let mut f = funded();
        f.advance_case(P, 20_000).expect("first");
        rejects(&mut f, LineError::NotAdvanceable, |l| {
            l.advance_case(P, 20_001)
        });
    }

    #[test]
    fn lf006b_funds_allocation_slots_unchanged() {
        for mut l in [submitted(), funded()] {
            let before = l;
            l.advance_case(P, u64::MAX).expect("advance");
            assert_eq!(l.ledger, before.ledger, "no ledger move");
            assert_eq!(l.ledger.locked, 300);
            assert_eq!(l.allocation, before.allocation, "no allocation");
            assert_eq!(
                (l.buyer_withdrawal, l.supplier_withdrawal),
                (before.buyer_withdrawal, before.supplier_withdrawal)
            );
            assert_eq!(
                (l.funded_at_ns, l.submitted_at_ns, l.evidence_commitment),
                (
                    before.funded_at_ns,
                    before.submitted_at_ns,
                    before.evidence_commitment
                )
            );
            assert_eq!(l.check_invariants(P), Ok(()));
        }
    }

    #[test]
    fn lf006b_buyer_window_and_advance_do_not_overlap() {
        let end = T + 1 + 5_000;
        // Buyer acts at end − 1: advance afterwards is not possible.
        let mut l = submitted();
        l.open_dispute(P, end - 1).expect("buyer dispute");
        rejects(&mut l, LineError::NotAdvanceable, |l| {
            l.advance_case(P, end)
        });
        assert_eq!(l.dispute_reason, DisputeReason::BuyerDispute);
        let mut l = submitted();
        l.accept_line(P, end - 1).expect("buyer accept");
        rejects(&mut l, LineError::NotAdvanceable, |l| {
            l.advance_case(P, end)
        });
        // Advance at end: the buyer can no longer accept or dispute.
        let mut l = submitted();
        l.advance_case(P, end).expect("advance at end");
        rejects(
            &mut l,
            ws(LineStatus::Submitted, LineStatus::Disputed),
            |l| l.accept_line(P, end),
        );
        rejects(
            &mut l,
            ws(LineStatus::Submitted, LineStatus::Disputed),
            |l| l.open_dispute(P, end),
        );
        // Submission window closed ⇒ no late submission on a NON_DELIVERY line.
        let mut f = funded();
        f.advance_case(P, 20_000).expect("non-delivery");
        rejects(&mut f, ws(LineStatus::Funded, LineStatus::Disputed), |l| {
            l.submit_delivery(P, C, 20_000)
        });
    }

    #[test]
    fn lf006b_overflow_guard() {
        let bad = LineParams {
            delivery_deadline_ns: u64::MAX,
            delivery_grace_ns: 1,
            ..P
        };
        let mut f = funded();
        rejects(&mut f, LineError::DeadlineOverflow, |l| {
            l.advance_case(bad, u64::MAX)
        });
        let mut s = submitted();
        s.submitted_at_ns = u64::MAX;
        rejects(&mut s, LineError::DeadlineOverflow, |l| {
            l.advance_case(P, u64::MAX)
        });
    }

    // ---- LF-007 mutual settlement ----------------------------------------------

    const T0: u64 = T + 2; // disputed(): buyer dispute at T + 2
    const HOUR: u64 = 3_600_000_000_000;

    #[test]
    fn lf007_propose_requires_disputed() {
        for mut l in [LineStateV1::new(), funded(), submitted()] {
            let found = l.status;
            rejects(
                &mut l,
                LineError::WrongState {
                    expected: LineStatus::Disputed,
                    found,
                },
                |l| l.propose_split(P, Proposer::Buyer, 150, 150, T0),
            );
        }
        let mut a = allocated_120_180();
        rejects(&mut a, LineError::AlreadyFinalized, |l| {
            l.propose_split(P, Proposer::Supplier, 150, 150, T0 + 9)
        });
    }

    #[test]
    fn lf007_propose_sum_must_equal_principal() {
        for (b, s) in [
            (150, 149),
            (150, 151),
            (0, 0),
            (300, 1),
            (u128::MAX, 1),
            (u128::MAX, u128::MAX),
        ] {
            let mut l = disputed();
            rejects(&mut l, LineError::AllocationSumMismatch, |l| {
                l.propose_split(P, Proposer::Buyer, b, s, T0)
            });
        }
        let mut l = disputed();
        rejects(&mut l, LineError::InvalidDecisionMode, |l| {
            l.propose_split(P, Proposer::None, 150, 150, T0)
        });
    }

    #[test]
    fn lf007_ids_monotonic_and_supersede() {
        let mut l = disputed();
        let a = l
            .propose_split(P, Proposer::Buyer, 200, 100, T0)
            .expect("a");
        let b = l
            .propose_split(P, Proposer::Supplier, 100, 200, T0 + 1)
            .expect("b");
        let c = l
            .propose_split(P, Proposer::Buyer, 150, 150, T0 + 2)
            .expect("c");
        assert_eq!((a, b, c), (1, 2, 3));
        assert_eq!(
            l.proposal,
            SplitProposalV1 {
                status: ProposalStatus::Open,
                proposer: Proposer::Buyer,
                proposal_id: 3,
                buyer_amount: 150,
                supplier_amount: 150,
                created_at_ns: T0 + 2,
            }
        );
        // Superseded ids are stale even with their own amounts.
        rejects(&mut l, LineError::StaleProposal, |l| {
            l.accept_split(P, Proposer::Supplier, 1, 200, 100, T0 + 3)
        });
        rejects(&mut l, LineError::StaleProposal, |l| {
            l.accept_split(P, Proposer::Buyer, 2, 100, 200, T0 + 3)
        });
        // No ledger movement while proposing.
        assert_eq!(l.ledger.locked, 300);
        assert_eq!(l.status, LineStatus::Disputed);
        assert_eq!(l.allocation, AllocationRecordV1::EMPTY);
    }

    #[test]
    fn lf007_accept_exact_id_and_amounts() {
        let mut l = disputed();
        rejects(&mut l, LineError::NoActiveProposal, |l| {
            l.accept_split(P, Proposer::Supplier, 1, 150, 150, T0)
        });
        let id = l
            .propose_split(P, Proposer::Buyer, 120, 180, T0)
            .expect("p");
        for (pid, b, s, err) in [
            (0, 120, 180, LineError::StaleProposal),
            (id + 1, 120, 180, LineError::StaleProposal),
            (u64::MAX, 120, 180, LineError::StaleProposal),
            (id, 121, 180, LineError::ProposalMismatch),
            (id, 120, 179, LineError::ProposalMismatch),
            (id, 180, 120, LineError::ProposalMismatch),
        ] {
            rejects(&mut l, err, |l| {
                l.accept_split(P, Proposer::Supplier, pid, b, s, T0)
            });
        }
        l.accept_split(P, Proposer::Supplier, id, 120, 180, T0 + 5)
            .expect("exact accept");
        assert_eq!(
            l.allocation,
            AllocationRecordV1 {
                mode: AllocationMode::Mutual,
                buyer_amount: 120,
                supplier_amount: 180,
                source_id: id,
                finalized_at_ns: T0 + 5,
            }
        );
        assert_eq!(
            (
                l.ledger.locked,
                l.ledger.buyer_claimable,
                l.ledger.supplier_claimable
            ),
            (0, 120, 180)
        );
        // The accepted record is the proposal exactly as made (mutation M9).
        assert_eq!(
            l.proposal,
            SplitProposalV1 {
                status: ProposalStatus::Accepted,
                proposer: Proposer::Buyer,
                proposal_id: id,
                buyer_amount: 120,
                supplier_amount: 180,
                created_at_ns: T0,
            }
        );
        assert_eq!(l.status, LineStatus::Allocated);
    }

    #[test]
    fn lf007_proposer_cannot_accept_own() {
        for who in [Proposer::Buyer, Proposer::Supplier] {
            let mut l = disputed();
            let id = l.propose_split(P, who, 120, 180, T0).expect("p");
            rejects(&mut l, LineError::OwnProposal, |l| {
                l.accept_split(P, who, id, 120, 180, T0)
            });
            rejects(&mut l, LineError::InvalidDecisionMode, |l| {
                l.accept_split(P, Proposer::None, id, 120, 180, T0)
            });
            let other = if who == Proposer::Buyer {
                Proposer::Supplier
            } else {
                Proposer::Buyer
            };
            l.accept_split(P, other, id, 120, 180, T0)
                .expect("counterparty");
        }
    }

    #[test]
    fn lf007_accept_once_immutable() {
        let mut l = disputed();
        let id = mutual(&mut l, P, 120, 180, T0);
        let frozen = l;
        rejects(&mut l, LineError::AlreadyFinalized, |l| {
            l.accept_split(P, Proposer::Supplier, id, 120, 180, T0 + 1)
        });
        rejects(&mut l, LineError::AlreadyFinalized, |l| {
            l.propose_split(P, Proposer::Buyer, 300, 0, T0 + 1)
        });
        for d in [
            decision(AllocationMode::PrimaryRuling, 0, 300),
            decision(AllocationMode::BackupRuling, 300, 0),
            decision(AllocationMode::Fallback, 180, 120),
            decision(AllocationMode::Mutual, 150, 150),
        ] {
            rejects(&mut l, LineError::AlreadyFinalized, |l| {
                l.finalize_dispute(P, d, T0 + 1)
            });
        }
        assert_eq!(l, frozen);
    }

    #[test]
    fn lf007_zero_leg_splits() {
        for (b, s) in [(0, 300), (300, 0)] {
            let mut l = disputed();
            mutual(&mut l, P, b, s, T0);
            assert_eq!(
                (l.ledger.buyer_claimable, l.ledger.supplier_claimable),
                (b, s)
            );
            assert_eq!(l.check_invariants(P), Ok(()));
        }
    }

    #[test]
    fn lf007_large_values() {
        let big = LineParams {
            principal: u128::MAX,
            ..P
        };
        for (b, s) in [
            (u128::MAX - 1, 1),
            (1, u128::MAX - 1),
            (0, u128::MAX),
            (u128::MAX, 0),
        ] {
            let mut l = LineStateV1::new();
            l.fund(big, u128::MAX, T).expect("f");
            l.submit_delivery(big, C, T).expect("s");
            l.open_dispute(big, T).expect("d");
            rejects(&mut l, LineError::AllocationSumMismatch, |l| {
                l.propose_split(big, Proposer::Buyer, u128::MAX, 1, T)
            });
            let id = l
                .propose_split(big, Proposer::Supplier, b, s, T)
                .expect("p");
            l.accept_split(big, Proposer::Buyer, id, b, s, T)
                .expect("a");
            assert_eq!(l.ledger.total(), Some(u128::MAX));
            assert_eq!(
                (l.ledger.buyer_claimable, l.ledger.supplier_claimable),
                (b, s)
            );
        }
    }

    #[test]
    fn lf007_before_t0_rejected() {
        let mut l = disputed();
        rejects(&mut l, LineError::BeforeWindowStart, |l| {
            l.propose_split(P, Proposer::Buyer, 150, 150, T0 - 1)
        });
        let id = l
            .propose_split(P, Proposer::Buyer, 150, 150, T0)
            .expect("at T0");
        rejects(&mut l, LineError::BeforeWindowStart, |l| {
            l.accept_split(P, Proposer::Supplier, id, 150, 150, T0 - 1)
        });
        l.accept_split(P, Proposer::Supplier, id, 150, 150, T0)
            .expect("accept at T0");
    }

    #[test]
    fn lf007_every_phase_allowed() {
        // docs/08: mutual settlement in negotiation, primary, backup and
        // fallback phases alike (default N = 48 h, A = B = 72 h), and late.
        let (n, a, b) = (48 * HOUR, 72 * HOUR, 72 * HOUR);
        for now in [
            T0,
            T0 + n - 1,
            T0 + n,
            T0 + n + a - 1,
            T0 + n + a,
            T0 + n + a + b - 1,
            T0 + n + a + b,
            T0 + 365 * 24 * HOUR,
            u64::MAX,
        ] {
            let mut l = disputed();
            let id = l
                .propose_split(P, Proposer::Supplier, 10, 290, now)
                .expect("propose");
            l.accept_split(P, Proposer::Buyer, id, 10, 290, now)
                .expect("accept");
            assert_eq!(l.allocation.finalized_at_ns, now);
        }
    }

    #[test]
    fn lf007_nonce_overflow() {
        let mut l = disputed();
        l.propose_split(P, Proposer::Buyer, 150, 150, T0)
            .expect("p");
        l.proposal.proposal_id = u64::MAX;
        assert_eq!(l.check_invariants(P), Ok(()));
        rejects(&mut l, LineError::ProposalNonceOverflow, |l| {
            l.propose_split(P, Proposer::Supplier, 100, 200, T0)
        });
        // The u64::MAX proposal itself can still be accepted.
        l.accept_split(P, Proposer::Supplier, u64::MAX, 150, 150, T0)
            .expect("accept max id");
        assert_eq!(l.allocation.source_id, u64::MAX);
    }

    #[test]
    fn lf007_ruling_first_blocks_accept() {
        // Race (docs/08): an earlier valid final allocation wins; the open
        // proposal can no longer be accepted or superseded.
        let mut l = disputed();
        let id = l
            .propose_split(P, Proposer::Buyer, 120, 180, T0)
            .expect("p");
        l.finalize_dispute(P, decision(AllocationMode::PrimaryRuling, 0, 300), T0 + 1)
            .expect("ruling first");
        rejects(&mut l, LineError::AlreadyFinalized, |l| {
            l.accept_split(P, Proposer::Supplier, id, 120, 180, T0 + 1)
        });
        assert_eq!(l.allocation.mode, AllocationMode::PrimaryRuling);
        assert_eq!(l.proposal.status, ProposalStatus::Open);
        assert_eq!(l.check_invariants(P), Ok(()));
    }

    #[test]
    fn lf007_finalize_rejects_mutual() {
        let mut l = disputed();
        rejects(&mut l, LineError::InvalidDecisionMode, |l| {
            l.finalize_dispute(P, decision(AllocationMode::Mutual, 120, 180), T0)
        });
        // Even with an open proposal of the same amounts and id.
        let id = l
            .propose_split(P, Proposer::Buyer, 120, 180, T0)
            .expect("p");
        rejects(&mut l, LineError::InvalidDecisionMode, |l| {
            l.finalize_dispute(
                P,
                DisputeDecision {
                    source_id: id,
                    ..decision(AllocationMode::Mutual, 120, 180)
                },
                T0,
            )
        });
    }

    #[test]
    fn lf007_layout_fixed_size() {
        let size = |l: &LineStateV1| near_sdk::borsh::to_vec(l).expect("enc").len();
        let mut open = disputed();
        open.propose_split(P, Proposer::Buyer, 1, 299, T0)
            .expect("p");
        let mut big_id = open;
        big_id.proposal.proposal_id = u64::MAX;
        for l in [disputed(), open, big_id, allocated_120_180()] {
            assert_eq!(size(&l), LINE_STATE_BORSH_BYTES);
        }
        assert_eq!(
            near_sdk::borsh::to_vec(&SplitProposalV1::EMPTY)
                .expect("enc")
                .len(),
            50
        );
    }

    #[test]
    fn lf007_invariant_ties_mutual_to_proposal() {
        let good = allocated_120_180();
        assert_eq!(good.check_invariants(P), Ok(()));
        let v = Err(LineError::InvariantViolated(
            "mutual allocation differs from accepted proposal",
        ));
        let mut x = good;
        x.allocation.source_id = 2;
        assert_eq!(x.check_invariants(P), v);
        let mut x = good;
        x.proposal.status = ProposalStatus::Open;
        assert_eq!(x.check_invariants(P), v);
        let mut x = good;
        x.proposal.buyer_amount = 119;
        x.proposal.supplier_amount = 181;
        assert_eq!(x.check_invariants(P), v);
        // An accepted proposal under a non-Mutual allocation.
        let mut r = disputed();
        r.finalize_dispute(P, decision(AllocationMode::PrimaryRuling, 120, 180), T0)
            .expect("r");
        r.proposal = SplitProposalV1 {
            status: ProposalStatus::Accepted,
            proposer: Proposer::Buyer,
            proposal_id: 1,
            buyer_amount: 120,
            supplier_amount: 180,
            created_at_ns: T0,
        };
        assert_eq!(r.check_invariants(P), v);
        // A proposal record on a line that was never disputed.
        let mut f = funded();
        f.proposal = r.proposal;
        f.proposal.status = ProposalStatus::Open;
        assert_eq!(
            f.check_invariants(P),
            Err(LineError::InvariantViolated("proposal record"))
        );
        let mut e = disputed();
        e.proposal.created_at_ns = 1;
        assert_eq!(
            e.check_invariants(P),
            Err(LineError::InvariantViolated(
                "empty proposal record not zero"
            ))
        );
    }

    // ---- LF-008 timed arbitration and fallback ----------------------------------
    // P windows: N = 1 000, A = 2 000, B = 3 000; disputed(): T0 = T + 2.
    const PS: u64 = T0 + 1_000; // primary start
    const BS: u64 = PS + 2_000; // backup start
    const FS: u64 = BS + 3_000; // fallback eligible

    #[test]
    fn lf008_primary_only_in_primary_window() {
        for now in [T0, PS - 1, BS, BS + 1, FS, u64::MAX] {
            let mut l = disputed();
            rejects(&mut l, LineError::NotRulingWindow, |l| {
                l.submit_ruling(P, Arbitrator::Primary, 100, 200, now)
            });
        }
        for now in [PS, PS + 1, BS - 1] {
            let mut l = disputed();
            l.submit_ruling(P, Arbitrator::Primary, 100, 200, now)
                .expect("primary inside its window");
            assert_eq!(
                l.allocation,
                AllocationRecordV1 {
                    mode: AllocationMode::PrimaryRuling,
                    buyer_amount: 100,
                    supplier_amount: 200,
                    source_id: 0,
                    finalized_at_ns: now,
                }
            );
        }
    }

    #[test]
    fn lf008_backup_only_in_backup_window() {
        for now in [T0, PS, BS - 1, FS, FS + 1, u64::MAX] {
            let mut l = disputed();
            rejects(&mut l, LineError::NotRulingWindow, |l| {
                l.submit_ruling(P, Arbitrator::Backup, 0, 300, now)
            });
        }
        for now in [BS, BS + 1, FS - 1] {
            let mut l = disputed();
            l.submit_ruling(P, Arbitrator::Backup, 0, 300, now)
                .expect("backup inside its window");
            assert_eq!(l.allocation.mode, AllocationMode::BackupRuling);
            assert_eq!(
                (l.ledger.buyer_claimable, l.ledger.supplier_claimable),
                (0, 300)
            );
        }
    }

    #[test]
    fn lf008_fallback_only_after_longstop() {
        for now in [T0, PS, BS, FS - 1] {
            let mut l = disputed();
            rejects(&mut l, LineError::FallbackNotEligible, |l| {
                l.trigger_fallback(P, now)
            });
        }
        for now in [FS, FS + 1, u64::MAX] {
            let mut l = disputed();
            l.trigger_fallback(P, now).expect("after longstop");
            // P = 300, supplier bps 4 000: supplier floor(120) = 120, buyer 180.
            assert_eq!(
                (
                    l.allocation.mode,
                    l.ledger.buyer_claimable,
                    l.ledger.supplier_claimable
                ),
                (AllocationMode::Fallback, 180, 120)
            );
        }
    }

    #[test]
    fn lf008_fallback_rounding() {
        for (principal, bps, want) in [
            (1_001u128, 3_333u16, (668u128, 333u128)), // docs/07 example
            (1_001, 0, (1_001, 0)),
            (1_001, 10_000, (0, 1_001)),
            (1, 5_000, (1, 0)),
            (3, 3_334, (2, 1)),
        ] {
            let p = LineParams {
                principal,
                fallback_supplier_bps: bps,
                ..P
            };
            let mut l = LineStateV1::new();
            l.fund(p, principal, T).expect("f");
            l.submit_delivery(p, C, T).expect("s");
            l.open_dispute(p, T).expect("d");
            l.trigger_fallback(p, T + 6_000).expect("fallback");
            assert_eq!(
                (l.ledger.buyer_claimable, l.ledger.supplier_claimable),
                want
            );
        }
        let big = LineParams {
            principal: u128::MAX,
            fallback_supplier_bps: 3_333,
            ..P
        };
        let mut l = LineStateV1::new();
        l.fund(big, u128::MAX, T).expect("f");
        l.submit_delivery(big, C, T).expect("s");
        l.open_dispute(big, T).expect("d");
        l.trigger_fallback(big, T + 6_000)
            .expect("fallback at u128::MAX");
        let (b, s) = split_bps(u128::MAX, 3_333).expect("split");
        assert_eq!(
            (l.ledger.buyer_claimable, l.ledger.supplier_claimable),
            (b, s)
        );
        assert_eq!(b.checked_add(s), Some(u128::MAX));
    }

    #[test]
    fn lf008_ruling_sum_and_extremes() {
        for (b, s) in [
            (150, 149),
            (150, 151),
            (u128::MAX, 1),
            (u128::MAX, u128::MAX),
        ] {
            let mut l = disputed();
            rejects(&mut l, LineError::AllocationSumMismatch, |l| {
                l.submit_ruling(P, Arbitrator::Primary, b, s, PS)
            });
        }
        let big = LineParams {
            principal: u128::MAX,
            ..P
        };
        for (b, s) in [(u128::MAX - 1, 1), (0, u128::MAX), (u128::MAX, 0)] {
            let mut l = LineStateV1::new();
            l.fund(big, u128::MAX, T).expect("f");
            l.submit_delivery(big, C, T).expect("s");
            l.open_dispute(big, T).expect("d"); // T0 = T
            l.submit_ruling(big, Arbitrator::Backup, b, s, T + 3_000)
                .expect("backup at u128::MAX");
            assert_eq!(l.ledger.total(), Some(u128::MAX));
        }
    }

    #[test]
    fn lf008_wrong_state_rejected() {
        for mut l in [LineStateV1::new(), funded(), submitted()] {
            let found = l.status;
            let e = LineError::WrongState {
                expected: LineStatus::Disputed,
                found,
            };
            rejects(&mut l, e, |l| {
                l.submit_ruling(P, Arbitrator::Primary, 100, 200, PS)
            });
            rejects(&mut l, e, |l| l.trigger_fallback(P, FS));
        }
    }

    #[test]
    fn lf008_double_finalization_rejected() {
        let mut l = disputed();
        l.submit_ruling(P, Arbitrator::Primary, 100, 200, PS)
            .expect("first");
        let frozen = l;
        rejects(&mut l, LineError::AlreadyFinalized, |l| {
            l.submit_ruling(P, Arbitrator::Primary, 100, 200, PS + 1)
        });
        rejects(&mut l, LineError::AlreadyFinalized, |l| {
            l.submit_ruling(P, Arbitrator::Backup, 300, 0, BS)
        });
        rejects(&mut l, LineError::AlreadyFinalized, |l| {
            l.trigger_fallback(P, FS)
        });
        rejects(&mut l, LineError::AlreadyFinalized, |l| {
            l.propose_split(P, Proposer::Buyer, 300, 0, FS)
        });
        rejects(&mut l, LineError::AlreadyFinalized, |l| {
            l.accept_split(P, Proposer::Supplier, 1, 300, 0, FS)
        });
        assert_eq!(l, frozen, "allocation immutable");
    }

    #[test]
    fn lf008_races_both_orders() {
        // Mutual vs primary ruling, both eligible at the same chain time.
        for mutual_first in [true, false] {
            let mut l = disputed();
            let id = l
                .propose_split(P, Proposer::Buyer, 120, 180, PS)
                .expect("p");
            if mutual_first {
                l.accept_split(P, Proposer::Supplier, id, 120, 180, PS + 5)
                    .expect("mutual wins");
                rejects(&mut l, LineError::AlreadyFinalized, |l| {
                    l.submit_ruling(P, Arbitrator::Primary, 0, 300, PS + 5)
                });
                assert_eq!(l.allocation.mode, AllocationMode::Mutual);
            } else {
                l.submit_ruling(P, Arbitrator::Primary, 0, 300, PS + 5)
                    .expect("ruling wins");
                rejects(&mut l, LineError::AlreadyFinalized, |l| {
                    l.accept_split(P, Proposer::Supplier, id, 120, 180, PS + 5)
                });
                assert_eq!(l.allocation.mode, AllocationMode::PrimaryRuling);
            }
            assert_eq!(l.check_invariants(P), Ok(()));
        }
        // Mutual vs backup ruling and vs fallback, both orders.
        for (when, other) in [(BS + 1, 0u8), (FS + 1, 1u8)] {
            for mutual_first in [true, false] {
                let mut l = disputed();
                let id = l
                    .propose_split(P, Proposer::Supplier, 50, 250, when)
                    .expect("p");
                let other_call = |l: &mut LineStateV1| {
                    if other == 0 {
                        l.submit_ruling(P, Arbitrator::Backup, 300, 0, when)
                    } else {
                        l.trigger_fallback(P, when)
                    }
                };
                if mutual_first {
                    l.accept_split(P, Proposer::Buyer, id, 50, 250, when)
                        .expect("m");
                    rejects(&mut l, LineError::AlreadyFinalized, other_call);
                } else {
                    other_call(&mut l).expect("other");
                    rejects(&mut l, LineError::AlreadyFinalized, |l| {
                        l.accept_split(P, Proposer::Buyer, id, 50, 250, when)
                    });
                }
            }
        }
    }

    #[test]
    fn lf008_late_entry_each_phase() {
        // NO_RESPONSE: submitted at T + 1, review 5 000 → T0 = T + 5 001.
        // NON_DELIVERY: delivery 20 000, grace 0 → T0 = 20 000.
        let t0s = [T + 1 + 5_000, 20_000u64];
        for (k, &t0) in t0s.iter().enumerate() {
            let (ps, bs, fs) = (t0 + 1_000, t0 + 3_000, t0 + 6_000);
            for (advance_at, phase) in [
                (t0, "negotiation"),
                (ps + 7, "primary"),
                (bs + 7, "backup"),
                (fs + 7, "fallback"),
                (fs + 10 * 24 * 3_600_000_000_000, "fallback-late"),
            ] {
                let mut l = if k == 0 { submitted() } else { funded() };
                l.advance_case(P, advance_at).expect("advance");
                assert_eq!(l.dispute_t0_ns, t0, "fixed T0 ({phase})");
                let now = advance_at;
                let ok_p = l
                    .clone()
                    .submit_ruling(P, Arbitrator::Primary, 1, 299, now)
                    .is_ok();
                let ok_b = l
                    .clone()
                    .submit_ruling(P, Arbitrator::Backup, 1, 299, now)
                    .is_ok();
                let ok_f = l.clone().trigger_fallback(P, now).is_ok();
                let ok_m = {
                    let mut m = l;
                    let id = m.propose_split(P, Proposer::Buyer, 1, 299, now).expect("p");
                    m.accept_split(P, Proposer::Supplier, id, 1, 299, now)
                        .is_ok()
                };
                let want = match phase {
                    "negotiation" => (false, false, false),
                    "primary" => (true, false, false),
                    "backup" => (false, true, false),
                    _ => (false, false, true),
                };
                assert_eq!((ok_p, ok_b, ok_f), want, "{phase} reason {k}");
                assert!(ok_m, "mutual always available ({phase})");
            }
        }
    }

    #[test]
    fn lf008_silent_arbiters_then_fallback() {
        let mut l = disputed();
        // Nothing happens through negotiation, primary and backup windows.
        for now in [T0, PS, BS, FS - 1] {
            assert_eq!(l.status, LineStatus::Disputed);
            assert!(l.clone().trigger_fallback(P, now).is_err());
        }
        assert_eq!(l.ledger.locked, 300, "no automatic allocation");
        l.trigger_fallback(P, FS).expect("longstop");
        assert_eq!(l.allocation.finalized_at_ns, FS);
    }

    // ---- F3 funding guard (tests written before the implementation) ----------
    // Rule (docs/31 §Approved rule): credit iff now < funding_deadline AND
    // now + review_window <= delivery_deadline + grace (checked u64).

    fn f3(funding: u64, delivery: u64, grace: u64, review: u64) -> LineParams {
        LineParams {
            funding_deadline_ns: funding,
            delivery_deadline_ns: delivery,
            delivery_grace_ns: grace,
            review_window_ns: review,
            ..P
        }
    }

    fn fund_at(p: LineParams, now: u64) -> Result<(), LineError> {
        let mut l = LineStateV1::new();
        let before = l;
        let r = l.fund(p, p.principal, now);
        if r.is_err() {
            assert_eq!(l, before, "rejected funding changed the line");
        } else {
            assert_eq!(
                (l.status, l.ledger.locked),
                (LineStatus::Funded, p.principal)
            );
        }
        r
    }

    #[test]
    fn f3_delivery_time_boundaries_zero_grace() {
        // limit = delivery + grace - review = 12_000 - 5_000 = 7_000
        let p = f3(10_000, 12_000, 0, 5_000);
        assert_eq!(fund_at(p, 6_999), Ok(()));
        assert_eq!(
            fund_at(p, 7_000),
            Ok(()),
            "equality accepted: supplier has exactly D"
        );
        assert_eq!(fund_at(p, 7_001), Err(LineError::DeliveryTimeTooShort));
        assert_eq!(fund_at(p, 9_999), Err(LineError::DeliveryTimeTooShort));
    }

    #[test]
    fn f3_funding_deadline_boundaries_unchanged() {
        // delivery far away: the funding deadline binds (-1 / 0 / +1).
        let p = f3(10_000, 100_000, 0, 5_000);
        assert_eq!(fund_at(p, 9_999), Ok(()));
        assert_eq!(
            fund_at(p, 10_000),
            Err(LineError::DeadlinePassed(Deadline::Funding))
        );
        assert_eq!(
            fund_at(p, 10_001),
            Err(LineError::DeadlinePassed(Deadline::Funding))
        );
    }

    #[test]
    fn f3_positive_grace_counts_as_delivery_time() {
        // limit = 12_000 + 1_000 - 5_000 = 8_000
        let p = f3(10_000, 12_000, 1_000, 5_000);
        assert_eq!(fund_at(p, 7_999), Ok(()));
        assert_eq!(fund_at(p, 8_000), Ok(()));
        assert_eq!(fund_at(p, 8_001), Err(LineError::DeliveryTimeTooShort));
        // Same deadline without grace: 7_001..=8_000 would be rejected.
        assert_eq!(
            fund_at(f3(10_000, 12_000, 0, 5_000), 7_500),
            Err(LineError::DeliveryTimeTooShort)
        );
        assert_eq!(
            fund_at(p, 7_500),
            Ok(()),
            "grace extends the funding window"
        );
    }

    #[test]
    fn f3_remaining_time_ends_inside_grace() {
        // delivery == funding deadline; the D period ends inside the grace
        // period: allowed because grace is agreed submission time.
        let p = f3(10_000, 10_000, 6_000, 5_000); // limit = 11_000 > funding deadline
        assert_eq!(fund_at(p, 9_999), Ok(()), "funding deadline binds");
        assert_eq!(
            fund_at(p, 10_000),
            Err(LineError::DeadlinePassed(Deadline::Funding))
        );
        let tight = f3(10_000, 10_000, 4_999, 5_000); // limit = 9_999
        assert_eq!(fund_at(tight, 9_999), Ok(()));
        let tighter = f3(10_000, 10_000, 4_998, 5_000); // limit = 9_998
        assert_eq!(
            fund_at(tighter, 9_999),
            Err(LineError::DeliveryTimeTooShort)
        );
    }

    #[test]
    fn f3_initial_timeline_shorter_than_d_is_never_fundable() {
        // delivery + grace - review is before any possible funding time.
        let p = f3(10_000, 10_500, 0, 5_000); // limit = 5_500
        for now in [0, T, 5_501, 9_999] {
            let r = fund_at(p, now);
            if now <= 5_500 {
                assert_eq!(r, Ok(()));
            } else {
                assert_eq!(r, Err(LineError::DeliveryTimeTooShort), "now={now}");
            }
        }
        let never = f3(10_000, 10_000, 0, 30_000); // limit underflows: 10_000 - 30_000 < 0
        for now in [0, 1, T, 9_999] {
            assert_eq!(
                fund_at(never, now),
                Err(LineError::DeliveryTimeTooShort),
                "now={now}"
            );
        }
    }

    #[test]
    fn f3_checked_arithmetic_extremes() {
        let m = u64::MAX;
        // now + review overflows u64: rejected, never wraps.
        let p = f3(m, m, 0, 5_000);
        assert_eq!(fund_at(p, m - 4_999), Err(LineError::DeliveryTimeTooShort));
        assert_eq!(fund_at(p, m - 5_000), Ok(()), "exactly reaches u64::MAX");
        // delivery + grace overflows (prevented at creation; still checked).
        let q = f3(m - 10, m - 5, 10, 1);
        assert_eq!(fund_at(q, 0), Err(LineError::DeadlineOverflow));
        // Maximum windows.
        let w = 30 * 24 * 3_600_000_000_000;
        let r = f3(1_000_000, 1_000_000 + w, w, w); // limit = 1_000_000 + w
        assert_eq!(fund_at(r, 999_999), Ok(()));
    }

    #[test]
    fn f3_check_order_and_existing_rules() {
        let p = f3(10_000, 12_000, 0, 5_000);
        // Amount mismatch after the time rules: a late deposit reports the time rule.
        let mut l = LineStateV1::new();
        assert_eq!(l.fund(p, 1, 9_000), Err(LineError::DeliveryTimeTooShort));
        assert_eq!(l.fund(p, 1, 6_000), Err(LineError::AmountMismatch));
        l.fund(p, p.principal, 6_000).expect("fund");
        assert_eq!(
            l.fund(p, p.principal, 6_001),
            Err(LineError::WrongState {
                expected: LineStatus::Unfunded,
                found: LineStatus::Funded
            })
        );
        // Delivery / submission and NON_DELIVERY T0 unchanged by F3.
        assert_eq!(l.non_delivery_t0(p, 12_000), Ok(Some(12_000)));
        l.submit_delivery(p, C, 11_999)
            .expect("submit before the unchanged cutoff");
    }

    /// 1 status + 8 + 8 + 32 + 1 reason + 8 + allocation (1+16+16+8+8)
    /// + ledger 112 + 2 × slot (1+8+4+16+8+8).
    pub const LINE_STATE_BORSH_BYTES: usize =
        1 + 8 + 8 + 32 + 1 + 8 + 49 + 112 + 2 * 45 + (1 + 1 + 8 + 16 + 16 + 8);
}
