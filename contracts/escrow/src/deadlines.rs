//! Deadline predicates v1 (M1 S5b). `docs/08` §Deadline rules v1
//! (`deadline_rules_version = 1`, hashed in the terms).
//!
//! All intervals are half-open `[start, end)` in chain nanoseconds. Every sum
//! is a checked u64 addition; an overflow is an error, never a wrap or panic.
//! Creation-time validation (`terms::validate`) already rejects terms whose
//! sums overflow, so `Overflow` here is a defensive impossibility.
//!
//! | Action | Allowed while |
//! |---|---|
//! | accept terms / appointment | `now < acceptance_deadline` |
//! | fund a line | `now < funding_deadline` |
//! | submit delivery | `now < delivery_deadline + grace` |
//! | buyer accept / dispute | `submitted_at <= now < submitted_at + review_window` |
//!
//! At the exact end of the submission window NON_DELIVERY becomes eligible
//! with `T0 = delivery_deadline + grace`; at the exact end of review
//! NO_RESPONSE becomes eligible with `T0 = submitted_at + review_window`.
//! T0 is computed from immutable values, so a late query returns the same T0.
//!
//! Pure: chain time is a parameter.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeadlineError {
    /// A deadline sum exceeds u64::MAX.
    Overflow,
}

/// Where `now` lies relative to a half-open window `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowPosition {
    BeforeStart,
    Open,
    /// `now >= end`.
    Closed,
}

fn position(now_ns: u64, start_ns: u64, end_ns: u64) -> WindowPosition {
    if now_ns < start_ns {
        WindowPosition::BeforeStart
    } else if now_ns < end_ns {
        WindowPosition::Open
    } else {
        WindowPosition::Closed
    }
}

/// `now < acceptance_deadline`.
pub fn acceptance_open(now_ns: u64, acceptance_deadline_ns: u64) -> bool {
    now_ns < acceptance_deadline_ns
}

/// `now < funding_deadline`.
pub fn funding_open(now_ns: u64, funding_deadline_ns: u64) -> bool {
    now_ns < funding_deadline_ns
}

/// `delivery_deadline + grace` (checked).
pub fn submission_cutoff(delivery_deadline_ns: u64, grace_ns: u64) -> Result<u64, DeadlineError> {
    delivery_deadline_ns
        .checked_add(grace_ns)
        .ok_or(DeadlineError::Overflow)
}

/// `now < delivery_deadline + grace`.
pub fn submission_open(
    now_ns: u64,
    delivery_deadline_ns: u64,
    grace_ns: u64,
) -> Result<bool, DeadlineError> {
    Ok(now_ns < submission_cutoff(delivery_deadline_ns, grace_ns)?)
}

/// F3 (`docs/31` §Approved rule): funding at `now` leaves the supplier at
/// least `review_window` of agreed submission time, i.e. `now + review_window
/// <= delivery_deadline + grace` (grace counts as agreed submission time).
/// Checked: an overflowing `now + review_window` means "not enough time";
/// an overflowing `delivery + grace` is an error (prevented at creation).
pub fn funding_leaves_delivery_time(
    now_ns: u64,
    delivery_deadline_ns: u64,
    grace_ns: u64,
    review_window_ns: u64,
) -> Result<bool, DeadlineError> {
    let cutoff = submission_cutoff(delivery_deadline_ns, grace_ns)?;
    Ok(match now_ns.checked_add(review_window_ns) {
        Some(t) => t <= cutoff,
        None => false,
    })
}

/// `submitted_at + review_window` (checked).
pub fn review_end(submitted_at_ns: u64, review_window_ns: u64) -> Result<u64, DeadlineError> {
    submitted_at_ns
        .checked_add(review_window_ns)
        .ok_or(DeadlineError::Overflow)
}

/// Position of `now` in the review window `[submitted_at, submitted_at + review)`.
pub fn review_position(
    now_ns: u64,
    submitted_at_ns: u64,
    review_window_ns: u64,
) -> Result<WindowPosition, DeadlineError> {
    Ok(position(
        now_ns,
        submitted_at_ns,
        review_end(submitted_at_ns, review_window_ns)?,
    ))
}

/// NON_DELIVERY eligibility: `Some(T0 = delivery + grace)` iff `now >= T0`.
pub fn non_delivery_t0(
    now_ns: u64,
    delivery_deadline_ns: u64,
    grace_ns: u64,
) -> Result<Option<u64>, DeadlineError> {
    let t0 = submission_cutoff(delivery_deadline_ns, grace_ns)?;
    Ok((now_ns >= t0).then_some(t0))
}

