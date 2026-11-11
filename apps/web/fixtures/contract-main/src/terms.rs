//! Agreement terms v1 and their creation-time validation (M1 S1 / LF-002a).
//!
//! Field order and types follow `docs/20` §Canonical terms encoding v1
//! (FROZEN 2026-10-27). The Borsh derive below is the serialization the hash
//! will use in S2; do not reorder, add or retype fields without schema v2.
//!
//! This module is pure: no `near_sdk::env` access. Time and the contract's own
//! identities are passed in through [`ValidationContext`].
//!
//! Validation rules come from `docs/20` (field table), `docs/08` §Deadline rules v1
//! (OQ-02/03/12), `docs/03` FD-04/FD-05/FD-06 and OQ-09.

use near_sdk::AccountId;
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};

/// `schema_version` accepted by this contract.
pub const SCHEMA_VERSION_V1: u16 = 1;
/// `deadline_rules_version` accepted by this contract (`docs/08` §Deadline rules v1).
pub const DEADLINE_RULES_VERSION_V1: u16 = 1;

/// Basis-point denominator; fallback bps of a line must sum to exactly this (FD-04).
pub const BPS_DENOMINATOR: u16 = 10_000;

/// Number of lines allowed per agreement.
pub const MIN_LINES: usize = 1;
pub const MAX_LINES: usize = 3;

const NS_PER_SEC: u64 = 1_000_000_000;
const NS_PER_HOUR: u64 = 3_600 * NS_PER_SEC;
const NS_PER_DAY: u64 = 24 * NS_PER_HOUR;

/// Smallest allowed window: 60 s (OQ-02).
pub const MIN_WINDOW_NS: u64 = 60 * NS_PER_SEC;
/// Largest allowed window: 30 days (OQ-02).
pub const MAX_WINDOW_NS: u64 = 30 * NS_PER_DAY;
/// Largest allowed delivery grace: 30 days (OQ-03). The smallest is 0.
pub const MAX_DELIVERY_GRACE_NS: u64 = 30 * NS_PER_DAY;

/// Business defaults (FD-06). A window below its default makes the agreement
/// "Accelerated timing — test only".
pub const DEFAULT_REVIEW_WINDOW_NS: u64 = 72 * NS_PER_HOUR;
pub const DEFAULT_NEGOTIATION_WINDOW_NS: u64 = 48 * NS_PER_HOUR;
pub const DEFAULT_PRIMARY_WINDOW_NS: u64 = 72 * NS_PER_HOUR;
pub const DEFAULT_BACKUP_WINDOW_NS: u64 = 72 * NS_PER_HOUR;
pub const DEFAULT_DELIVERY_GRACE_NS: u64 = 0;

/// Immutable agreement terms, canonical encoding v1. Field order = Borsh order.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
pub struct AgreementTermsV1 {
    pub schema_version: u16,
    pub deadline_rules_version: u16,
    pub buyer_id: AccountId,
    pub supplier_id: AccountId,
    pub primary_arbitrator_id: AccountId,
    pub backup_arbitrator_id: AccountId,
    pub ft_contract_id: AccountId,
    pub agreement_nonce: u64,
    pub acceptance_deadline_ns: u64,
    pub funding_deadline_ns: u64,
    pub delivery_grace_period_ns: u64,
    pub review_window_ns: u64,
    pub negotiation_window_ns: u64,
    pub primary_window_ns: u64,
    pub backup_window_ns: u64,
    pub lines: Vec<LineTermsV1>,
}

/// Immutable terms of one line, canonical encoding v1. Field order = Borsh order.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
pub struct LineTermsV1 {
    pub line_id: u32,
    /// Token principal in NEP-141 base units.
    pub principal: u128,
    pub delivery_deadline_ns: u64,
    /// Salted 32-byte commitment computed offchain; never raw text.
    pub acceptance_criteria_commitment: [u8; 32],
    pub fallback_buyer_bps: u16,
    pub fallback_supplier_bps: u16,
}

/// Contract-side facts the terms are validated against. Supplied by the caller
/// (later: from `env` and contract state), never read here.
#[derive(Debug, Clone, Copy)]
pub struct ValidationContext<'a> {
    /// Current chain time in nanoseconds.
    pub now_ns: u64,
    /// This escrow contract's account id.
    pub escrow_id: &'a AccountId,
    /// The single NEP-141 contract allowlisted at init.
    pub allowlisted_ft_id: &'a AccountId,
    /// Operator treasury account (gas/storage reserve, `docs/25`), OQ-09.
    pub operator_treasury_id: &'a AccountId,
}

/// The four appointed roles, in terms order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Buyer,
    Supplier,
    PrimaryArbitrator,
    BackupArbitrator,
}

/// Contract-side accounts no role may equal (OQ-09).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReservedAccount {
    Escrow,
    FtContract,
    OperatorTreasury,
}

