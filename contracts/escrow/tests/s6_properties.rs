//! M1 S6 — stateful, model-based property harness (test-only).
//! Plan: `evidence/m1/s6-property-plan.md`.
//!
//! Each case builds a validated 1–3 line agreement and applies a random
//! action sequence through the public pure API (`AgreementV1`). An oracle
//! written from the specs (`docs/06`, `docs/07`, `docs/08`, `docs/27`) with
//! u128 arithmetic predicts every result and the resulting shadow model; the
//! real state must match it after every step, and every invariant is
//! re-checked after every step.
//!
//! Runs use fixed ChaCha seeds (reproducible). `LINEFAIR_S6_SEED_HEX=<64 hex>`
//! overrides the seed for exploration runs. A failure writes the minimized
//! input to `evidence/m1/s6-<property>-FAILED-<n>.txt` (never overwritten).

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::PathBuf;

use linefair_escrow::agreement::{AcceptKind, AgreementState, AgreementV1};
use linefair_escrow::hash::{NetworkId, terms_hash};
use linefair_escrow::ledger::split_bps;
use linefair_escrow::line::{
    AllocationMode, Beneficiary, DisputeReason, LineParams, LineStateV1, LineStatus,
    ProposalStatus, Proposer, SlotState, SplitProposalV1, WithdrawalOutcome,
};
use linefair_escrow::terms::{
    AgreementTermsV1, DEFAULT_BACKUP_WINDOW_NS, DEFAULT_NEGOTIATION_WINDOW_NS,
    DEFAULT_PRIMARY_WINDOW_NS, DEFAULT_REVIEW_WINDOW_NS, LineTermsV1, MAX_DELIVERY_GRACE_NS,
    MAX_WINDOW_NS, MIN_WINDOW_NS, ValidationContext,
};
use near_sdk::AccountId;
use near_sdk::borsh;
use proptest::prelude::*;
use proptest::test_runner::{Config, RngAlgorithm, TestCaseError, TestError, TestRng, TestRunner};

const CASES: u32 = 10_000;
const MAX_ACTIONS: usize = 60;
const LINE_STATE_BYTES: usize = 359; // 309 + 50 B LF-007 proposal record

// ---------------------------------------------------------------- accounts ---

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Who {
    Buyer,
    Supplier,
    Primary,
    Backup,
    Stranger,
}

fn acc(s: &str) -> AccountId {
    s.parse().expect("account")
}

fn id_of(w: Who) -> AccountId {
    acc(match w {
        Who::Buyer => "buyer.test.near",
        Who::Supplier => "supplier.test.near",
        Who::Primary => "primary.test.near",
        Who::Backup => "backup.test.near",
        Who::Stranger => "stranger.test.near",
    })
}

fn escrow() -> AccountId {
    acc("escrow.test.near")
}
fn ft() -> AccountId {
    acc("ft.test.near")
}
fn treasury() -> AccountId {
    acc("treasury.test.near")
}

// ----------------------------------------------------------------- actions ---

#[derive(Debug, Clone, Copy)]
enum Amt {
    Exact,
    Minus1,
    Plus1,
    Zero,
    Max,
}

#[derive(Debug, Clone, Copy)]
enum ModeK {
    Mutual,
    Primary,
    Backup,
    Fallback,
    None,
    BuyerAccepted,
}

#[derive(Debug, Clone, Copy)]
enum Split {
    Random(u128),
    ZeroBuyer,
    ZeroSupplier,
    FallbackExact,
    FallbackOff,
    SumLow,
    SumHigh,
}

/// LF-007: which proposal id an `AcceptSplit` names.
#[derive(Debug, Clone, Copy)]
enum PidK {
    Current,
    Previous,
    Next,
    Zero,
}

#[derive(Debug, Clone, Copy)]
enum IdK {
    Fresh,
    ReuseSlot,
    Zero,
}

#[derive(Debug, Clone, Copy)]
enum Target {
    Correct,
    ForgedId,
    StaleEpoch,
    OtherBeneficiary,
    OtherLine,
}

#[derive(Debug, Clone, Copy)]
enum TimeK {
    Acceptance(i8),
    Funding(i8),
    Submission(usize, i8),
    Review(usize, i8),
    Small(u64),
    Large(u64),
    /// Cutoff relevant to line i's current state (acceptance, funding,
    /// submission or review end) plus d ∈ {-1, 0, 1}; resolved by the harness.
    Relevant(usize, i8),
    /// LF-008: phase edge k of DISPUTED line i (0 primary start T0+N,
    /// 1 backup start T0+N+A, 2 fallback T0+N+A+B) plus d ∈ {-1, 0, 1}.
    Phase(usize, u8, i8),
}

#[derive(Debug, Clone, Copy)]
enum Action {
    AcceptTerms(Who, bool),
    AcceptAppointment(Who, bool),
    Fund(usize, Who, Amt),
    Submit(usize, Who, bool),
    AcceptLine(usize, Who),
    Dispute(usize, Who),
    Finalize(usize, ModeK, Split, u64),
    Withdraw(usize, Who, IdK),
    Resolve(usize, bool, Target, bool),
    Starve(usize, bool),
    Advance(TimeK),
    /// State-aware: the harness picks a plausible next step from the model.
    Guided(u64),
    /// LF-006b permissionless advance into NO_RESPONSE / NON_DELIVERY.
    AdvanceCase(usize),
    /// State-aware advance: an eligible line if any, else a premature attempt.
    GuidedAdvance(u64),
    /// LF-007 mutual settlement: propose (line, caller, split).
    ProposeSplit(usize, Who, Split),
    /// LF-007: accept (line, caller, which id, exact amounts?).
    AcceptSplit(usize, Who, PidK, bool),
}

impl Action {
    fn kind(&self) -> &'static str {
        match self {
            Action::AcceptTerms(..) => "accept_terms",
            Action::AcceptAppointment(..) => "accept_appointment",
            Action::Fund(..) => "fund",
            Action::Submit(..) => "submit",
            Action::AcceptLine(..) => "accept_line",
            Action::Dispute(..) => "dispute",
            Action::Finalize(..) => "finalize",
            Action::Withdraw(..) => "withdraw",
            Action::Resolve(_, _, _, true) => "resolve_success",
            Action::Resolve(_, _, _, false) => "resolve_failure",
            Action::Starve(..) => "starve",
            Action::Advance(..) => "advance",
            Action::Guided(..) => "guided",
            Action::AdvanceCase(..) => "advance_case",
            Action::GuidedAdvance(..) => "guided_advance",
            Action::ProposeSplit(..) => "propose_split",
            Action::AcceptSplit(..) => "accept_split",
        }
    }
}

// -------------------------------------------------------------- generators ---

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Normal,
    Extreme,
    Withdrawals,
    Boundaries,
    Invalid,
}

fn arb_who(valid_bias: bool) -> BoxedStrategy<Who> {
    if valid_bias {
        prop_oneof![
            4 => Just(Who::Buyer),
            4 => Just(Who::Supplier),
            1 => Just(Who::Primary),
            1 => Just(Who::Backup),
            1 => Just(Who::Stranger),
        ]
        .boxed()
    } else {
        prop_oneof![
            1 => Just(Who::Buyer),
            1 => Just(Who::Supplier),
            2 => Just(Who::Primary),
            2 => Just(Who::Backup),
            3 => Just(Who::Stranger),
        ]
        .boxed()
    }
}

fn arb_principal(extreme: bool) -> BoxedStrategy<u128> {
    if extreme {
        prop_oneof![
            4 => Just(u128::MAX),
            3 => (u128::MAX - 1_000)..=u128::MAX,
            1 => any::<u128>().prop_map(|x| x.max(1)),
            1 => 1u128..=3,
        ]
        .boxed()
    } else {
        prop_oneof![
            3 => 1u128..=1_000,
            3 => 1_000_000u128..=1_000_000_000_000,
            1 => any::<u128>().prop_map(|x| x.max(1)),
            1 => (u128::MAX - 1_000)..=u128::MAX,
            1 => Just(u128::MAX),
        ]
        .boxed()
    }
}

fn arb_window(default: u64) -> BoxedStrategy<u64> {
    prop_oneof![
        Just(MIN_WINDOW_NS),
        Just(MAX_WINDOW_NS),
        Just(default),
        MIN_WINDOW_NS..=MAX_WINDOW_NS,
    ]
    .boxed()
}

