//! Agreement acceptance (M1 S3 / LF-003): `PROPOSED → AGREED`.
//!
//! `docs/06` §Agreement state and §Authorization table, `docs/08` §Deadline
//! rules v1, FD-05:
//! - buyer and supplier accept the exact terms (`accept_terms`);
//! - primary and backup arbitrators each accept their appointment
//!   (`accept_appointment`);
//! - every acceptance must quote the hash the contract computed itself and
//!   happen while `now < acceptance_deadline_ns`;
//! - the agreement is `AGREED` exactly when all four flags are set.
//!
//! Pure: no `env` access. Caller and time are arguments.

use near_sdk::AccountId;
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};

use crate::deadlines::{self, DisputePhase};
use crate::hash::TermsHash;
use crate::line::{
    Arbitrator, Beneficiary, DisputeReason, LineError, LineParams, LineStateV1, Proposer,
    WithdrawalOutcome, WithdrawalSlotV1, WithdrawalTicket,
};
use crate::terms::{AgreementTermsV1, Role};

/// Stored lifecycle state. `EXPIRED` is not stored: it is derived from chain
/// time by [`AgreementV1::status_at`], so no call is needed to expire a proposal.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
pub enum AgreementState {
    Proposed,
    Agreed,
    /// At least one line validly funded (`docs/06`).
    Active,
}

/// Status as seen at a given time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgreementStatus {
    Proposed,
    /// Acceptance deadline passed before all four roles accepted.
    Expired,
    Agreed,
    Active,
}

impl AgreementStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AgreementStatus::Proposed => "PROPOSED",
            AgreementStatus::Expired => "EXPIRED",
            AgreementStatus::Agreed => "AGREED",
            AgreementStatus::Active => "ACTIVE",
        }
    }
}

/// One flag per appointed role. Each can only be set by that role.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Acceptances {
    pub buyer: bool,
    pub supplier: bool,
    pub primary_arbitrator: bool,
    pub backup_arbitrator: bool,
}

impl Acceptances {
    fn flag_mut(&mut self, role: Role) -> &mut bool {
        match role {
            Role::Buyer => &mut self.buyer,
            Role::Supplier => &mut self.supplier,
            Role::PrimaryArbitrator => &mut self.primary_arbitrator,
            Role::BackupArbitrator => &mut self.backup_arbitrator,
        }
    }

    pub fn all(&self) -> bool {
        self.buyer && self.supplier && self.primary_arbitrator && self.backup_arbitrator
    }
}

/// An agreement as stored. `terms` and `terms_hash` never change after creation.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
pub struct AgreementV1 {
    pub terms: AgreementTermsV1,
    /// Contract-computed canonical hash (`hash::terms_hash`).
    pub terms_hash: TermsHash,
    pub state: AgreementState,
    pub acceptances: Acceptances,
    pub created_at_ns: u64,
    /// One pre-allocated fixed-size state per line, index = line_id (`docs/25`).
    pub lines: Vec<LineStateV1>,
}

/// Which acceptance method was called.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptKind {
    /// `accept_terms`: buyer or supplier only.
    Terms,
    /// `accept_appointment`: primary or backup arbitrator only.
    Appointment,
}

/// Why an acceptance was rejected. On any error the agreement is unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptError {
    /// Caller holds no role this method serves (T017, T018).
    NotAuthorizedForMethod,
    /// `now >= acceptance_deadline_ns`.
    AcceptanceDeadlinePassed,
    /// Quoted hash differs from the contract-computed hash (T065).
    TermsHashMismatch,
    /// This role already accepted (replay).
    AlreadyAccepted,
}

impl AcceptError {
    pub fn code(self) -> &'static str {
        match self {
            AcceptError::NotAuthorizedForMethod => "NotAuthorizedForMethod",
            AcceptError::AcceptanceDeadlinePassed => "AcceptanceDeadlinePassed",
            AcceptError::TermsHashMismatch => "TermsHashMismatch",
            AcceptError::AlreadyAccepted => "AlreadyAccepted",
        }
    }
}

/// Successful acceptance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Accepted {
    pub role: Role,
    /// True iff this acceptance moved the agreement to `AGREED`.
    pub now_agreed: bool,
}

impl AgreementV1 {
    /// A new proposal. The caller must have validated `terms` and computed
    /// `terms_hash` from them.
    pub fn propose(terms: AgreementTermsV1, terms_hash: TermsHash, now_ns: u64) -> Self {
        let lines = vec![LineStateV1::new(); terms.lines.len()];
        AgreementV1 {
            lines,
            terms,
            terms_hash,
            state: AgreementState::Proposed,
            acceptances: Acceptances::default(),
            created_at_ns: now_ns,
        }
    }

    pub fn status_at(&self, now_ns: u64) -> AgreementStatus {
        match self.state {
            AgreementState::Active => AgreementStatus::Active,
            AgreementState::Agreed => AgreementStatus::Agreed,
            AgreementState::Proposed
                if !deadlines::acceptance_open(now_ns, self.terms.acceptance_deadline_ns) =>
            {
                AgreementStatus::Expired
            }
            AgreementState::Proposed => AgreementStatus::Proposed,
        }
    }

    /// The role `caller` holds for this method, if any. Roles are pairwise
    /// distinct (validated at creation), so at most one matches.
    fn role_for(&self, kind: AcceptKind, caller: &AccountId) -> Option<Role> {
        let t = &self.terms;
        match kind {
            AcceptKind::Terms if caller == &t.buyer_id => Some(Role::Buyer),
            AcceptKind::Terms if caller == &t.supplier_id => Some(Role::Supplier),
            AcceptKind::Appointment if caller == &t.primary_arbitrator_id => {
                Some(Role::PrimaryArbitrator)
            }
            AcceptKind::Appointment if caller == &t.backup_arbitrator_id => {
                Some(Role::BackupArbitrator)
            }
            _ => None,
        }
    }