/// The four dispute-schedule windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Window {
    Review,
    Negotiation,
    Primary,
    Backup,
}

/// Why terms were rejected. Exactly one variant is returned: the first failing
/// rule in the order documented on [`validate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TermsError {
    UnsupportedSchemaVersion {
        found: u16,
    },
    UnsupportedDeadlineRulesVersion {
        found: u16,
    },
    FtNotAllowlisted,
    /// Two roles name the same account. `first < second` in [`Role`] order.
    RolesNotDistinct {
        first: Role,
        second: Role,
    },
    RoleIsReservedAccount {
        role: Role,
        reserved: ReservedAccount,
    },
    /// `now_ns >= acceptance_deadline_ns`.
    AcceptanceDeadlineNotInFuture,
    /// `funding_deadline_ns < acceptance_deadline_ns`.
    FundingDeadlineBeforeAcceptance,
    DeliveryGraceOutOfRange,
    WindowOutOfRange {
        window: Window,
    },
    LineCountOutOfRange {
        count: usize,
    },
    /// `line_id` does not equal its position (gap, duplicate or reorder).
    LineIdMismatch {
        position: u32,
        line_id: u32,
    },
    ZeroPrincipal {
        line_id: u32,
    },
    BpsOutOfRange {
        line_id: u32,
    },
    BpsSumInvalid {
        line_id: u32,
    },
    /// `delivery_deadline_ns < funding_deadline_ns`.
    DeliveryDeadlineBeforeFunding {
        line_id: u32,
    },
    /// `delivery_deadline_ns + delivery_grace_period_ns` overflows u64.
    SubmissionCutoffOverflow {
        line_id: u32,
    },
    /// Latest possible dispute schedule end overflows u64:
    /// `delivery + grace + review + negotiation + primary + backup`.
    PhaseScheduleOverflow {
        line_id: u32,
    },
    /// Σ line principals exceeds u128::MAX (Rule A, checked after per-line rules).
    PrincipalSumOverflow,
}

impl TermsError {
    /// Stable variant name, shared with the TypeScript vectors.
    pub fn code(&self) -> &'static str {
        match self {
            TermsError::UnsupportedSchemaVersion { .. } => "UnsupportedSchemaVersion",
            TermsError::UnsupportedDeadlineRulesVersion { .. } => "UnsupportedDeadlineRulesVersion",
            TermsError::FtNotAllowlisted => "FtNotAllowlisted",
            TermsError::RolesNotDistinct { .. } => "RolesNotDistinct",
            TermsError::RoleIsReservedAccount { .. } => "RoleIsReservedAccount",
            TermsError::AcceptanceDeadlineNotInFuture => "AcceptanceDeadlineNotInFuture",
            TermsError::FundingDeadlineBeforeAcceptance => "FundingDeadlineBeforeAcceptance",
            TermsError::DeliveryGraceOutOfRange => "DeliveryGraceOutOfRange",
            TermsError::WindowOutOfRange { .. } => "WindowOutOfRange",
            TermsError::LineCountOutOfRange { .. } => "LineCountOutOfRange",
            TermsError::LineIdMismatch { .. } => "LineIdMismatch",
            TermsError::ZeroPrincipal { .. } => "ZeroPrincipal",
            TermsError::BpsOutOfRange { .. } => "BpsOutOfRange",
            TermsError::BpsSumInvalid { .. } => "BpsSumInvalid",
            TermsError::DeliveryDeadlineBeforeFunding { .. } => "DeliveryDeadlineBeforeFunding",
            TermsError::SubmissionCutoffOverflow { .. } => "SubmissionCutoffOverflow",
            TermsError::PhaseScheduleOverflow { .. } => "PhaseScheduleOverflow",
            TermsError::PrincipalSumOverflow => "PrincipalSumOverflow",
        }
    }
}

impl AgreementTermsV1 {
    fn role_ids(&self) -> [(Role, &AccountId); 4] {
        [
            (Role::Buyer, &self.buyer_id),
            (Role::Supplier, &self.supplier_id),
            (Role::PrimaryArbitrator, &self.primary_arbitrator_id),
            (Role::BackupArbitrator, &self.backup_arbitrator_id),
        ]
    }

    fn windows(&self) -> [(Window, u64, u64); 4] {
        [
            (
                Window::Review,
                self.review_window_ns,
                DEFAULT_REVIEW_WINDOW_NS,
            ),
            (
                Window::Negotiation,
                self.negotiation_window_ns,
                DEFAULT_NEGOTIATION_WINDOW_NS,
            ),
            (
                Window::Primary,
                self.primary_window_ns,
                DEFAULT_PRIMARY_WINDOW_NS,
            ),
            (
                Window::Backup,
                self.backup_window_ns,
                DEFAULT_BACKUP_WINDOW_NS,
            ),
        ]
    }