fn arb_terms(extreme: bool, tight_lines: bool) -> impl Strategy<Value = (AgreementTermsV1, u64)> {
    let line = (
        arb_principal(extreme),
        prop_oneof![Just(0u16), Just(10_000u16), 0u16..=10_000],
        0u64..=1_000_000_000_000,
        // F3: ~1 in 4 lines keeps a tight timeline (delivery soon after the
        // funding deadline, so the F3 delivery-time rule binds); the others
        // leave at least the review window after the funding deadline.
        prop::bool::weighted(if tight_lines { 0.25 } else { 0.0 }),
    );
    (
        proptest::collection::vec(line, 1..=3),
        prop_oneof![
            Just(0u64),
            Just(MAX_DELIVERY_GRACE_NS),
            0..=MAX_DELIVERY_GRACE_NS
        ],
        arb_window(DEFAULT_REVIEW_WINDOW_NS),
        arb_window(DEFAULT_NEGOTIATION_WINDOW_NS),
        arb_window(DEFAULT_PRIMARY_WINDOW_NS),
        arb_window(DEFAULT_BACKUP_WINDOW_NS),
        (
            1u64..=1_000_000_000_000,
            0u64..=1_000_000_000_000,
            0u64..=1_000,
        ),
        any::<u64>(),
    )
        .prop_map(move |(lines, grace, rv, ng, pr, bk, (a, b, k), nonce)| {
            // Tight lines put the F3 limit (delivery + grace − review) inside
            // [now, funding], so the −1 / 0 / +1 edge is reachable; others
            // leave at least the review window after the funding deadline.
            let span = (a + b).max(1);
            let off = |c: u64, tight: bool| {
                if tight {
                    rv.saturating_sub(grace).saturating_sub(c % span)
                } else {
                    c + rv
                }
            };
            let max_c = lines.iter().map(|l| off(l.2, l.3)).max().unwrap_or(0);
            // Timeline: now < acceptance <= funding <= delivery_i.
            let (now, acceptance, funding) = if extreme {
                // Latest possible phase end lands within 1 000 ns of u64::MAX.
                let tail = grace + rv + ng + pr + bk; // each <= 30 d: no overflow
                let latest_delivery = u64::MAX - tail - k;
                let funding = latest_delivery - max_c;
                let acceptance = funding - b;
                (acceptance - a, acceptance, funding)
            } else {
                let now = 1_800_000_000_000_000_000u64 + k;
                (now, now + a, now + a + b)
            };
            // Rule A: Σ principal must fit u128. If the drawn principals
            // overflow, scale each to ⌊p / n⌋ (≥ 1); single lines keep u128::MAX.
            let n = lines.len() as u128;
            let fits = lines
                .iter()
                .try_fold(0u128, |a, l| a.checked_add(l.0))
                .is_some();
            let lt = lines
                .iter()
                .enumerate()
                .map(|(i, &(p, s_bps, c, tight))| LineTermsV1 {
                    line_id: u32::try_from(i).expect("small"),
                    principal: if fits { p } else { (p / n).max(1) },
                    delivery_deadline_ns: funding + off(c, tight),
                    acceptance_criteria_commitment: [u8::try_from(i).expect("small") + 1; 32],
                    fallback_buyer_bps: 10_000 - s_bps,
                    fallback_supplier_bps: s_bps,
                })
                .collect();
            let terms = AgreementTermsV1 {
                schema_version: 1,
                deadline_rules_version: 1,
                buyer_id: id_of(Who::Buyer),
                supplier_id: id_of(Who::Supplier),
                primary_arbitrator_id: id_of(Who::Primary),
                backup_arbitrator_id: id_of(Who::Backup),
                ft_contract_id: ft(),
                agreement_nonce: nonce,
                acceptance_deadline_ns: acceptance,
                funding_deadline_ns: funding,
                delivery_grace_period_ns: grace,
                review_window_ns: rv,
                negotiation_window_ns: ng,
                primary_window_ns: pr,
                backup_window_ns: bk,
                lines: lt,
            };
            (terms, now)
        })
}

fn arb_time(mode: Mode) -> BoxedStrategy<TimeK> {
    let d = -1i8..=1;
    let cut = prop_oneof![
        d.clone().prop_map(TimeK::Acceptance),
        d.clone().prop_map(TimeK::Funding),
        (0usize..3, d.clone()).prop_map(|(i, d)| TimeK::Submission(i, d)),
        (0usize..3, d).prop_map(|(i, d)| TimeK::Review(i, d)),
    ];
    // Weighted toward cutoff − 1 so sequences keep progressing, while the
    // exact cutoff (0) and cutoff + 1 are still hit in ~40 % of jumps.
    let rel_d = prop_oneof![3 => Just(-1i8), 1 => Just(0i8), 1 => Just(1i8)];
    let relevant = (0usize..3, rel_d).prop_map(|(i, d)| TimeK::Relevant(i, d));
    if mode == Mode::Boundaries {
        prop_oneof![4 => relevant, 1 => cut].boxed()
    } else {
        prop_oneof![
            3 => relevant,
            2 => cut,
            2 => (1u64..=1_000).prop_map(TimeK::Small),
            1 => (1u64..=1_000_000_000_000).prop_map(TimeK::Large),
        ]
        .boxed()
    }
}

fn arb_action(mode: Mode) -> BoxedStrategy<Action> {
    let valid = mode != Mode::Invalid;
    let line = if valid {
        (0usize..3).boxed()
    } else {
        prop_oneof![3 => 0usize..3, 1 => Just(3usize)].boxed()
    };
    let who = arb_who(valid);
    let amt = if valid {
        prop_oneof![6 => Just(Amt::Exact), 1 => Just(Amt::Minus1), 1 => Just(Amt::Plus1), 1 => Just(Amt::Zero), 1 => Just(Amt::Max)].boxed()
    } else {
        prop_oneof![1 => Just(Amt::Exact), 2 => Just(Amt::Minus1), 2 => Just(Amt::Plus1), 2 => Just(Amt::Zero), 2 => Just(Amt::Max)].boxed()
    };
    let modek = prop_oneof![
        3 => Just(ModeK::Mutual), 2 => Just(ModeK::Primary), 2 => Just(ModeK::Backup), 3 => Just(ModeK::Fallback),
        1 => Just(ModeK::None), 1 => Just(ModeK::BuyerAccepted),
    ];
    let split = prop_oneof![
        3 => any::<u128>().prop_map(Split::Random),
        1 => Just(Split::ZeroBuyer), 1 => Just(Split::ZeroSupplier),
        3 => Just(Split::FallbackExact), 1 => Just(Split::FallbackOff),
        1 => Just(Split::SumLow), 1 => Just(Split::SumHigh),
    ];
    let idk = prop_oneof![6 => Just(IdK::Fresh), 1 => Just(IdK::ReuseSlot), 1 => Just(IdK::Zero)];
    let pidk = prop_oneof![5 => Just(PidK::Current), 1 => Just(PidK::Previous), 1 => Just(PidK::Next), 1 => Just(PidK::Zero)];
    let target = prop_oneof![
        5 => Just(Target::Correct), 1 => Just(Target::ForgedId), 1 => Just(Target::StaleEpoch),
        1 => Just(Target::OtherBeneficiary), 1 => Just(Target::OtherLine),
    ];
    let w_accept = if mode == Mode::Withdrawals { 1 } else { 2 };
    let (w_flow, w_wd) = match mode {
        Mode::Withdrawals => (1, 8),
        _ => (4, 3),
    };
    let w_guided = match mode {
        Mode::Invalid => 8,
        Mode::Withdrawals => 20,
        _ => 40,
    };
    prop_oneof![
        w_guided => any::<u64>().prop_map(Action::Guided),
        2 => (0usize..4).prop_map(Action::AdvanceCase),
        6 => any::<u64>().prop_map(Action::GuidedAdvance),
        w_accept => (who.clone(), prop::bool::weighted(0.9)).prop_map(|(w, h)| Action::AcceptTerms(w, h)),
        w_accept => (who.clone(), prop::bool::weighted(0.9)).prop_map(|(w, h)| Action::AcceptAppointment(w, h)),
        w_flow => (line.clone(), who.clone(), amt).prop_map(|(l, w, a)| Action::Fund(l, w, a)),
        w_flow => (line.clone(), who.clone(), prop::bool::weighted(0.1)).prop_map(|(l, w, z)| Action::Submit(l, w, z)),
        w_flow => (line.clone(), who.clone()).prop_map(|(l, w)| Action::AcceptLine(l, w)),
        w_flow => (line.clone(), who.clone()).prop_map(|(l, w)| Action::Dispute(l, w)),
        w_flow => (line.clone(), modek, split.clone(), any::<u64>()).prop_map(|(l, m, s, src)| Action::Finalize(l, m, s, src)),
        w_flow => (line.clone(), who.clone(), split).prop_map(|(l, w, s)| Action::ProposeSplit(l, w, s)),
        w_flow => (line.clone(), who.clone(), pidk, prop::bool::weighted(0.8)).prop_map(|(l, w, k, e)| Action::AcceptSplit(l, w, k, e)),
        w_wd => (line.clone(), who, idk).prop_map(|(l, w, k)| Action::Withdraw(l, w, k)),
        w_wd => (line.clone(), any::<bool>(), target, any::<bool>()).prop_map(|(l, b, t, s)| Action::Resolve(l, b, t, s)),
        1 => (line, any::<bool>()).prop_map(|(l, b)| Action::Starve(l, b)),
        3 => arb_time(mode).prop_map(Action::Advance),
    ]
    .boxed()
}

#[derive(Debug, Clone)]
struct Scenario {
    terms: AgreementTermsV1,
    now: u64,
    pre_accepted: bool,
    actions: Vec<Action>,
}

fn arb_scenario(mode: Mode) -> impl Strategy<Value = Scenario> {
    let extreme = mode == Mode::Extreme;
    let actions = if mode == Mode::Boundaries {
        // Every action preceded by a jump to an exact cutoff −1/0/+1.
        proptest::collection::vec((arb_time(mode), arb_action(mode)), 1..=MAX_ACTIONS / 2)
            .prop_map(|v| {
                v.into_iter()
                    .flat_map(|(t, a)| [Action::Advance(t), a])
                    .collect()
            })
            .boxed()
    } else {
        proptest::collection::vec(arb_action(mode), 1..=MAX_ACTIONS).boxed()
    };
    // F3 tight lines only where funding edges are explored (P1, P2, P4).
    // P3 (fixed withdrawal prefix needs every line fundable) and P5
    // (rejection atomicity) keep the pre-F3 timeline distribution; their
    // oracle still includes the F3 rule.
    let tight = matches!(mode, Mode::Normal | Mode::Extreme | Mode::Boundaries);
    (
        arb_terms(extreme, tight),
        prop::bool::weighted(0.85),
        actions,
    )
        .prop_map(|((terms, now), pre_accepted, actions)| Scenario {
            terms,
            now,
            pre_accepted,
            actions,
        })
}

/// Concrete (buyer, supplier) amounts for a `Split` of principal `p`
/// (shared by Finalize and ProposeSplit; may deliberately not sum to `p`).
fn split_amounts(p: u128, s_bps: u16, split: Split) -> Result<(u128, u128), TestCaseError> {
    let fb = split_bps(p, s_bps).map_err(|e| fail(format!("split {e:?}")))?;
    Ok(match split {
        Split::Random(r) => {
            let b = if p == u128::MAX { r } else { r % (p + 1) };
            (b, p - b)
        }
        Split::ZeroBuyer => (0, p),
        Split::ZeroSupplier => (p, 0),
        Split::FallbackExact => fb,
        Split::FallbackOff => {
            if fb.1 > 0 {
                (fb.0 + 1, fb.1 - 1)
            } else {
                (fb.0 - 1, fb.1 + 1)
            }
        }
        Split::SumLow => (0, p - 1),
        Split::SumHigh => (p, 1),
    })
}

