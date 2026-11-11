//! Per-line ledger (M1 S4 / LF-004a). `docs/07`, `tests/FINANCIAL_INVARIANTS.md`.
//!
//! A funded line with principal `P` is split across seven buckets:
//!
//! ```text
//! P = locked + buyer_claimable + supplier_claimable
//!       + buyer_pending + supplier_pending + buyer_paid + supplier_paid
//! ```
//!
//! Value only moves along the edges of the `docs/07` diagrams:
//!
//! ```text
//! locked ──► buyer_claimable    ──► buyer_pending    ──► buyer_paid
//!   │                ▲                   │
//!   │                └───(definite failure)┘
//!   └──► supplier_claimable ──► supplier_pending ──► supplier_paid
//!                    ▲                   │
//!                    └───(definite failure)┘
//! ```
//!
//! There is no edge out of `*_paid` (terminal), none between buyer and
//! supplier buckets, and none back into `locked`. Every move is a checked
//! subtraction and a checked addition of the same amount, so conservation
//! holds by construction; `check_conservation` verifies it independently.
//!
//! Pure: no `env`, no token calls. Amounts are NEP-141 base units (u128).

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};

use crate::terms::BPS_DENOMINATOR;

/// The seven buckets of one line.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[borsh(crate = "near_sdk::borsh")]
pub struct LineLedgerV1 {
    pub locked: u128,
    pub buyer_claimable: u128,
    pub supplier_claimable: u128,
    pub buyer_pending: u128,
    pub supplier_pending: u128,
    pub buyer_paid: u128,
    pub supplier_paid: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bucket {
    Locked,
    BuyerClaimable,
    SupplierClaimable,
    BuyerPending,
    SupplierPending,
    BuyerPaid,
    SupplierPaid,
}

pub const ALL_BUCKETS: [Bucket; 7] = [
    Bucket::Locked,
    Bucket::BuyerClaimable,
    Bucket::SupplierClaimable,
    Bucket::BuyerPending,
    Bucket::SupplierPending,
    Bucket::BuyerPaid,
    Bucket::SupplierPaid,
];

/// The only permitted value movements (`docs/07`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    /// Allocation: locked → buyer claim.
    AllocateToBuyer,
    /// Allocation: locked → supplier claim.
    AllocateToSupplier,
    /// Withdrawal start (claim moves to pending *before* the async transfer).
    BeginBuyerWithdrawal,
    BeginSupplierWithdrawal,
    /// Authenticated success callback.
    ConfirmBuyerPaid,
    ConfirmSupplierPaid,
    /// Authenticated *definite* failure callback restores the claim.
    RestoreBuyerClaim,
    RestoreSupplierClaim,
}

pub const ALL_EDGES: [Edge; 8] = [
    Edge::AllocateToBuyer,
    Edge::AllocateToSupplier,
    Edge::BeginBuyerWithdrawal,
    Edge::BeginSupplierWithdrawal,
    Edge::ConfirmBuyerPaid,
    Edge::ConfirmSupplierPaid,
    Edge::RestoreBuyerClaim,
    Edge::RestoreSupplierClaim,
];