    /// Derived label (not stored, not hashed): true iff any window is shorter
    /// than its FD-06 business default. Such agreements are shown as
    /// "Accelerated timing — test only".
    pub fn accelerated_test_timing(&self) -> bool {
        self.windows()
            .iter()
            .any(|&(_, value, default)| value < default)
    }

    /// Validate terms at creation. Never panics.
    ///
    /// Rules are checked in this order and the first failure is returned:
    /// 1. schema / deadline-rules version;
    /// 2. FT contract equals the allowlisted FT;
    /// 3. four roles pairwise distinct (FD-05), then none equals escrow, FT or
    ///    operator treasury (OQ-09);
    /// 4. `now < acceptance_deadline <= funding_deadline` (OQ-12);
    /// 5. grace in `0..=30 d`, each window in `60 s..=30 d` (OQ-02/03);
    /// 6. `1..=3` lines; then per line in order: `line_id == position`,
    ///    principal > 0, each bps `<= 10 000`, bps sum `== 10 000` (FD-04),
    ///    `delivery >= funding` (OQ-12), and checked u64 sums for the
    ///    submission cutoff and the latest dispute-phase end;
    /// 7. the checked sum of all line principals fits u128 (Rule A).
    pub fn validate(&self, ctx: &ValidationContext<'_>) -> Result<(), TermsError> {
        if self.schema_version != SCHEMA_VERSION_V1 {
            return Err(TermsError::UnsupportedSchemaVersion {
                found: self.schema_version,
            });
        }
        if self.deadline_rules_version != DEADLINE_RULES_VERSION_V1 {
            return Err(TermsError::UnsupportedDeadlineRulesVersion {
                found: self.deadline_rules_version,
            });
        }
        if &self.ft_contract_id != ctx.allowlisted_ft_id {
            return Err(TermsError::FtNotAllowlisted);
        }

        let roles = self.role_ids();
        for (i, &(first, a)) in roles.iter().enumerate() {
            for &(second, b) in roles.iter().skip(i + 1) {
                if a == b {
                    return Err(TermsError::RolesNotDistinct { first, second });
                }
            }
        }
        let reserved = [
            (ReservedAccount::Escrow, ctx.escrow_id),
            (ReservedAccount::FtContract, ctx.allowlisted_ft_id),
            (ReservedAccount::OperatorTreasury, ctx.operator_treasury_id),
        ];
        for &(role, id) in roles.iter() {
            for &(kind, reserved_id) in reserved.iter() {
                if id == reserved_id {
                    return Err(TermsError::RoleIsReservedAccount {
                        role,
                        reserved: kind,
                    });
                }
            }
        }

        if ctx.now_ns >= self.acceptance_deadline_ns {
            return Err(TermsError::AcceptanceDeadlineNotInFuture);
        }
        if self.funding_deadline_ns < self.acceptance_deadline_ns {
            return Err(TermsError::FundingDeadlineBeforeAcceptance);
        }

        if self.delivery_grace_period_ns > MAX_DELIVERY_GRACE_NS {
            return Err(TermsError::DeliveryGraceOutOfRange);
        }
        for &(window, value, _) in self.windows().iter() {
            if !(MIN_WINDOW_NS..=MAX_WINDOW_NS).contains(&value) {
                return Err(TermsError::WindowOutOfRange { window });
            }
        }

        let count = self.lines.len();
        if !(MIN_LINES..=MAX_LINES).contains(&count) {
            return Err(TermsError::LineCountOutOfRange { count });
        }
        for (position, line) in (0u32..).zip(self.lines.iter()) {
            self.validate_line(position, line)?;
        }
        // Rule A (founder 2026-11-01): the agreement's total principal must fit
        // u128, so it can be fully funded and every per-agreement total is exact.
        self.lines
            .iter()
            .try_fold(0u128, |acc, l| acc.checked_add(l.principal))
            .ok_or(TermsError::PrincipalSumOverflow)?;
        Ok(())
    }