/// LF-008: who submits a `Finalize` ruling attempt. Usually the arbitrator
/// of the requested mode; 1 in 16 an adversarial caller (buyer, supplier,
/// stranger or the *other* arbitrator); other modes are non-arbitrators.
fn finalize_caller(mk: ModeK, src: u64) -> Who {
    let wrong = [Who::Buyer, Who::Supplier, Who::Stranger];
    match mk {
        ModeK::Primary | ModeK::Backup if (src >> 40) % 16 == 15 => match (src >> 44) % 4 {
            3 if matches!(mk, ModeK::Primary) => Who::Backup,
            3 => Who::Primary,
            k => wrong[k as usize],
        },
        ModeK::Primary => Who::Primary,
        ModeK::Backup => Who::Backup,
        ModeK::Mutual => Who::Buyer,
        ModeK::None => Who::Supplier,
        _ => Who::Stranger,
    }
}

// ------------------------------------------------------------ shadow model ---

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MSlot {
    state: SlotState,
    id: u64,
    epoch: u32,
    amount: u128,
}

const EMPTY_SLOT: MSlot = MSlot {
    state: SlotState::Empty,
    id: 0,
    epoch: 0,
    amount: 0,
};

/// Buckets: 0 locked, 1 buyer_claimable, 2 supplier_claimable, 3 buyer_pending,
/// 4 supplier_pending, 5 buyer_paid, 6 supplier_paid.
#[derive(Debug, Clone, PartialEq, Eq)]
struct MLine {
    status: LineStatus,
    b: [u128; 7],
    submitted_at: u64,
    alloc: Option<(AllocationMode, u128, u128, u64)>,
    slots: [MSlot; 2],
    /// (dispute_reason, dispute_t0) as the oracle expects them.
    dispute: (DisputeReason, u64),
    /// LF-007 proposal record as the oracle expects it.
    prop: SplitProposalV1,
}

#[derive(Debug, Clone)]
struct Model {
    acc: [bool; 4],
    agreed: bool,
    active: bool,
    lines: Vec<MLine>,
    /// Σ recognized fundings as a 256-bit (hi, lo) pair: several lines near
    /// u128::MAX can exceed u128 in aggregate (each line alone cannot).
    funded_total: (u128, u128),
}

/// 256-bit accumulate: (hi, lo) + x.
fn add256(acc: (u128, u128), x: u128) -> (u128, u128) {
    let (lo, carry) = acc.1.overflowing_add(x);
    (acc.0 + u128::from(carry), lo)
}

fn status_rank(s: LineStatus) -> u8 {
    match s {
        LineStatus::Unfunded => 0,
        LineStatus::Funded => 1,
        LineStatus::Submitted => 2,
        LineStatus::Disputed => 3,
        LineStatus::Allocated => 4,
    }
}

// ----------------------------------------------------------------- harness ---

type Stats = RefCell<BTreeMap<&'static str, (u64, u64)>>;

struct Harness<'s> {
    t: AgreementTermsV1,
    a: AgreementV1,
    hash: [u8; 32],
    now: u64,
    m: Model,
    next_id: u64,
    starved: Vec<(usize, usize, MSlot)>,
    agreement_len: usize,
    stats: &'s Stats,
}

fn fail(msg: String) -> TestCaseError {
    TestCaseError::fail(msg)
}

macro_rules! check {
    ($cond:expr, $($arg:tt)*) => {
        if !$cond {
            return Err(fail(format!($($arg)*)));
        }
    };
}

fn bytes<T: borsh::BorshSerialize>(x: &T) -> Vec<u8> {
    borsh::to_vec(x).expect("borsh")
}

impl<'s> Harness<'s> {
    fn new(sc: &Scenario, stats: &'s Stats) -> Result<Self, TestCaseError> {
        let (e, f, tr) = (escrow(), ft(), treasury());
        let ctx = ValidationContext {
            now_ns: sc.now,
            escrow_id: &e,
            allowlisted_ft_id: &f,
            operator_treasury_id: &tr,
        };
        check!(
            sc.terms.validate(&ctx).is_ok(),
            "generator produced invalid terms: {:?}",
            sc.terms.validate(&ctx)
        );
        let hash = terms_hash(NetworkId::Sandbox, &e, &sc.terms);
        let mut a = AgreementV1::propose(sc.terms.clone(), hash, sc.now);
        let n = sc.terms.lines.len();
        let mut m = Model {
            acc: [false; 4],
            agreed: false,
            active: false,
            lines: vec![
                MLine {
                    status: LineStatus::Unfunded,
                    b: [0; 7],
                    submitted_at: 0,
                    alloc: None,
                    slots: [EMPTY_SLOT; 2],
                    dispute: (DisputeReason::None, 0),
                    prop: SplitProposalV1::EMPTY,
                };
                n
            ],
            funded_total: (0, 0),
        };
        if sc.pre_accepted {
            for (k, w) in [
                (AcceptKind::Terms, Who::Buyer),
                (AcceptKind::Terms, Who::Supplier),
                (AcceptKind::Appointment, Who::Primary),
                (AcceptKind::Appointment, Who::Backup),
            ] {
                a.accept(k, &id_of(w), &hash, sc.now)
                    .map_err(|e| fail(format!("pre-accept {e:?}")))?;
            }
            m.acc = [true; 4];
            m.agreed = true;
        }
        let agreement_len = bytes(&a).len();
        let h = Harness {
            t: sc.terms.clone(),
            a,
            hash,
            now: sc.now,
            m,
            next_id: 1,
            starved: Vec::new(),
            agreement_len,
            stats,
        };
        h.check_all(None)?;
        Ok(h)
    }

    fn n(&self) -> usize {
        self.t.lines.len()
    }

    fn p(&self, i: usize) -> u128 {
        self.t.lines[i].principal
    }

    fn params(&self, i: usize) -> LineParams {
        LineParams {
            principal: self.t.lines[i].principal,
            fallback_supplier_bps: self.t.lines[i].fallback_supplier_bps,
            funding_deadline_ns: self.t.funding_deadline_ns,
            delivery_deadline_ns: self.t.lines[i].delivery_deadline_ns,
            delivery_grace_ns: self.t.delivery_grace_period_ns,
            review_window_ns: self.t.review_window_ns,
            negotiation_window_ns: self.t.negotiation_window_ns,
            primary_window_ns: self.t.primary_window_ns,
            backup_window_ns: self.t.backup_window_ns,
        }
    }

    // Oracle time rules (u128, independent of production u64 code).
    fn submission_open(&self, i: usize) -> bool {
        u128::from(self.now)
            < u128::from(self.t.lines[i].delivery_deadline_ns)
                + u128::from(self.t.delivery_grace_period_ns)
    }
    /// F3 oracle (u128, independent of the u64 production code):
    /// now + review_window <= delivery_deadline + grace.
    fn f3_time_ok(&self, i: usize) -> bool {
        i < self.n()
            && u128::from(self.now) + u128::from(self.t.review_window_ns)
                <= u128::from(self.t.lines[i].delivery_deadline_ns)
                    + u128::from(self.t.delivery_grace_period_ns)
    }
    fn f3_limit(&self, i: usize) -> Option<u128> {
        (u128::from(self.t.lines[i].delivery_deadline_ns)
            + u128::from(self.t.delivery_grace_period_ns))
        .checked_sub(u128::from(self.t.review_window_ns))
    }
    fn review_open(&self, i: usize) -> bool {
        let s = u128::from(self.m.lines[i].submitted_at);
        let n = u128::from(self.now);
        s <= n && n < s + u128::from(self.t.review_window_ns)
    }

    fn record(&self, kind: &'static str, ok: bool) {
        let mut st = self.stats.borrow_mut();
        let e = st.entry(kind).or_insert((0, 0));
        if ok { e.0 += 1 } else { e.1 += 1 }
    }