impl Edge {
    pub fn endpoints(self) -> (Bucket, Bucket) {
        use Bucket::*;
        match self {
            Edge::AllocateToBuyer => (Locked, BuyerClaimable),
            Edge::AllocateToSupplier => (Locked, SupplierClaimable),
            Edge::BeginBuyerWithdrawal => (BuyerClaimable, BuyerPending),
            Edge::BeginSupplierWithdrawal => (SupplierClaimable, SupplierPending),
            Edge::ConfirmBuyerPaid => (BuyerPending, BuyerPaid),
            Edge::ConfirmSupplierPaid => (SupplierPending, SupplierPaid),
            Edge::RestoreBuyerClaim => (BuyerPending, BuyerClaimable),
            Edge::RestoreSupplierClaim => (SupplierPending, SupplierClaimable),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LedgerError {
    /// A funded line must have P > 0.
    ZeroPrincipal,
    /// Moving 0 is refused: it would be a no-op that could be replayed.
    ZeroAmount,
    /// The source bucket holds less than the amount.
    InsufficientBalance { bucket: Bucket },
    /// Destination addition overflowed (impossible while conservation holds).
    Overflow { bucket: Bucket },
    /// Sum of buckets is not P, or the sum overflowed.
    ConservationViolated,
}

impl LedgerError {
    pub fn code(self) -> &'static str {
        match self {
            LedgerError::ZeroPrincipal => "ZeroPrincipal",
            LedgerError::ZeroAmount => "ZeroAmount",
            LedgerError::InsufficientBalance { .. } => "InsufficientBalance",
            LedgerError::Overflow { .. } => "Overflow",
            LedgerError::ConservationViolated => "ConservationViolated",
        }
    }
}

impl LineLedgerV1 {
    /// Ledger of a line just funded with exactly `principal`.
    pub fn funded(principal: u128) -> Result<Self, LedgerError> {
        if principal == 0 {
            return Err(LedgerError::ZeroPrincipal);
        }
        Ok(LineLedgerV1 {
            locked: principal,
            ..LineLedgerV1::default()
        })
    }

    pub fn get(&self, b: Bucket) -> u128 {
        match b {
            Bucket::Locked => self.locked,
            Bucket::BuyerClaimable => self.buyer_claimable,
            Bucket::SupplierClaimable => self.supplier_claimable,
            Bucket::BuyerPending => self.buyer_pending,
            Bucket::SupplierPending => self.supplier_pending,
            Bucket::BuyerPaid => self.buyer_paid,
            Bucket::SupplierPaid => self.supplier_paid,
        }
    }

    fn slot(&mut self, b: Bucket) -> &mut u128 {
        match b {
            Bucket::Locked => &mut self.locked,
            Bucket::BuyerClaimable => &mut self.buyer_claimable,
            Bucket::SupplierClaimable => &mut self.supplier_claimable,
            Bucket::BuyerPending => &mut self.buyer_pending,
            Bucket::SupplierPending => &mut self.supplier_pending,
            Bucket::BuyerPaid => &mut self.buyer_paid,
            Bucket::SupplierPaid => &mut self.supplier_paid,
        }
    }

    /// Checked sum of all seven buckets; `None` on overflow.
    pub fn total(&self) -> Option<u128> {
        ALL_BUCKETS
            .iter()
            .try_fold(0u128, |acc, &b| acc.checked_add(self.get(b)))
    }

    /// `P == sum of buckets` (and the sum does not overflow).
    pub fn check_conservation(&self, principal: u128) -> Result<(), LedgerError> {
        match self.total() {
            Some(t) if t == principal => Ok(()),
            _ => Err(LedgerError::ConservationViolated),
        }
    }

    /// Move `amount` along `edge`. Atomic: on any error the ledger is unchanged.
    pub fn apply(&mut self, edge: Edge, amount: u128) -> Result<(), LedgerError> {
        if amount == 0 {
            return Err(LedgerError::ZeroAmount);
        }
        let (from, to) = edge.endpoints();
        let new_from = self
            .get(from)
            .checked_sub(amount)
            .ok_or(LedgerError::InsufficientBalance { bucket: from })?;
        let new_to = self
            .get(to)
            .checked_add(amount)
            .ok_or(LedgerError::Overflow { bucket: to })?;
        *self.slot(from) = new_from;
        *self.slot(to) = new_to;
        Ok(())
    }

    /// Total ever allocated to the buyer (claimable + pending + paid).
    pub fn buyer_allocated(&self) -> Option<u128> {
        self.buyer_claimable
            .checked_add(self.buyer_pending)?
            .checked_add(self.buyer_paid)
    }

    /// Total ever allocated to the supplier (claimable + pending + paid).
    pub fn supplier_allocated(&self) -> Option<u128> {
        self.supplier_claimable
            .checked_add(self.supplier_pending)?
            .checked_add(self.supplier_paid)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitError {
    /// Supplier bps above 10 000.
    BpsOutOfRange,
    /// Unreachable for valid input (see the bound proof on `split_bps`).
    ArithmeticOverflow,
}

/// Fallback split of principal `p` with supplier share `supplier_bps`
/// (FD-04, `docs/07` §Allocation formula):
/// `supplier = floor(p * supplier_bps / 10 000)`, `buyer = p - supplier`.
/// The rounding remainder always goes to the buyer.
///
/// Overflow-free for every u128 `p`: with `p = q * 10 000 + r` (`r < 10 000`),
/// `floor(p * s / 10 000) = q * s + floor(r * s / 10 000)` exactly, and both
/// terms are bounded by `p` and `10^8`.
///
/// Returns `(buyer, supplier)`.
pub fn split_bps(p: u128, supplier_bps: u16) -> Result<(u128, u128), SplitError> {
    if supplier_bps > BPS_DENOMINATOR {
        return Err(SplitError::BpsOutOfRange);
    }
    let d = u128::from(BPS_DENOMINATOR);
    let s = u128::from(supplier_bps);
    let q = p / d;
    let r = p % d;
    // q * s <= p * s / d <= p; r * s < 10^8. Checked anyway.
    let supplier = q
        .checked_mul(s)
        .and_then(|a| {
            r.checked_mul(s)
                .map(|b| b / d)
                .and_then(|b| a.checked_add(b))
        })
        .ok_or(SplitError::ArithmeticOverflow)?;
    let buyer = p
        .checked_sub(supplier)
        .ok_or(SplitError::ArithmeticOverflow)?;
    Ok((buyer, supplier))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // ---- independent 256-bit reference for p * s (test only) ------------------

    /// (hi, lo) of a * b where b < 2^64.
    fn mul_wide(a: u128, b: u128) -> (u128, u128) {
        assert!(b < (1u128 << 64));
        let a_lo = a & u128::from(u64::MAX);
        let a_hi = a >> 64;
        let lo_prod = a_lo * b; // < 2^128
        let hi_prod = a_hi * b; // < 2^128
        let (lo, carry) = lo_prod.overflowing_add((hi_prod & u128::from(u64::MAX)) << 64);
        let hi = (hi_prod >> 64) + u128::from(carry);
        (hi, lo)
    }

    fn le_wide(a: (u128, u128), b: (u128, u128)) -> bool {
        a.0 < b.0 || (a.0 == b.0 && a.1 <= b.1)
    }

    fn add_wide(a: (u128, u128), b: u128) -> (u128, u128) {
        let (lo, carry) = a.1.overflowing_add(b);
        (a.0 + u128::from(carry), lo)
    }

    /// supplier is the floor of p*s/10000 iff supplier*10000 <= p*s < supplier*10000 + 10000.
    fn is_floor(p: u128, s: u16, supplier: u128) -> bool {
        let ps = mul_wide(p, u128::from(s));
        let lo_bound = mul_wide(supplier, 10_000);
        let hi_bound = add_wide(lo_bound, 10_000);
        le_wide(lo_bound, ps) && !le_wide(hi_bound, ps)
    }

    // ---- split_bps ---------------------------------------------------------

    #[test]
    fn split_spec_example_1001_3333() {
        // docs/07: P=1 001, S=3 333 → supplier 333, buyer 668.
        assert_eq!(split_bps(1_001, 3_333), Ok((668, 333)));
    }

    #[test]
    fn split_matches_independent_python_reference() {
        // Literals from evidence/m1/s4-python-split-reference.py (Python big
        // ints): (P, S, buyer, supplier).
        let cases: [(u128, u16, u128, u128); 12] = [
            (1001, 3333, 668, 333),
            (
                340282366920938463463374607431768211455,
                1,
                340248338684246369617028269971025034634,
                34028236692093846346337460743176821,
            ),
            (
                340282366920938463463374607431768211455,
                3333,
                226866254026189673591031850774759866578,
                113416112894748789872342756657008344877,
            ),
            (
                340282366920938463463374607431768211455,
                5000,
                170141183460469231731687303715884105728,
                170141183460469231731687303715884105727,
            ),
            (
                340282366920938463463374607431768211455,
                9999,
                34028236692093846346337460743176822,
                340248338684246369617028269971025034633,
            ),
            (
                340282366920938463463374607431768211455,
                10000,
                0,
                340282366920938463463374607431768211455,
            ),
            (
                340282366920938463463374607431768211454,
                3333,
                226866254026189673591031850774759866577,
                113416112894748789872342756657008344877,
            ),
            (
                170141183460469231731687303715884105728,
                7,
                170022084632046903269475122603282986854,
                119098828422328462212181112601118874,
            ),
            (
                100000000000000000000000000000000000000,
                1234,
                87660000000000000000000000000000000000,
                12340000000000000000000000000000000000,
            ),
            (
                12345678901234567890123456789,
                6667,
                4114814777781481477778148148,
                8230864123453086412345308641,
            ),
            (3, 5000, 2, 1),
            (9999, 1, 9999, 0),
        ];
        for (p, s, buyer, supplier) in cases {
            assert_eq!(split_bps(p, s), Ok((buyer, supplier)), "P={p} S={s}");
        }
    }

    #[test]
    fn split_edges_0_and_10000() {
        for p in [1u128, 2, 9_999, 10_000, 10_001, 1_001, u128::MAX] {
            assert_eq!(split_bps(p, 0), Ok((p, 0)), "S=0 all to buyer, p={p}");
            assert_eq!(
                split_bps(p, 10_000),
                Ok((0, p)),
                "S=10000 all to supplier, p={p}"
            );
        }
        assert_eq!(split_bps(0, 5_000), Ok((0, 0)));
    }

    #[test]
    fn split_u128_max_no_overflow() {
        let p = u128::MAX;
        assert_eq!(split_bps(p, 10_000), Ok((0, p)));
        // S = 1: supplier = floor(MAX / 10 000).
        let (b, s) = split_bps(p, 1).expect("S=1");
        assert_eq!(s, p / 10_000);
        assert_eq!(b, p - p / 10_000);
        assert!(is_floor(p, 1, s));
        // S = 9 999 and 5 000.
        for bps in [9_999u16, 5_000, 3_333, 1] {
            let (b, s) = split_bps(p, bps).expect("split");
            assert_eq!(b.checked_add(s), Some(p), "conservation bps={bps}");
            assert!(is_floor(p, bps, s), "floor bps={bps}");
        }
        // Literal value for S = 5 000 on an odd MAX: supplier = (MAX - 1) / 2.
        assert_eq!(split_bps(p, 5_000), Ok((p / 2 + 1, p / 2)));
    }

    #[test]
    fn split_remainder_goes_to_buyer() {
        // P = 3, S = 5 000 → supplier floor(1.5) = 1, buyer 2.
        assert_eq!(split_bps(3, 5_000), Ok((2, 1)));
        // P = 1, any S < 10 000 → supplier 0, buyer 1.
        for s in [1u16, 5_000, 9_999] {
            assert_eq!(split_bps(1, s), Ok((1, 0)));
        }
        // P = 9 999, S = 1 → supplier floor(0.9999) = 0.
        assert_eq!(split_bps(9_999, 1), Ok((9_999, 0)));
        // P = 10 000, S = 1 → exactly 1.
        assert_eq!(split_bps(10_000, 1), Ok((9_999, 1)));
        // The 500/300/200 demo lines with 6-decimal units and the demo bps.
        assert_eq!(
            split_bps(500_000_000, 5_000),
            Ok((250_000_000, 250_000_000))
        );
        assert_eq!(
            split_bps(300_000_000, 4_000),
            Ok((180_000_000, 120_000_000))
        );
        assert_eq!(split_bps(200_000_000, 7_000), Ok((60_000_000, 140_000_000)));
    }

    #[test]
    fn split_rejects_bps_above_10000() {
        for s in [10_001u16, 20_000, u16::MAX] {
            assert_eq!(split_bps(1_000, s), Err(SplitError::BpsOutOfRange));
            assert_eq!(split_bps(u128::MAX, s), Err(SplitError::BpsOutOfRange));
        }
    }

    #[test]
    fn wide_reference_self_check() {
        assert_eq!(mul_wide(u128::MAX, 1), (0, u128::MAX));
        assert_eq!(mul_wide(u128::MAX, 2), (1, u128::MAX - 1));
        assert_eq!(mul_wide(1u128 << 127, 4), (2, 0));
        assert!(is_floor(1_001, 3_333, 333));
        assert!(!is_floor(1_001, 3_333, 334));
        assert!(!is_floor(1_001, 3_333, 332));
    }

    // ---- ledger -------------------------------------------------------------

    fn assert_rejected(l: &mut LineLedgerV1, e: Edge, amount: u128, err: LedgerError) {
        let before = *l;
        assert_eq!(l.apply(e, amount), Err(err), "{e:?} {amount}");
        assert_eq!(*l, before, "unchanged after rejection");
    }

    #[test]
    fn funded_locks_exact_principal() {
        let l = LineLedgerV1::funded(1_001).expect("funded");
        assert_eq!(l.locked, 1_001);
        assert_eq!(l.total(), Some(1_001));
        assert_eq!(l.check_conservation(1_001), Ok(()));
        assert_eq!(
            l.check_conservation(1_000),
            Err(LedgerError::ConservationViolated)
        );
        assert_eq!(
            l.check_conservation(1_002),
            Err(LedgerError::ConservationViolated)
        );
        assert_eq!(LineLedgerV1::funded(0), Err(LedgerError::ZeroPrincipal));
        let max = LineLedgerV1::funded(u128::MAX).expect("max");
        assert_eq!(max.check_conservation(u128::MAX), Ok(()));
    }

    #[test]
    fn edge_table_matches_docs07() {
        use Bucket::*;
        let edges: Vec<_> = ALL_EDGES.iter().map(|e| e.endpoints()).collect();
        let expected = [
            (Locked, BuyerClaimable),
            (Locked, SupplierClaimable),
            (BuyerClaimable, BuyerPending),
            (SupplierClaimable, SupplierPending),
            (BuyerPending, BuyerPaid),
            (SupplierPending, SupplierPaid),
            (BuyerPending, BuyerClaimable),
            (SupplierPending, SupplierClaimable),
        ];
        assert_eq!(edges, expected);
        // Structural properties: nothing leaves *_paid, nothing enters locked,
        // no buyer↔supplier crossing.
        let is_buyer = |b: Bucket| matches!(b, BuyerClaimable | BuyerPending | BuyerPaid);
        let is_supplier =
            |b: Bucket| matches!(b, SupplierClaimable | SupplierPending | SupplierPaid);
        for (from, to) in edges {
            assert!(
                !matches!(from, BuyerPaid | SupplierPaid),
                "edge out of terminal {from:?}"
            );
            assert_ne!(to, Locked, "edge into locked");
            assert!(!(is_buyer(from) && is_supplier(to)), "buyer→supplier");
            assert!(!(is_supplier(from) && is_buyer(to)), "supplier→buyer");
        }
    }

    #[test]
    fn golden_scenario_500_300_200() {
        // Line A 500: accepted → supplier claims 500 and is paid.
        let mut a = LineLedgerV1::funded(500).expect("a");
        a.apply(Edge::AllocateToSupplier, 500).expect("alloc");
        a.apply(Edge::BeginSupplierWithdrawal, 500).expect("begin");
        a.apply(Edge::ConfirmSupplierPaid, 500).expect("paid");
        assert_eq!(a.supplier_paid, 500);
        assert_eq!(a.check_conservation(500), Ok(()));

        // Line B 300: disputed → 180 supplier / 120 buyer; buyer withdrawal
        // fails definitely once, then succeeds; supplier still claimable.
        let mut b = LineLedgerV1::funded(300).expect("b");
        b.apply(Edge::AllocateToSupplier, 180).expect("s");
        b.apply(Edge::AllocateToBuyer, 120).expect("b");
        assert_eq!(b.locked, 0);
        b.apply(Edge::BeginBuyerWithdrawal, 120).expect("begin");
        b.apply(Edge::RestoreBuyerClaim, 120)
            .expect("definite failure");
        assert_eq!(b.buyer_claimable, 120);
        b.apply(Edge::BeginBuyerWithdrawal, 120)
            .expect("retry by beneficiary");
        b.apply(Edge::ConfirmBuyerPaid, 120).expect("paid");
        assert_eq!((b.buyer_paid, b.supplier_claimable), (120, 180));
        assert_eq!(b.buyer_allocated(), Some(120));
        assert_eq!(b.supplier_allocated(), Some(180));
        assert_eq!(b.check_conservation(300), Ok(()));

        // Line C 200: still under review → fully locked.
        let c = LineLedgerV1::funded(200).expect("c");
        assert_eq!(c.locked, 200);

        let sum = [a.total(), b.total(), c.total()]
            .iter()
            .try_fold(0u128, |acc, t| t.and_then(|t| acc.checked_add(t)));
        assert_eq!(sum, Some(1_000), "ledger reconciles to the 1 000 deposited");
    }

    #[test]
    fn zero_amount_rejected_on_every_edge() {
        let mut l = LineLedgerV1::funded(10).expect("l");
        for e in ALL_EDGES {
            assert_rejected(&mut l, e, 0, LedgerError::ZeroAmount);
        }
    }

    #[test]
    fn overdraw_rejected_on_every_edge_with_exact_boundary() {
        // Put 10 in each source bucket that can feed an edge, then try 11.
        for e in ALL_EDGES {
            let (from, _) = e.endpoints();
            let mut l = LineLedgerV1::funded(100).expect("l");
            // Route 10 into `from` along legal edges.
            match from {
                Bucket::Locked => {}
                Bucket::BuyerClaimable => l.apply(Edge::AllocateToBuyer, 10).expect("x"),
                Bucket::SupplierClaimable => l.apply(Edge::AllocateToSupplier, 10).expect("x"),
                Bucket::BuyerPending => {
                    l.apply(Edge::AllocateToBuyer, 10).expect("x");
                    l.apply(Edge::BeginBuyerWithdrawal, 10).expect("x");
                }
                Bucket::SupplierPending => {
                    l.apply(Edge::AllocateToSupplier, 10).expect("x");
                    l.apply(Edge::BeginSupplierWithdrawal, 10).expect("x");
                }
                Bucket::BuyerPaid | Bucket::SupplierPaid => unreachable!("no edge from paid"),
            }
            let available = l.get(from);
            assert_rejected(
                &mut l,
                e,
                available + 1,
                LedgerError::InsufficientBalance { bucket: from },
            );
            assert_rejected(
                &mut l,
                e,
                u128::MAX,
                LedgerError::InsufficientBalance { bucket: from },
            );
            l.apply(e, available).expect("exact balance moves");
            assert_eq!(l.get(from), 0);
            assert_eq!(l.check_conservation(100), Ok(()));
        }
    }

    #[test]
    fn replayed_moves_cannot_double_spend() {
        // Allocation replay: locked is exhausted after the first allocation.
        let mut l = LineLedgerV1::funded(300).expect("l");
        l.apply(Edge::AllocateToSupplier, 300).expect("first");
        assert_rejected(
            &mut l,
            Edge::AllocateToSupplier,
            300,
            LedgerError::InsufficientBalance {
                bucket: Bucket::Locked,
            },
        );
        assert_rejected(
            &mut l,
            Edge::AllocateToBuyer,
            1,
            LedgerError::InsufficientBalance {
                bucket: Bucket::Locked,
            },
        );
        // Withdrawal replay: claim already moved to pending.
        l.apply(Edge::BeginSupplierWithdrawal, 300).expect("begin");
        assert_rejected(
            &mut l,
            Edge::BeginSupplierWithdrawal,
            300,
            LedgerError::InsufficientBalance {
                bucket: Bucket::SupplierClaimable,
            },
        );
        // Callback replay: success then a second success / a late failure.
        l.apply(Edge::ConfirmSupplierPaid, 300).expect("paid");
        assert_rejected(
            &mut l,
            Edge::ConfirmSupplierPaid,
            300,
            LedgerError::InsufficientBalance {
                bucket: Bucket::SupplierPending,
            },
        );
        assert_rejected(
            &mut l,
            Edge::RestoreSupplierClaim,
            300,
            LedgerError::InsufficientBalance {
                bucket: Bucket::SupplierPending,
            },
        );
        assert_eq!(l.supplier_paid, 300);
        assert_eq!(l.check_conservation(300), Ok(()));
    }

    #[test]
    fn cross_beneficiary_moves_impossible() {
        // The buyer's claim cannot be withdrawn through the supplier path.
        let mut l = LineLedgerV1::funded(100).expect("l");
        l.apply(Edge::AllocateToBuyer, 100).expect("alloc");
        assert_rejected(
            &mut l,
            Edge::BeginSupplierWithdrawal,
            100,
            LedgerError::InsufficientBalance {
                bucket: Bucket::SupplierClaimable,
            },
        );
        l.apply(Edge::BeginBuyerWithdrawal, 100).expect("begin");
        assert_rejected(
            &mut l,
            Edge::ConfirmSupplierPaid,
            100,
            LedgerError::InsufficientBalance {
                bucket: Bucket::SupplierPending,
            },
        );
        assert_rejected(
            &mut l,
            Edge::RestoreSupplierClaim,
            100,
            LedgerError::InsufficientBalance {
                bucket: Bucket::SupplierPending,
            },
        );
        assert_eq!(l.buyer_pending, 100);
    }

    #[test]
    fn corrupted_ledgers_detected() {
        // Hand-built invalid states (never produced by `apply`).
        let mut l = LineLedgerV1::funded(100).expect("l");
        l.buyer_claimable = 1; // minted value
        assert_eq!(
            l.check_conservation(100),
            Err(LedgerError::ConservationViolated)
        );
        let overflow = LineLedgerV1 {
            locked: u128::MAX,
            supplier_paid: 1,
            ..LineLedgerV1::default()
        };
        assert_eq!(overflow.total(), None);
        assert_eq!(
            overflow.check_conservation(u128::MAX),
            Err(LedgerError::ConservationViolated)
        );
        // A destination at u128::MAX makes `apply` report overflow atomically.
        let mut weird = LineLedgerV1 {
            locked: 5,
            supplier_claimable: u128::MAX,
            ..LineLedgerV1::default()
        };
        assert_rejected(
            &mut weird,
            Edge::AllocateToSupplier,
            5,
            LedgerError::Overflow {
                bucket: Bucket::SupplierClaimable,
            },
        );
    }

    #[test]
    fn u128_max_line_full_lifecycle() {
        let p = u128::MAX;
        let (buyer, supplier) = split_bps(p, 3_333).expect("split");
        let mut l = LineLedgerV1::funded(p).expect("l");
        l.apply(Edge::AllocateToBuyer, buyer).expect("b");
        l.apply(Edge::AllocateToSupplier, supplier).expect("s");
        assert_eq!(l.locked, 0);
        l.apply(Edge::BeginBuyerWithdrawal, buyer).expect("bb");
        l.apply(Edge::BeginSupplierWithdrawal, supplier)
            .expect("bs");
        l.apply(Edge::ConfirmSupplierPaid, supplier).expect("ps");
        l.apply(Edge::RestoreBuyerClaim, buyer).expect("rb");
        l.apply(Edge::BeginBuyerWithdrawal, buyer).expect("bb2");
        l.apply(Edge::ConfirmBuyerPaid, buyer).expect("pb");
        assert_eq!((l.buyer_paid, l.supplier_paid), (buyer, supplier));
        assert_eq!(l.check_conservation(p), Ok(()));
    }

    #[test]
    fn borsh_size_is_fixed_112_bytes() {
        // 7 × u128 = 112 bytes, regardless of values (storage pre-allocation, docs/25).
        let zero = near_sdk::borsh::to_vec(&LineLedgerV1::default()).expect("enc");
        let max = near_sdk::borsh::to_vec(&LineLedgerV1 {
            locked: u128::MAX,
            buyer_claimable: u128::MAX,
            supplier_claimable: u128::MAX,
            buyer_pending: u128::MAX,
            supplier_pending: u128::MAX,
            buyer_paid: u128::MAX,
            supplier_paid: u128::MAX,
        })
        .expect("enc");
        assert_eq!((zero.len(), max.len()), (112, 112));
        let back: LineLedgerV1 = near_sdk::borsh::from_slice(&max).expect("dec");
        assert_eq!(back.supplier_paid, u128::MAX);
    }

    // ---- properties -----------------------------------------------------------

    fn arb_p() -> impl Strategy<Value = u128> {
        prop_oneof![
            1u128..20_001,
            Just(u128::MAX),
            Just(u128::MAX - 1),
            (u128::MAX - 20_000)..=u128::MAX,
            1u128..=u128::MAX,
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 10_000, ..ProptestConfig::default() })]

        /// split_bps: conservation, exact floor (vs a 256-bit reference),
        /// monotonic in S, and buyer gets the remainder.
        #[test]
        fn split_bps_exact_prop(p in arb_p(), s in 0u16..=10_000) {
            let (b, sup) = split_bps(p, s).expect("valid bps");
            prop_assert_eq!(b.checked_add(sup), Some(p));
            prop_assert!(is_floor(p, s, sup));
            if p < (1u128 << 100) {
                // Direct u128 arithmetic is exact here.
                prop_assert_eq!(sup, p * u128::from(s) / 10_000);
            }
            if s < 10_000 {
                let (_, sup_next) = split_bps(p, s + 1).expect("valid");
                prop_assert!(sup_next >= sup);
            }
        }

        /// Random sequences of moves: every successful move preserves
        /// conservation; every failed move leaves the ledger unchanged; paid
        /// buckets never decrease.
        #[test]
        fn random_moves_preserve_conservation_prop(
            p in arb_p(),
            moves in proptest::collection::vec((0usize..8, any::<u128>(), 0u8..4), 1..64),
        ) {
            let mut l = LineLedgerV1::funded(p).expect("funded");
            for (ei, raw, mode) in moves {
                let e = ALL_EDGES[ei];
                let (from, _) = e.endpoints();
                let avail = l.get(from);
                // Mix exact, partial, over and arbitrary amounts.
                let amount = match mode {
                    0 => avail,
                    1 => if avail == 0 { 0 } else { raw % avail + 1 },
                    2 => avail.saturating_add(1),
                    _ => raw,
                };
                let before = l;
                let paid_before = (l.buyer_paid, l.supplier_paid);
                match l.apply(e, amount) {
                    Ok(()) => {
                        prop_assert!(amount > 0 && amount <= avail);
                    }
                    Err(_) => prop_assert_eq!(l, before),
                }
                prop_assert_eq!(l.check_conservation(p), Ok(()));
                prop_assert!(l.buyer_paid >= paid_before.0 && l.supplier_paid >= paid_before.1);
                for b in ALL_BUCKETS {
                    prop_assert!(l.get(b) <= p, "no bucket exceeds P");
                }
            }
        }
    }
}