    /// Record `caller`'s acceptance. Checks, in order: role for this method,
    /// acceptance deadline, exact hash, not already accepted. Mutates only on
    /// success.
    pub fn accept(
        &mut self,
        kind: AcceptKind,
        caller: &AccountId,
        quoted_hash: &TermsHash,
        now_ns: u64,
    ) -> Result<Accepted, AcceptError> {
        let role = self
            .role_for(kind, caller)
            .ok_or(AcceptError::NotAuthorizedForMethod)?;
        if !deadlines::acceptance_open(now_ns, self.terms.acceptance_deadline_ns) {
            return Err(AcceptError::AcceptanceDeadlinePassed);
        }
        if quoted_hash != &self.terms_hash {
            return Err(AcceptError::TermsHashMismatch);
        }
        let flag = self.acceptances.flag_mut(role);
        if *flag {
            return Err(AcceptError::AlreadyAccepted);
        }
        *flag = true;
        let now_agreed = self.acceptances.all();
        if now_agreed {
            self.state = AgreementState::Agreed;
        }
        Ok(Accepted { role, now_agreed })
    }
}

/// Why a line operation was rejected. On any error nothing changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineOpError {
    LineNotFound,
    /// Funding needs an AGREED (or ACTIVE) agreement.
    AgreementNotAgreed,
    /// Caller does not hold the role this operation requires.
    NotAuthorized,
    Line(LineError),
}

impl LineOpError {
    pub fn code(self) -> &'static str {
        match self {
            LineOpError::LineNotFound => "LineNotFound",
            LineOpError::AgreementNotAgreed => "AgreementNotAgreed",
            LineOpError::NotAuthorized => "NotAuthorized",
            LineOpError::Line(e) => e.code(),
        }
    }
}

impl From<LineError> for LineOpError {
    fn from(e: LineError) -> Self {
        LineOpError::Line(e)
    }
}

/// LF-008: a DISPUTED line's phase and its phase starts
/// `(T0 + N, T0 + N + A, T0 + N + A + B)`.
pub type PhaseInfo = (DisputePhase, (u64, u64, u64));

/// Line operations (M1 S5; deadlines S5b). Each touches exactly one line.
/// Dispute-finalization authority (LF-007/LF-008), the FT predecessor check
/// (LF-005) and the private-callback check (LF-009) are added by later slices;
/// none of these methods is reachable from a contract entry point yet.
impl AgreementV1 {
    fn line_index(&self, line_id: u32) -> Result<(usize, LineParams), LineOpError> {
        let i = usize::try_from(line_id).map_err(|_| LineOpError::LineNotFound)?;
        let t = self.terms.lines.get(i).ok_or(LineOpError::LineNotFound)?;
        if i >= self.lines.len() {
            return Err(LineOpError::LineNotFound);
        }
        Ok((
            i,
            LineParams {
                principal: t.principal,
                fallback_supplier_bps: t.fallback_supplier_bps,
                funding_deadline_ns: self.terms.funding_deadline_ns,
                delivery_deadline_ns: t.delivery_deadline_ns,
                delivery_grace_ns: self.terms.delivery_grace_period_ns,
                review_window_ns: self.terms.review_window_ns,
                negotiation_window_ns: self.terms.negotiation_window_ns,
                primary_window_ns: self.terms.primary_window_ns,
                backup_window_ns: self.terms.backup_window_ns,
            },
        ))
    }

    fn require_role(&self, caller: &AccountId, role: Role) -> Result<(), LineOpError> {
        let id = match role {
            Role::Buyer => &self.terms.buyer_id,
            Role::Supplier => &self.terms.supplier_id,
            Role::PrimaryArbitrator => &self.terms.primary_arbitrator_id,
            Role::BackupArbitrator => &self.terms.backup_arbitrator_id,
        };
        if caller == id {
            Ok(())
        } else {
            Err(LineOpError::NotAuthorized)
        }
    }

    /// Exact funding of one line by the buyer (sender). AGREED → ACTIVE on the
    /// first funded line.
    pub fn fund_line(
        &mut self,
        line_id: u32,
        sender: &AccountId,
        amount: u128,
        now_ns: u64,
    ) -> Result<(), LineOpError> {
        let (i, p) = self.line_index(line_id)?;
        if !matches!(self.state, AgreementState::Agreed | AgreementState::Active) {
            return Err(LineOpError::AgreementNotAgreed);
        }
        self.require_role(sender, Role::Buyer)?;
        self.lines[i].fund(p, amount, now_ns)?;
        self.state = AgreementState::Active;
        Ok(())
    }

    pub fn submit_delivery(
        &mut self,
        line_id: u32,
        caller: &AccountId,
        commitment: [u8; 32],
        now_ns: u64,
    ) -> Result<(), LineOpError> {
        let (i, p) = self.line_index(line_id)?;
        self.require_role(caller, Role::Supplier)?;
        Ok(self.lines[i].submit_delivery(p, commitment, now_ns)?)
    }

    pub fn accept_line(
        &mut self,
        line_id: u32,
        caller: &AccountId,
        now_ns: u64,
    ) -> Result<(), LineOpError> {
        let (i, p) = self.line_index(line_id)?;
        self.require_role(caller, Role::Buyer)?;
        Ok(self.lines[i].accept_line(p, now_ns)?)
    }