    fn validate_line(&self, position: u32, line: &LineTermsV1) -> Result<(), TermsError> {
        let line_id = line.line_id;
        if line_id != position {
            return Err(TermsError::LineIdMismatch { position, line_id });
        }
        if line.principal == 0 {
            return Err(TermsError::ZeroPrincipal { line_id });
        }
        if line.fallback_buyer_bps > BPS_DENOMINATOR || line.fallback_supplier_bps > BPS_DENOMINATOR
        {
            return Err(TermsError::BpsOutOfRange { line_id });
        }
        // Both values are <= 10 000 here, so the u32 sum cannot overflow.
        let bps_sum = u32::from(line.fallback_buyer_bps) + u32::from(line.fallback_supplier_bps);
        if bps_sum != u32::from(BPS_DENOMINATOR) {
            return Err(TermsError::BpsSumInvalid { line_id });
        }
        if line.delivery_deadline_ns < self.funding_deadline_ns {
            return Err(TermsError::DeliveryDeadlineBeforeFunding { line_id });
        }
        let submission_cutoff = line
            .delivery_deadline_ns
            .checked_add(self.delivery_grace_period_ns)
            .ok_or(TermsError::SubmissionCutoffOverflow { line_id })?;
        // Latest possible T0 is submitted_at + review with submitted_at <
        // submission_cutoff; the last phase boundary is T0 + N + A + B.
        [
            self.review_window_ns,
            self.negotiation_window_ns,
            self.primary_window_ns,
            self.backup_window_ns,
        ]
        .iter()
        .try_fold(submission_cutoff, |acc, &w| acc.checked_add(w))
        .ok_or(TermsError::PhaseScheduleOverflow { line_id })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // Fixed, realistic chain time (2027-01-15T08:00:00Z in ns).
    const NOW: u64 = 1_800_000_000_000_000_000;
    const HOUR: u64 = NS_PER_HOUR;

    fn acc(s: &str) -> AccountId {
        s.parse().expect("test account id")
    }

    struct Ctx {
        escrow: AccountId,
        ft: AccountId,
        treasury: AccountId,
    }

    impl Ctx {
        fn new() -> Self {
            Self {
                escrow: acc("escrow.linefair.testnet"),
                ft: acc("usdt-test.linefair.testnet"),
                treasury: acc("treasury.linefair.testnet"),
            }
        }
        fn at(&self, now_ns: u64) -> ValidationContext<'_> {
            ValidationContext {
                now_ns,
                escrow_id: &self.escrow,
                allowlisted_ft_id: &self.ft,
                operator_treasury_id: &self.treasury,
            }
        }
    }

    fn line(line_id: u32, principal: u128, buyer_bps: u16, supplier_bps: u16) -> LineTermsV1 {
        LineTermsV1 {
            line_id,
            principal,
            delivery_deadline_ns: NOW + 96 * HOUR,
            acceptance_criteria_commitment: [u8::try_from(line_id).expect("small id") + 1; 32],
            fallback_buyer_bps: buyer_bps,
            fallback_supplier_bps: supplier_bps,
        }
    }

    /// The 3-line demo agreement (500 / 300 / 200), default windows.
    fn valid_terms() -> AgreementTermsV1 {
        AgreementTermsV1 {
            schema_version: 1,
            deadline_rules_version: 1,
            buyer_id: acc("buyer.test.near"),
            supplier_id: acc("supplier.test.near"),
            primary_arbitrator_id: acc("primary.test.near"),
            backup_arbitrator_id: acc("backup.test.near"),
            ft_contract_id: acc("usdt-test.linefair.testnet"),
            agreement_nonce: 7,
            acceptance_deadline_ns: NOW + 24 * HOUR,
            funding_deadline_ns: NOW + 48 * HOUR,
            delivery_grace_period_ns: DEFAULT_DELIVERY_GRACE_NS,
            review_window_ns: DEFAULT_REVIEW_WINDOW_NS,
            negotiation_window_ns: DEFAULT_NEGOTIATION_WINDOW_NS,
            primary_window_ns: DEFAULT_PRIMARY_WINDOW_NS,
            backup_window_ns: DEFAULT_BACKUP_WINDOW_NS,
            lines: vec![
                line(0, 500_000_000, 5_000, 5_000),
                line(1, 300_000_000, 6_000, 4_000),
                line(2, 200_000_000, 3_000, 7_000),
            ],
        }
    }

    fn check(t: &AgreementTermsV1) -> Result<(), TermsError> {
        t.validate(&Ctx::new().at(NOW))
    }

    fn window_mut(t: &mut AgreementTermsV1, w: Window) -> &mut u64 {
        match w {
            Window::Review => &mut t.review_window_ns,
            Window::Negotiation => &mut t.negotiation_window_ns,
            Window::Primary => &mut t.primary_window_ns,
            Window::Backup => &mut t.backup_window_ns,
        }
    }

    fn role_mut(t: &mut AgreementTermsV1, r: Role) -> &mut AccountId {
        match r {
            Role::Buyer => &mut t.buyer_id,
            Role::Supplier => &mut t.supplier_id,
            Role::PrimaryArbitrator => &mut t.primary_arbitrator_id,
            Role::BackupArbitrator => &mut t.backup_arbitrator_id,
        }
    }

    const ALL_ROLES: [Role; 4] = [
        Role::Buyer,
        Role::Supplier,
        Role::PrimaryArbitrator,
        Role::BackupArbitrator,
    ];
    const ALL_WINDOWS: [Window; 4] = [
        Window::Review,
        Window::Negotiation,
        Window::Primary,
        Window::Backup,
    ];

    // ---- baseline -------------------------------------------------------

    #[test]
    fn valid_three_line_terms_pass() {
        assert_eq!(check(&valid_terms()), Ok(()));
        assert!(!valid_terms().accelerated_test_timing());
    }