    /// Apply one action: oracle prediction, real call, comparison, invariants.
    /// Resolve `Guided(seed)` into a concrete, spec-plausible next action
    /// from the shadow model (it may still be rejected, e.g. by time; the
    /// oracle judges it like any other action).
    fn guide(&self, seed: u64) -> Action {
        let r = seed >> 8;
        if !self.m.agreed {
            let missing: Vec<usize> = (0..4).filter(|&k| !self.m.acc[k]).collect();
            let k = missing[(r as usize) % missing.len()];
            return match k {
                0 => Action::AcceptTerms(Who::Buyer, true),
                1 => Action::AcceptTerms(Who::Supplier, true),
                2 => Action::AcceptAppointment(Who::Primary, true),
                _ => Action::AcceptAppointment(Who::Backup, true),
            };
        }
        let i = (seed as usize) % self.n();
        let l = &self.m.lines[i];
        match l.status {
            LineStatus::Unfunded => Action::Fund(i, Who::Buyer, Amt::Exact),
            LineStatus::Funded => Action::Submit(i, Who::Supplier, false),
            LineStatus::Submitted => {
                if r.is_multiple_of(2) {
                    Action::AcceptLine(i, Who::Buyer)
                } else {
                    Action::Dispute(i, Who::Buyer)
                }
            }
            LineStatus::Disputed => {
                let wide = u128::from(r) | (u128::from(r.rotate_left(17)) << 64);
                let (mode, split) = match r % 7 {
                    0 => (ModeK::Fallback, Split::FallbackExact),
                    1 => (ModeK::Mutual, Split::ZeroBuyer),
                    2 => (ModeK::Primary, Split::ZeroSupplier),
                    3 => (ModeK::Backup, Split::Random(wide)),
                    4 => (ModeK::Primary, Split::Random(wide)),
                    _ => (ModeK::Mutual, Split::Random(wide)),
                };
                if matches!(mode, ModeK::Mutual) {
                    // LF-007: a mutual split is a proposal plus the
                    // counterparty's acceptance of exactly that proposal.
                    let pr = l.prop;
                    if pr.status == ProposalStatus::Open && !(r >> 3).is_multiple_of(4) {
                        let who = if pr.proposer == Proposer::Buyer {
                            Who::Supplier
                        } else {
                            Who::Buyer
                        };
                        return Action::AcceptSplit(i, who, PidK::Current, true);
                    }
                    let who = if (r >> 5).is_multiple_of(2) {
                        Who::Buyer
                    } else {
                        Who::Supplier
                    };
                    return Action::ProposeSplit(i, who, split);
                }
                // LF-008: act according to the line's current phase (oracle,
                // u128), or jump to a phase edge −1 / 0 / +1.
                let t0 = u128::from(l.dispute.1);
                let ps = t0 + u128::from(self.t.negotiation_window_ns);
                let bs = ps + u128::from(self.t.primary_window_ns);
                let fs = bs + u128::from(self.t.backup_window_ns);
                let n = u128::from(self.now);
                let d = [-1i8, 0, 1, 0, 1][((r >> 9) % 5) as usize];
                let jump = |k: u8| Action::Advance(TimeK::Phase(i, k, d));
                let phase = if n < ps {
                    1
                } else if n < bs {
                    2
                } else if n < fs {
                    3
                } else {
                    4
                };
                match (phase, (r >> 12) % 8) {
                    (1, _) => jump(((r >> 15) % 3) as u8),
                    (2, 7) => jump(1),
                    (3, 7) => jump(2),
                    (2, 6) => Action::Finalize(i, ModeK::Backup, split, r),
                    (3, 6) => Action::Finalize(i, ModeK::Primary, split, r),
                    (4, 6) => Action::Finalize(i, ModeK::Backup, split, r),
                    (2, _) => Action::Finalize(i, ModeK::Primary, split, r),
                    (3, _) => Action::Finalize(i, ModeK::Backup, split, r),
                    _ => Action::Finalize(i, ModeK::Fallback, Split::FallbackExact, r),
                }
            }
            LineStatus::Allocated => {
                for k in 0..2 {
                    let bi = ((r as usize) + k) % 2;
                    let slot = l.slots[bi];
                    if slot.state == SlotState::Pending {
                        return match r % 8 {
                            0 => Action::Starve(i, bi == 0),
                            1..=5 => Action::Resolve(i, bi == 0, Target::Correct, true),
                            _ => Action::Resolve(i, bi == 0, Target::Correct, false),
                        };
                    }
                    if l.b[1 + bi] > 0 {
                        let who = if bi == 0 { Who::Buyer } else { Who::Supplier };
                        return Action::Withdraw(i, who, IdK::Fresh);
                    }
                }
                Action::Advance(TimeK::Small(1))
            }
        }
    }