    pub fn open_dispute(
        &mut self,
        line_id: u32,
        caller: &AccountId,
        now_ns: u64,
    ) -> Result<(), LineOpError> {
        let (i, p) = self.line_index(line_id)?;
        self.require_role(caller, Role::Buyer)?;
        Ok(self.lines[i].open_dispute(p, now_ns)?)
    }

    /// LF-008: an appointed arbitrator rules inside its own window. The
    /// caller decides the role: primary_arbitrator_id → primary,
    /// backup_arbitrator_id → backup (4 distinct accounts); anyone else is
    /// not authorized.
    pub fn submit_ruling(
        &mut self,
        line_id: u32,
        caller: &AccountId,
        buyer_amount: u128,
        supplier_amount: u128,
        now_ns: u64,
    ) -> Result<(), LineOpError> {
        let (i, p) = self.line_index(line_id)?;
        let who = if caller == &self.terms.primary_arbitrator_id {
            Arbitrator::Primary
        } else if caller == &self.terms.backup_arbitrator_id {
            Arbitrator::Backup
        } else {
            return Err(LineOpError::NotAuthorized);
        };
        Ok(self.lines[i].submit_ruling(p, who, buyer_amount, supplier_amount, now_ns)?)
    }

    /// LF-008: permissionless fallback after the longstop (no caller argument).
    pub fn trigger_fallback(&mut self, line_id: u32, now_ns: u64) -> Result<(), LineOpError> {
        let (i, p) = self.line_index(line_id)?;
        Ok(self.lines[i].trigger_fallback(p, now_ns)?)
    }

    /// LF-008: read-only dispute phase and phase starts of a DISPUTED line.
    pub fn dispute_phase(
        &self,
        line_id: u32,
        now_ns: u64,
    ) -> Result<Option<PhaseInfo>, LineOpError> {
        let (i, p) = self.line_index(line_id)?;
        let l = &self.lines[i];
        let Some(ph) = l.dispute_phase(p, now_ns)? else {
            return Ok(None);
        };
        let starts = deadlines::phase_starts(
            l.dispute_t0_ns,
            p.negotiation_window_ns,
            p.primary_window_ns,
            p.backup_window_ns,
        )
        .map_err(|_| LineOpError::Line(LineError::DeadlineOverflow))?;
        Ok(Some((ph, starts)))
    }

    /// The caller withdraws *their own* claim. Returns the ticket and the
    /// recipient, which is always the immutable buyer_id / supplier_id.
    pub fn begin_withdrawal(
        &mut self,
        line_id: u32,
        caller: &AccountId,
        withdrawal_id: u64,
        now_ns: u64,
    ) -> Result<(WithdrawalTicket, AccountId), LineOpError> {
        let (i, p) = self.line_index(line_id)?;
        let (b, recipient) = if caller == &self.terms.buyer_id {
            (Beneficiary::Buyer, self.terms.buyer_id.clone())
        } else if caller == &self.terms.supplier_id {
            (Beneficiary::Supplier, self.terms.supplier_id.clone())
        } else {
            return Err(LineOpError::NotAuthorized);
        };
        let t = self.lines[i].begin_withdrawal(p, b, withdrawal_id, now_ns)?;
        Ok((t, recipient))
    }

    /// LF-009: which beneficiary `caller` is (buyer or supplier), if any.
    pub fn beneficiary_of(&self, caller: &AccountId) -> Option<Beneficiary> {
        if caller == &self.terms.buyer_id {
            Some(Beneficiary::Buyer)
        } else if caller == &self.terms.supplier_id {
            Some(Beneficiary::Supplier)
        } else {
            None
        }
    }

    /// LF-009: the current withdrawal slot of one beneficiary on one line
    /// (read-only; the callback validates against it before mutating).
    pub fn withdrawal_slot(
        &self,
        line_id: u32,
        b: Beneficiary,
    ) -> Result<WithdrawalSlotV1, LineOpError> {
        let (i, _) = self.line_index(line_id)?;
        Ok(*self.lines[i].slot(b))
    }

    /// Outcome of the authenticated private callback (LF-009 checks the caller).
    pub fn resolve_withdrawal(
        &mut self,
        line_id: u32,
        b: Beneficiary,
        withdrawal_id: u64,
        epoch: u32,
        outcome: WithdrawalOutcome,
        now_ns: u64,
    ) -> Result<(), LineOpError> {
        let (i, p) = self.line_index(line_id)?;
        Ok(self.lines[i].resolve_withdrawal(p, b, withdrawal_id, epoch, outcome, now_ns)?)
    }

    /// LF-007: the buyer or supplier as a settlement party; anyone else
    /// (arbitrators included) is not authorized.
    fn party(&self, caller: &AccountId) -> Result<Proposer, LineOpError> {
        if caller == &self.terms.buyer_id {
            Ok(Proposer::Buyer)
        } else if caller == &self.terms.supplier_id {
            Ok(Proposer::Supplier)
        } else {
            Err(LineOpError::NotAuthorized)
        }
    }

    /// LF-007: buyer or supplier proposes a split of a DISPUTED line.
    pub fn propose_split(
        &mut self,
        line_id: u32,
        caller: &AccountId,
        buyer_amount: u128,
        supplier_amount: u128,
        now_ns: u64,
    ) -> Result<u64, LineOpError> {
        let (i, p) = self.line_index(line_id)?;
        let who = self.party(caller)?;
        Ok(self.lines[i].propose_split(p, who, buyer_amount, supplier_amount, now_ns)?)
    }

    /// LF-007: the counterparty accepts the exact active proposal.
    pub fn accept_split(
        &mut self,
        line_id: u32,
        caller: &AccountId,
        proposal_id: u64,
        buyer_amount: u128,
        supplier_amount: u128,
        now_ns: u64,
    ) -> Result<(), LineOpError> {
        let (i, p) = self.line_index(line_id)?;
        let who = self.party(caller)?;
        Ok(self.lines[i].accept_split(
            p,
            who,
            proposal_id,
            buyer_amount,
            supplier_amount,
            now_ns,
        )?)
    }