    #[test]
    fn versions_must_be_one() {
        let mut t = valid_terms();
        t.schema_version = 2;
        assert_eq!(
            check(&t),
            Err(TermsError::UnsupportedSchemaVersion { found: 2 })
        );
        let mut t = valid_terms();
        t.deadline_rules_version = 0;
        assert_eq!(
            check(&t),
            Err(TermsError::UnsupportedDeadlineRulesVersion { found: 0 })
        );
    }

    // ---- T011 zero principal ------------------------------------------

    #[test]
    fn t011_zero_principal_rejected() {
        for line_id in 0u32..3 {
            let mut t = valid_terms();
            t.lines[line_id as usize].principal = 0;
            assert_eq!(check(&t), Err(TermsError::ZeroPrincipal { line_id }));
        }
        // Boundary: 1 base unit passes; u128::MAX passes validation (no arithmetic on it here).
        let mut t = valid_terms();
        t.lines[0].principal = 1;
        // Rule A: one line may be u128::MAX only if the total still fits.
        t.lines[1].principal = u128::MAX - 1 - t.lines[2].principal;
        assert_eq!(check(&t), Ok(()));
    }

    // ---- T012 line count ------------------------------------------------

    #[test]
    fn t012_four_lines_and_zero_lines_rejected() {
        let mut t = valid_terms();
        t.lines.push(line(3, 1, 5_000, 5_000));
        assert_eq!(check(&t), Err(TermsError::LineCountOutOfRange { count: 4 }));

        let mut t = valid_terms();
        t.lines.clear();
        assert_eq!(check(&t), Err(TermsError::LineCountOutOfRange { count: 0 }));

        // Boundaries 1 and 3 pass.
        let mut t = valid_terms();
        t.lines.truncate(1);
        assert_eq!(check(&t), Ok(()));
        assert_eq!(check(&valid_terms()), Ok(()));
    }

    // ---- line_id ---------------------------------------------------------

    #[test]
    fn line_id_gap_duplicate_and_reorder_rejected() {
        // Gap: 0, 2, ...
        let mut t = valid_terms();
        t.lines[1].line_id = 2;
        t.lines[2].line_id = 3;
        assert_eq!(
            check(&t),
            Err(TermsError::LineIdMismatch {
                position: 1,
                line_id: 2
            })
        );
        // Duplicate: 0, 0, 2
        let mut t = valid_terms();
        t.lines[1].line_id = 0;
        assert_eq!(
            check(&t),
            Err(TermsError::LineIdMismatch {
                position: 1,
                line_id: 0
            })
        );
        // Reordered: 1, 0, 2
        let mut t = valid_terms();
        t.lines.swap(0, 1);
        assert_eq!(
            check(&t),
            Err(TermsError::LineIdMismatch {
                position: 0,
                line_id: 1
            })
        );
        // Not starting at 0 (single line with id 1).
        let mut t = valid_terms();
        t.lines.truncate(1);
        t.lines[0].line_id = 1;
        assert_eq!(
            check(&t),
            Err(TermsError::LineIdMismatch {
                position: 0,
                line_id: 1
            })
        );
    }

    // ---- T013 / T014 role distinctness (FD-05) --------------------------

    #[test]
    fn t013_same_buyer_and_supplier_rejected() {
        let mut t = valid_terms();
        t.supplier_id = t.buyer_id.clone();
        assert_eq!(
            check(&t),
            Err(TermsError::RolesNotDistinct {
                first: Role::Buyer,
                second: Role::Supplier
            })
        );
    }

    #[test]
    fn t014_all_six_role_pairs_rejected() {
        let mut pairs = 0;
        for (i, &first) in ALL_ROLES.iter().enumerate() {
            for &second in ALL_ROLES.iter().skip(i + 1) {
                let mut t = valid_terms();
                let shared = acc("shared.test.near");
                *role_mut(&mut t, first) = shared.clone();
                *role_mut(&mut t, second) = shared;
                assert_eq!(
                    check(&t),
                    Err(TermsError::RolesNotDistinct { first, second }),
                    "pair {first:?}/{second:?}"
                );
                pairs += 1;
            }
        }
        assert_eq!(pairs, 6);
    }

    #[test]
    fn role_equal_to_escrow_ft_or_treasury_rejected() {
        let ctx = Ctx::new();
        let reserved = [
            (ReservedAccount::Escrow, ctx.escrow.clone()),
            (ReservedAccount::FtContract, ctx.ft.clone()),
            (ReservedAccount::OperatorTreasury, ctx.treasury.clone()),
        ];
        for &role in ALL_ROLES.iter() {
            for (kind, id) in reserved.iter() {
                let mut t = valid_terms();
                *role_mut(&mut t, role) = id.clone();
                assert_eq!(
                    t.validate(&ctx.at(NOW)),
                    Err(TermsError::RoleIsReservedAccount {
                        role,
                        reserved: *kind
                    }),
                    "{role:?} = {kind:?}"
                );
            }
        }
    }