/// NO_RESPONSE eligibility: `Some(T0 = submitted_at + review)` iff `now >= T0`.
pub fn no_response_t0(
    now_ns: u64,
    submitted_at_ns: u64,
    review_window_ns: u64,
) -> Result<Option<u64>, DeadlineError> {
    let t0 = review_end(submitted_at_ns, review_window_ns)?;
    Ok((now_ns >= t0).then_some(t0))
}

/// LF-008: dispute phase of a DISPUTED line (`docs/08` §Phase boundary
/// algorithm). Half-open; at each exact boundary the earlier authority
/// expires. `BeforeT0` is unreachable for a stored DISPUTED line (T0 <= now
/// when the dispute starts) and is reported for completeness.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisputePhase {
    BeforeT0,
    /// `[T0, T0 + N)`: mutual settlement only.
    Negotiation,
    /// `[T0 + N, T0 + N + A)`: primary arbitrator or mutual.
    Primary,
    /// `[T0 + N + A, T0 + N + A + B)`: backup arbitrator or mutual.
    Backup,
    /// `[T0 + N + A + B, ∞)`: permissionless fallback or mutual.
    Fallback,
}

impl DisputePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            DisputePhase::BeforeT0 => "BEFORE_T0",
            DisputePhase::Negotiation => "NEGOTIATION",
            DisputePhase::Primary => "PRIMARY",
            DisputePhase::Backup => "BACKUP",
            DisputePhase::Fallback => "FALLBACK",
        }
    }
}

/// Phase start times `(primary, backup, fallback)` = `(T0+N, T0+N+A, T0+N+A+B)`, checked.
pub fn phase_starts(
    t0_ns: u64,
    negotiation_ns: u64,
    primary_ns: u64,
    backup_ns: u64,
) -> Result<(u64, u64, u64), DeadlineError> {
    let p = t0_ns
        .checked_add(negotiation_ns)
        .ok_or(DeadlineError::Overflow)?;
    let b = p.checked_add(primary_ns).ok_or(DeadlineError::Overflow)?;
    let f = b.checked_add(backup_ns).ok_or(DeadlineError::Overflow)?;
    Ok((p, b, f))
}