    fn step(&mut self, act: Action) -> Result<(), TestCaseError> {
        let act = match act {
            Action::Guided(seed) => {
                self.record("guided", true);
                self.guide(seed)
            }
            Action::GuidedAdvance(seed) => {
                self.record("guided_advance", true);
                let n = u128::from(self.now);
                let eligible: Vec<usize> = (0..self.n())
                    .filter(|&i| match self.m.lines[i].status {
                        LineStatus::Funded => !self.submission_open(i),
                        LineStatus::Submitted => {
                            n >= u128::from(self.m.lines[i].submitted_at)
                                + u128::from(self.t.review_window_ns)
                        }
                        _ => false,
                    })
                    .collect();
                match eligible.get((seed as usize) % eligible.len().max(1)) {
                    Some(&i) => Action::AdvanceCase(i),
                    None => Action::AdvanceCase((seed as usize) % self.n()),
                }
            }
            other => other,
        };
        let before = bytes(&self.a);
        let before_lines: Vec<Vec<u8>> = self.a.lines.iter().map(bytes).collect();
        let before_real = self.a.clone();
        let terms_bytes = bytes(&self.a.terms);
        // `None` = no call was made (no-op action).
        let (real_ok, predicted, line_target): (Option<bool>, Option<bool>, Option<usize>) =
            match act {
                Action::AcceptTerms(w, good) | Action::AcceptAppointment(w, good) => {
                    let (kind, role) = match (act, w) {
                        (Action::AcceptTerms(..), Who::Buyer) => (AcceptKind::Terms, Some(0)),
                        (Action::AcceptTerms(..), Who::Supplier) => (AcceptKind::Terms, Some(1)),
                        (Action::AcceptTerms(..), _) => (AcceptKind::Terms, None),
                        (_, Who::Primary) => (AcceptKind::Appointment, Some(2)),
                        (_, Who::Backup) => (AcceptKind::Appointment, Some(3)),
                        _ => (AcceptKind::Appointment, None),
                    };
                    let mut h = self.hash;
                    if !good {
                        h[0] ^= 1;
                    }
                    let pred = role.is_some_and(|r| !self.m.acc[r])
                        && self.now < self.t.acceptance_deadline_ns
                        && good;
                    let r = self.a.accept(kind, &id_of(w), &h, self.now).is_ok();
                    if pred {
                        self.m.acc[role.expect("role")] = true;
                        if self.m.acc.iter().all(|&x| x) {
                            self.m.agreed = true;
                        }
                    }
                    (Some(r), Some(pred), None)
                }
                Action::Fund(i, w, amt) => {
                    let p = if i < self.n() { self.p(i) } else { 1 };
                    let amount = match amt {
                        Amt::Exact => p,
                        Amt::Minus1 => p - 1,
                        Amt::Plus1 => p.checked_add(1).unwrap_or(0),
                        Amt::Zero => 0,
                        Amt::Max => u128::MAX,
                    };
                    let pred = i < self.n()
                        && self.m.agreed
                        && w == Who::Buyer
                        && self.m.lines[i].status == LineStatus::Unfunded
                        && self.now < self.t.funding_deadline_ns
                        && self.f3_time_ok(i)
                        && amount == p;
                    let r = self
                        .a
                        .fund_line(i as u32, &id_of(w), amount, self.now)
                        .is_ok();
                    if pred {
                        let l = &mut self.m.lines[i];
                        l.status = LineStatus::Funded;
                        l.b[0] = p;
                        self.m.active = true;
                        self.m.funded_total = add256(self.m.funded_total, p);
                    }
                    (Some(r), Some(pred), Some(i))
                }
                Action::Submit(i, w, zero) => {
                    let c = if zero { [0u8; 32] } else { [0xA5; 32] };
                    let pred = i < self.n()
                        && w == Who::Supplier
                        && self.m.lines[i].status == LineStatus::Funded
                        && self.submission_open(i)
                        && !zero;
                    let r = self
                        .a
                        .submit_delivery(i as u32, &id_of(w), c, self.now)
                        .is_ok();
                    if pred {
                        self.m.lines[i].status = LineStatus::Submitted;
                        self.m.lines[i].submitted_at = self.now;
                    }
                    (Some(r), Some(pred), Some(i))
                }
                Action::AcceptLine(i, w) | Action::Dispute(i, w) => {
                    let accept = matches!(act, Action::AcceptLine(..));
                    let pred = i < self.n()
                        && w == Who::Buyer
                        && self.m.lines[i].status == LineStatus::Submitted
                        && self.review_open(i);
                    let r = if accept {
                        self.a.accept_line(i as u32, &id_of(w), self.now).is_ok()
                    } else {
                        self.a.open_dispute(i as u32, &id_of(w), self.now).is_ok()
                    };
                    if pred {
                        let p = self.p(i);
                        let now = self.now;
                        let l = &mut self.m.lines[i];
                        if accept {
                            l.status = LineStatus::Allocated;
                            l.alloc = Some((AllocationMode::BuyerAccepted, 0, p, 0));
                            l.b[0] = 0;
                            l.b[2] = p;
                        } else {
                            l.status = LineStatus::Disputed;
                            l.dispute = (DisputeReason::BuyerDispute, now);
                        }
                    }
                    (Some(r), Some(pred), Some(i))
                }
                Action::Finalize(i, mk, split, src) => {
                    // LF-008: authority- and time-gated finalization. Primary /
                    // Backup = `submit_ruling` by a caller (usually the right
                    // arbitrator, sometimes adversarial), Fallback =
                    // permissionless `trigger_fallback`; any other mode is a
                    // ruling attempt by a non-arbitrator. Mutual only via LF-007.
                    let (p, s_bps) = if i < self.n() {
                        (self.p(i), self.t.lines[i].fallback_supplier_bps)
                    } else {
                        (1, 0)
                    };
                    let fb = split_bps(p, s_bps).map_err(|e| fail(format!("split {e:?}")))?;
                    let (bb, ss) = split_amounts(p, s_bps, split)?;
                    let caller = finalize_caller(mk, src);
                    // Oracle phase (u128, independent of production u64 code).
                    let phase = if i < self.n() && self.m.lines[i].status == LineStatus::Disputed {
                        let t0 = u128::from(self.m.lines[i].dispute.1);
                        let ps = t0 + u128::from(self.t.negotiation_window_ns);
                        let bs = ps + u128::from(self.t.primary_window_ns);
                        let fs = bs + u128::from(self.t.backup_window_ns);
                        let n = u128::from(self.now);
                        Some(if n < t0 {
                            0u8
                        } else if n < ps {
                            1
                        } else if n < bs {
                            2
                        } else if n < fs {
                            3
                        } else {
                            4
                        })
                    } else {
                        None
                    };
                    let sum_ok = bb.checked_add(ss) == Some(p);
                    let (pred, mode, amounts, r) = match mk {
                        ModeK::Fallback => {
                            let r = self.a.trigger_fallback(i as u32, self.now).is_ok();
                            (phase == Some(4), AllocationMode::Fallback, fb, r)
                        }
                        _ => {
                            let r = self
                                .a
                                .submit_ruling(i as u32, &id_of(caller), bb, ss, self.now)
                                .is_ok();
                            let (mode, window) = match caller {
                                Who::Primary => (AllocationMode::PrimaryRuling, 2u8),
                                Who::Backup => (AllocationMode::BackupRuling, 3u8),
                                _ => (AllocationMode::None, 99u8),
                            };
                            (phase == Some(window) && sum_ok, mode, (bb, ss), r)
                        }
                    };
                    if pred {
                        let l = &mut self.m.lines[i];
                        l.status = LineStatus::Allocated;
                        l.alloc = Some((mode, amounts.0, amounts.1, 0));
                        l.b[0] = 0;
                        l.b[1] = amounts.0;
                        l.b[2] = amounts.1;
                    }
                    (Some(r), Some(pred), Some(i))
                }
                Action::Withdraw(i, w, idk) => {
                    let ben = match w {
                        Who::Buyer => Some(0usize),
                        Who::Supplier => Some(1),
                        _ => None,
                    };
                    let slot = if i < self.n() {
                        self.m.lines[i].slots[ben.unwrap_or(0)]
                    } else {
                        EMPTY_SLOT
                    };
                    let id = match idk {
                        IdK::Fresh => {
                            let x = self.next_id;
                            self.next_id += 1;
                            x
                        }
                        IdK::ReuseSlot => slot.id,
                        IdK::Zero => 0,
                    };
                    let pred = i < self.n()
                        && ben.is_some()
                        && self.m.lines[i].status == LineStatus::Allocated
                        && slot.state != SlotState::Pending
                        && self.m.lines[i].b[1 + ben.unwrap_or(0)] > 0
                        && (slot.state == SlotState::Empty || id > slot.id);
                    let res = self.a.begin_withdrawal(i as u32, &id_of(w), id, self.now);
                    if let (Ok((t, recipient)), true) = (&res, pred) {
                        let bi = ben.expect("ben");
                        let l = &mut self.m.lines[i];
                        let amount = l.b[1 + bi];
                        check!(
                            t.amount == amount
                                && t.withdrawal_id == id
                                && t.epoch == slot.epoch + 1,
                            "ticket {t:?} vs model amount {amount} id {id}"
                        );
                        check!(
                            *recipient == id_of(w),
                            "recipient {recipient} is not the beneficiary {w:?}"
                        );
                        l.b[1 + bi] = 0;
                        l.b[3 + bi] = amount;
                        l.slots[bi] = MSlot {
                            state: SlotState::Pending,
                            id,
                            epoch: slot.epoch + 1,
                            amount,
                        };
                    }
                    (Some(res.is_ok()), Some(pred), Some(i))
                }
                Action::Resolve(i, buyer, target, success) => {
                    let bi = if buyer { 0 } else { 1 };
                    let b = if buyer {
                        Beneficiary::Buyer
                    } else {
                        Beneficiary::Supplier
                    };
                    let own = if i < self.n() {
                        self.m.lines[i].slots[bi]
                    } else {
                        EMPTY_SLOT
                    };
                    let (line_call, id, epoch) = match target {
                        Target::Correct => (i, own.id, own.epoch),
                        Target::ForgedId => (i, own.id.wrapping_add(1_000), own.epoch),
                        Target::StaleEpoch => (i, own.id, own.epoch.wrapping_sub(1)),
                        Target::OtherBeneficiary => {
                            let other = if i < self.n() {
                                self.m.lines[i].slots[1 - bi]
                            } else {
                                EMPTY_SLOT
                            };
                            (i, other.id, other.epoch)
                        }
                        Target::OtherLine => ((i + 1) % self.n().max(1), own.id, own.epoch),
                    };
                    let tgt = if line_call < self.n() {
                        self.m.lines[line_call].slots[bi]
                    } else {
                        EMPTY_SLOT
                    };
                    let would_match = line_call < self.n()
                        && tgt.state == SlotState::Pending
                        && id == tgt.id
                        && epoch == tgt.epoch;
                    // A starved withdrawal's callback never arrives.
                    if would_match
                        && self
                            .starved
                            .iter()
                            .any(|&(l, s, _)| l == line_call && s == bi)
                    {
                        self.record("resolve_suppressed_starved", true);
                        (None, None, None)
                    } else {
                        let outcome = if success {
                            WithdrawalOutcome::Success
                        } else {
                            WithdrawalOutcome::DefiniteFailure
                        };
                        let r = self
                            .a
                            .resolve_withdrawal(line_call as u32, b, id, epoch, outcome, self.now)
                            .is_ok();
                        if would_match {
                            let l = &mut self.m.lines[line_call];
                            let amt = tgt.amount;
                            l.b[3 + bi] = 0;
                            if success {
                                l.b[5 + bi] += amt;
                                l.slots[bi].state = SlotState::Paid;
                            } else {
                                l.b[1 + bi] = amt;
                                l.slots[bi].state = SlotState::Failed;
                            }
                        }
                        (Some(r), Some(would_match), Some(line_call))
                    }
                }
                Action::Starve(i, buyer) => {
                    let bi = if buyer { 0 } else { 1 };
                    if i < self.n()
                        && self.m.lines[i].slots[bi].state == SlotState::Pending
                        && !self.starved.iter().any(|&(l, s, _)| l == i && s == bi)
                    {
                        self.starved.push((i, bi, self.m.lines[i].slots[bi]));
                    }
                    (None, None, None)
                }
                Action::AdvanceCase(i) => {
                    // Oracle: u128 arithmetic straight from docs/08 / docs/06 §advance_case.
                    let (pred, reason, t0) = if i < self.n() {
                        let ml = &self.m.lines[i];
                        let n = u128::from(self.now);
                        match ml.status {
                            LineStatus::Submitted => {
                                let t0 = u128::from(ml.submitted_at)
                                    + u128::from(self.t.review_window_ns);
                                (n >= t0, DisputeReason::NoResponse, t0)
                            }
                            LineStatus::Funded => {
                                let t0 = u128::from(self.t.lines[i].delivery_deadline_ns)
                                    + u128::from(self.t.delivery_grace_period_ns);
                                (n >= t0, DisputeReason::NonDelivery, t0)
                            }
                            _ => (false, DisputeReason::None, 0),
                        }
                    } else {
                        (false, DisputeReason::None, 0)
                    };
                    let r = self.a.advance_case(i as u32, self.now).is_ok();
                    if pred {
                        let t0 = u64::try_from(t0).map_err(|_| fail("t0 overflow".into()))?;
                        let l = &mut self.m.lines[i];
                        l.status = LineStatus::Disputed;
                        l.dispute = (reason, t0);
                    }
                    (Some(r), Some(pred), Some(i))
                }
                Action::ProposeSplit(i, w, split) => {
                    let p = if i < self.n() { self.p(i) } else { 1 };
                    let s_bps = if i < self.n() {
                        self.t.lines[i].fallback_supplier_bps
                    } else {
                        0
                    };
                    let (bb, ss) = split_amounts(p, s_bps, split)?;
                    let proposer = match w {
                        Who::Buyer => Some(Proposer::Buyer),
                        Who::Supplier => Some(Proposer::Supplier),
                        _ => None,
                    };
                    // Oracle (docs/06 §Authorization, docs/08): buyer or
                    // supplier, DISPUTED, now >= T0, B + S == P (u128-exact
                    // via checked_add), next nonce fits u64.
                    let pred = i < self.n()
                        && proposer.is_some()
                        && self.m.lines[i].status == LineStatus::Disputed
                        && u128::from(self.now) >= u128::from(self.m.lines[i].dispute.1)
                        && bb.checked_add(ss) == Some(p)
                        && self.m.lines[i].prop.proposal_id < u64::MAX;
                    let r = self.a.propose_split(i as u32, &id_of(w), bb, ss, self.now);
                    if pred {
                        let l = &mut self.m.lines[i];
                        let id = l.prop.proposal_id + 1;
                        check!(r == Ok(id), "propose_split returned {r:?}, model id {id}");
                        l.prop = SplitProposalV1 {
                            status: ProposalStatus::Open,
                            proposer: proposer.expect("party"),
                            proposal_id: id,
                            buyer_amount: bb,
                            supplier_amount: ss,
                            created_at_ns: self.now,
                        };
                    }
                    (Some(r.is_ok()), Some(pred), Some(i))
                }
                Action::AcceptSplit(i, w, pk, exact) => {
                    let mp = if i < self.n() {
                        self.m.lines[i].prop
                    } else {
                        SplitProposalV1::EMPTY
                    };
                    let pid = match pk {
                        PidK::Current => mp.proposal_id,
                        PidK::Previous => mp.proposal_id.wrapping_sub(1),
                        PidK::Next => mp.proposal_id.wrapping_add(1),
                        PidK::Zero => 0,
                    };
                    let (bb, ss) = if exact {
                        (mp.buyer_amount, mp.supplier_amount)
                    } else if mp.supplier_amount > 0 {
                        (mp.buyer_amount.wrapping_add(1), mp.supplier_amount - 1)
                    } else {
                        (mp.buyer_amount.wrapping_sub(1), 1)
                    };
                    let acceptor = match w {
                        Who::Buyer => Some(Proposer::Buyer),
                        Who::Supplier => Some(Proposer::Supplier),
                        _ => None,
                    };
                    let pred = i < self.n()
                        && self.m.lines[i].status == LineStatus::Disputed
                        && u128::from(self.now) >= u128::from(self.m.lines[i].dispute.1)
                        && mp.status == ProposalStatus::Open
                        && pid == mp.proposal_id
                        && (bb, ss) == (mp.buyer_amount, mp.supplier_amount)
                        && acceptor.is_some()
                        && acceptor != Some(mp.proposer);
                    let r = self
                        .a
                        .accept_split(i as u32, &id_of(w), pid, bb, ss, self.now)
                        .is_ok();
                    if !r && mp.status == ProposalStatus::Open {
                        if pid != mp.proposal_id {
                            self.record("accept_split_stale_rejected", true);
                        } else if (bb, ss) != (mp.buyer_amount, mp.supplier_amount) {
                            self.record("accept_split_mismatch_rejected", true);
                        } else if acceptor == Some(mp.proposer) {
                            self.record("accept_split_own_rejected", true);
                        } else if acceptor.is_none() {
                            self.record("accept_split_unauthorized_rejected", true);
                        }
                    }
                    if pred {
                        let l = &mut self.m.lines[i];
                        l.status = LineStatus::Allocated;
                        l.alloc = Some((AllocationMode::Mutual, bb, ss, pid));
                        l.b[0] = 0;
                        l.b[1] = bb;
                        l.b[2] = ss;
                        l.prop.status = ProposalStatus::Accepted;
                    }
                    (Some(r), Some(pred), Some(i))
                }
                Action::Guided(_) | Action::GuidedAdvance(_) => {
                    return Err(fail("guided action was not resolved".into()));
                }
                Action::Advance(k) => {
                    let base: Option<i128> = match k {
                        TimeK::Acceptance(d) => {
                            Some(i128::from(self.t.acceptance_deadline_ns) + i128::from(d))
                        }
                        TimeK::Funding(d) => {
                            Some(i128::from(self.t.funding_deadline_ns) + i128::from(d))
                        }
                        TimeK::Submission(i, d) if i < self.n() => Some(
                            i128::from(self.t.lines[i].delivery_deadline_ns)
                                + i128::from(self.t.delivery_grace_period_ns)
                                + i128::from(d),
                        ),
                        TimeK::Review(i, d)
                            if i < self.n() && self.m.lines[i].status == LineStatus::Submitted =>
                        {
                            Some(
                                i128::from(self.m.lines[i].submitted_at)
                                    + i128::from(self.t.review_window_ns)
                                    + i128::from(d),
                            )
                        }
                        TimeK::Small(x) | TimeK::Large(x) => {
                            Some(i128::from(self.now) + i128::from(x))
                        }
                        TimeK::Phase(i, k, d)
                            if i < self.n() && self.m.lines[i].status == LineStatus::Disputed =>
                        {
                            let mut t = i128::from(self.m.lines[i].dispute.1);
                            let w = [
                                self.t.negotiation_window_ns,
                                self.t.primary_window_ns,
                                self.t.backup_window_ns,
                            ];
                            for x in w.iter().take(usize::from(k) + 1) {
                                t += i128::from(*x);
                            }
                            Some(t + i128::from(d))
                        }
                        TimeK::Relevant(i, d) => {
                            let i = i % self.n();
                            let base = if !self.m.agreed {
                                Some(self.t.acceptance_deadline_ns)
                            } else {
                                match self.m.lines[i].status {
                                    LineStatus::Unfunded => Some(match self.f3_limit(i) {
                                        Some(l)
                                            if l + 1 < u128::from(self.t.funding_deadline_ns) =>
                                        {
                                            u64::try_from(l + 1)
                                                .unwrap_or(self.t.funding_deadline_ns)
                                        }
                                        _ => self.t.funding_deadline_ns,
                                    }),
                                    LineStatus::Funded => Some(
                                        self.t.lines[i].delivery_deadline_ns
                                            + self.t.delivery_grace_period_ns,
                                    ),
                                    LineStatus::Submitted => {
                                        Some(self.m.lines[i].submitted_at + self.t.review_window_ns)
                                    }
                                    _ => None,
                                }
                            };
                            base.map(|b| i128::from(b) + i128::from(d))
                        }
                        _ => None,
                    };
                    if let Some(t) = base.and_then(|t| u64::try_from(t).ok())
                        && t >= self.now
                    {
                        self.now = t; // chain time never goes backwards
                    }
                    (None, None, None)
                }
            };

        // Boundary evidence: actions executed exactly at a cutoff −1 / 0 / +1
        // (judged by the oracle like every other action).
        if let Some(r) = real_ok {
            let now = u128::from(self.now);
            let at = |cut: u128| -> Option<&'static str> {
                if now + 1 == cut {
                    Some("m1")
                } else if now == cut {
                    Some("0")
                } else if now == cut + 1 {
                    Some("p1")
                } else {
                    None
                }
            };
            let tag: Option<(&'static str, &'static str)> = match act {
                Action::Fund(i, ..) if i < self.n() => self
                    .f3_limit(i)
                    .filter(|l| l + 1 < u128::from(self.t.funding_deadline_ns))
                    .and_then(|l| at(l + 1).map(|d| ("f3_limit", d)))
                    .or_else(|| at(u128::from(self.t.funding_deadline_ns)).map(|d| ("funding", d))),
                Action::Submit(i, ..) if i < self.n() => {
                    at(u128::from(self.t.lines[i].delivery_deadline_ns)
                        + u128::from(self.t.delivery_grace_period_ns))
                    .map(|d| ("submission", d))
                }
                Action::AcceptLine(i, _) | Action::Dispute(i, _)
                    if i < self.n() && before_real.lines[i].status == LineStatus::Submitted =>
                {
                    at(u128::from(before_real.lines[i].submitted_at_ns)
                        + u128::from(self.t.review_window_ns))
                    .map(|d| ("review", d))
                }
                Action::AcceptTerms(..) | Action::AcceptAppointment(..) => {
                    at(u128::from(self.t.acceptance_deadline_ns)).map(|d| ("acceptance", d))
                }
                Action::Finalize(i, mk, _, src)
                    if i < self.n() && before_real.lines[i].status == LineStatus::Disputed =>
                {
                    // Tag by the role that actually acted (finalize_caller).
                    let mk = match (mk, finalize_caller(mk, src)) {
                        (ModeK::Fallback, _) => ModeK::Fallback,
                        (_, Who::Primary) => ModeK::Primary,
                        (_, Who::Backup) => ModeK::Backup,
                        _ => ModeK::None,
                    };
                    let t0 = u128::from(before_real.lines[i].dispute_t0_ns);
                    let ps = t0 + u128::from(self.t.negotiation_window_ns);
                    let bs = ps + u128::from(self.t.primary_window_ns);
                    let fs = bs + u128::from(self.t.backup_window_ns);
                    match mk {
                        ModeK::Primary => at(ps)
                            .map(|d| ("ph_primary_open", d))
                            .or_else(|| at(bs).map(|d| ("ph_primary_close", d))),
                        ModeK::Backup => at(bs)
                            .map(|d| ("ph_backup_open", d))
                            .or_else(|| at(fs).map(|d| ("ph_backup_close", d))),
                        ModeK::Fallback => at(fs).map(|d| ("ph_fallback_open", d)),
                        _ => None,
                    }
                }
                Action::AdvanceCase(i) if i < self.n() => match before_real.lines[i].status {
                    LineStatus::Submitted => at(u128::from(before_real.lines[i].submitted_at_ns)
                        + u128::from(self.t.review_window_ns))
                    .map(|d| ("advance_nr", d)),
                    LineStatus::Funded => at(u128::from(self.t.lines[i].delivery_deadline_ns)
                        + u128::from(self.t.delivery_grace_period_ns))
                    .map(|d| ("advance_nd", d)),
                    _ => None,
                },
                _ => None,
            };
            if let Some((which, d)) = tag {
                let key: &'static str = match (which, d) {
                    // F3: exclusive cutoff = limit + 1, so "m1" is the limit
                    // itself (equality accepted) and "0"/"p1" must be rejected.
                    ("f3_limit", "m1") => "boundary_f3_delivery_limit_minus1",
                    ("f3_limit", "0") => "boundary_f3_delivery_limit_exact",
                    ("f3_limit", _) => "boundary_f3_delivery_limit_plus1",
                    ("funding", "m1") => "boundary_funding_cutoff_minus1",
                    ("funding", "0") => "boundary_funding_cutoff_exact",
                    ("funding", _) => "boundary_funding_cutoff_plus1",
                    ("submission", "m1") => "boundary_submission_cutoff_minus1",
                    ("submission", "0") => "boundary_submission_cutoff_exact",
                    ("submission", _) => "boundary_submission_cutoff_plus1",
                    ("review", "m1") => "boundary_review_end_minus1",
                    ("review", "0") => "boundary_review_end_exact",
                    ("review", _) => "boundary_review_end_plus1",
                    ("acceptance", "m1") => "boundary_acceptance_minus1",
                    ("acceptance", "0") => "boundary_acceptance_exact",
                    ("advance_nr", "m1") => "advance_no_response_t0_minus1",
                    ("advance_nr", "0") => "advance_no_response_t0_exact",
                    ("advance_nr", _) => "advance_no_response_t0_plus1",
                    ("advance_nd", "m1") => "advance_non_delivery_t0_minus1",
                    ("advance_nd", "0") => "advance_non_delivery_t0_exact",
                    ("advance_nd", _) => "advance_non_delivery_t0_plus1",
                    ("ph_primary_open", "m1") => "phase_primary_open_minus1",
                    ("ph_primary_open", "0") => "phase_primary_open_exact",
                    ("ph_primary_open", _) => "phase_primary_open_plus1",
                    ("ph_primary_close", "m1") => "phase_primary_close_minus1",
                    ("ph_primary_close", "0") => "phase_primary_close_exact",
                    ("ph_primary_close", _) => "phase_primary_close_plus1",
                    ("ph_backup_open", "m1") => "phase_backup_open_minus1",
                    ("ph_backup_open", "0") => "phase_backup_open_exact",
                    ("ph_backup_open", _) => "phase_backup_open_plus1",
                    ("ph_backup_close", "m1") => "phase_backup_close_minus1",
                    ("ph_backup_close", "0") => "phase_backup_close_exact",
                    ("ph_backup_close", _) => "phase_backup_close_plus1",
                    ("ph_fallback_open", "m1") => "phase_fallback_open_minus1",
                    ("ph_fallback_open", "0") => "phase_fallback_open_exact",
                    ("ph_fallback_open", _) => "phase_fallback_open_plus1",
                    _ => "boundary_acceptance_plus1",
                };
                self.record(key, r);
            }
        }
        match (real_ok, predicted) {
            (Some(r), Some(p)) => {
                self.record(act.kind(), r);
                check!(
                    r == p,
                    "oracle mismatch for {act:?} at now={}: real ok={r}, predicted ok={p}",
                    self.now
                );
                if !r {
                    check!(
                        bytes(&self.a) == before,
                        "rejected {act:?} changed persistent state"
                    );
                } else {
                    check!(
                        bytes(&self.a.terms) == terms_bytes,
                        "terms changed by {act:?}"
                    );
                    if let Some(i) = line_target {
                        for (j, lb) in before_lines.iter().enumerate() {
                            if j != i {
                                check!(
                                    bytes(&self.a.lines[j]) == *lb,
                                    "{act:?} on line {i} changed line {j}"
                                );
                            }
                        }
                        check!(
                            self.a.acceptances == before_real.acceptances,
                            "line action changed acceptances"
                        );
                    } else {
                        for (j, lb) in before_lines.iter().enumerate() {
                            check!(
                                bytes(&self.a.lines[j]) == *lb,
                                "agreement-level {act:?} changed line {j}"
                            );
                        }
                    }
                }
            }
            _ => {
                if !matches!(act, Action::Resolve(..)) {
                    self.record(act.kind(), true);
                }
                check!(
                    bytes(&self.a) == before,
                    "no-op {act:?} changed persistent state"
                );
            }
        }
        self.check_all(Some(&before_real))
    }

    /// Model equality and every invariant.
    fn check_all(&self, prev: Option<&AgreementV1>) -> Result<(), TestCaseError> {
        let a = &self.a;
        let expected_state = if !self.m.agreed {
            AgreementState::Proposed
        } else if self.m.active {
            AgreementState::Active
        } else {
            AgreementState::Agreed
        };
        check!(
            a.state == expected_state,
            "agreement state {:?} != model {:?}",
            a.state,
            expected_state
        );
        let ac = &a.acceptances;
        check!(
            [
                ac.buyer,
                ac.supplier,
                ac.primary_arbitrator,
                ac.backup_arbitrator
            ] == self.m.acc,
            "acceptances differ from model"
        );
        check!(
            bytes(a).len() == self.agreement_len,
            "agreement Borsh size changed"
        );
        let mut sum_all: (u128, u128) = (0, 0);
        for (i, (l, ml)) in a.lines.iter().zip(&self.m.lines).enumerate() {
            let p = self.p(i);
            let g = &l.ledger;
            let real_b = [
                g.locked,
                g.buyer_claimable,
                g.supplier_claimable,
                g.buyer_pending,
                g.supplier_pending,
                g.buyer_paid,
                g.supplier_paid,
            ];
            // 1. model equality
            check!(
                l.status == ml.status,
                "line {i} status {:?} != model {:?}",
                l.status,
                ml.status
            );
            check!(
                real_b == ml.b,
                "line {i} buckets {real_b:?} != model {:?}",
                ml.b
            );
            if ml.status != LineStatus::Unfunded && ml.status != LineStatus::Funded {
                check!(
                    l.submitted_at_ns == ml.submitted_at,
                    "line {i} submitted_at"
                );
            }
            check!(
                (l.dispute_reason, l.dispute_t0_ns) == ml.dispute,
                "line {i} dispute {:?} != model {:?}",
                (l.dispute_reason, l.dispute_t0_ns),
                ml.dispute
            );
            let real_alloc = (l.allocation.mode != AllocationMode::None).then_some((
                l.allocation.mode,
                l.allocation.buyer_amount,
                l.allocation.supplier_amount,
                l.allocation.source_id,
            ));
            check!(
                real_alloc == ml.alloc,
                "line {i} allocation {real_alloc:?} != model {:?}",
                ml.alloc
            );
            check!(
                l.proposal == ml.prop,
                "line {i} proposal {:?} != model {:?}",
                l.proposal,
                ml.prop
            );
            for (bi, s) in [&l.buyer_withdrawal, &l.supplier_withdrawal]
                .into_iter()
                .enumerate()
            {
                let ms = ml.slots[bi];
                check!(
                    (s.state, s.withdrawal_id, s.epoch, s.amount)
                        == (ms.state, ms.id, ms.epoch, ms.amount),
                    "line {i} slot {bi} {s:?} != model {ms:?}"
                );
                // 6. pending ↔ open slot
                let pending = real_b[3 + bi];
                if s.state == SlotState::Pending {
                    check!(
                        pending == s.amount && s.amount > 0,
                        "line {i} pending {pending} != open slot {}",
                        s.amount
                    );
                } else {
                    check!(pending == 0, "line {i} pending {pending} without open slot");
                }
            }
            // 2. conservation / zero before funding / bucket bound
            let total = real_b.iter().try_fold(0u128, |acc, &x| acc.checked_add(x));
            if l.status == LineStatus::Unfunded {
                check!(real_b == [0; 7], "unfunded line {i} has value");
            } else {
                check!(total == Some(p), "line {i} total {total:?} != P {p}");
            }
            check!(real_b.iter().all(|&x| x <= p), "line {i} bucket above P");
            sum_all = add256(sum_all, total.unwrap_or(0));
            // 8. fixed size
            check!(
                bytes(l).len() == LINE_STATE_BYTES,
                "line {i} Borsh size {}",
                bytes(l).len()
            );
            // 9. production checker
            check!(
                l.check_invariants(self.params(i)).is_ok(),
                "line {i} production invariant: {:?}",
                l.check_invariants(self.params(i))
            );
            // 14. eligibility queries vs oracle
            let nd_expected = (l.status == LineStatus::Funded && !self.submission_open(i))
                .then(|| self.t.lines[i].delivery_deadline_ns + self.t.delivery_grace_period_ns);
            check!(
                a.non_delivery_t0(i as u32, self.now) == Ok(nd_expected),
                "line {i} non_delivery_t0 mismatch"
            );
            let nr_expected = (l.status == LineStatus::Submitted
                && u128::from(self.now)
                    >= u128::from(ml.submitted_at) + u128::from(self.t.review_window_ns))
            .then(|| ml.submitted_at + self.t.review_window_ns);
            check!(
                a.no_response_t0(i as u32, self.now) == Ok(nr_expected),
                "line {i} no_response_t0 mismatch"
            );
            // 4, 5, 7 against the previous step
            if let Some(prev) = prev {
                let pl: &LineStateV1 = &prev.lines[i];
                check!(
                    g.buyer_paid >= pl.ledger.buyer_paid
                        && g.supplier_paid >= pl.ledger.supplier_paid,
                    "line {i} paid decreased"
                );
                check!(
                    status_rank(l.status) >= status_rank(pl.status),
                    "line {i} status went backwards"
                );
                if pl.allocation.mode != AllocationMode::None {
                    check!(
                        l.allocation == pl.allocation,
                        "line {i} finalized allocation changed"
                    );
                }
                for (s, ps) in [
                    (&l.buyer_withdrawal, &pl.buyer_withdrawal),
                    (&l.supplier_withdrawal, &pl.supplier_withdrawal),
                ] {
                    if ps.state == SlotState::Paid {
                        check!(s == ps, "line {i} PAID slot changed");
                    }
                }
            }
        }
        // 3. aggregate conservation
        check!(
            sum_all == self.m.funded_total,
            "Σ ledgers {sum_all:?} != Σ recognized fundings {:?}",
            self.m.funded_total
        );
        // The production aggregate is checked: exact when it fits u128, None
        // otherwise, never a wrapped value.
        let expected_prod = (self.m.funded_total.0 == 0).then_some(self.m.funded_total.1);
        check!(
            a.ledger_total() == expected_prod,
            "ledger_total {:?} != {:?}",
            a.ledger_total(),
            expected_prod
        );
        Ok(())
    }

    /// 12. starved withdrawals stay PENDING with their original record.
    fn finish(&self) -> Result<(), TestCaseError> {
        for &(i, bi, ms) in &self.starved {
            let s = if bi == 0 {
                &self.a.lines[i].buyer_withdrawal
            } else {
                &self.a.lines[i].supplier_withdrawal
            };
            check!(
                (s.state, s.withdrawal_id, s.epoch, s.amount)
                    == (SlotState::Pending, ms.id, ms.epoch, ms.amount),
                "starved withdrawal line {i} slot {bi} changed: {s:?}"
            );
            self.record("starved_still_pending_at_end", true);
        }
        Ok(())
    }

    /// Deterministic prefix used by P3: every line reaches ALLOCATED.
    fn drive_to_allocated(&mut self, splits: &[u128]) -> Result<(), TestCaseError> {
        if !self.m.agreed {
            for (w, appt) in [
                (Who::Buyer, false),
                (Who::Supplier, false),
                (Who::Primary, true),
                (Who::Backup, true),
            ] {
                self.step(if appt {
                    Action::AcceptAppointment(w, true)
                } else {
                    Action::AcceptTerms(w, true)
                })?;
            }
        }
        // LF-008: rulings depend on chain time, so fund / submit / settle
        // every line first, then move time forward once per phase.
        for i in 0..self.n() {
            self.step(Action::Fund(i, Who::Buyer, Amt::Exact))?;
        }
        for i in 0..self.n() {
            self.step(Action::Submit(i, Who::Supplier, false))?;
        }
        let r_of = |i: usize| splits.get(i).copied().unwrap_or(0);
        for i in 0..self.n() {
            let r = r_of(i);
            if r % 3 == 0 {
                self.step(Action::AcceptLine(i, Who::Buyer))?;
            } else {
                self.step(Action::Dispute(i, Who::Buyer))?;
                if r % 3 == 1 {
                    // LF-007: mutual split = proposal + exact counterparty acceptance.
                    self.step(Action::ProposeSplit(i, Who::Buyer, Split::Random(r)))?;
                    self.step(Action::AcceptSplit(i, Who::Supplier, PidK::Current, true))?;
                }
            }
        }
        // Remaining disputed lines: primary ruling at its window start, then
        // fallback at the longstop (all disputes share T0 = now).
        for (k, mode) in [(0u8, ModeK::Primary), (2u8, ModeK::Fallback)] {
            for i in 0..self.n() {
                let r = r_of(i);
                let want = if (r / 3) % 2 == 0 {
                    ModeK::Primary
                } else {
                    ModeK::Fallback
                };
                if self.m.lines[i].status == LineStatus::Disputed
                    && std::mem::discriminant(&want) == std::mem::discriminant(&mode)
                {
                    self.step(Action::Advance(TimeK::Phase(i, k, 0)))?;
                    let split = if matches!(mode, ModeK::Fallback) {
                        Split::FallbackExact
                    } else {
                        Split::Random(r)
                    };
                    self.step(Action::Finalize(i, mode, split, 1))?;
                }
            }
        }
        for i in 0..self.n() {
            check!(
                self.m.lines[i].status == LineStatus::Allocated,
                "prefix failed to allocate line {i}"
            );
        }
        Ok(())
    }
}