    #[test]
    fn non_allowlisted_ft_rejected() {
        let mut t = valid_terms();
        t.ft_contract_id = acc("other-token.testnet");
        assert_eq!(check(&t), Err(TermsError::FtNotAllowlisted));
    }

    // ---- T015 bps (FD-04) ------------------------------------------------

    #[test]
    fn t015_invalid_bps_sum_rejected() {
        for (b, s) in [(5_000, 4_999), (5_000, 5_001), (0, 0), (9_999, 0)] {
            let mut t = valid_terms();
            t.lines[2].fallback_buyer_bps = b;
            t.lines[2].fallback_supplier_bps = s;
            assert_eq!(
                check(&t),
                Err(TermsError::BpsSumInvalid { line_id: 2 }),
                "{b}/{s}"
            );
        }
    }

    #[test]
    fn t015_bps_above_10000_rejected() {
        for (b, s) in [(10_001, 0), (0, 10_001), (u16::MAX, u16::MAX), (20_000, 0)] {
            let mut t = valid_terms();
            t.lines[1].fallback_buyer_bps = b;
            t.lines[1].fallback_supplier_bps = s;
            assert_eq!(
                check(&t),
                Err(TermsError::BpsOutOfRange { line_id: 1 }),
                "{b}/{s}"
            );
        }
        // Boundaries: 10 000/0 and 0/10 000 pass.
        let mut t = valid_terms();
        t.lines[0].fallback_buyer_bps = 10_000;
        t.lines[0].fallback_supplier_bps = 0;
        t.lines[1].fallback_buyer_bps = 0;
        t.lines[1].fallback_supplier_bps = 10_000;
        assert_eq!(check(&t), Ok(()));
    }

    // ---- T051 window and grace bounds (OQ-02/03) ------------------------

    #[test]
    fn t051_window_below_60s_or_above_30d_rejected() {
        for &w in ALL_WINDOWS.iter() {
            for bad in [0, MIN_WINDOW_NS - 1, MAX_WINDOW_NS + 1, u64::MAX] {
                let mut t = valid_terms();
                *window_mut(&mut t, w) = bad;
                assert_eq!(
                    check(&t),
                    Err(TermsError::WindowOutOfRange { window: w }),
                    "{w:?} = {bad}"
                );
            }
            for good in [MIN_WINDOW_NS, MAX_WINDOW_NS] {
                let mut t = valid_terms();
                *window_mut(&mut t, w) = good;
                assert_eq!(check(&t), Ok(()), "{w:?} = {good}");
            }
        }
    }

    #[test]
    fn t051_grace_above_30d_rejected() {
        let mut t = valid_terms();
        t.delivery_grace_period_ns = MAX_DELIVERY_GRACE_NS + 1;
        assert_eq!(check(&t), Err(TermsError::DeliveryGraceOutOfRange));
        t.delivery_grace_period_ns = u64::MAX;
        assert_eq!(check(&t), Err(TermsError::DeliveryGraceOutOfRange));
        for good in [0, 1, MAX_DELIVERY_GRACE_NS] {
            t.delivery_grace_period_ns = good;
            assert_eq!(check(&t), Ok(()), "grace = {good}");
        }
    }

    // ---- Rule A (founder 2026-11-01): Σ principal fits u128 -------------

    fn with_principals(ps: &[u128]) -> AgreementTermsV1 {
        let mut t = valid_terms();
        t.lines.truncate(ps.len());
        for (l, p) in t.lines.iter_mut().zip(ps) {
            l.principal = *p;
        }
        t
    }

    #[test]
    fn rule_a_sum_exactly_u128_max_passes() {
        let third = u128::MAX / 3;
        for ps in [
            vec![u128::MAX - 1, 1],
            vec![u128::MAX],
            vec![third, third, third],
            vec![u128::MAX - 2, 1, 1],
        ] {
            assert_eq!(check(&with_principals(&ps)), Ok(()), "{ps:?}");
        }
    }

    #[test]
    fn rule_a_sum_overflow_rejected() {
        let third = u128::MAX / 3;
        for ps in [
            vec![u128::MAX, 1],
            vec![third + 1, third + 1, third + 1],
            vec![u128::MAX, u128::MAX],
            vec![u128::MAX - 1, 1, 1],
        ] {
            assert_eq!(
                check(&with_principals(&ps)),
                Err(TermsError::PrincipalSumOverflow),
                "{ps:?}"
            );
        }
    }

    #[test]
    fn rule_a_checked_after_per_line_rules() {
        let mut t = with_principals(&[u128::MAX, u128::MAX, 0]);
        assert_eq!(check(&t), Err(TermsError::ZeroPrincipal { line_id: 2 }));
        t = with_principals(&[u128::MAX, u128::MAX, 1]);
        t.lines[1].fallback_buyer_bps = 1;
        assert_eq!(check(&t), Err(TermsError::BpsSumInvalid { line_id: 1 }));
    }