    /// LF-006b: permissionless advance (no caller argument by design).
    pub fn advance_case(
        &mut self,
        line_id: u32,
        now_ns: u64,
    ) -> Result<DisputeReason, LineOpError> {
        let (i, p) = self.line_index(line_id)?;
        Ok(self.lines[i].advance_case(p, now_ns)?)
    }

    /// NON_DELIVERY eligibility and its fixed T0 (read-only, `docs/08`).
    pub fn non_delivery_t0(&self, line_id: u32, now_ns: u64) -> Result<Option<u64>, LineOpError> {
        let (i, p) = self.line_index(line_id)?;
        Ok(self.lines[i].non_delivery_t0(p, now_ns)?)
    }

    /// NO_RESPONSE eligibility and its fixed T0 (read-only, `docs/08`).
    pub fn no_response_t0(&self, line_id: u32, now_ns: u64) -> Result<Option<u64>, LineOpError> {
        let (i, p) = self.line_index(line_id)?;
        Ok(self.lines[i].no_response_t0(p, now_ns)?)
    }

    /// Checked sum of every line's ledger total.
    pub fn ledger_total(&self) -> Option<u128> {
        self.lines.iter().try_fold(0u128, |acc, l| {
            l.ledger.total().and_then(|t| acc.checked_add(t))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terms::{
        DEFAULT_BACKUP_WINDOW_NS, DEFAULT_NEGOTIATION_WINDOW_NS, DEFAULT_PRIMARY_WINDOW_NS,
        DEFAULT_REVIEW_WINDOW_NS, LineTermsV1,
    };

    const NOW: u64 = 1_800_000_000_000_000_000;
    const HOUR: u64 = 3_600_000_000_000;
    const HASH: TermsHash = [7u8; 32];

    fn acc(s: &str) -> AccountId {
        s.parse().expect("account")
    }
    fn buyer() -> AccountId {
        acc("buyer.test.near")
    }
    fn supplier() -> AccountId {
        acc("supplier.test.near")
    }
    fn primary() -> AccountId {
        acc("primary.test.near")
    }
    fn backup() -> AccountId {
        acc("backup.test.near")
    }
    fn stranger() -> AccountId {
        acc("stranger.test.near")
    }

    fn terms() -> AgreementTermsV1 {
        AgreementTermsV1 {
            schema_version: 1,
            deadline_rules_version: 1,
            buyer_id: buyer(),
            supplier_id: supplier(),
            primary_arbitrator_id: primary(),
            backup_arbitrator_id: backup(),
            ft_contract_id: acc("ft.test.near"),
            agreement_nonce: 1,
            acceptance_deadline_ns: NOW + 24 * HOUR,
            funding_deadline_ns: NOW + 48 * HOUR,
            delivery_grace_period_ns: 0,
            review_window_ns: DEFAULT_REVIEW_WINDOW_NS,
            negotiation_window_ns: DEFAULT_NEGOTIATION_WINDOW_NS,
            primary_window_ns: DEFAULT_PRIMARY_WINDOW_NS,
            backup_window_ns: DEFAULT_BACKUP_WINDOW_NS,
            lines: vec![LineTermsV1 {
                line_id: 0,
                principal: 1_000,
                delivery_deadline_ns: NOW + 96 * HOUR,
                acceptance_criteria_commitment: [1; 32],
                fallback_buyer_bps: 5_000,
                fallback_supplier_bps: 5_000,
            }],
        }
    }

    fn proposed() -> AgreementV1 {
        AgreementV1::propose(terms(), HASH, NOW)
    }

    fn deadline() -> u64 {
        terms().acceptance_deadline_ns
    }

    /// Asserts the call fails with `err` and leaves the agreement unchanged.
    fn assert_rejected(
        a: &mut AgreementV1,
        kind: AcceptKind,
        caller: &AccountId,
        hash: &TermsHash,
        now: u64,
        err: AcceptError,
    ) {
        let before = a.clone();
        assert_eq!(
            a.accept(kind, caller, hash, now),
            Err(err),
            "{caller} {kind:?}"
        );
        assert_eq!(a, &before, "state unchanged after rejection");
    }

    #[test]
    fn new_proposal_has_no_acceptances() {
        let a = proposed();
        assert_eq!(a.state, AgreementState::Proposed);
        assert_eq!(a.acceptances, Acceptances::default());
        assert_eq!(a.status_at(NOW), AgreementStatus::Proposed);
        assert_eq!(a.created_at_ns, NOW);
    }

    #[test]
    fn t002_to_t005_happy_path_in_spec_order() {
        let mut a = proposed();
        // T002 buyer accepts exact hash → one approval recorded.
        assert_eq!(
            a.accept(AcceptKind::Terms, &buyer(), &HASH, NOW),
            Ok(Accepted {
                role: Role::Buyer,
                now_agreed: false
            })
        );
        assert_eq!(
            a.acceptances,
            Acceptances {
                buyer: true,
                ..Acceptances::default()
            }
        );
        assert_eq!(a.state, AgreementState::Proposed);
        // T003 supplier accepts same hash → commercial approvals complete.
        assert_eq!(
            a.accept(AcceptKind::Terms, &supplier(), &HASH, NOW),
            Ok(Accepted {
                role: Role::Supplier,
                now_agreed: false
            })
        );
        assert!(a.acceptances.buyer && a.acceptances.supplier);
        assert!(!a.acceptances.primary_arbitrator && !a.acceptances.backup_arbitrator);
        assert_eq!(a.state, AgreementState::Proposed);
        // T004 primary acknowledges → only primary flag set.
        assert_eq!(
            a.accept(AcceptKind::Appointment, &primary(), &HASH, NOW),
            Ok(Accepted {
                role: Role::PrimaryArbitrator,
                now_agreed: false
            })
        );
        assert!(a.acceptances.primary_arbitrator && !a.acceptances.backup_arbitrator);
        assert_eq!(a.state, AgreementState::Proposed);
        // T005 backup acknowledges → AGREED.
        assert_eq!(
            a.accept(AcceptKind::Appointment, &backup(), &HASH, NOW),
            Ok(Accepted {
                role: Role::BackupArbitrator,
                now_agreed: true
            })
        );
        assert_eq!(a.state, AgreementState::Agreed);
        assert_eq!(a.status_at(NOW), AgreementStatus::Agreed);
        // Once agreed, the status stays AGREED after the acceptance deadline.
        assert_eq!(a.status_at(deadline()), AgreementStatus::Agreed);
        assert_eq!(a.status_at(u64::MAX), AgreementStatus::Agreed);
    }

    #[test]
    fn all_24_acceptance_orders_reach_agreed_only_on_the_fourth() {
        let steps = [
            (AcceptKind::Terms, buyer()),
            (AcceptKind::Terms, supplier()),
            (AcceptKind::Appointment, primary()),
            (AcceptKind::Appointment, backup()),
        ];
        let mut orders = 0;
        for i in 0..4 {
            for j in 0..4 {
                for k in 0..4 {
                    for l in 0..4 {
                        let o = [i, j, k, l];
                        if (0..4).any(|x| !o.contains(&x)) {
                            continue;
                        }
                        let mut a = proposed();
                        for (n, &s) in o.iter().enumerate() {
                            let (kind, who) = &steps[s];
                            let r = a.accept(*kind, who, &HASH, NOW).expect("accept");
                            assert_eq!(r.now_agreed, n == 3, "order {o:?} step {n}");
                            let expected = if n == 3 {
                                AgreementState::Agreed
                            } else {
                                AgreementState::Proposed
                            };
                            assert_eq!(a.state, expected);
                        }
                        orders += 1;
                    }
                }
            }
        }
        assert_eq!(orders, 24);
    }

    #[test]
    fn t017_wrong_signer_for_accept_terms_rejected() {
        let mut a = proposed();
        for who in [
            stranger(),
            primary(),
            backup(),
            acc("buyer.test.near.evil"),
            acc("test.near"),
        ] {
            assert_rejected(
                &mut a,
                AcceptKind::Terms,
                &who,
                &HASH,
                NOW,
                AcceptError::NotAuthorizedForMethod,
            );
        }
    }

    #[test]
    fn t018_supplier_as_arbitrator_rejected() {
        let mut a = proposed();
        for who in [supplier(), buyer(), stranger()] {
            assert_rejected(
                &mut a,
                AcceptKind::Appointment,
                &who,
                &HASH,
                NOW,
                AcceptError::NotAuthorizedForMethod,
            );
        }
        // Still rejected after the supplier has accepted the terms.
        a.accept(AcceptKind::Terms, &supplier(), &HASH, NOW)
            .expect("supplier terms");
        assert_rejected(
            &mut a,
            AcceptKind::Appointment,
            &supplier(),
            &HASH,
            NOW,
            AcceptError::NotAuthorizedForMethod,
        );
        assert!(!a.acceptances.primary_arbitrator && !a.acceptances.backup_arbitrator);
    }

    #[test]
    fn t065_mismatched_hash_rejected_for_every_role() {
        let mut wrong = HASH;
        wrong[31] ^= 1;
        let mut a = proposed();
        for (kind, who) in [
            (AcceptKind::Terms, buyer()),
            (AcceptKind::Terms, supplier()),
            (AcceptKind::Appointment, primary()),
            (AcceptKind::Appointment, backup()),
        ] {
            for h in [wrong, [0u8; 32], [0xffu8; 32]] {
                assert_rejected(&mut a, kind, &who, &h, NOW, AcceptError::TermsHashMismatch);
            }
        }
        assert_eq!(a.acceptances, Acceptances::default());
    }

    #[test]
    fn acceptance_deadline_boundary() {
        let d = deadline();
        // One nanosecond before: accepted.
        let mut a = proposed();
        assert!(a.accept(AcceptKind::Terms, &buyer(), &HASH, d - 1).is_ok());
        // At and after the deadline: rejected for every role.
        for now in [d, d + 1, u64::MAX] {
            let mut a = proposed();
            for (kind, who) in [
                (AcceptKind::Terms, buyer()),
                (AcceptKind::Terms, supplier()),
                (AcceptKind::Appointment, primary()),
                (AcceptKind::Appointment, backup()),
            ] {
                assert_rejected(
                    &mut a,
                    kind,
                    &who,
                    &HASH,
                    now,
                    AcceptError::AcceptanceDeadlinePassed,
                );
            }
        }
    }

    #[test]
    fn proposal_expires_at_deadline_and_cannot_complete() {
        let d = deadline();
        let mut a = proposed();
        for (kind, who) in [
            (AcceptKind::Terms, buyer()),
            (AcceptKind::Terms, supplier()),
            (AcceptKind::Appointment, primary()),
        ] {
            a.accept(kind, &who, &HASH, d - 1).expect("before deadline");
        }
        assert_eq!(a.status_at(d - 1), AgreementStatus::Proposed);
        assert_eq!(a.status_at(d), AgreementStatus::Expired);
        assert_rejected(
            &mut a,
            AcceptKind::Appointment,
            &backup(),
            &HASH,
            d,
            AcceptError::AcceptanceDeadlinePassed,
        );
        assert_eq!(a.state, AgreementState::Proposed);
        assert_eq!(a.status_at(d), AgreementStatus::Expired);
    }

    #[test]
    fn replayed_acceptance_rejected() {
        let mut a = proposed();
        a.accept(AcceptKind::Terms, &buyer(), &HASH, NOW)
            .expect("first");
        assert_rejected(
            &mut a,
            AcceptKind::Terms,
            &buyer(),
            &HASH,
            NOW,
            AcceptError::AlreadyAccepted,
        );
        assert_rejected(
            &mut a,
            AcceptKind::Terms,
            &buyer(),
            &HASH,
            NOW + 1,
            AcceptError::AlreadyAccepted,
        );
        // After AGREED, every role's replay is rejected and state stays AGREED.
        a.accept(AcceptKind::Terms, &supplier(), &HASH, NOW)
            .expect("supplier");
        a.accept(AcceptKind::Appointment, &primary(), &HASH, NOW)
            .expect("primary");
        a.accept(AcceptKind::Appointment, &backup(), &HASH, NOW)
            .expect("backup");
        for (kind, who) in [
            (AcceptKind::Terms, buyer()),
            (AcceptKind::Terms, supplier()),
            (AcceptKind::Appointment, primary()),
            (AcceptKind::Appointment, backup()),
        ] {
            assert_rejected(&mut a, kind, &who, &HASH, NOW, AcceptError::AlreadyAccepted);
        }
        assert_eq!(a.state, AgreementState::Agreed);
    }

    #[test]
    fn check_order_is_role_then_deadline_then_hash_then_replay() {
        let mut wrong = HASH;
        wrong[0] ^= 1;
        let d = deadline();
        let mut a = proposed();
        // Unauthorized wins over everything else.
        assert_rejected(
            &mut a,
            AcceptKind::Terms,
            &stranger(),
            &wrong,
            d,
            AcceptError::NotAuthorizedForMethod,
        );
        // Deadline before hash.
        assert_rejected(
            &mut a,
            AcceptKind::Terms,
            &buyer(),
            &wrong,
            d,
            AcceptError::AcceptanceDeadlinePassed,
        );
        // Hash before replay.
        a.accept(AcceptKind::Terms, &buyer(), &HASH, NOW)
            .expect("buyer");
        assert_rejected(
            &mut a,
            AcceptKind::Terms,
            &buyer(),
            &wrong,
            NOW,
            AcceptError::TermsHashMismatch,
        );
    }

    #[test]
    fn stored_agreement_borsh_round_trip() {
        let mut a = proposed();
        a.accept(AcceptKind::Terms, &buyer(), &HASH, NOW)
            .expect("buyer");
        let bytes = near_sdk::borsh::to_vec(&a).expect("encode");
        let back: AgreementV1 = near_sdk::borsh::from_slice(&bytes).expect("decode");
        assert_eq!(back, a);
    }

    // ---- M1 S5: line operations at agreement level --------------------------

    use crate::line::{LineStatus, SlotState};

    /// 3-line 500/300/200 agreement, all four acceptances done.
    fn agreed_demo() -> AgreementV1 {
        let mut t = terms();
        let line = |id: u32, p: u128, b: u16, s: u16| LineTermsV1 {
            line_id: id,
            principal: p,
            delivery_deadline_ns: NOW + 96 * HOUR,
            acceptance_criteria_commitment: [id as u8 + 1; 32],
            fallback_buyer_bps: b,
            fallback_supplier_bps: s,
        };
        t.lines = vec![
            line(0, 500, 5_000, 5_000),
            line(1, 300, 6_000, 4_000),
            line(2, 200, 3_000, 7_000),
        ];
        let mut a = AgreementV1::propose(t, HASH, NOW);
        for (k, w) in [
            (AcceptKind::Terms, buyer()),
            (AcceptKind::Terms, supplier()),
            (AcceptKind::Appointment, primary()),
            (AcceptKind::Appointment, backup()),
        ] {
            a.accept(k, &w, &HASH, NOW).expect("accept");
        }
        a
    }

    /// LF-007: buyer proposes, supplier accepts the exact proposal.
    fn settle(a: &mut AgreementV1, line_id: u32, b: u128, s: u128, now: u64) {
        let id = a
            .propose_split(line_id, &buyer(), b, s, now)
            .expect("propose");
        a.accept_split(line_id, &supplier(), id, b, s, now)
            .expect("accept");
    }

    #[test]
    fn lines_preallocated_unfunded_at_proposal() {
        let a = agreed_demo();
        assert_eq!(a.lines.len(), 3);
        assert!(a.lines.iter().all(|l| *l == LineStateV1::new()));
        assert_eq!(a.ledger_total(), Some(0));
    }

    #[test]
    fn t006_t007_t008_fund_each_line_exactly_and_independently() {
        let mut a = agreed_demo();
        assert_eq!(a.status_at(NOW), AgreementStatus::Agreed);
        // T006 line 1 (id 0).
        a.fund_line(0, &buyer(), 500, NOW + 1).expect("fund 0");
        assert_eq!(a.lines[0].ledger.locked, 500);
        assert_eq!(
            a.status_at(NOW + 1),
            AgreementStatus::Active,
            "AGREED → ACTIVE"
        );
        assert_eq!(a.lines[1], LineStateV1::new(), "other lines untouched");
        // T007 line 2 has its own ledger.
        a.fund_line(1, &buyer(), 300, NOW + 2).expect("fund 1");
        assert_eq!(
            (a.lines[0].ledger.locked, a.lines[1].ledger.locked),
            (500, 300)
        );
        // T008 aggregate equals the deposit sum.
        a.fund_line(2, &buyer(), 200, NOW + 3).expect("fund 2");
        assert_eq!(a.ledger_total(), Some(1_000));
        // Wrong amount, wrong sender, double funding, unknown line.
        let before = a.clone();
        assert_eq!(
            a.fund_line(1, &buyer(), 300, NOW),
            Err(LineOpError::Line(LineError::WrongState {
                expected: LineStatus::Unfunded,
                found: LineStatus::Funded
            }))
        );
        assert_eq!(
            a.fund_line(3, &buyer(), 1, NOW),
            Err(LineOpError::LineNotFound)
        );
        assert_eq!(
            a.fund_line(u32::MAX, &buyer(), 1, NOW),
            Err(LineOpError::LineNotFound)
        );
        assert_eq!(a, before);
    }

    #[test]
    fn funding_prerequisites() {
        // Not AGREED: proposed, partially accepted, or expired.
        let mut p = proposed();
        assert_eq!(
            p.fund_line(0, &buyer(), 1_000, NOW),
            Err(LineOpError::AgreementNotAgreed)
        );
        p.accept(AcceptKind::Terms, &buyer(), &HASH, NOW)
            .expect("b");
        p.accept(AcceptKind::Terms, &supplier(), &HASH, NOW)
            .expect("s");
        assert_eq!(
            p.fund_line(0, &buyer(), 1_000, NOW),
            Err(LineOpError::AgreementNotAgreed)
        );
        // Only the buyer funds (T019 pure part: supplier deposit not credited).
        let mut a = agreed_demo();
        for w in [supplier(), primary(), backup(), stranger()] {
            assert_eq!(
                a.fund_line(0, &w, 500, NOW),
                Err(LineOpError::NotAuthorized),
                "{w}"
            );
        }
        for wrong in [499u128, 501, 0, u128::MAX] {
            assert_eq!(
                a.fund_line(0, &buyer(), wrong, NOW),
                Err(LineOpError::Line(LineError::AmountMismatch))
            );
        }
        assert_eq!(
            a.state,
            AgreementState::Agreed,
            "rejected funding does not activate"
        );
        assert_eq!(a.ledger_total(), Some(0));
    }

    #[test]
    fn role_restrictions_per_operation() {
        let mut a = agreed_demo();
        a.fund_line(0, &buyer(), 500, NOW).expect("fund");
        for w in [buyer(), primary(), backup(), stranger()] {
            assert_eq!(
                a.submit_delivery(0, &w, [5; 32], NOW),
                Err(LineOpError::NotAuthorized),
                "submit {w}"
            );
        }
        a.submit_delivery(0, &supplier(), [5; 32], NOW)
            .expect("supplier submits");
        for w in [supplier(), primary(), backup(), stranger()] {
            assert_eq!(
                a.accept_line(0, &w, NOW),
                Err(LineOpError::NotAuthorized),
                "accept {w}"
            );
            assert_eq!(
                a.open_dispute(0, &w, NOW),
                Err(LineOpError::NotAuthorized),
                "dispute {w}"
            );
        }
        a.accept_line(0, &buyer(), NOW).expect("buyer accepts");
        // Arbitrators and strangers cannot withdraw or redirect (T043 pure part).
        for w in [primary(), backup(), stranger()] {
            assert_eq!(
                a.begin_withdrawal(0, &w, 1, NOW).err(),
                Some(LineOpError::NotAuthorized),
                "withdraw {w}"
            );
        }
        // Buyer has nothing on an accepted line.
        assert_eq!(
            a.begin_withdrawal(0, &buyer(), 1, NOW).err(),
            Some(LineOpError::Line(LineError::NothingToWithdraw))
        );
        let (t, recipient) = a
            .begin_withdrawal(0, &supplier(), 1, NOW)
            .expect("supplier");
        assert_eq!(
            (t.amount, recipient),
            (500, supplier()),
            "recipient fixed by the terms"
        );
    }

    #[test]
    fn golden_500_300_200_scenario_reconciles_to_1000() {
        let mut a = agreed_demo();
        for (id, amt) in [(0u32, 500u128), (1, 300), (2, 200)] {
            a.fund_line(id, &buyer(), amt, NOW).expect("fund");
            a.submit_delivery(id, &supplier(), [id as u8 + 10; 32], NOW + 1)
                .expect("submit");
        }
        // Line A: accepted → supplier withdraws successfully.
        a.accept_line(0, &buyer(), NOW + 2).expect("accept A");
        let (t, _) = a.begin_withdrawal(0, &supplier(), 1, NOW + 3).expect("w A");
        a.resolve_withdrawal(
            0,
            t.beneficiary,
            t.withdrawal_id,
            t.epoch,
            WithdrawalOutcome::Success,
            NOW + 4,
        )
        .expect("paid A");
        // Line B: disputed → 120 buyer / 180 supplier. Buyer: definite failure,
        // then success. Supplier: inconclusive (no callback), stays pending.
        a.open_dispute(1, &buyer(), NOW + 2).expect("dispute B");
        settle(&mut a, 1, 120, 180, NOW + 3);
        let (tb, _) = a
            .begin_withdrawal(1, &buyer(), 2, NOW + 4)
            .expect("w B buyer");
        a.resolve_withdrawal(
            1,
            tb.beneficiary,
            tb.withdrawal_id,
            tb.epoch,
            WithdrawalOutcome::DefiniteFailure,
            NOW + 5,
        )
        .expect("fail");
        let (tb2, _) = a
            .begin_withdrawal(1, &buyer(), 4, NOW + 6)
            .expect("w B buyer again");
        a.resolve_withdrawal(
            1,
            tb2.beneficiary,
            tb2.withdrawal_id,
            tb2.epoch,
            WithdrawalOutcome::Success,
            NOW + 7,
        )
        .expect("paid B buyer");
        let (_ts, _) = a
            .begin_withdrawal(1, &supplier(), 3, NOW + 4)
            .expect("w B supplier");
        // Line C: still under review.
        let l = &a.lines;
        assert_eq!(
            (l[0].status, l[1].status, l[2].status),
            (
                LineStatus::Allocated,
                LineStatus::Allocated,
                LineStatus::Submitted
            )
        );
        assert_eq!(l[0].ledger.supplier_paid, 500);
        assert_eq!(
            (l[1].ledger.buyer_paid, l[1].ledger.supplier_pending),
            (120, 180)
        );
        assert_eq!(l[1].supplier_withdrawal.state, SlotState::Pending);
        assert_eq!(l[2].ledger.locked, 200);
        assert_eq!(a.ledger_total(), Some(1_000));
        let paid: u128 = l
            .iter()
            .map(|x| x.ledger.buyer_paid + x.ledger.supplier_paid)
            .sum();
        assert_eq!(
            paid, 620,
            "500 + 120 confirmed paid; 180 pending; 200 locked"
        );
    }

    #[test]
    fn operations_never_change_other_lines() {
        let mut a = agreed_demo();
        for (id, amt) in [(0u32, 500u128), (1, 300), (2, 200)] {
            a.fund_line(id, &buyer(), amt, NOW).expect("fund");
        }
        let snapshot = a.lines.clone();
        a.submit_delivery(1, &supplier(), [1; 32], NOW).expect("s");
        a.open_dispute(1, &buyer(), NOW).expect("d");
        settle(&mut a, 1, 0, 300, NOW);
        a.begin_withdrawal(1, &supplier(), 9, NOW).expect("w");
        assert_eq!(a.lines[0], snapshot[0]);
        assert_eq!(a.lines[2], snapshot[2]);
        // A callback addressed to a different line does not match.
        assert_eq!(
            a.resolve_withdrawal(
                2,
                Beneficiary::Supplier,
                9,
                1,
                WithdrawalOutcome::Success,
                NOW
            ),
            Err(LineOpError::Line(LineError::WithdrawalNotPending))
        );
        assert_eq!(a.lines[2], snapshot[2]);
    }

    #[test]
    fn agreement_with_lines_borsh_round_trip() {
        let mut a = agreed_demo();
        a.fund_line(0, &buyer(), 500, NOW).expect("fund");
        let bytes = near_sdk::borsh::to_vec(&a).expect("enc");
        let back: AgreementV1 = near_sdk::borsh::from_slice(&bytes).expect("dec");
        assert_eq!(back, a);
    }

    // ---- M1 S5b: deadlines at agreement level -----------------------------------

    #[test]
    fn fund_line_after_funding_deadline_rejected() {
        let funding = terms().funding_deadline_ns;
        // F3: give line 0 enough delivery time that the funding deadline (not
        // the F3 delivery-time rule) is the binding edge in this test.
        let far = |mut a: AgreementV1| {
            a.terms.lines[0].delivery_deadline_ns = funding + 200 * 3_600_000_000_000;
            a
        };
        for now in [funding, funding + 1] {
            let mut a = far(agreed_demo());
            let before = a.clone();
            assert_eq!(
                a.fund_line(0, &buyer(), 500, now)
                    .map_err(LineOpError::code),
                Err("FundingDeadlinePassed")
            );
            assert_eq!(a, before, "stays AGREED, nothing funded");
            assert_eq!(a.ledger_total(), Some(0));
        }
        let mut a = far(agreed_demo());
        a.fund_line(0, &buyer(), 500, funding - 1)
            .expect("one ns before");
        assert_eq!(a.state, AgreementState::Active);
    }

    #[test]
    fn line_params_carry_hashed_timing() {
        // Agreement-level grace and review; per-line delivery deadlines.
        let mut a = agreed_demo();
        let grace = 2 * HOUR;
        a.terms.delivery_grace_period_ns = grace;
        a.terms.review_window_ns = 2 * HOUR;
        a.terms.lines[2].delivery_deadline_ns = NOW + 120 * HOUR;
        for (id, amt) in [(0u32, 500u128), (1, 300), (2, 200)] {
            a.fund_line(id, &buyer(), amt, NOW).expect("fund");
        }
        for (id, delivery) in [
            (0u32, NOW + 96 * HOUR),
            (1, NOW + 96 * HOUR),
            (2, NOW + 120 * HOUR),
        ] {
            let cutoff = delivery + grace;
            assert_eq!(a.non_delivery_t0(id, cutoff - 1), Ok(None), "line {id}");
            assert_eq!(a.non_delivery_t0(id, cutoff), Ok(Some(cutoff)), "line {id}");
        }
        // Review window from the terms: submit at S, review ends at S + 2 h.
        let s_at = NOW + 10;
        a.submit_delivery(1, &supplier(), [3; 32], s_at)
            .expect("submit");
        assert_eq!(
            a.no_response_t0(1, s_at + 2 * HOUR),
            Ok(Some(s_at + 2 * HOUR))
        );
        assert_eq!(
            a.accept_line(1, &buyer(), s_at + 2 * HOUR)
                .map_err(LineOpError::code),
            Err("ReviewWindowClosed")
        );
        a.accept_line(1, &buyer(), s_at + 2 * HOUR - 1)
            .expect("inside review");
        assert_eq!(a.non_delivery_t0(9, NOW), Err(LineOpError::LineNotFound));
    }
}