// ------------------------------------------------------------------ runner ---

fn seed_for(name: &str) -> [u8; 32] {
    if let Ok(hex) = std::env::var("LINEFAIR_S6_SEED_HEX") {
        let b = hex.as_bytes();
        assert_eq!(b.len(), 64, "LINEFAIR_S6_SEED_HEX must be 64 hex chars");
        let mut out = [0u8; 32];
        for (o, pair) in out.iter_mut().zip(b.chunks_exact(2)) {
            *o = u8::from_str_radix(std::str::from_utf8(pair).expect("ascii"), 16).expect("hex");
        }
        return out;
    }
    // Fixed default seed: sha256("linefair/s6/v1/<property>").
    near_sdk::env::sha256_array(format!("linefair/s6/v1/{name}").as_bytes())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn save_failure(name: &str, seed: &[u8; 32], text: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../evidence/m1");
    std::fs::create_dir_all(&dir).expect("evidence dir");
    let mut n = 1;
    loop {
        let path = dir.join(format!("s6-{name}-FAILED-{n}.txt"));
        if !path.exists() {
            let body = format!(
                "property: {name}\nseed_hex: {}\ncases: {CASES}\n\n{text}\n",
                hex(seed)
            );
            std::fs::write(&path, body).expect("write failure trace");
            return path;
        }
        n += 1;
    }
}

fn run_property(
    name: &str,
    mode: Mode,
    min_ok: &[(&'static str, u64)],
    min_rejected: &[(&'static str, u64)],
) {
    let seed = seed_for(name);
    let stats: Stats = RefCell::new(BTreeMap::new());
    let cases_run = RefCell::new(0u64);
    let config = Config {
        cases: CASES,
        failure_persistence: None,
        max_shrink_iters: 4_096,
        ..Config::default()
    };
    let mut runner =
        TestRunner::new_with_rng(config, TestRng::from_seed(RngAlgorithm::ChaCha, &seed));
    let result = runner.run(
        &(
            arb_scenario(mode),
            proptest::collection::vec(any::<u128>(), 3),
        ),
        |(sc, splits)| {
            *cases_run.borrow_mut() += 1;
            let mut h = Harness::new(&sc, &stats)?;
            if mode == Mode::Withdrawals {
                h.drive_to_allocated(&splits)?;
            }
            for act in sc.actions.iter().copied() {
                h.step(act)?;
            }
            h.finish()
        },
    );
    println!(
        "EVIDENCE property={name} seed_hex={} cases_configured={CASES} test_fn_invocations={}",
        hex(&seed),
        cases_run.borrow()
    );
    for (k, (ok, err)) in stats.borrow().iter() {
        println!("EVIDENCE property={name} action={k} ok={ok} rejected={err}");
    }
    match result {
        Ok(()) => {}
        Err(TestError::Fail(reason, value)) => {
            let path = save_failure(
                name,
                &seed,
                &format!("reason: {reason}\n\nminimal input:\n{value:#?}"),
            );
            panic!(
                "{name} failed: {reason}\nminimized trace saved to {}",
                path.display()
            );
        }
        Err(TestError::Abort(reason)) => {
            let path = save_failure(name, &seed, &format!("ABORT: {reason}"));
            panic!("{name} aborted: {reason} ({})", path.display());
        }
    }
    // Coverage guard: the sequences must actually reach deep states.
    let st = stats.borrow();
    for &(k, min) in min_ok {
        let ok = st.get(k).map(|x| x.0).unwrap_or(0);
        assert!(
            ok >= min,
            "{name}: coverage too low for {k}: {ok} successful < {min}"
        );
    }
    for &(k, min) in min_rejected {
        let rej = st.get(k).map(|x| x.1).unwrap_or(0);
        assert!(
            rej >= min,
            "{name}: coverage too low for {k}: {rej} rejected < {min}"
        );
    }
    // Explicit (LF-006b): advance_case is never accepted one ns before T0.
    for (k, (ok, _)) in st.iter() {
        if k.starts_with("advance_") && k.ends_with("_minus1") {
            assert_eq!(*ok, 0, "{name}: {k} accepted {ok} advances before T0");
        }
    }
    // Explicit (LF-008): no ruling / fallback one ns before its window opens,
    // and no ruling at or after its window closes (earlier authority expires).
    for (k, (ok, _)) in st.iter() {
        if k.starts_with("phase_")
            && ((k.contains("_open_") && k.ends_with("_minus1"))
                || (k.contains("_close_") && (k.ends_with("_exact") || k.ends_with("_plus1"))))
        {
            assert_eq!(
                *ok, 0,
                "{name}: {k} accepted {ok} out-of-window finalizations"
            );
        }
    }
    // Explicit: nothing is ever accepted at an exact cutoff or one ns after.
    for (k, (ok, _)) in st.iter() {
        if k.starts_with("boundary_") && (k.ends_with("_exact") || k.ends_with("_plus1")) {
            assert_eq!(
                *ok, 0,
                "{name}: {k} accepted {ok} actions at/after a cutoff"
            );
        }
    }
}

// Coverage floors: about 25 % of the counts measured on the first full run
// with the fixed seeds (disclosed in evidence/m1/s6-property-plan.md).
const DEEP_FLOOR: &[(&str, u64)] = &[
    ("fund", 4_000),
    ("submit", 3_500),
    ("accept_line", 1_500),
    ("dispute", 1_500),
    ("finalize", 1_500),
    ("withdraw", 4_500),
    ("resolve_success", 2_400),
    ("resolve_failure", 1_000),
    ("starved_still_pending_at_end", 500),
    ("boundary_submission_cutoff_minus1", 50),
    ("boundary_review_end_minus1", 50),
    // LF-006b (≈ 25 % of the first measured run, 2026-11-01).
    ("advance_case", 150),
    ("advance_no_response_t0_exact", 12),
    ("advance_non_delivery_t0_exact", 12),
    // LF-007 (≈ 25 % of the first measured passing run, 2026-11-03,
    // evidence/lf007/s6-run-20261103T024017Z.log.txt; min of p1, p2).
    ("propose_split", 800),
    ("accept_split", 225),
    ("accept_split_stale_rejected", 50),
    ("accept_split_own_rejected", 25),
    ("accept_split_mismatch_rejected", 18),
    ("accept_split_unauthorized_rejected", 19),
    // LF-008 (≈ 25 % of the first passing run, 2026-11-03,
    // evidence/lf008/s6-run-20261103T184315Z.log.txt; min of p1, p2).
    ("phase_primary_open_exact", 74),
    ("phase_primary_close_minus1", 39),
    ("phase_backup_open_exact", 84),
    ("phase_backup_close_minus1", 40),
    ("phase_fallback_open_exact", 109),
    // F3 (≈ 25 % of the first passing run 2026-11-05, min of p1, p2):
    // funding at the F3 limit itself is credited.
    ("boundary_f3_delivery_limit_minus1", 5),
];
const BOUNDARY_SEEN: &[(&str, u64)] = &[
    // LF-008: rulings at the exact close of their window are seen and rejected
    // (≈ 25 % of min over p1, p2, p5 in the first passing run).
    ("phase_primary_close_exact", 3),
    ("phase_backup_close_exact", 3),
    ("boundary_submission_cutoff_exact", 140),
    ("boundary_review_end_exact", 120),
    ("boundary_funding_cutoff_exact", 240),
];

#[test]
fn p1_random_sequences_match_model_and_invariants() {
    run_property("p1", Mode::Normal, DEEP_FLOOR, BOUNDARY_SEEN);
}

#[test]
fn p2_extreme_integers_near_u128_and_u64_max() {
    run_property("p2", Mode::Extreme, DEEP_FLOOR, BOUNDARY_SEEN);
}

#[test]
fn p3_withdrawal_replay_failure_and_uncertain_pending() {
    run_property(
        "p3",
        Mode::Withdrawals,
        &[
            ("finalize", 3_300),
            ("withdraw", 8_000),
            ("resolve_success", 4_200),
            ("resolve_failure", 1_900),
            ("starved_still_pending_at_end", 900),
            ("accept_split", 1_650),
            ("phase_primary_open_exact", 800),
            ("phase_fallback_open_exact", 845),
        ],
        &[],
    );
}

#[test]
fn p4_exact_deadline_boundaries() {
    run_property(
        "p4",
        Mode::Boundaries,
        &[
            ("fund", 1_000),
            ("submit", 450),
            ("finalize", 90),
            ("withdraw", 250),
            ("resolve_success", 120),
            ("resolve_failure", 50),
            ("boundary_funding_cutoff_minus1", 900),
            ("boundary_submission_cutoff_minus1", 250),
            ("boundary_review_end_minus1", 130),
            ("advance_case", 390),
            ("advance_no_response_t0_exact", 30),
            ("advance_non_delivery_t0_exact", 60),
            ("propose_split", 180),
            ("accept_split", 38),
            ("phase_primary_open_exact", 14),
            ("phase_backup_open_exact", 17),
            ("phase_fallback_open_exact", 21),
            ("boundary_f3_delivery_limit_minus1", 50),
        ],
        &[
            ("boundary_funding_cutoff_exact", 1_250),
            ("boundary_submission_cutoff_exact", 500),
            ("boundary_review_end_exact", 200),
            ("boundary_submission_cutoff_plus1", 1_700),
            ("boundary_review_end_plus1", 650),
            // F3: one ns and more past the limit are seen and always rejected.
            ("boundary_f3_delivery_limit_exact", 44),
            ("boundary_f3_delivery_limit_plus1", 126),
        ],
    );
}

#[test]
fn p5_rejected_operations_are_byte_identical() {
    run_property(
        "p5",
        Mode::Invalid,
        &[
            ("fund", 3_000),
            ("submit", 2_200),
            ("finalize", 550),
            ("withdraw", 1_200),
            ("resolve_success", 490),
            ("resolve_failure", 200),
            ("advance_case", 340),
            ("propose_split", 218),
            ("accept_split", 39),
            ("accept_split_stale_rejected", 20),
            ("accept_split_unauthorized_rejected", 16),
        ],
        BOUNDARY_SEEN,
    );
}