    #[test]
    fn window_bound_constants_match_spec() {
        // docs/20 field table, literal values.
        assert_eq!(MIN_WINDOW_NS, 60_000_000_000);
        assert_eq!(MAX_WINDOW_NS, 2_592_000_000_000_000);
        assert_eq!(MAX_DELIVERY_GRACE_NS, 2_592_000_000_000_000);
        assert_eq!(DEFAULT_REVIEW_WINDOW_NS, 259_200_000_000_000);
        assert_eq!(DEFAULT_NEGOTIATION_WINDOW_NS, 172_800_000_000_000);
        assert_eq!(DEFAULT_PRIMARY_WINDOW_NS, 259_200_000_000_000);
        assert_eq!(DEFAULT_BACKUP_WINDOW_NS, 259_200_000_000_000);
    }

    // ---- T052 accelerated label (FD-06) ---------------------------------

    #[test]
    fn t052_accelerated_label_iff_some_window_below_default() {
        let t = valid_terms();
        assert!(!t.accelerated_test_timing(), "all defaults");

        for &w in ALL_WINDOWS.iter() {
            let mut t = valid_terms();
            let default = *window_mut(&mut t, w);
            *window_mut(&mut t, w) = default - 1;
            assert!(t.accelerated_test_timing(), "{w:?} = default - 1");
            assert_eq!(check(&t), Ok(()), "accelerated terms remain valid");

            let mut t = valid_terms();
            *window_mut(&mut t, w) = default + 1;
            assert!(!t.accelerated_test_timing(), "{w:?} = default + 1");
        }

        // Fully accelerated demo timing: all windows at 60 s.
        let mut t = valid_terms();
        for &w in ALL_WINDOWS.iter() {
            *window_mut(&mut t, w) = MIN_WINDOW_NS;
        }
        assert!(t.accelerated_test_timing());
        assert_eq!(check(&t), Ok(()));

        // Grace is not a window; a nonzero grace does not change the label.
        let mut t = valid_terms();
        t.delivery_grace_period_ns = HOUR;
        assert!(!t.accelerated_test_timing());
    }

    // ---- deadline ordering (OQ-12) --------------------------------------

    #[test]
    fn acceptance_deadline_must_be_after_now() {
        let ctx = Ctx::new();
        let t = valid_terms();
        let a = t.acceptance_deadline_ns;
        assert_eq!(t.validate(&ctx.at(a - 1)), Ok(()));
        assert_eq!(
            t.validate(&ctx.at(a)),
            Err(TermsError::AcceptanceDeadlineNotInFuture)
        );
        assert_eq!(
            t.validate(&ctx.at(a + 1)),
            Err(TermsError::AcceptanceDeadlineNotInFuture)
        );
    }

    #[test]
    fn funding_deadline_before_acceptance_rejected() {
        let mut t = valid_terms();
        t.funding_deadline_ns = t.acceptance_deadline_ns - 1;
        assert_eq!(check(&t), Err(TermsError::FundingDeadlineBeforeAcceptance));
        t.funding_deadline_ns = t.acceptance_deadline_ns;
        assert_eq!(check(&t), Ok(()), "equality allowed");
    }

    #[test]
    fn delivery_deadline_before_funding_rejected() {
        let mut t = valid_terms();
        t.lines[1].delivery_deadline_ns = t.funding_deadline_ns - 1;
        assert_eq!(
            check(&t),
            Err(TermsError::DeliveryDeadlineBeforeFunding { line_id: 1 })
        );
        t.lines[1].delivery_deadline_ns = t.funding_deadline_ns;
        assert_eq!(check(&t), Ok(()), "equality allowed");
    }

    // ---- checked u64 sums ------------------------------------------------

    fn phase_span(t: &AgreementTermsV1) -> u64 {
        t.delivery_grace_period_ns
            + t.review_window_ns
            + t.negotiation_window_ns
            + t.primary_window_ns
            + t.backup_window_ns
    }

    #[test]
    fn delivery_plus_grace_overflow_rejected() {
        let mut t = valid_terms();
        t.delivery_grace_period_ns = MAX_DELIVERY_GRACE_NS;
        // Keep ordering valid: funding <= delivery.
        t.lines[0].delivery_deadline_ns = u64::MAX - MAX_DELIVERY_GRACE_NS + 1;
        assert_eq!(
            check(&t),
            Err(TermsError::SubmissionCutoffOverflow { line_id: 0 })
        );
        t.lines[0].delivery_deadline_ns = u64::MAX;
        assert_eq!(
            check(&t),
            Err(TermsError::SubmissionCutoffOverflow { line_id: 0 })
        );
        // Exactly u64::MAX is representable: not a submission-cutoff overflow
        // (the later phase sum then overflows instead).
        t.lines[0].delivery_deadline_ns = u64::MAX - MAX_DELIVERY_GRACE_NS;
        assert_eq!(
            check(&t),
            Err(TermsError::PhaseScheduleOverflow { line_id: 0 })
        );
    }