/// The phase `now` lies in, derived only from the fixed T0 and hashed windows.
pub fn dispute_phase(
    now_ns: u64,
    t0_ns: u64,
    negotiation_ns: u64,
    primary_ns: u64,
    backup_ns: u64,
) -> Result<DisputePhase, DeadlineError> {
    let (p, b, f) = phase_starts(t0_ns, negotiation_ns, primary_ns, backup_ns)?;
    Ok(if now_ns < t0_ns {
        DisputePhase::BeforeT0
    } else if now_ns < p {
        DisputePhase::Negotiation
    } else if now_ns < b {
        DisputePhase::Primary
    } else if now_ns < f {
        DisputePhase::Backup
    } else {
        DisputePhase::Fallback
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terms::{MAX_DELIVERY_GRACE_NS, MAX_WINDOW_NS, MIN_WINDOW_NS};
    use proptest::prelude::*;

    const HOUR: u64 = 3_600_000_000_000;
    const D: u64 = 1_800_000_000_000_000_000;

    #[test]
    fn lf008_phase_boundaries() {
        let (t0, n, a, b) = (D, 48 * HOUR, 72 * HOUR, 72 * HOUR);
        let ph = |now| dispute_phase(now, t0, n, a, b).expect("no overflow");
        assert_eq!(ph(t0 - 1), DisputePhase::BeforeT0);
        assert_eq!(ph(t0), DisputePhase::Negotiation);
        assert_eq!(ph(t0 + n - 1), DisputePhase::Negotiation);
        assert_eq!(ph(t0 + n), DisputePhase::Primary);
        assert_eq!(ph(t0 + n + 1), DisputePhase::Primary);
        assert_eq!(ph(t0 + n + a - 1), DisputePhase::Primary);
        assert_eq!(ph(t0 + n + a), DisputePhase::Backup);
        assert_eq!(ph(t0 + n + a + 1), DisputePhase::Backup);
        assert_eq!(ph(t0 + n + a + b - 1), DisputePhase::Backup);
        assert_eq!(ph(t0 + n + a + b), DisputePhase::Fallback);
        assert_eq!(ph(t0 + n + a + b + 1), DisputePhase::Fallback);
        assert_eq!(ph(u64::MAX), DisputePhase::Fallback);
        assert_eq!(
            phase_starts(t0, n, a, b),
            Ok((t0 + n, t0 + n + a, t0 + n + a + b))
        );
    }

    #[test]
    fn lf008_phase_overflow_checked() {
        assert_eq!(
            dispute_phase(0, u64::MAX - 10, 5, 5, 5),
            Err(DeadlineError::Overflow)
        );
        assert_eq!(
            phase_starts(u64::MAX, 1, 0, 0),
            Err(DeadlineError::Overflow)
        );
        assert_eq!(
            phase_starts(u64::MAX - 3, 1, 1, 1),
            Ok((u64::MAX - 2, u64::MAX - 1, u64::MAX))
        );
    }

    #[test]
    fn acceptance_cutoff_minus1_0_plus1() {
        assert!(acceptance_open(D - 1, D));
        assert!(!acceptance_open(D, D));
        assert!(!acceptance_open(D + 1, D));
        assert!(acceptance_open(0, 1));
        assert!(!acceptance_open(0, 0));
    }

    #[test]
    fn funding_cutoff_minus1_0_plus1() {
        assert!(funding_open(D - 1, D));
        assert!(!funding_open(D, D));
        assert!(!funding_open(D + 1, D));
    }

    #[test]
    fn t053_submission_open_one_ns_before_deadline_plus_grace() {
        for grace in [0, 1, HOUR, MAX_DELIVERY_GRACE_NS] {
            let cutoff = D + grace;
            assert_eq!(submission_cutoff(D, grace), Ok(cutoff));
            assert_eq!(
                submission_open(cutoff - 1, D, grace),
                Ok(true),
                "grace {grace}"
            );
            assert_eq!(
                non_delivery_t0(cutoff - 1, D, grace),
                Ok(None),
                "not yet eligible"
            );
        }
    }

    #[test]
    fn t054_submission_closed_at_deadline_plus_grace_and_non_delivery_t0() {
        for grace in [0, 1, HOUR, MAX_DELIVERY_GRACE_NS] {
            let cutoff = D + grace;
            for now in [cutoff, cutoff + 1] {
                assert_eq!(
                    submission_open(now, D, grace),
                    Ok(false),
                    "grace {grace} now {now}"
                );
                assert_eq!(non_delivery_t0(now, D, grace), Ok(Some(cutoff)));
            }
        }
        // Grace is part of the cutoff: with grace 0 the deadline itself is closed.
        assert_eq!(submission_open(D, D, 0), Ok(false));
        assert_eq!(submission_open(D, D, 1), Ok(true));
    }

    #[test]
    fn review_window_minus1_0_plus1_and_no_response_t0() {
        let s = D;
        for review in [MIN_WINDOW_NS, 72 * HOUR, MAX_WINDOW_NS] {
            let end = s + review;
            assert_eq!(
                review_position(end - 1, s, review),
                Ok(WindowPosition::Open)
            );
            assert_eq!(no_response_t0(end - 1, s, review), Ok(None));
            for now in [end, end + 1] {
                assert_eq!(review_position(now, s, review), Ok(WindowPosition::Closed));
                assert_eq!(no_response_t0(now, s, review), Ok(Some(end)));
            }
        }
    }

    #[test]
    fn review_window_start_is_inclusive() {
        let review = 72 * HOUR;
        assert_eq!(review_position(D, D, review), Ok(WindowPosition::Open));
        assert_eq!(
            review_position(D - 1, D, review),
            Ok(WindowPosition::BeforeStart)
        );
        assert_eq!(
            review_position(0, D, review),
            Ok(WindowPosition::BeforeStart)
        );
    }

    #[test]
    fn t0_fixed_when_queried_late() {
        let review = 72 * HOUR;
        let t0 = D + review;
        for late in [t0, t0 + 10 * 24 * HOUR, u64::MAX] {
            assert_eq!(no_response_t0(late, D, review), Ok(Some(t0)), "late {late}");
        }
        let grace = HOUR;
        let nd = D + grace;
        for late in [nd, nd + 10 * 24 * HOUR, u64::MAX] {
            assert_eq!(non_delivery_t0(late, D, grace), Ok(Some(nd)));
        }
    }

    #[test]
    fn checked_overflow_near_u64_max() {
        // Exactly u64::MAX is representable.
        assert_eq!(submission_cutoff(u64::MAX - HOUR, HOUR), Ok(u64::MAX));
        assert_eq!(review_end(u64::MAX - HOUR, HOUR), Ok(u64::MAX));
        // One more overflows: error, never wrap.
        assert_eq!(
            submission_cutoff(u64::MAX - HOUR + 1, HOUR),
            Err(DeadlineError::Overflow)
        );
        assert_eq!(submission_cutoff(u64::MAX, 1), Err(DeadlineError::Overflow));
        assert_eq!(review_end(u64::MAX, 1), Err(DeadlineError::Overflow));
        assert_eq!(review_end(u64::MAX, u64::MAX), Err(DeadlineError::Overflow));
        assert_eq!(
            submission_open(0, u64::MAX, 1),
            Err(DeadlineError::Overflow)
        );
        assert_eq!(
            review_position(0, u64::MAX, 1),
            Err(DeadlineError::Overflow)
        );
        assert_eq!(
            non_delivery_t0(u64::MAX, u64::MAX, 1),
            Err(DeadlineError::Overflow)
        );
        assert_eq!(
            no_response_t0(u64::MAX, u64::MAX, 1),
            Err(DeadlineError::Overflow)
        );
        // Zero additions at MAX are fine.
        assert_eq!(submission_cutoff(u64::MAX, 0), Ok(u64::MAX));
    }

    #[test]
    fn cutoffs_ending_at_u64_max() {
        let m = u64::MAX;
        assert!(acceptance_open(m - 1, m));
        assert!(!acceptance_open(m, m));
        assert!(funding_open(m - 1, m));
        assert!(!funding_open(m, m));
        assert_eq!(submission_open(m - 1, m - HOUR, HOUR), Ok(true));
        assert_eq!(submission_open(m, m - HOUR, HOUR), Ok(false));
        assert_eq!(non_delivery_t0(m, m - HOUR, HOUR), Ok(Some(m)));
        assert_eq!(
            review_position(m - 1, m - HOUR, HOUR),
            Ok(WindowPosition::Open)
        );
        assert_eq!(
            review_position(m, m - HOUR, HOUR),
            Ok(WindowPosition::Closed)
        );
        assert_eq!(no_response_t0(m, m - HOUR, HOUR), Ok(Some(m)));
        assert_eq!(no_response_t0(m - 1, m - HOUR, HOUR), Ok(None));
    }

    fn arb_u64() -> impl Strategy<Value = u64> {
        prop_oneof![
            Just(0u64),
            Just(u64::MAX),
            (u64::MAX - 10_000)..=u64::MAX,
            0u64..10_000,
            any::<u64>(),
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 10_000, ..ProptestConfig::default() })]

        /// Every predicate equals a u128 reference model of the half-open rules.
        #[test]
        fn predicates_match_u128_reference_prop(now in arb_u64(), a in arb_u64(), b in arb_u64()) {
            let (n, x, y) = (u128::from(now), u128::from(a), u128::from(b));
            let max = u128::from(u64::MAX);
            prop_assert_eq!(acceptance_open(now, a), n < x);
            prop_assert_eq!(funding_open(now, a), n < x);
            let sum = x + y;
            if sum > max {
                prop_assert_eq!(submission_open(now, a, b), Err(DeadlineError::Overflow));
                prop_assert_eq!(review_position(now, a, b), Err(DeadlineError::Overflow));
                prop_assert_eq!(non_delivery_t0(now, a, b), Err(DeadlineError::Overflow));
                prop_assert_eq!(no_response_t0(now, a, b), Err(DeadlineError::Overflow));
            } else {
                let end = u64::try_from(sum).expect("fits");
                prop_assert_eq!(submission_open(now, a, b), Ok(n < sum));
                prop_assert_eq!(non_delivery_t0(now, a, b), Ok((n >= sum).then_some(end)));
                prop_assert_eq!(no_response_t0(now, a, b), Ok((n >= sum).then_some(end)));
                let expected = if n < x {
                    WindowPosition::BeforeStart
                } else if n < sum {
                    WindowPosition::Open
                } else {
                    WindowPosition::Closed
                };
                prop_assert_eq!(review_position(now, a, b), Ok(expected));
                // Eligibility and openness are complementary.
                prop_assert_eq!(submission_open(now, a, b) == Ok(true), non_delivery_t0(now, a, b) == Ok(None));
            }
        }
    }
}