    #[test]
    fn phase_sum_overflow_rejected_with_exact_boundary() {
        for grace in [0, HOUR, MAX_DELIVERY_GRACE_NS] {
            let mut t = valid_terms();
            t.delivery_grace_period_ns = grace;
            let limit = u64::MAX - phase_span(&t);
            t.lines[2].delivery_deadline_ns = limit;
            assert_eq!(check(&t), Ok(()), "grace {grace}: exact limit passes");
            t.lines[2].delivery_deadline_ns = limit + 1;
            assert_eq!(
                check(&t),
                Err(TermsError::PhaseScheduleOverflow { line_id: 2 }),
                "grace {grace}: limit + 1 fails"
            );
        }
        // Max windows too.
        let mut t = valid_terms();
        for &w in ALL_WINDOWS.iter() {
            *window_mut(&mut t, w) = MAX_WINDOW_NS;
        }
        let limit = u64::MAX - phase_span(&t);
        t.lines[0].delivery_deadline_ns = limit;
        assert_eq!(check(&t), Ok(()));
        t.lines[0].delivery_deadline_ns = limit + 1;
        assert_eq!(
            check(&t),
            Err(TermsError::PhaseScheduleOverflow { line_id: 0 })
        );
    }

    // ---- never panics ----------------------------------------------------

    fn arb_line() -> impl Strategy<Value = LineTermsV1> {
        (
            0u32..5,
            prop_oneof![Just(0u128), any::<u128>()],
            any::<u64>(),
            any::<[u8; 32]>(),
            prop_oneof![0u16..=10_000, any::<u16>()],
            prop_oneof![0u16..=10_000, any::<u16>()],
        )
            .prop_map(|(line_id, principal, d, c, b, s)| LineTermsV1 {
                line_id,
                principal,
                delivery_deadline_ns: d,
                acceptance_criteria_commitment: c,
                fallback_buyer_bps: b,
                fallback_supplier_bps: s,
            })
    }

    fn arb_u64_edge() -> impl Strategy<Value = u64> {
        prop_oneof![
            Just(0u64),
            Just(u64::MAX),
            Just(MIN_WINDOW_NS),
            Just(MAX_WINDOW_NS),
            any::<u64>()
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 4_096, ..ProptestConfig::default() })]

        /// `validate` returns for arbitrary field values (never panics, never
        /// overflows) and agrees with its documented necessary conditions.
        #[test]
        fn validate_never_panics_prop(
            now in arb_u64_edge(),
            acceptance in arb_u64_edge(),
            funding in arb_u64_edge(),
            grace in arb_u64_edge(),
            windows in proptest::array::uniform4(arb_u64_edge()),
            lines in proptest::collection::vec(arb_line(), 0..5),
            role_pick in proptest::array::uniform4(0usize..5),
        ) {
            let names = ["a.test.near", "b.test.near", "c.test.near", "d.test.near", "a.test.near"];
            let mut t = valid_terms();
            t.buyer_id = acc(names[role_pick[0]]);
            t.supplier_id = acc(names[role_pick[1]]);
            t.primary_arbitrator_id = acc(names[role_pick[2]]);
            t.backup_arbitrator_id = acc(names[role_pick[3]]);
            t.acceptance_deadline_ns = acceptance;
            t.funding_deadline_ns = funding;
            t.delivery_grace_period_ns = grace;
            t.review_window_ns = windows[0];
            t.negotiation_window_ns = windows[1];
            t.primary_window_ns = windows[2];
            t.backup_window_ns = windows[3];
            t.lines = lines;

            let ctx = Ctx::new();
            let result = t.validate(&ctx.at(now));
            let _ = t.accelerated_test_timing();
            if result.is_ok() {
                prop_assert!(
                    t.lines.iter().try_fold(0u128, |a, l| a.checked_add(l.principal)).is_some(),
                    "Rule A: valid terms have a principal sum that fits u128"
                );
                prop_assert!(now < t.acceptance_deadline_ns);
                prop_assert!(t.acceptance_deadline_ns <= t.funding_deadline_ns);
                prop_assert!((1..=3).contains(&t.lines.len()));
                for (i, l) in t.lines.iter().enumerate() {
                    prop_assert_eq!(l.line_id as usize, i);
                    prop_assert!(l.principal > 0);
                    prop_assert_eq!(
                        u32::from(l.fallback_buyer_bps) + u32::from(l.fallback_supplier_bps),
                        10_000
                    );
                    prop_assert!(l.delivery_deadline_ns >= t.funding_deadline_ns);
                    let end = [grace, windows[0], windows[1], windows[2], windows[3]]
                        .iter()
                        .try_fold(l.delivery_deadline_ns, |a, &w| a.checked_add(w));
                    prop_assert!(end.is_some());
                }
            }
        }
    }
}
