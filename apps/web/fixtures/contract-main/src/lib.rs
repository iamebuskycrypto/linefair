//! LineFair escrow contract (NEAR sandbox/testnet only).
//!
//! State: agreements can be proposed and accepted (`PROPOSED → AGREED`),
//! lines can be funded with the single allowlisted NEP-141 token through
//! `ft_on_transfer` (LF-005), and every line can reach a final allocation
//! (decision only, no transfer). There is **no payout code**: no
//! `ft_transfer`, no withdrawal entry point and no payable method. Attached
//! NEAR is rejected by every method.
//! - `terms`: AgreementTermsV1 types and creation-time validation (S1).
//! - `hash`: canonical terms hash v1, network + escrow bound (S2).
//! - `terms_json`: strict JSON edge parser for the terms (S2).
//! - `agreement`: pure acceptance state machine (S3).
//! - `ledger`: seven-bucket per-line ledger and fallback split (S4).
//! - `deadlines`: half-open deadline predicates and dispute phases of `docs/08` v1 (S5b, LF-008).
//! - `line`: per-line state machine (S5; time-gated in S5b). Line states are pre-allocated at
//!   creation and visible in `get_agreement`; changed by `ft_on_transfer` (funding, LF-005)
//!   and by `submit_delivery` / `accept_line` / `open_dispute` (LF-006), the
//!   permissionless `advance_case` (LF-006b), `propose_split` / `accept_split`
//!   (mutual settlement, LF-007), and `submit_ruling` / `trigger_fallback`
//!   (timed arbitration and fallback, LF-008).
//! - `funding`: strict FT funding message v1 parser (LF-005).
//!
//! Panic messages are stable codes `ERR_<AREA>[:<Code>]`; no business text
//! or evidence is ever logged.

pub mod agreement;
pub mod deadlines;
pub mod funding;
pub mod hash;
pub mod ledger;
pub mod line;
pub mod terms;
pub mod terms_json;

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{U64, U128};
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, env, near, require,
};

use agreement::{AcceptKind, AgreementV1, LineOpError};
use funding::{FundingMsgError, parse_funding_msg};
use hash::{NetworkId, TermsHash, terms_hash};
use line::{Beneficiary, SlotState, WithdrawalOutcome};
use terms::{AgreementTermsV1, ValidationContext};
use terms_json::{AgreementTermsJsonV1, encode_hex_lower, parse_hex32, parse_u64, parse_u128};

/// Human-readable contract version, checked by the sandbox smoke test.
pub const CONTRACT_VERSION: &str = "linefair-escrow 0.1.0 (lf-012 f3)";

/// LF-009 gas budget (`docs/25` §Withdraw gas floor). Measured in sandbox
/// with the pinned token; see `evidence/lf009/` for the measured burn and
/// margins. `withdraw` rejects before any state change unless the prepaid
/// gas covers all three.
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
#[cfg(not(feature = "test-starve-callback"))]
pub const GAS_WITHDRAW_CALLBACK: Gas = Gas::from_tgas(15);
/// Test only (`docs/27` item 7): too little gas for the callback to finish,
/// so the transfer happens but its outcome is never recorded. 1 Tgas was
/// measured to be enough for the callback's own execution (receipt fees are
/// prepaid separately), so the starve value is 10 Ggas.
#[cfg(feature = "test-starve-callback")]
pub const GAS_WITHDRAW_CALLBACK: Gas = Gas::from_ggas(10);
pub const GAS_WITHDRAW_SELF: Gas = Gas::from_tgas(30);

/// LF-009: `BUYER` / `SUPPLIER` (exact, uppercase).
fn beneficiary_from(s: &str) -> Option<Beneficiary> {
    match s {
        "BUYER" => Some(Beneficiary::Buyer),
        "SUPPLIER" => Some(Beneficiary::Supplier),
        _ => None,
    }
}

/// Upper bound for `max_agreements` at init: the provisional testnet cap
/// (`docs/25`, OQ-05). Lower values are allowed.
pub const MAX_AGREEMENTS_LIMIT: u32 = 25;

/// Storage a single `create_agreement` may add (`docs/25`, provisional).
pub const MAX_AGREEMENT_BYTES: u64 = 4_096;
/// LF-010A (`docs/28`): bound on the immutable creator allowlist.
pub const MAX_CREATORS: usize = 10;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Agreements,
    TermsIndex,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    network: NetworkId,
    allowlisted_ft_id: AccountId,
    operator_treasury_id: AccountId,
    max_agreements: u32,
    next_agreement_id: u64,
    agreements: LookupMap<u64, AgreementV1>,
    /// Canonical hash → agreement id. Never removed, so an identical preimage
    /// can never be registered twice (T078).
    terms_index: LookupMap<TermsHash, u64>,
    /// Rule B (founder 2026-11-01): outstanding customer token liabilities E =
    /// Σ over all agreements and lines of locked + claimable + pending. Paid
    /// amounts are excluded; this is not a lifetime deposit counter. +16 B of
    /// root state. Changes only by `checked_add` on a credited deposit, and
    /// (LF-009) by `checked_sub` in the authenticated callback that confirms a
    /// payout. Allocation, withdrawal start, definite failure and an
    /// unresolved pending withdrawal leave it unchanged.
    custody_total: u128,
    /// LF-009: last issued withdrawal id (contract-wide, monotonic from 1;
    /// 0 = none yet). +8 B root state.
    last_withdrawal_id: u64,
    /// LF-009: withdrawals currently PENDING (incl. inconclusive). +8 B.
    open_withdrawals: u64,
    /// LF-010A (`docs/28`): accounts allowed to create agreements (as their
    /// buyer). Set once in `new`; no method can change it. Grants no other
    /// right. Testnet slot-exhaustion mitigation, not a permissionless design.
    creator_allowlist: Vec<AccountId>,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptancesView {
    pub buyer: bool,
    pub supplier: bool,
    pub primary_arbitrator: bool,
    pub backup_arbitrator: bool,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineView {
    pub line_id: u32,
    pub status: String,
    pub locked: U128,
    pub buyer_claimable: U128,
    pub supplier_claimable: U128,
    pub buyer_pending: U128,
    pub supplier_pending: U128,
    pub buyer_paid: U128,
    pub supplier_paid: U128,
    pub buyer_withdrawal: String,
    pub supplier_withdrawal: String,
    /// 0 until submitted.
    pub submitted_at_ns: U64,
    /// Salted 32-byte delivery-evidence commitment (hex); all zeros until submitted.
    pub evidence_commitment: String,
    /// `NONE`, `BUYER_DISPUTE`, `NO_RESPONSE` or `NON_DELIVERY`.
    pub dispute_reason: String,
    /// 0 unless disputed.
    pub dispute_t0_ns: U64,
    /// Read-only, computed at view time: NO_RESPONSE eligibility and its fixed
    /// T0 (SUBMITTED line whose review window has closed). The transition
    /// itself is the permissionless `advance_case` (LF-006b).
    pub no_response_t0_ns: Option<U64>,
    /// Read-only: NON_DELIVERY eligibility and its fixed T0 (FUNDED line past
    /// delivery deadline + grace).
    pub non_delivery_t0_ns: Option<U64>,
    /// `NONE` until ALLOCATED; then `BUYER_ACCEPTED`, `MUTUAL`,
    /// `PRIMARY_RULING`, `BACKUP_RULING` or `FALLBACK`.
    pub allocation_mode: String,
    pub allocation_buyer_amount: U128,
    pub allocation_supplier_amount: U128,
    /// Accepted proposal id for `MUTUAL`; 0 otherwise.
    pub allocation_source_id: U64,
    pub allocation_finalized_at_ns: U64,
    /// LF-007 single active proposal: `NONE`, `OPEN` or `ACCEPTED`. An OPEN
    /// proposal on an ALLOCATED line can no longer be accepted.
    pub proposal_status: String,
    /// Per-line nonce of the latest proposal (0 = none yet).
    pub proposal_id: U64,
    /// `NONE`, `BUYER` or `SUPPLIER`.
    pub proposal_proposer: String,
    pub proposal_buyer_amount: U128,
    pub proposal_supplier_amount: U128,
    pub proposal_created_at_ns: U64,
    /// LF-008, read-only at view time: `NONE` unless DISPUTED, else
    /// `NEGOTIATION`, `PRIMARY`, `BACKUP` or `FALLBACK` (derived from the
    /// fixed T0 and the hashed windows).
    pub dispute_phase: String,
    /// `T0 + N` (primary window start), DISPUTED lines only.
    pub primary_start_ns: Option<U64>,
    /// `T0 + N + A` (backup window start).
    pub backup_start_ns: Option<U64>,
    /// `T0 + N + A + B` (fallback eligibility).
    pub fallback_start_ns: Option<U64>,
}

/// LF-009: one withdrawal slot (`get_withdrawal`).
#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WithdrawalView {
    pub agreement_id: U64,
    pub line_id: u32,
    /// `BUYER` or `SUPPLIER`.
    pub beneficiary: String,
    /// `EMPTY`, `PENDING` (incl. inconclusive: outcome unconfirmed), `PAID`
    /// (authenticated callback confirmed the transfer) or `FAILED` (definite
    /// failure; the amount was restored to claimable once).
    pub state: String,
    /// Contract-wide withdrawal id of the latest withdrawal (0 = none).
    pub withdrawal_id: U64,
    pub epoch: u32,
    pub amount: U128,
    pub started_at_ns: U64,
    pub resolved_at_ns: U64,
    /// Immutable recipient from the terms (never a parameter).
    pub recipient: AccountId,
    pub ft_contract_id: AccountId,
}

/// LF-009: custody observation (`docs/27` R-2 is observation only: compare
/// with `ft_balance_of(escrow)` offchain; never used to change state).
#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustodySummaryView {
    /// E = Σ locked + claimable + pending over all lines.
    pub outstanding_liabilities: U128,
    pub open_withdrawals: U64,
    pub last_withdrawal_id: U64,
    pub ft_contract_id: AccountId,
}

/// LF-009: result of the withdrawal callback (also the result of the
/// `withdraw` transaction, which returns the callback promise).
#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WithdrawalResultView {
    pub withdrawal_id: U64,
    /// `PAID`, `FAILED` (claim restored), `PENDING` (incident: liabilities
    /// would underflow; nothing changed) or `IGNORED` (no matching pending
    /// withdrawal; nothing changed).
    pub outcome: String,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgreementView {
    pub agreement_id: U64,
    /// `PROPOSED`, `EXPIRED` (derived from chain time), `AGREED` or `ACTIVE` (first line funded).
    pub status: String,
    pub terms_hash: String,
    pub acceptances: AcceptancesView,
    pub accelerated_test_timing: bool,
    pub created_at_ns: U64,
    pub terms: AgreementTermsJsonV1,
    pub lines: Vec<LineView>,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigView {
    pub network_id: String,
    pub allowlisted_ft_id: AccountId,
    pub operator_treasury_id: AccountId,
    pub max_agreements: u32,
    pub agreements_created: U64,
    /// LF-010A: immutable creator allowlist.
    pub creator_allowlist: Vec<AccountId>,
}

fn fail(area: &str, code: &str) -> ! {
    env::panic_str(&format!("{area}:{code}"))
}

/// LF-007: strict canonical decimal u128 (no sign, no leading zeros, no
/// overflow), like the terms edge; `U128` JSON would accept `+1` / `007`.
fn amount(field: &'static str, s: &str) -> u128 {
    parse_u128(field, s).unwrap_or_else(|e| fail("ERR_AMOUNT_FORMAT", e.code()))
}

#[near]
impl Contract {
    /// One-time init, callable only by the contract account itself.
    #[init]
    #[private]
    pub fn new(
        network_id: String,
        allowlisted_ft_id: AccountId,
        operator_treasury_id: AccountId,
        max_agreements: u32,
        creator_allowlist: Vec<AccountId>,
    ) -> Self {
        let network =
            NetworkId::parse(&network_id).unwrap_or_else(|| env::panic_str("ERR_INIT_NETWORK"));
        let me = env::current_account_id();
        require!(
            allowlisted_ft_id != me
                && operator_treasury_id != me
                && allowlisted_ft_id != operator_treasury_id,
            "ERR_INIT_ACCOUNTS_NOT_DISTINCT"
        );
        require!(
            (1..=MAX_AGREEMENTS_LIMIT).contains(&max_agreements),
            "ERR_INIT_MAX_AGREEMENTS"
        );
        require!(
            (1..=MAX_CREATORS).contains(&creator_allowlist.len()),
            "ERR_INIT_CREATOR_ALLOWLIST_SIZE"
        );
        for (i, a) in creator_allowlist.iter().enumerate() {
            require!(
                !creator_allowlist[..i].contains(a),
                "ERR_INIT_CREATOR_ALLOWLIST_DUPLICATE"
            );
            require!(
                a != &me && a != &allowlisted_ft_id && a != &operator_treasury_id,
                "ERR_INIT_CREATOR_ALLOWLIST_RESERVED"
            );
        }
        Self {
            network,
            allowlisted_ft_id,
            operator_treasury_id,
            max_agreements,
            next_agreement_id: 0,
            agreements: LookupMap::new(StorageKey::Agreements),
            terms_index: LookupMap::new(StorageKey::TermsIndex),
            custody_total: 0,
            last_withdrawal_id: 0,
            open_withdrawals: 0,
            creator_allowlist,
        }
    }

    /// Propose an agreement. Signer must be the terms' buyer. The contract
    /// validates the terms, computes the canonical hash itself, and refuses
    /// a preimage that was already registered. Returns the new agreement id.
    pub fn create_agreement(&mut self, terms: AgreementTermsJsonV1) -> U64 {
        let caller = env::predecessor_account_id();
        // LF-010A: checked first, before any parsing or storage write, so a
        // non-listed caller can never consume a slot or registry entry.
        if !self.creator_allowlist.contains(&caller) {
            env::panic_str("ERR_CREATOR_NOT_ALLOWLISTED");
        }
        let now = env::block_timestamp();
        let me = env::current_account_id();

        let t = AgreementTermsV1::try_from(&terms)
            .unwrap_or_else(|e| fail("ERR_TERMS_PARSE", e.code()));
        require!(caller == t.buyer_id, "ERR_NOT_BUYER");
        let ctx = ValidationContext {
            now_ns: now,
            escrow_id: &me,
            allowlisted_ft_id: &self.allowlisted_ft_id,
            operator_treasury_id: &self.operator_treasury_id,
        };
        t.validate(&ctx)
            .unwrap_or_else(|e| fail("ERR_TERMS_INVALID", e.code()));
        require!(
            self.next_agreement_id < u64::from(self.max_agreements),
            "ERR_AGREEMENT_CAP_REACHED"
        );
        let h = terms_hash(self.network, &me, &t);
        require!(!self.terms_index.contains_key(&h), "ERR_DUPLICATE_TERMS");

        let id = self.next_agreement_id;
        let before = env::storage_usage();
        self.agreements.insert(id, AgreementV1::propose(t, h, now));
        self.terms_index.insert(h, id);
        self.agreements.flush();
        self.terms_index.flush();
        let added = env::storage_usage()
            .checked_sub(before)
            .unwrap_or_else(|| env::panic_str("ERR_STORAGE_ACCOUNTING"));
        require!(added <= MAX_AGREEMENT_BYTES, "ERR_AGREEMENT_TOO_LARGE");
        self.next_agreement_id = id
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("ERR_AGREEMENT_ID_OVERFLOW"));
        U64(id)
    }

    /// Buyer or supplier accepts the exact terms identified by `terms_hash`
    /// (64 lowercase hex characters).
    pub fn accept_terms(&mut self, agreement_id: U64, terms_hash: String) {
        self.accept(AcceptKind::Terms, agreement_id, &terms_hash);
    }

    /// Primary or backup arbitrator accepts the appointment under the exact
    /// terms identified by `terms_hash`.
    pub fn accept_appointment(&mut self, agreement_id: U64, terms_hash: String) {
        self.accept(AcceptKind::Appointment, agreement_id, &terms_hash);
    }

    pub fn get_agreement(&self, agreement_id: U64) -> Option<AgreementView> {
        let now = env::block_timestamp();
        self.agreements.get(&agreement_id.0).map(|a| AgreementView {
            agreement_id,
            status: a.status_at(now).as_str().to_string(),
            terms_hash: encode_hex_lower(&a.terms_hash),
            acceptances: AcceptancesView {
                buyer: a.acceptances.buyer,
                supplier: a.acceptances.supplier,
                primary_arbitrator: a.acceptances.primary_arbitrator,
                backup_arbitrator: a.acceptances.backup_arbitrator,
            },
            accelerated_test_timing: a.terms.accelerated_test_timing(),
            created_at_ns: U64(a.created_at_ns),
            terms: AgreementTermsJsonV1::from(&a.terms),
            lines: (0u32..)
                .zip(a.lines.iter())
                .map(|(line_id, l)| (line_id, l, a.dispute_phase(line_id, now).ok().flatten()))
                .map(|(line_id, l, phase)| LineView {
                    line_id,
                    status: l.status.as_str().to_string(),
                    locked: U128(l.ledger.locked),
                    buyer_claimable: U128(l.ledger.buyer_claimable),
                    supplier_claimable: U128(l.ledger.supplier_claimable),
                    buyer_pending: U128(l.ledger.buyer_pending),
                    supplier_pending: U128(l.ledger.supplier_pending),
                    buyer_paid: U128(l.ledger.buyer_paid),
                    supplier_paid: U128(l.ledger.supplier_paid),
                    buyer_withdrawal: l.buyer_withdrawal.state.as_str().to_string(),
                    supplier_withdrawal: l.supplier_withdrawal.state.as_str().to_string(),
                    submitted_at_ns: U64(l.submitted_at_ns),
                    evidence_commitment: encode_hex_lower(&l.evidence_commitment),
                    dispute_reason: l.dispute_reason.as_str().to_string(),
                    dispute_t0_ns: U64(l.dispute_t0_ns),
                    no_response_t0_ns: a.no_response_t0(line_id, now).ok().flatten().map(U64),
                    non_delivery_t0_ns: a.non_delivery_t0(line_id, now).ok().flatten().map(U64),
                    allocation_mode: l.allocation.mode.as_str().to_string(),
                    allocation_buyer_amount: U128(l.allocation.buyer_amount),
                    allocation_supplier_amount: U128(l.allocation.supplier_amount),
                    allocation_source_id: U64(l.allocation.source_id),
                    allocation_finalized_at_ns: U64(l.allocation.finalized_at_ns),
                    proposal_status: l.proposal.status.as_str().to_string(),
                    proposal_id: U64(l.proposal.proposal_id),
                    proposal_proposer: l.proposal.proposer.as_str().to_string(),
                    proposal_buyer_amount: U128(l.proposal.buyer_amount),
                    proposal_supplier_amount: U128(l.proposal.supplier_amount),
                    proposal_created_at_ns: U64(l.proposal.created_at_ns),
                    dispute_phase: phase.map_or("NONE", |(ph, _)| ph.as_str()).to_string(),
                    primary_start_ns: phase.map(|(_, s)| U64(s.0)),
                    backup_start_ns: phase.map(|(_, s)| U64(s.1)),
                    fallback_start_ns: phase.map(|(_, s)| U64(s.2)),
                })
                .collect(),
        })
    }

    /// The canonical hash this contract would compute for `terms` (no
    /// validation, no state change). Lets clients and tests check encoders.
    pub fn compute_terms_hash(&self, terms: AgreementTermsJsonV1) -> String {
        let t = AgreementTermsV1::try_from(&terms)
            .unwrap_or_else(|e| fail("ERR_TERMS_PARSE", e.code()));
        encode_hex_lower(&terms_hash(self.network, &env::current_account_id(), &t))
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            network_id: self.network.as_str().to_string(),
            allowlisted_ft_id: self.allowlisted_ft_id.clone(),
            operator_treasury_id: self.operator_treasury_id.clone(),
            max_agreements: self.max_agreements,
            agreements_created: U64(self.next_agreement_id),
            creator_allowlist: self.creator_allowlist.clone(),
        }
    }

    /// LF-006: the supplier commits delivery evidence for a FUNDED line before
    /// `delivery_deadline + grace`. `evidence_commitment` is 64 lowercase hex
    /// characters (a salted commitment, never raw content; `docs/09`).
    pub fn submit_delivery(
        &mut self,
        agreement_id: U64,
        line_id: u32,
        evidence_commitment: String,
    ) {
        let c = parse_hex32("evidence_commitment", &evidence_commitment)
            .unwrap_or_else(|_| env::panic_str("ERR_EVIDENCE_COMMITMENT_FORMAT"));
        let (caller, now) = (env::predecessor_account_id(), env::block_timestamp());
        self.agreement_mut(agreement_id)
            .submit_delivery(line_id, &caller, c, now)
            .unwrap_or_else(|e| fail("ERR_LINE", e.code()));
    }

    /// LF-006: the buyer accepts a SUBMITTED line inside its review window:
    /// locked → supplier claimable (no token transfer; payouts are LF-009).
    pub fn accept_line(&mut self, agreement_id: U64, line_id: u32) {
        let (caller, now) = (env::predecessor_account_id(), env::block_timestamp());
        self.agreement_mut(agreement_id)
            .accept_line(line_id, &caller, now)
            .unwrap_or_else(|e| fail("ERR_LINE", e.code()));
    }

    /// LF-006: the buyer disputes a SUBMITTED line inside its review window
    /// (T0 = now). Funds stay locked; no allocation is made here.
    pub fn open_dispute(&mut self, agreement_id: U64, line_id: u32) {
        let (caller, now) = (env::predecessor_account_id(), env::block_timestamp());
        self.agreement_mut(agreement_id)
            .open_dispute(line_id, &caller, now)
            .unwrap_or_else(|e| fail("ERR_LINE", e.code()));
    }

    /// LF-006b: permissionless, deterministic advance into the agreed dispute
    /// procedure (`docs/06`, FD-07, OQ-07). **Any caller.** SUBMITTED after
    /// review end → DISPUTED NO_RESPONSE (T0 = submitted_at + review); FUNDED
    /// after delivery + grace → DISPUTED NON_DELIVERY (T0 = delivery + grace).
    /// The result depends only on stored state and chain time; funds,
    /// allocation, withdrawals and E are unchanged. No settlement here.
    pub fn advance_case(&mut self, agreement_id: U64, line_id: u32) {
        let now = env::block_timestamp();
        self.agreement_mut(agreement_id)
            .advance_case(line_id, now)
            .unwrap_or_else(|e| fail("ERR_LINE", e.code()));
    }

    /// LF-007: the buyer or supplier proposes a split of a DISPUTED line,
    /// `buyer_amount + supplier_amount == principal` (canonical decimal
    /// strings, checked). Becomes the line's single active proposal and
    /// supersedes any earlier one. Allowed in every dispute phase until a
    /// final allocation exists (`docs/08`). No ledger move, no token call.
    /// Returns the new proposal id (per-line nonce).
    pub fn propose_split(
        &mut self,
        agreement_id: U64,
        line_id: u32,
        buyer_amount: String,
        supplier_amount: String,
    ) -> U64 {
        let b = amount("buyer_amount", &buyer_amount);
        let s = amount("supplier_amount", &supplier_amount);
        let (caller, now) = (env::predecessor_account_id(), env::block_timestamp());
        let id = self
            .agreement_mut(agreement_id)
            .propose_split(line_id, &caller, b, s, now)
            .unwrap_or_else(|e| fail("ERR_LINE", e.code()));
        U64(id)
    }

    /// LF-007: the counterparty of the proposer accepts the exact active
    /// proposal (`proposal_id` and both amounts must match). Single writer:
    /// the line becomes ALLOCATED (`MUTUAL`, immutable); locked → claimable.
    /// No outgoing token transfer (payouts are LF-009). E is unchanged.
    pub fn accept_split(
        &mut self,
        agreement_id: U64,
        line_id: u32,
        proposal_id: String,
        buyer_amount: String,
        supplier_amount: String,
    ) {
        let id = parse_u64("proposal_id", &proposal_id)
            .unwrap_or_else(|e| fail("ERR_AMOUNT_FORMAT", e.code()));
        let b = amount("buyer_amount", &buyer_amount);
        let s = amount("supplier_amount", &supplier_amount);
        let (caller, now) = (env::predecessor_account_id(), env::block_timestamp());
        self.agreement_mut(agreement_id)
            .accept_split(line_id, &caller, id, b, s, now)
            .unwrap_or_else(|e| fail("ERR_LINE", e.code()));
    }

    /// LF-008: an appointed arbitrator rules on a DISPUTED line inside its own
    /// window only — primary in `[T0+N, T0+N+A)`, backup in
    /// `[T0+N+A, T0+N+A+B)` — with `buyer_amount + supplier_amount ==
    /// principal` (strict decimals, checked). Single writer: ALLOCATED and
    /// immutable. Allocation only between the original buyer and supplier;
    /// no token call (payouts are LF-009); E unchanged.
    pub fn submit_ruling(
        &mut self,
        agreement_id: U64,
        line_id: u32,
        buyer_amount: String,
        supplier_amount: String,
    ) {
        let b = amount("buyer_amount", &buyer_amount);
        let s = amount("supplier_amount", &supplier_amount);
        let (caller, now) = (env::predecessor_account_id(), env::block_timestamp());
        self.agreement_mut(agreement_id)
            .submit_ruling(line_id, &caller, b, s, now)
            .unwrap_or_else(|e| fail("ERR_LINE", e.code()));
    }

    /// LF-008: **any caller**, from `T0 + N + A + B`, applies the pre-agreed
    /// fallback split of the hashed terms (supplier = floor(P·bps/10 000),
    /// buyer = remainder). No amount parameters; result depends only on
    /// stored terms and chain time. Single writer; E unchanged.
    pub fn trigger_fallback(&mut self, agreement_id: U64, line_id: u32) {
        let now = env::block_timestamp();
        self.agreement_mut(agreement_id)
            .trigger_fallback(line_id, now)
            .unwrap_or_else(|e| fail("ERR_LINE", e.code()));
    }

    /// LF-009: the beneficiary withdraws their **whole** claimable amount on
    /// one ALLOCATED line. Caller must be the immutable `buyer_id` (for
    /// `BUYER`) or `supplier_id` (for `SUPPLIER`); the recipient is always that
    /// account. Requires exactly 1 yoctoNEAR (forwarded to `ft_transfer`) and
    /// enough prepaid gas for the transfer and the callback; both are checked
    /// before any state change. claimable → pending (E unchanged), then
    /// `ft_transfer` on the allowlisted token and the private callback, which
    /// alone decides PAID / FAILED. At most one open withdrawal per slot.
    #[payable]
    pub fn withdraw(&mut self, agreement_id: U64, line_id: u32, beneficiary: String) -> Promise {
        if env::attached_deposit() != NearToken::from_yoctonear(1) {
            fail("ERR_WITHDRAW", "DepositMustBeOneYocto");
        }
        let need = GAS_FT_TRANSFER
            .as_gas()
            .checked_add(GAS_WITHDRAW_CALLBACK.as_gas())
            .and_then(|g| g.checked_add(GAS_WITHDRAW_SELF.as_gas()))
            .unwrap_or(u64::MAX);
        if env::prepaid_gas().as_gas() < need {
            fail("ERR_WITHDRAW", "InsufficientGas");
        }
        let b = beneficiary_from(&beneficiary)
            .unwrap_or_else(|| fail("ERR_WITHDRAW", "BadBeneficiary"));
        let id = self
            .last_withdrawal_id
            .checked_add(1)
            .unwrap_or_else(|| fail("ERR_WITHDRAW", "IdOverflow"));
        let open = self
            .open_withdrawals
            .checked_add(1)
            .unwrap_or_else(|| fail("ERR_WITHDRAW", "OpenCountOverflow"));
        let (caller, now) = (env::predecessor_account_id(), env::block_timestamp());
        let a = self.agreement_mut(agreement_id);
        // The caller must be exactly the requested beneficiary, checked before
        // anything is reserved.
        if a.beneficiary_of(&caller) != Some(b) {
            fail("ERR_LINE", "NotAuthorized");
        }
        let (ticket, recipient) = a
            .begin_withdrawal(line_id, &caller, id, now)
            .unwrap_or_else(|e| fail("ERR_LINE", e.code()));
        self.last_withdrawal_id = id;
        self.open_withdrawals = open;
        ext_ft_core::ext(self.allowlisted_ft_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(recipient, U128(ticket.amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_WITHDRAW_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_withdrawal_transfer(
                        agreement_id,
                        line_id,
                        beneficiary,
                        U64(id),
                        ticket.epoch,
                    ),
            )
    }

    /// LF-009 private callback (`docs/27` R-1). Only the escrow itself may call
    /// it. Total: never panics for the genuine callback; anything that does
    /// not match the exact PENDING withdrawal (id, epoch, line, beneficiary)
    /// changes nothing. Successful transfer → PAID and E −= amount (checked;
    /// an underflow keeps it PENDING and logs an incident). Failed transfer →
    /// FAILED, amount restored to claimable once, E unchanged.
    #[private]
    pub fn on_withdrawal_transfer(
        &mut self,
        agreement_id: U64,
        line_id: u32,
        beneficiary: String,
        withdrawal_id: U64,
        epoch: u32,
    ) -> WithdrawalResultView {
        // Explicit as well as `#[private]` (which guards only the exported
        // entry point): only the escrow itself may deliver the outcome.
        if env::predecessor_account_id() != env::current_account_id() {
            fail("ERR_WITHDRAW", "CallbackNotPrivate");
        }
        let id = withdrawal_id.0;
        let result = |outcome: &str| WithdrawalResultView {
            withdrawal_id,
            outcome: outcome.to_string(),
        };
        let ignored = |code: &str| {
            env::log_str(&format!("LF_WITHDRAWAL_IGNORED:{code}:{id}"));
            result("IGNORED")
        };
        if env::promise_results_count() != 1 {
            return ignored("ResultCount");
        }
        // Read no data (max_len 0): Failed = the ft_transfer receipt
        // reverted (definite failure); anything else = the receipt succeeded.
        let outcome = match env::promise_result_checked(0, 0) {
            Err(PromiseError::Failed) => WithdrawalOutcome::DefiniteFailure,
            Ok(_) | Err(PromiseError::TooLong(_)) => WithdrawalOutcome::Success,
            // `PromiseError` is non-exhaustive: an unknown outcome is never
            // guessed. The withdrawal stays PENDING (inconclusive, `docs/27`).
            Err(_) => {
                env::log_str(&format!("LF_WITHDRAWAL_INCONCLUSIVE:{id}"));
                return result("PENDING");
            }
        };
        let Some(b) = beneficiary_from(&beneficiary) else {
            return ignored("BadBeneficiary");
        };
        let Some(a) = self.agreements.get(&agreement_id.0) else {
            return ignored("AgreementNotFound");
        };
        let slot = match a.withdrawal_slot(line_id, b) {
            Ok(s) => s,
            Err(e) => return ignored(e.code()),
        };
        if slot.state != SlotState::Pending {
            return ignored("WithdrawalNotPending");
        }
        if slot.withdrawal_id != id || slot.epoch != epoch {
            return ignored("WithdrawalIdMismatch");
        }
        let new_e = match outcome {
            WithdrawalOutcome::Success => match self.custody_total.checked_sub(slot.amount) {
                Some(e) => e,
                None => {
                    env::log_str(&format!("LF_INCIDENT:CustodyUnderflow:{id}"));
                    return result("PENDING");
                }
            },
            WithdrawalOutcome::DefiniteFailure => self.custody_total,
        };
        let now = env::block_timestamp();
        let Some(a) = self.agreements.get_mut(&agreement_id.0) else {
            return ignored("AgreementNotFound");
        };
        if let Err(e) = a.resolve_withdrawal(line_id, b, id, epoch, outcome, now) {
            return ignored(e.code());
        }
        self.custody_total = new_e;
        self.open_withdrawals = match self.open_withdrawals.checked_sub(1) {
            Some(n) => n,
            None => {
                env::log_str(&format!("LF_INCIDENT:OpenCountUnderflow:{id}"));
                0
            }
        };
        match outcome {
            WithdrawalOutcome::Success => {
                env::log_str(&format!("LF_WITHDRAWAL_PAID:{id}"));
                result("PAID")
            }
            WithdrawalOutcome::DefiniteFailure => {
                env::log_str(&format!("LF_WITHDRAWAL_FAILED:{id}"));
                result("FAILED")
            }
        }
    }

    /// LF-009 view: the latest withdrawal of one beneficiary on one line.
    pub fn get_withdrawal(
        &self,
        agreement_id: U64,
        line_id: u32,
        beneficiary: String,
    ) -> Option<WithdrawalView> {
        let b = beneficiary_from(&beneficiary)?;
        let a = self.agreements.get(&agreement_id.0)?;
        let s = a.withdrawal_slot(line_id, b).ok()?;
        let recipient = match b {
            Beneficiary::Buyer => a.terms.buyer_id.clone(),
            Beneficiary::Supplier => a.terms.supplier_id.clone(),
        };
        Some(WithdrawalView {
            agreement_id,
            line_id,
            beneficiary,
            state: s.state.as_str().to_string(),
            withdrawal_id: U64(s.withdrawal_id),
            epoch: s.epoch,
            amount: U128(s.amount),
            started_at_ns: U64(s.started_at_ns),
            resolved_at_ns: U64(s.resolved_at_ns),
            recipient,
            ft_contract_id: self.allowlisted_ft_id.clone(),
        })
    }

    /// LF-009 view: liabilities and open withdrawals (observation only).
    pub fn custody_summary(&self) -> CustodySummaryView {
        CustodySummaryView {
            outstanding_liabilities: U128(self.custody_total),
            open_withdrawals: U64(self.open_withdrawals),
            last_withdrawal_id: U64(self.last_withdrawal_id),
            ft_contract_id: self.allowlisted_ft_id.clone(),
        }
    }

    /// Rule B: outstanding customer token liabilities E (locked + claimable +
    /// pending over all lines; paid excluded). Read-only observation: compare
    /// with the token's `ft_balance_of(escrow)` offchain. A surplus (balance >
    /// E) comes from inflows not credited as funding, which are never credited
    /// or swept. The aggregate balance is never used to infer or change any
    /// withdrawal outcome (`docs/27` R-2).
    pub fn outstanding_liabilities(&self) -> U128 {
        U128(self.custody_total)
    }

    pub fn contract_version(&self) -> String {
        if cfg!(feature = "test-starve-callback") {
            format!("{CONTRACT_VERSION} +test-starve-callback")
        } else {
            CONTRACT_VERSION.to_string()
        }
    }
}

/// NEP-141 receiver (`docs/07` §Recognized deposit flow). The return value is
/// the **unused** amount: `0` only after an exact, valid deposit has been
/// credited to exactly one line; the full amount (refunded by the token's
/// resolver) in every other case, with nothing written. Never panics on bad
/// input. Refunds log only a reason code.
#[near]
impl FungibleTokenReceiver for Contract {
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        match self.try_credit_deposit(&sender_id, amount.0, &msg) {
            Ok(()) => PromiseOrValue::Value(U128(0)),
            Err(code) => {
                env::log_str(&format!("LF_FT_REFUND:{code}"));
                PromiseOrValue::Value(amount)
            }
        }
    }
}

impl Contract {
    /// All checks run on a copy; the agreement is written only on success.
    fn try_credit_deposit(
        &mut self,
        sender_id: &AccountId,
        amount: u128,
        msg: &str,
    ) -> Result<(), &'static str> {
        if env::predecessor_account_id() != self.allowlisted_ft_id {
            return Err("UnexpectedToken");
        }
        let m = parse_funding_msg(msg).map_err(FundingMsgError::code)?;
        let mut a = self
            .agreements
            .get(&m.agreement_id)
            .cloned()
            .ok_or("AgreementNotFound")?;
        if m.terms_hash != a.terms_hash {
            return Err("TermsHashMismatch");
        }
        a.fund_line(m.line_id, sender_id, amount, env::block_timestamp())
            .map_err(LineOpError::code)?;
        // Rule B: checked before anything is written.
        let custody_total = self
            .custody_total
            .checked_add(amount)
            .ok_or("CustodyOverflow")?;
        self.agreements.insert(m.agreement_id, a);
        self.custody_total = custody_total;
        Ok(())
    }

    /// Mutable agreement or `ERR_AGREEMENT_NOT_FOUND`. Every caller panics on
    /// a rejected transition, so the whole call reverts.
    fn agreement_mut(&mut self, agreement_id: U64) -> &mut AgreementV1 {
        self.agreements
            .get_mut(&agreement_id.0)
            .unwrap_or_else(|| env::panic_str("ERR_AGREEMENT_NOT_FOUND"))
    }

    fn accept(&mut self, kind: AcceptKind, agreement_id: U64, terms_hash_hex: &str) {
        let quoted = parse_hex32("terms_hash", terms_hash_hex)
            .unwrap_or_else(|_| env::panic_str("ERR_TERMS_HASH_FORMAT"));
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let a = self
            .agreements
            .get_mut(&agreement_id.0)
            .unwrap_or_else(|| env::panic_str("ERR_AGREEMENT_NOT_FOUND"));
        a.accept(kind, &caller, &quoted, now)
            .unwrap_or_else(|e| fail("ERR_ACCEPT", e.code()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const NOW: u64 = 1_800_000_000_000_000_000;
    const HOUR: u64 = 3_600_000_000_000;

    fn acc(s: &str) -> AccountId {
        s.parse().expect("account")
    }

    fn set_ctx(predecessor: &str, now: u64) {
        let t = std::time::Instant::now();
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("escrow.test.near"))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(predecessor))
            .block_timestamp(now);
        testing_env!(b.build());
        B4T.with(|x| {
            let mut x = x.borrow_mut();
            x.set_ctx += t.elapsed();
            x.set_ctx_calls += 1;
        });
    }

    /// Test-only phase timing for the B4 bottleneck investigation.
    #[derive(Default, Debug)]
    struct B4Timing {
        reset_and_init: std::time::Duration,
        agreements: std::time::Duration,
        deposits: std::time::Duration,
        checks: std::time::Duration,
        set_ctx: std::time::Duration,
        set_ctx_calls: u64,
    }

    thread_local! {
        static B4T: std::cell::RefCell<B4Timing> = std::cell::RefCell::new(B4Timing::default());
    }

    /// Wipe the mocked chain's storage: each independent property case starts
    /// from an empty chain. Within a case storage persists across calls,
    /// because `testing_env!` carries the trie forward. Every `Contract` of the
    /// previous case must already be dropped (`store` collections flush on drop).
    fn fresh_chain() {
        near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    }

    /// LF-010A test default: two allowlisted creators. `supplier` is listed
    /// on purpose so "allowlisted but not the buyer" stays testable.
    fn test_creators() -> Vec<AccountId> {
        vec![acc("buyer.test.near"), acc("supplier.test.near")]
    }

    fn init(max: u32) -> Contract {
        set_ctx("escrow.test.near", NOW);
        Contract::new(
            "sandbox".into(),
            acc("ft.test.near"),
            acc("treasury.test.near"),
            max,
            test_creators(),
        )
    }

    fn terms_json(nonce: u64, lines: usize) -> AgreementTermsJsonV1 {
        let line = |i: u32| terms_json::LineTermsJsonV1 {
            line_id: i,
            principal: "1000000".into(),
            delivery_deadline_ns: (NOW + 96 * HOUR).to_string(),
            acceptance_criteria_commitment: "ab".repeat(32),
            fallback_buyer_bps: 5_000,
            fallback_supplier_bps: 5_000,
        };
        AgreementTermsJsonV1 {
            schema_version: 1,
            deadline_rules_version: 1,
            buyer_id: "buyer.test.near".into(),
            supplier_id: "supplier.test.near".into(),
            primary_arbitrator_id: "primary.test.near".into(),
            backup_arbitrator_id: "backup.test.near".into(),
            ft_contract_id: "ft.test.near".into(),
            agreement_nonce: nonce.to_string(),
            acceptance_deadline_ns: (NOW + 24 * HOUR).to_string(),
            funding_deadline_ns: (NOW + 48 * HOUR).to_string(),
            delivery_grace_period_ns: "0".into(),
            review_window_ns: terms::DEFAULT_REVIEW_WINDOW_NS.to_string(),
            negotiation_window_ns: terms::DEFAULT_NEGOTIATION_WINDOW_NS.to_string(),
            primary_window_ns: terms::DEFAULT_PRIMARY_WINDOW_NS.to_string(),
            backup_window_ns: terms::DEFAULT_BACKUP_WINDOW_NS.to_string(),
            lines: (0..lines)
                .map(|i| line(u32::try_from(i).expect("small")))
                .collect(),
        }
    }

    #[test]
    fn contract_version_is_stable() {
        let c = init(5);
        assert_eq!(c.contract_version(), CONTRACT_VERSION);
    }

    #[test]
    fn t001_create_returns_monotonic_ids_and_deterministic_hash() {
        let mut c = init(5);
        set_ctx("buyer.test.near", NOW);
        let expected = c.compute_terms_hash(terms_json(1, 3));
        assert_eq!(c.create_agreement(terms_json(1, 3)), U64(0));
        assert_eq!(c.create_agreement(terms_json(2, 3)), U64(1));
        let v = c.get_agreement(U64(0)).expect("exists");
        assert_eq!(v.status, "PROPOSED");
        assert_eq!(v.terms_hash, expected);
        assert_eq!(v.terms, terms_json(1, 3));
        assert_eq!(
            v.acceptances,
            AcceptancesView {
                buyer: false,
                supplier: false,
                primary_arbitrator: false,
                backup_arbitrator: false
            }
        );
        assert_eq!(c.get_config().agreements_created, U64(2));
        assert!(c.get_agreement(U64(2)).is_none());
    }

    #[test]
    #[should_panic(expected = "ERR_DUPLICATE_TERMS")]
    fn t078_identical_preimage_rejected() {
        let mut c = init(5);
        set_ctx("buyer.test.near", NOW);
        c.create_agreement(terms_json(1, 3));
        c.create_agreement(terms_json(1, 3));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_BUYER")]
    fn create_by_non_buyer_rejected() {
        let mut c = init(5);
        set_ctx("supplier.test.near", NOW);
        c.create_agreement(terms_json(1, 3));
    }

    #[test]
    #[should_panic(expected = "ERR_AGREEMENT_CAP_REACHED")]
    fn cap_reached_rejected() {
        let mut c = init(2);
        set_ctx("buyer.test.near", NOW);
        c.create_agreement(terms_json(1, 1));
        c.create_agreement(terms_json(2, 1));
        c.create_agreement(terms_json(3, 1));
    }

    #[test]
    #[should_panic(expected = "ERR_TERMS_INVALID:RolesNotDistinct")]
    fn invalid_terms_rejected_with_code() {
        let mut c = init(5);
        set_ctx("buyer.test.near", NOW);
        let mut t = terms_json(1, 1);
        t.supplier_id = "buyer.test.near".into();
        c.create_agreement(t);
    }

    #[test]
    #[should_panic(expected = "ERR_TERMS_PARSE:NonCanonicalDecimal")]
    fn non_canonical_terms_rejected_with_code() {
        let mut c = init(5);
        set_ctx("buyer.test.near", NOW);
        let mut t = terms_json(1, 1);
        t.agreement_nonce = "01".into();
        c.create_agreement(t);
    }

    #[test]
    fn three_line_agreement_storage_within_budget() {
        let mut c = init(5);
        set_ctx("buyer.test.near", NOW);
        let before = env::storage_usage();
        c.create_agreement(terms_json(1, 3));
        let used = env::storage_usage() - before;
        assert!(used <= MAX_AGREEMENT_BYTES, "used {used}");
    }

    #[test]
    fn full_acceptance_through_contract_methods() {
        let mut c = init(5);
        set_ctx("buyer.test.near", NOW);
        let id = c.create_agreement(terms_json(1, 3));
        let h = c.get_agreement(id).expect("exists").terms_hash;
        for (who, appointment) in [
            ("buyer.test.near", false),
            ("supplier.test.near", false),
            ("primary.test.near", true),
            ("backup.test.near", true),
        ] {
            set_ctx(who, NOW + 1);
            if appointment {
                c.accept_appointment(id, h.clone());
            } else {
                c.accept_terms(id, h.clone());
            }
        }
        assert_eq!(c.get_agreement(id).expect("exists").status, "AGREED");
    }

    #[test]
    #[should_panic(expected = "ERR_TERMS_HASH_FORMAT")]
    fn uppercase_hash_rejected() {
        let mut c = init(5);
        set_ctx("buyer.test.near", NOW);
        let id = c.create_agreement(terms_json(1, 1));
        let h = c
            .get_agreement(id)
            .expect("exists")
            .terms_hash
            .to_uppercase();
        c.accept_terms(id, h);
    }

    #[test]
    #[should_panic(expected = "ERR_AGREEMENT_NOT_FOUND")]
    fn unknown_agreement_rejected() {
        let mut c = init(5);
        set_ctx("buyer.test.near", NOW);
        c.accept_terms(U64(9), "00".repeat(32));
    }

    #[test]
    #[should_panic(expected = "ERR_INIT_NETWORK")]
    fn init_rejects_mainnet() {
        set_ctx("escrow.test.near", NOW);
        Contract::new(
            "mainnet".into(),
            acc("ft.test.near"),
            acc("treasury.test.near"),
            5,
            test_creators(),
        );
    }

    #[test]
    fn t079_init_rejects_mainnet_and_unknown_networks() {
        for bad in ["mainnet", "localnet", "Testnet", "SANDBOX", "testnet ", ""] {
            set_ctx("escrow.test.near", NOW);
            let r = std::panic::catch_unwind(|| {
                Contract::new(
                    bad.into(),
                    acc("ft.test.near"),
                    acc("treasury.test.near"),
                    5,
                    test_creators(),
                )
            });
            let payload = match r {
                Ok(_) => panic!("{bad:?} must be rejected"),
                Err(p) => p,
            };
            let msg = payload
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| payload.downcast_ref::<&str>().copied())
                .unwrap_or("");
            assert!(msg.contains("ERR_INIT_NETWORK"), "{bad:?}: {msg}");
        }
        for ok in ["sandbox", "testnet"] {
            set_ctx("escrow.test.near", NOW);
            let c = Contract::new(
                ok.into(),
                acc("ft.test.near"),
                acc("treasury.test.near"),
                5,
                test_creators(),
            );
            assert_eq!(c.get_config().network_id, ok);
        }
    }

    #[test]
    #[should_panic(expected = "ERR_INIT_MAX_AGREEMENTS")]
    fn init_rejects_cap_above_provisional_limit() {
        init(MAX_AGREEMENTS_LIMIT + 1);
    }

    #[test]
    #[should_panic(expected = "ERR_INIT_ACCOUNTS_NOT_DISTINCT")]
    fn init_rejects_ft_equal_treasury() {
        set_ctx("escrow.test.near", NOW);
        Contract::new(
            "sandbox".into(),
            acc("ft.test.near"),
            acc("ft.test.near"),
            5,
            test_creators(),
        );
    }

    // ---- LF-005: ft_on_transfer (mocked chain) ------------------------------
    // Principal per line in terms_json(): 1 000 000. FT = ft.test.near.

    const P: u128 = 1_000_000;
    const FT: &str = "ft.test.near";

    fn returned(r: PromiseOrValue<U128>) -> u128 {
        match r {
            PromiseOrValue::Value(v) => v.0,
            PromiseOrValue::Promise(_) => panic!("ft_on_transfer must return a value"),
        }
    }

    /// Create + all four acceptances; returns (id, hash).
    fn agreed(c: &mut Contract, nonce: u64, lines: usize) -> (U64, String) {
        set_ctx("buyer.test.near", NOW);
        let id = c.create_agreement(terms_json(nonce, lines));
        let h = c.get_agreement(id).expect("exists").terms_hash;
        for (who, appt) in [
            ("buyer.test.near", false),
            ("supplier.test.near", false),
            ("primary.test.near", true),
            ("backup.test.near", true),
        ] {
            set_ctx(who, NOW + 1);
            if appt {
                c.accept_appointment(id, h.clone());
            } else {
                c.accept_terms(id, h.clone());
            }
        }
        (id, h)
    }

    /// `agreed` with every delivery deadline at NOW + 200 h (F3 never binds
    /// before the funding deadline at NOW + 48 h).
    fn agreed_far(c: &mut Contract, nonce: u64, lines: usize) -> (U64, String) {
        set_ctx("buyer.test.near", NOW);
        let mut t = terms_json(nonce, lines);
        for l in t.lines.iter_mut() {
            l.delivery_deadline_ns = (NOW + 200 * HOUR).to_string();
        }
        let id = c.create_agreement(t);
        let h = c.get_agreement(id).expect("exists").terms_hash;
        for (who, appt) in [
            ("buyer.test.near", false),
            ("supplier.test.near", false),
            ("primary.test.near", true),
            ("backup.test.near", true),
        ] {
            set_ctx(who, NOW + 1);
            if appt {
                c.accept_appointment(id, h.clone());
            } else {
                c.accept_terms(id, h.clone());
            }
        }
        (id, h)
    }

    fn msg(id: U64, line: u32, h: &str) -> String {
        format!(
            r#"{{"version":1,"agreement_id":"{}","line_id":{line},"terms_hash":"{h}"}}"#,
            id.0
        )
    }

    fn deposit(c: &mut Contract, ft: &str, sender: &str, amount: u128, m: &str, now: u64) -> u128 {
        set_ctx(ft, now);
        returned(c.ft_on_transfer(acc(sender), U128(amount), m.to_string()))
    }

    fn stored(c: &Contract, id: U64) -> Vec<u8> {
        near_sdk::borsh::to_vec(c.agreements.get(&id.0).expect("stored")).expect("borsh")
    }

    /// Refund path: full amount back, reason logged, agreement byte-identical.
    #[allow(clippy::too_many_arguments)] // test-only assertion helper
    fn assert_refund(
        c: &mut Contract,
        id: U64,
        ft: &str,
        sender: &str,
        amount: u128,
        m: &str,
        now: u64,
        code: &str,
    ) {
        let before = stored(c, id);
        let custody_before = c.custody_total;
        assert_eq!(
            deposit(c, ft, sender, amount, m, now),
            amount,
            "full amount unused for {code}"
        );
        assert!(
            near_sdk::test_utils::get_logs()
                .iter()
                .any(|l| l == &format!("LF_FT_REFUND:{code}")),
            "expected log LF_FT_REFUND:{code}, got {:?}",
            near_sdk::test_utils::get_logs()
        );
        assert_eq!(stored(c, id), before, "no state change on refund ({code})");
        assert_eq!(
            c.custody_total, custody_before,
            "Rule B: refund leaves E unchanged ({code})"
        );
    }

    #[test]
    fn ft_on_transfer_valid_deposit_returns_zero_and_funds_line() {
        let mut c = init(5);
        let (id, h) = agreed(&mut c, 1, 3);
        assert_eq!(
            deposit(&mut c, FT, "buyer.test.near", P, &msg(id, 1, &h), NOW + 2),
            0
        );
        let v = c.get_agreement(id).expect("exists");
        assert_eq!(v.status, "ACTIVE");
        assert_eq!(v.lines[1].status, "FUNDED");
        assert_eq!(v.lines[1].locked, U128(P));
        assert_eq!(
            (v.lines[0].status.as_str(), v.lines[2].status.as_str()),
            ("UNFUNDED", "UNFUNDED")
        );
        assert!(
            near_sdk::test_utils::get_logs().is_empty(),
            "no refund log on success"
        );
    }

    #[test]
    fn t020_unexpected_predecessor_full_refund_no_change() {
        let mut c = init(5);
        let (id, h) = agreed(&mut c, 1, 1);
        for fake in [
            "fake-ft.test.near",
            "buyer.test.near",
            "escrow.test.near",
            "treasury.test.near",
        ] {
            assert_refund(
                &mut c,
                id,
                fake,
                "buyer.test.near",
                P,
                &msg(id, 0, &h),
                NOW + 2,
                "UnexpectedToken",
            );
        }
    }

    #[test]
    fn t019_sender_not_buyer_full_refund() {
        let mut c = init(5);
        let (id, h) = agreed(&mut c, 1, 1);
        for who in [
            "supplier.test.near",
            "primary.test.near",
            "backup.test.near",
            "stranger.test.near",
        ] {
            assert_refund(
                &mut c,
                id,
                FT,
                who,
                P,
                &msg(id, 0, &h),
                NOW + 2,
                "NotAuthorized",
            );
        }
    }

    #[test]
    fn t031_t032_wrong_amount_full_refund() {
        let mut c = init(5);
        let (id, h) = agreed(&mut c, 1, 1);
        for amt in [P - 1, P + 1, 1, u128::MAX] {
            assert_refund(
                &mut c,
                id,
                FT,
                "buyer.test.near",
                amt,
                &msg(id, 0, &h),
                NOW + 2,
                "AmountMismatch",
            );
        }
    }

    #[test]
    fn t033_second_deposit_same_line_full_refund() {
        let mut c = init(5);
        let (id, h) = agreed(&mut c, 1, 2);
        assert_eq!(
            deposit(&mut c, FT, "buyer.test.near", P, &msg(id, 0, &h), NOW + 2),
            0
        );
        assert_refund(
            &mut c,
            id,
            FT,
            "buyer.test.near",
            P,
            &msg(id, 0, &h),
            NOW + 3,
            "WrongState",
        );
        // The other line is still fundable.
        assert_eq!(
            deposit(&mut c, FT, "buyer.test.near", P, &msg(id, 1, &h), NOW + 3),
            0
        );
    }

    #[test]
    fn t034_unknown_agreement_or_other_agreements_hash_refund() {
        let mut c = init(5);
        let (id0, h0) = agreed(&mut c, 1, 1);
        let (id1, h1) = agreed(&mut c, 2, 1);
        assert_refund(
            &mut c,
            id0,
            FT,
            "buyer.test.near",
            P,
            &msg(U64(9), 0, &h0),
            NOW + 2,
            "AgreementNotFound",
        );
        assert_refund(
            &mut c,
            id0,
            FT,
            "buyer.test.near",
            P,
            &msg(id0, 0, &h1),
            NOW + 2,
            "TermsHashMismatch",
        );
        assert_refund(
            &mut c,
            id1,
            FT,
            "buyer.test.near",
            P,
            &msg(id1, 0, &h0),
            NOW + 2,
            "TermsHashMismatch",
        );
    }

    #[test]
    fn t066_terms_hash_mismatch_full_refund() {
        let mut c = init(5);
        let (id, h) = agreed(&mut c, 1, 1);
        let mut flipped = h.clone().into_bytes();
        flipped[0] = if flipped[0] == b'a' { b'b' } else { b'a' };
        let flipped = String::from_utf8(flipped).expect("utf8");
        for bad in [flipped.as_str(), &"0".repeat(64)] {
            assert_refund(
                &mut c,
                id,
                FT,
                "buyer.test.near",
                P,
                &msg(id, 0, bad),
                NOW + 2,
                "TermsHashMismatch",
            );
        }
    }

    #[test]
    fn funding_before_agreed_full_refund() {
        let mut c = init(5);
        set_ctx("buyer.test.near", NOW);
        let id = c.create_agreement(terms_json(1, 1));
        let h = c.get_agreement(id).expect("exists").terms_hash;
        assert_refund(
            &mut c,
            id,
            FT,
            "buyer.test.near",
            P,
            &msg(id, 0, &h),
            NOW + 1,
            "AgreementNotAgreed",
        );
        set_ctx("buyer.test.near", NOW + 1);
        c.accept_terms(id, h.clone());
        assert_refund(
            &mut c,
            id,
            FT,
            "buyer.test.near",
            P,
            &msg(id, 0, &h),
            NOW + 2,
            "AgreementNotAgreed",
        );
    }

    #[test]
    fn funding_deadline_minus1_ok_exact_and_plus1_refund() {
        let deadline = NOW + 48 * HOUR; // terms_json(): funding deadline
        let mut c = init(5);
        // F3: delivery far enough out that the funding deadline binds.
        let (id, h) = agreed_far(&mut c, 1, 3);
        assert_refund(
            &mut c,
            id,
            FT,
            "buyer.test.near",
            P,
            &msg(id, 0, &h),
            deadline,
            "FundingDeadlinePassed",
        );
        assert_refund(
            &mut c,
            id,
            FT,
            "buyer.test.near",
            P,
            &msg(id, 0, &h),
            deadline + 1,
            "FundingDeadlinePassed",
        );
        assert_eq!(
            deposit(
                &mut c,
                FT,
                "buyer.test.near",
                P,
                &msg(id, 0, &h),
                deadline - 1
            ),
            0
        );
    }

    #[test]
    fn malformed_msg_full_refund_state_byte_identical() {
        let mut c = init(5);
        let (id, h) = agreed(&mut c, 1, 1);
        let cases: Vec<(String, &str)> = vec![
            (String::new(), "MsgJson"),
            ("{}".into(), "MsgJson"),
            (format!("{}x", msg(id, 0, &h)), "MsgJson"),
            (
                msg(id, 0, &h).replace("\"version\":1", "\"version\":2"),
                "MsgVersion",
            ),
            (
                msg(id, 0, &h).replace("\"agreement_id\":\"0\"", "\"agreement_id\":\"00\""),
                "MsgAgreementIdNonCanonical",
            ),
            (
                msg(id, 0, &h).replace(
                    "\"agreement_id\":\"0\"",
                    "\"agreement_id\":\"18446744073709551616\"",
                ),
                "MsgAgreementIdOverflow",
            ),
            (msg(id, 3, &h), "MsgLineIdOutOfRange"),
            (msg(id, 0, &h.to_uppercase()), "MsgTermsHash"),
            (msg(id, 0, &h).replace('}', ",\"memo\":\"x\"}"), "MsgJson"),
        ];
        for (m, code) in cases {
            assert_refund(&mut c, id, FT, "buyer.test.near", P, &m, NOW + 2, code);
        }
    }

    #[test]
    fn line_not_in_agreement_full_refund() {
        let mut c = init(5);
        let (id, h) = agreed(&mut c, 1, 1);
        for line in [1u32, 2] {
            assert_refund(
                &mut c,
                id,
                FT,
                "buyer.test.near",
                P,
                &msg(id, line, &h),
                NOW + 2,
                "LineNotFound",
            );
        }
    }

    // ---- Rule B (founder 2026-11-01): outstanding liabilities E -------------

    /// E recomputed from storage: Σ (locked + claimable + pending) over all
    /// agreements 0..next_agreement_id. Paid is excluded.
    fn unpaid_buckets(c: &Contract) -> u128 {
        (0..c.next_agreement_id)
            .filter_map(|id| c.agreements.get(&id))
            .flat_map(|a| a.lines.iter())
            .map(|l| {
                let g = &l.ledger;
                g.locked
                    + g.buyer_claimable
                    + g.supplier_claimable
                    + g.buyer_pending
                    + g.supplier_pending
            })
            .sum()
    }

    #[test]
    fn rule_b_credited_deposit_increases_outstanding_by_p() {
        let mut c = init(5);
        assert_eq!(c.outstanding_liabilities(), U128(0));
        let (id, h) = agreed(&mut c, 1, 3);
        let (id2, h2) = agreed(&mut c, 2, 1);
        assert_eq!(
            deposit(&mut c, FT, "buyer.test.near", P, &msg(id, 0, &h), NOW + 2),
            0
        );
        assert_eq!(c.outstanding_liabilities(), U128(P));
        assert_eq!(
            deposit(&mut c, FT, "buyer.test.near", P, &msg(id2, 0, &h2), NOW + 2),
            0
        );
        assert_eq!(
            c.outstanding_liabilities(),
            U128(2 * P),
            "contract-wide across agreements"
        );
        assert_eq!(unpaid_buckets(&c), 2 * P);
        // Refunds leave E unchanged (assert_refund also checks this).
        assert_refund(
            &mut c,
            id,
            FT,
            "buyer.test.near",
            P - 1,
            &msg(id, 1, &h),
            NOW + 2,
            "AmountMismatch",
        );
        assert_refund(
            &mut c,
            id,
            FT,
            "buyer.test.near",
            P,
            &msg(id, 0, &h),
            NOW + 2,
            "WrongState",
        );
        assert_eq!(c.outstanding_liabilities(), U128(2 * P));
    }

    #[test]
    fn rule_b_overflow_refunds_and_writes_nothing() {
        let mut c = init(5);
        let (id, h) = agreed(&mut c, 1, 2);
        // One unit of headroom short: refunded, byte-identical, E unchanged.
        c.custody_total = u128::MAX - (P - 1);
        assert_refund(
            &mut c,
            id,
            FT,
            "buyer.test.near",
            P,
            &msg(id, 0, &h),
            NOW + 2,
            "CustodyOverflow",
        );
        assert_eq!(c.custody_total, u128::MAX - (P - 1));
        // Exact headroom: credited and E reaches u128::MAX.
        c.custody_total = u128::MAX - P;
        assert_eq!(
            deposit(&mut c, FT, "buyer.test.near", P, &msg(id, 0, &h), NOW + 2),
            0
        );
        assert_eq!(c.custody_total, u128::MAX);
        // Any further credit overflows.
        assert_refund(
            &mut c,
            id,
            FT,
            "buyer.test.near",
            P,
            &msg(id, 1, &h),
            NOW + 2,
            "CustodyOverflow",
        );
    }

    #[test]
    fn rule_b_state_layout_adds_exactly_16_bytes() {
        let mut c = init(5);
        // Root state = network (1) + bstr(ft) + bstr(treasury) + max_agreements (4)
        // + next_agreement_id (8) + 2 × LookupMap prefix (4 + 1) + custody_total (16).
        let ft = "ft.test.near".len();
        let tr = "treasury.test.near".len();
        let without_rule_b = 1 + (4 + ft) + (4 + tr) + 4 + 8 + 2 * (4 + 1);
        // LF-009 appends last_withdrawal_id (8) + open_withdrawals (8) after E;
        // LF-010A appends the creator allowlist Vec<AccountId> (4 + Σ(4 + len)).
        let list_bytes = 4 + test_creators()
            .iter()
            .map(|a| 4 + a.as_str().len())
            .sum::<usize>();
        let bytes = near_sdk::borsh::to_vec(&c).expect("borsh");
        assert_eq!(
            bytes.len(),
            without_rule_b + 16 + 16 + list_bytes,
            "Rule B adds exactly 16 bytes; LF-009 adds exactly 16 more; LF-010A adds the list"
        );
        let e_at = bytes.len() - list_bytes - 32;
        assert_eq!(
            &bytes[e_at..e_at + 16],
            &[0u8; 16],
            "E = 0 at init, little-endian u128"
        );
        assert_eq!(
            &bytes[e_at + 16..e_at + 32],
            &[0u8; 16],
            "LF-009 counters 0 at init"
        );
        assert_eq!(
            &bytes[e_at + 32..],
            &near_sdk::borsh::to_vec(&test_creators()).expect("b")[..],
            "allowlist last"
        );
        c.custody_total = 0x0102_0304_0506_0708_090a_0b0c_0d0e_0f10;
        c.last_withdrawal_id = 0x1112_1314_1516_1718;
        c.open_withdrawals = 0x2122_2324_2526_2728;
        let bytes = near_sdk::borsh::to_vec(&c).expect("borsh");
        assert_eq!(&bytes[e_at..e_at + 16], &c.custody_total.to_le_bytes());
        assert_eq!(
            &bytes[e_at + 16..e_at + 24],
            &c.last_withdrawal_id.to_le_bytes()
        );
        assert_eq!(
            &bytes[e_at + 24..e_at + 32],
            &c.open_withdrawals.to_le_bytes()
        );
    }

    #[derive(Debug, Clone, Copy)]
    enum Dep {
        Exact,
        Minus1,
        Plus1,
        Max,
    }

    fn arb_dep() -> impl proptest::strategy::Strategy<Value = (usize, u32, u8, Dep, u8)> {
        use proptest::prelude::*;
        (
            0usize..4, // agreement index (3 = missing)
            0u32..4,   // line id (3 = not in schema)
            0u8..4,    // sender: buyer, supplier, stranger, ft itself
            prop_oneof![5 => Just(Dep::Exact), 1 => Just(Dep::Minus1), 1 => Just(Dep::Plus1), 1 => Just(Dep::Max)],
            0u8..8, // msg: 0..5 good, 6 bad hash, 7 garbage
        )
    }

    /// One B4 case: after every deposit attempt E == Σ unpaid buckets ==
    /// model credited sum; rejected deposits leave every agreement and E
    /// byte-identical.
    fn b4_case(
        shape: &[usize],
        deps: &[(usize, u32, u8, Dep, u8)],
    ) -> Result<(), proptest::test_runner::TestCaseError> {
        let t = std::time::Instant::now();
        fresh_chain();
        let mut c = init(5);
        B4T.with(|x| x.borrow_mut().reset_and_init += t.elapsed());
        let t = std::time::Instant::now();
        let mut ag = Vec::new();
        for (k, &lines) in shape.iter().enumerate() {
            ag.push((agreed(&mut c, k as u64 + 1, lines), lines));
        }
        B4T.with(|x| x.borrow_mut().agreements += t.elapsed());
        let mut model: u128 = 0;
        let mut funded = std::collections::HashSet::new();
        for &(ai, line, snd, d, mk) in deps {
            let sender = [
                "buyer.test.near",
                "supplier.test.near",
                "stranger.test.near",
                FT,
            ][snd as usize];
            let amount = match d {
                Dep::Exact => P,
                Dep::Minus1 => P - 1,
                Dep::Plus1 => P + 1,
                Dep::Max => u128::MAX,
            };
            let (id, h, lines) = match ag.get(ai) {
                Some(((id, h), lines)) => (*id, h.clone(), *lines),
                None => (U64(99), "0".repeat(64), 0),
            };
            let m = match mk {
                0..=5 => msg(id, line, &h),
                6 => msg(id, line, &"0".repeat(64)),
                _ => "garbage".to_string(),
            };
            let expect_ok = ai < ag.len()
                && (line as usize) < lines
                && sender == "buyer.test.near"
                && amount == P
                && mk <= 5
                && !funded.contains(&(ai, line));
            let tc = std::time::Instant::now();
            let before: Vec<Vec<u8>> = (0..c.next_agreement_id)
                .map(|i| stored(&c, U64(i)))
                .collect();
            let e_before = c.custody_total;
            B4T.with(|x| x.borrow_mut().checks += tc.elapsed());
            let td = std::time::Instant::now();
            let unused = deposit(&mut c, FT, sender, amount, &m, NOW + 2);
            B4T.with(|x| x.borrow_mut().deposits += td.elapsed());
            let tc = std::time::Instant::now();
            if expect_ok {
                proptest::prop_assert_eq!(unused, 0);
                funded.insert((ai, line));
                model += P;
            } else {
                proptest::prop_assert_eq!(unused, amount, "full refund");
                let after: Vec<Vec<u8>> = (0..c.next_agreement_id)
                    .map(|i| stored(&c, U64(i)))
                    .collect();
                proptest::prop_assert_eq!(after, before, "rejected deposit changed an agreement");
                proptest::prop_assert_eq!(c.custody_total, e_before);
            }
            proptest::prop_assert_eq!(c.custody_total, model, "E == credited sum");
            proptest::prop_assert_eq!(c.custody_total, unpaid_buckets(&c), "E == Σ unpaid buckets");
            B4T.with(|x| x.borrow_mut().checks += tc.elapsed());
        }
        Ok(())
    }

    /// B4 profiles (env `LINEFAIR_PROPTEST_PROFILE`): `diag` = 50 cases,
    /// `quick` = 200 cases (default for routine `cargo test`), `full` =
    /// 10 000 cases (required before Rule B is accepted). Seed: fixed ChaCha
    /// sha256("linefair/rule-b/v1/b4"), overridable by `LINEFAIR_B4_SEED_HEX`.
    #[test]
    fn rule_b_outstanding_equals_unpaid_buckets_prop() {
        use proptest::test_runner::{Config, RngAlgorithm, TestError, TestRng, TestRunner};
        let (profile, cases): (&str, u32) = match std::env::var("LINEFAIR_PROPTEST_PROFILE")
            .as_deref()
        {
            Ok("full") => ("full", 10_000),
            Ok("diag") => ("diag", 50),
            Ok("quick") | Err(_) => ("quick", 200),
            Ok(other) => panic!("unknown LINEFAIR_PROPTEST_PROFILE {other:?} (diag|quick|full)"),
        };
        let seed: [u8; 32] = match std::env::var("LINEFAIR_B4_SEED_HEX") {
            Ok(h) => parse_hex32("seed", &h).expect("LINEFAIR_B4_SEED_HEX: 64 lowercase hex"),
            Err(_) => near_sdk::env::sha256_array(b"linefair/rule-b/v1/b4"),
        };
        let seed_hex = encode_hex_lower(&seed);
        B4T.with(|x| *x.borrow_mut() = B4Timing::default());
        let attempted = std::cell::Cell::new(0u64);
        let passed = std::cell::Cell::new(0u64);
        let started = std::time::Instant::now();
        eprintln!(
            "B4 START profile={profile} cases={cases} seed_hex={seed_hex} overflow_checks={}",
            overflow_checks_enabled()
        );
        let config = Config {
            cases,
            failure_persistence: None,
            ..Config::default()
        };
        let mut runner =
            TestRunner::new_with_rng(config, TestRng::from_seed(RngAlgorithm::ChaCha, &seed));
        let strategy = (
            proptest::collection::vec(1usize..=3, 1..=3),
            proptest::collection::vec(arb_dep(), 1..=20),
        );
        let result = runner.run(&strategy, |(shape, deps)| {
            let n = attempted.get() + 1;
            attempted.set(n);
            if n.is_multiple_of(500) {
                eprintln!(
                    "B4 PROGRESS profile={profile} cases_attempted={n} elapsed_ms={}",
                    started.elapsed().as_millis()
                );
            }
            b4_case(&shape, &deps)?;
            passed.set(passed.get() + 1);
            Ok(())
        });
        let total = started.elapsed();
        let t = B4T.with(|x| std::mem::take(&mut *x.borrow_mut()));
        let pct = |d: std::time::Duration| 100.0 * d.as_secs_f64() / total.as_secs_f64().max(1e-9);
        eprintln!(
            "B4 TIMING total_ms={} reset_and_init_ms={} ({:.1}%) agreements_ms={} ({:.1}%) deposits_ms={} ({:.1}%) checks_ms={} ({:.1}%) set_ctx_ms={} ({:.1}%) set_ctx_calls={} other_incl_generation_ms={}",
            total.as_millis(),
            t.reset_and_init.as_millis(),
            pct(t.reset_and_init),
            t.agreements.as_millis(),
            pct(t.agreements),
            t.deposits.as_millis(),
            pct(t.deposits),
            t.checks.as_millis(),
            pct(t.checks),
            t.set_ctx.as_millis(),
            pct(t.set_ctx),
            t.set_ctx_calls,
            total
                .saturating_sub(t.reset_and_init + t.agreements + t.deposits + t.checks)
                .as_millis(),
        );
        eprintln!(
            "B4 END profile={profile} seed_hex={seed_hex} cases_configured={cases} cases_attempted={} cases_passed={} result={}",
            attempted.get(),
            passed.get(),
            if result.is_ok() { "PASS" } else { "FAIL" }
        );
        match result {
            Ok(()) => assert_eq!(
                passed.get(),
                u64::from(cases),
                "every configured case must run and pass"
            ),
            Err(TestError::Fail(reason, value)) => {
                panic!("B4 FAILED: {reason}\nminimal input: {value:#?}")
            }
            Err(TestError::Abort(reason)) => panic!("B4 ABORTED: {reason}"),
        }
    }

    /// True iff integer overflow panics in this build (checked arithmetic on).
    fn overflow_checks_enabled() -> bool {
        let x: u8 = std::hint::black_box(u8::MAX);
        std::panic::catch_unwind(|| std::hint::black_box(x) + 1).is_err()
    }

    #[test]
    fn overflow_checks_are_enabled_in_this_build() {
        assert!(
            overflow_checks_enabled(),
            "integer overflow checks must be on (debug and release profiles)"
        );
    }

    #[test]
    fn mock_storage_isolated_between_cases_preserved_within_case() {
        fn dup_panics(c: &mut Contract) -> bool {
            set_ctx("buyer.test.near", NOW);
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                c.create_agreement(terms_json(1, 1))
            }));
            match r {
                Ok(_) => false,
                Err(e) => {
                    let m = e
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_default();
                    assert!(m.contains("ERR_DUPLICATE_TERMS"), "unexpected panic: {m}");
                    true
                }
            }
        }
        // --- one case: sequential actions share storage ---
        fresh_chain();
        let mut c = init(5);
        let (id, h) = agreed(&mut c, 1, 1); // create_agreement flushes to storage
        assert_eq!(
            deposit(&mut c, FT, "buyer.test.near", P, &msg(id, 0, &h), NOW + 2),
            0
        );
        // A second, independent Contract value (empty in-memory cache) over the
        // same chain reads what earlier calls of this case wrote.
        let mut c2 = init(5);
        assert!(
            c2.agreements.get(&0).is_some(),
            "storage persists across calls within a case"
        );
        assert!(
            dup_panics(&mut c2),
            "the same case still sees its terms registry"
        );
        // `store` collections flush on drop: drop every Contract of this case
        // BEFORE wiping, so no cached entry can leak into the next case.
        drop(c);
        drop(c2);
        // --- next independent case: empty chain ---
        fresh_chain();
        let mut c3 = init(5);
        assert!(
            c3.agreements.get(&0).is_none(),
            "storage wiped between cases"
        );
        assert!(
            !dup_panics(&mut c3),
            "identical terms register again on a fresh chain"
        );
        assert_eq!(c3.next_agreement_id, 1);
        drop(c3);
        // Negative control: WITHOUT fresh_chain the previous case leaks in.
        let mut c4 = init(5);
        assert!(
            c4.agreements.get(&0).is_some(),
            "no reset => previous case visible"
        );
        assert!(
            dup_panics(&mut c4),
            "no reset => previous case's terms collide"
        );
    }

    // ---- LF-006: submit_delivery / accept_line / open_dispute (mocked chain) --
    // terms_json(): delivery NOW + 96 h, grace 0, review 72 h, funding NOW + 48 h.

    const EV: &str = "a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5";
    const REVIEW: u64 = 72 * HOUR;

    /// Agreed + every line funded with the exact principal through ft_on_transfer.
    fn funded(c: &mut Contract, nonce: u64, lines: usize) -> (U64, String) {
        let (id, h) = agreed(c, nonce, lines);
        for line in 0..lines as u32 {
            assert_eq!(
                deposit(c, FT, "buyer.test.near", P, &msg(id, line, &h), NOW + 2),
                0
            );
        }
        (id, h)
    }

    /// Every distinct `ERR_<AREA>[:<Code>]` token in `msg` (exact-code
    /// assertions; no substring matching). Mirrors `tests/common::err_codes`.
    fn err_codes(msg: &str) -> Vec<String> {
        let b = msg.as_bytes();
        let mut out: Vec<String> = Vec::new();
        let mut i = 0;
        while i + 4 <= b.len() {
            if &b[i..i + 4] == b"ERR_"
                && (i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_'))
            {
                let mut j = i + 4;
                while j < b.len()
                    && (b[j].is_ascii_uppercase() || b[j].is_ascii_digit() || b[j] == b'_')
                {
                    j += 1;
                }
                if j < b.len() && b[j] == b':' {
                    let k0 = j + 1;
                    let mut k = k0;
                    while k < b.len() && b[k].is_ascii_alphanumeric() {
                        k += 1;
                    }
                    if k > k0 {
                        j = k;
                    }
                }
                let t = msg[i..j].to_string();
                if !out.contains(&t) {
                    out.push(t);
                }
                i = j;
            } else {
                i += 1;
            }
        }
        out
    }

    #[test]
    fn err_codes_exact_tokens() {
        assert_eq!(
            err_codes("x GuestPanic { panic_msg: \"ERR_LINE:NotAuthorized\" }"),
            vec!["ERR_LINE:NotAuthorized"]
        );
        assert_ne!(
            err_codes("ERR_LINE:NotAuthorizedForMethod"),
            vec!["ERR_LINE:NotAuthorized"]
        );
        assert_eq!(
            err_codes("ERR_AGREEMENT_NOT_FOUND"),
            vec!["ERR_AGREEMENT_NOT_FOUND"]
        );
        assert_eq!(
            err_codes("a ERR_A:X b ERR_A:X c ERR_B"),
            vec!["ERR_A:X", "ERR_B"]
        );
        assert!(err_codes("XERR_A:B no").is_empty());
    }

    fn panic_message_ref(e: &Box<dyn std::any::Any + Send>) -> String {
        e.downcast_ref::<String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default()
    }

    fn panic_message(e: Box<dyn std::any::Any + Send>) -> String {
        e.downcast_ref::<String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default()
    }

    /// The call must panic with `code`; agreement bytes and E unchanged.
    fn expect_rejected(
        c: &mut Contract,
        id: U64,
        who: &str,
        now: u64,
        code: &str,
        f: impl FnOnce(&mut Contract),
    ) {
        let before = c
            .agreements
            .get(&id.0)
            .map(|a| near_sdk::borsh::to_vec(a).expect("borsh"));
        let e_before = c.custody_total;
        set_ctx(who, now);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(c)));
        let m = panic_message(r.expect_err("call must be rejected"));
        assert_eq!(
            err_codes(&m),
            vec![code.to_string()],
            "expected exactly {code}, got {m}"
        );
        let after = c
            .agreements
            .get(&id.0)
            .map(|a| near_sdk::borsh::to_vec(a).expect("borsh"));
        assert_eq!(
            after, before,
            "rejected call ({code}) changed the agreement"
        );
        assert_eq!(
            c.custody_total, e_before,
            "rejected call ({code}) changed E"
        );
    }

    fn submit(c: &mut Contract, id: U64, line: u32, who: &str, now: u64) {
        set_ctx(who, now);
        c.submit_delivery(id, line, EV.to_string());
    }

    fn line_view(c: &Contract, id: U64, line: usize) -> LineView {
        c.get_agreement(id).expect("exists").lines[line].clone()
    }

    #[test]
    fn lf006_submit_by_supplier_records_commitment() {
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 3);
        submit(&mut c, id, 1, "supplier.test.near", NOW + 10);
        let l = line_view(&c, id, 1);
        assert_eq!(l.status, "SUBMITTED");
        assert_eq!(l.evidence_commitment, EV);
        assert_eq!(l.submitted_at_ns, U64(NOW + 10));
        assert_eq!(l.locked, U128(P), "submission moves no funds");
        assert_eq!(c.custody_total, 3 * P, "E unchanged by submission");
    }

    #[test]
    fn lf006_submit_rejects_non_supplier_callers() {
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 1);
        for who in [
            "buyer.test.near",
            "primary.test.near",
            "backup.test.near",
            "stranger.test.near",
            "escrow.test.near",
        ] {
            expect_rejected(&mut c, id, who, NOW + 10, "ERR_LINE:NotAuthorized", |c| {
                c.submit_delivery(id, 0, EV.to_string())
            });
        }
    }

    #[test]
    fn lf006_submit_prerequisites_and_inputs() {
        let mut c = init(5);
        let (id, _) = agreed(&mut c, 1, 2); // not funded
        expect_rejected(
            &mut c,
            id,
            "supplier.test.near",
            NOW + 10,
            "ERR_LINE:WrongState",
            |c| c.submit_delivery(id, 0, EV.to_string()),
        );
        let (id2, _) = funded(&mut c, 2, 1);
        submit(&mut c, id2, 0, "supplier.test.near", NOW + 10);
        expect_rejected(
            &mut c,
            id2,
            "supplier.test.near",
            NOW + 11,
            "ERR_LINE:WrongState",
            |c| c.submit_delivery(id2, 0, EV.to_string()),
        );
        expect_rejected(
            &mut c,
            id2,
            "supplier.test.near",
            NOW + 11,
            "ERR_AGREEMENT_NOT_FOUND",
            |c| c.submit_delivery(U64(77), 0, EV.to_string()),
        );
        expect_rejected(
            &mut c,
            id2,
            "supplier.test.near",
            NOW + 11,
            "ERR_LINE:LineNotFound",
            |c| c.submit_delivery(id2, 1, EV.to_string()),
        );
        let (id3, _) = funded(&mut c, 3, 1);
        for bad in [
            EV.to_uppercase(),
            EV[..62].to_string(),
            format!("{EV}0"),
            format!("0x{}", &EV[..62]),
            String::new(),
        ] {
            expect_rejected(
                &mut c,
                id3,
                "supplier.test.near",
                NOW + 10,
                "ERR_EVIDENCE_COMMITMENT_FORMAT",
                |c| c.submit_delivery(id3, 0, bad),
            );
        }
        expect_rejected(
            &mut c,
            id3,
            "supplier.test.near",
            NOW + 10,
            "ERR_LINE:ZeroCommitment",
            |c| c.submit_delivery(id3, 0, "0".repeat(64)),
        );
    }

    #[test]
    fn lf006_submit_deadline_and_grace_boundaries() {
        for grace in [0u64, HOUR] {
            fresh_chain();
            let mut c = init(5);
            set_ctx("buyer.test.near", NOW);
            let mut t = terms_json(1, 1);
            t.delivery_grace_period_ns = grace.to_string();
            let id = c.create_agreement(t);
            let h = c.get_agreement(id).expect("exists").terms_hash;
            for (who, appt) in [
                ("buyer.test.near", false),
                ("supplier.test.near", false),
                ("primary.test.near", true),
                ("backup.test.near", true),
            ] {
                set_ctx(who, NOW + 1);
                if appt {
                    c.accept_appointment(id, h.clone())
                } else {
                    c.accept_terms(id, h.clone())
                }
            }
            assert_eq!(
                deposit(&mut c, FT, "buyer.test.near", P, &msg(id, 0, &h), NOW + 2),
                0
            );
            let cutoff = NOW + 96 * HOUR + grace;
            for now in [cutoff, cutoff + 1] {
                expect_rejected(
                    &mut c,
                    id,
                    "supplier.test.near",
                    now,
                    "ERR_LINE:SubmissionDeadlinePassed",
                    |c| c.submit_delivery(id, 0, EV.to_string()),
                );
                set_ctx("stranger.test.near", now);
                assert_eq!(
                    line_view(&c, id, 0).non_delivery_t0_ns,
                    Some(U64(cutoff)),
                    "NON_DELIVERY eligible at cutoff"
                );
            }
            set_ctx("stranger.test.near", cutoff - 1);
            assert_eq!(line_view(&c, id, 0).non_delivery_t0_ns, None);
            submit(&mut c, id, 0, "supplier.test.near", cutoff - 1);
            assert_eq!(
                line_view(&c, id, 0).status,
                "SUBMITTED",
                "grace {grace}: cutoff − 1 ns accepted"
            );
        }
    }

    #[test]
    fn lf006_accept_moves_locked_to_supplier_claimable() {
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 1);
        submit(&mut c, id, 0, "supplier.test.near", NOW + 10);
        set_ctx("buyer.test.near", NOW + 11);
        c.accept_line(id, 0);
        let l = line_view(&c, id, 0);
        assert_eq!(l.status, "ALLOCATED");
        assert_eq!(
            (l.locked, l.supplier_claimable, l.buyer_claimable),
            (U128(0), U128(P), U128(0))
        );
        assert_eq!(
            (l.buyer_paid, l.supplier_paid),
            (U128(0), U128(0)),
            "no payout on acceptance"
        );
        assert_eq!(
            c.custody_total, P,
            "E unchanged: claimable is still outstanding"
        );
    }

    #[test]
    fn lf006_accept_and_dispute_reject_wrong_roles_and_states() {
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 3);
        // Funded but not submitted.
        for (m, f) in [("accept", true), ("dispute", false)] {
            expect_rejected(
                &mut c,
                id,
                "buyer.test.near",
                NOW + 10,
                "ERR_LINE:WrongState",
                |c| {
                    if f {
                        c.accept_line(id, 0)
                    } else {
                        c.open_dispute(id, 0)
                    }
                },
            );
            let _ = m;
        }
        submit(&mut c, id, 0, "supplier.test.near", NOW + 10);
        for who in [
            "supplier.test.near",
            "primary.test.near",
            "backup.test.near",
            "stranger.test.near",
        ] {
            expect_rejected(&mut c, id, who, NOW + 11, "ERR_LINE:NotAuthorized", |c| {
                c.accept_line(id, 0)
            });
            expect_rejected(&mut c, id, who, NOW + 11, "ERR_LINE:NotAuthorized", |c| {
                c.open_dispute(id, 0)
            });
        }
        expect_rejected(
            &mut c,
            id,
            "buyer.test.near",
            NOW + 11,
            "ERR_AGREEMENT_NOT_FOUND",
            |c| c.accept_line(U64(9), 0),
        );
        expect_rejected(
            &mut c,
            id,
            "buyer.test.near",
            NOW + 11,
            "ERR_LINE:LineNotFound",
            |c| c.open_dispute(id, 3),
        );
    }

    #[test]
    fn lf006_review_window_boundaries() {
        let s_at = NOW + 10;
        let end = s_at + REVIEW;
        for (accept, now) in [
            (true, s_at),
            (true, end - 1),
            (false, s_at),
            (false, end - 1),
        ] {
            fresh_chain(); // independent case; previous iteration's Contract already dropped
            let mut c = init(5);
            let (id, _) = funded(&mut c, 1, 1);
            submit(&mut c, id, 0, "supplier.test.near", s_at);
            set_ctx("buyer.test.near", now);
            if accept {
                c.accept_line(id, 0)
            } else {
                c.open_dispute(id, 0)
            }
            assert_eq!(
                line_view(&c, id, 0).status,
                if accept { "ALLOCATED" } else { "DISPUTED" }
            );
        }
        for now in [end, end + 1] {
            fresh_chain();
            let mut c = init(5);
            let (id, _) = funded(&mut c, 1, 1);
            submit(&mut c, id, 0, "supplier.test.near", s_at);
            expect_rejected(
                &mut c,
                id,
                "buyer.test.near",
                now,
                "ERR_LINE:ReviewWindowClosed",
                |c| c.accept_line(id, 0),
            );
            expect_rejected(
                &mut c,
                id,
                "buyer.test.near",
                now,
                "ERR_LINE:ReviewWindowClosed",
                |c| c.open_dispute(id, 0),
            );
        }
    }

    #[test]
    fn lf006_open_dispute_keeps_funds_locked() {
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 1);
        submit(&mut c, id, 0, "supplier.test.near", NOW + 10);
        let before = line_view(&c, id, 0);
        set_ctx("buyer.test.near", NOW + 20);
        c.open_dispute(id, 0);
        let l = line_view(&c, id, 0);
        assert_eq!(
            (
                l.status.as_str(),
                l.dispute_reason.as_str(),
                l.dispute_t0_ns
            ),
            ("DISPUTED", "BUYER_DISPUTE", U64(NOW + 20))
        );
        for (a, b) in [
            (l.locked, before.locked),
            (l.buyer_claimable, before.buyer_claimable),
            (l.supplier_claimable, before.supplier_claimable),
            (l.buyer_pending, before.buyer_pending),
            (l.supplier_pending, before.supplier_pending),
            (l.buyer_paid, before.buyer_paid),
            (l.supplier_paid, before.supplier_paid),
        ] {
            assert_eq!(a, b, "opening a dispute moves no funds");
        }
        assert_eq!(l.locked, U128(P));
        assert_eq!(c.custody_total, P);
    }

    #[test]
    fn lf006_replay_and_conflicting_transitions_rejected() {
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 2);
        submit(&mut c, id, 0, "supplier.test.near", NOW + 10);
        submit(&mut c, id, 1, "supplier.test.near", NOW + 10);
        set_ctx("buyer.test.near", NOW + 11);
        c.accept_line(id, 0);
        c.open_dispute(id, 1);
        // Replays.
        expect_rejected(
            &mut c,
            id,
            "supplier.test.near",
            NOW + 12,
            "ERR_LINE:WrongState",
            |c| c.submit_delivery(id, 0, EV.to_string()),
        );
        expect_rejected(
            &mut c,
            id,
            "buyer.test.near",
            NOW + 12,
            "ERR_LINE:WrongState",
            |c| c.accept_line(id, 0),
        );
        expect_rejected(
            &mut c,
            id,
            "buyer.test.near",
            NOW + 12,
            "ERR_LINE:WrongState",
            |c| c.open_dispute(id, 1),
        );
        // Conflicts.
        expect_rejected(
            &mut c,
            id,
            "buyer.test.near",
            NOW + 12,
            "ERR_LINE:WrongState",
            |c| c.open_dispute(id, 0),
        );
        expect_rejected(
            &mut c,
            id,
            "buyer.test.near",
            NOW + 12,
            "ERR_LINE:WrongState",
            |c| c.accept_line(id, 1),
        );
        expect_rejected(
            &mut c,
            id,
            "supplier.test.near",
            NOW + 12,
            "ERR_LINE:WrongState",
            |c| c.submit_delivery(id, 1, EV.to_string()),
        );
    }

    #[test]
    fn lf006_three_line_isolation() {
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 3);
        let snap = |c: &Contract| -> Vec<Vec<u8>> {
            c.agreements
                .get(&id.0)
                .expect("a")
                .lines
                .iter()
                .map(|l| near_sdk::borsh::to_vec(l).expect("b"))
                .collect()
        };
        type Step<'a> = (usize, Box<dyn Fn(&mut Contract) + 'a>);
        let steps: Vec<Step> = vec![
            (
                0,
                Box::new(|c: &mut Contract| submit(c, id, 0, "supplier.test.near", NOW + 10)),
            ),
            (
                1,
                Box::new(|c: &mut Contract| submit(c, id, 1, "supplier.test.near", NOW + 10)),
            ),
            (
                2,
                Box::new(|c: &mut Contract| submit(c, id, 2, "supplier.test.near", NOW + 10)),
            ),
            (
                0,
                Box::new(|c: &mut Contract| {
                    set_ctx("buyer.test.near", NOW + 11);
                    c.accept_line(id, 0)
                }),
            ),
            (
                1,
                Box::new(|c: &mut Contract| {
                    set_ctx("buyer.test.near", NOW + 11);
                    c.open_dispute(id, 1)
                }),
            ),
        ];
        for (target, f) in steps {
            let before = snap(&c);
            f(&mut c);
            let after = snap(&c);
            for j in 0..3 {
                if j != target {
                    assert_eq!(
                        after[j], before[j],
                        "call on line {target} changed line {j}"
                    );
                }
            }
            assert_ne!(
                after[target], before[target],
                "target line {target} changed"
            );
        }
        assert_eq!(c.custody_total, 3 * P);
    }

    #[test]
    fn lf006_rejected_calls_leave_state_and_e_unchanged() {
        // expect_rejected asserts byte-identical state and E for every
        // rejection in the LF-006 tests above; here one of each kind in sequence.
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 1);
        expect_rejected(
            &mut c,
            id,
            "buyer.test.near",
            NOW + 10,
            "ERR_LINE:NotAuthorized",
            |c| c.submit_delivery(id, 0, EV.to_string()),
        );
        expect_rejected(
            &mut c,
            id,
            "buyer.test.near",
            NOW + 10,
            "ERR_LINE:WrongState",
            |c| c.accept_line(id, 0),
        );
        expect_rejected(
            &mut c,
            id,
            "supplier.test.near",
            NOW + 10,
            "ERR_EVIDENCE_COMMITMENT_FORMAT",
            |c| c.submit_delivery(id, 0, "zz".into()),
        );
        expect_rejected(
            &mut c,
            id,
            "supplier.test.near",
            NOW + 96 * HOUR,
            "ERR_LINE:SubmissionDeadlinePassed",
            |c| c.submit_delivery(id, 0, EV.to_string()),
        );
        assert_eq!(line_view(&c, id, 0).status, "FUNDED");
        assert_eq!(c.custody_total, P);
    }

    #[test]
    fn lf006_no_automatic_acceptance_after_review_expiry() {
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 1);
        let s_at = NOW + 10;
        submit(&mut c, id, 0, "supplier.test.near", s_at);
        for late in [s_at + REVIEW, s_at + REVIEW + 10 * 24 * HOUR] {
            set_ctx("stranger.test.near", late);
            let l = line_view(&c, id, 0);
            assert_eq!(
                l.status, "SUBMITTED",
                "buyer silence never accepts the work"
            );
            assert_eq!(
                (l.supplier_claimable, l.locked),
                (U128(0), U128(P)),
                "funds stay locked"
            );
            assert_eq!(
                l.no_response_t0_ns,
                Some(U64(s_at + REVIEW)),
                "NO_RESPONSE eligible, T0 fixed"
            );
            expect_rejected(
                &mut c,
                id,
                "buyer.test.near",
                late,
                "ERR_LINE:ReviewWindowClosed",
                |c| c.accept_line(id, 0),
            );
        }
        set_ctx("stranger.test.near", s_at + REVIEW - 1);
        assert_eq!(line_view(&c, id, 0).no_response_t0_ns, None);
    }

    #[test]
    fn lf006_e_unchanged_by_line_entrypoints() {
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 3);
        let e = c.custody_total;
        submit(&mut c, id, 0, "supplier.test.near", NOW + 10);
        submit(&mut c, id, 1, "supplier.test.near", NOW + 10);
        set_ctx("buyer.test.near", NOW + 11);
        c.accept_line(id, 0);
        c.open_dispute(id, 1);
        assert_eq!(c.custody_total, e);
        assert_eq!(
            c.custody_total,
            unpaid_buckets(&c),
            "E == Σ unpaid buckets after LF-006 transitions"
        );
    }

    // ---- LF-006b advance_case (contract, mocked chain) -----------------------
    // terms_json(): delivery NOW + 96 h, grace 0, review 72 h.

    #[test]
    fn lf006b_any_caller_may_advance() {
        for who in [
            "buyer.test.near",
            "supplier.test.near",
            "primary.test.near",
            "backup.test.near",
            "stranger.test.near",
            "escrow.test.near",
        ] {
            fresh_chain();
            let mut c = init(5);
            let (id, _) = funded(&mut c, 1, 2);
            submit(&mut c, id, 0, "supplier.test.near", NOW + 10);
            let t0_nr = NOW + 10 + REVIEW;
            let t0_nd = NOW + 96 * HOUR;
            set_ctx(who, t0_nd); // both lines eligible (t0_nr < t0_nd)
            c.advance_case(id, 0);
            c.advance_case(id, 1);
            let v = c.get_agreement(id).expect("exists");
            assert_eq!(
                (v.lines[0].dispute_reason.as_str(), v.lines[0].dispute_t0_ns),
                ("NO_RESPONSE", U64(t0_nr)),
                "{who}"
            );
            assert_eq!(
                (v.lines[1].dispute_reason.as_str(), v.lines[1].dispute_t0_ns),
                ("NON_DELIVERY", U64(t0_nd)),
                "{who}"
            );
            assert_eq!(c.custody_total, 2 * P, "E unchanged");
            drop(c);
        }
    }

    #[test]
    fn lf006b_rejections_leave_state_and_e_unchanged() {
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 3);
        submit(&mut c, id, 0, "supplier.test.near", NOW + 10);
        let t0 = NOW + 10 + REVIEW;
        expect_rejected(
            &mut c,
            id,
            "stranger.test.near",
            t0 - 1,
            "ERR_LINE:NotEligible",
            |c| c.advance_case(id, 0),
        );
        expect_rejected(
            &mut c,
            id,
            "stranger.test.near",
            NOW + 96 * HOUR - 1,
            "ERR_LINE:NotEligible",
            |c| c.advance_case(id, 1),
        );
        expect_rejected(
            &mut c,
            id,
            "stranger.test.near",
            t0,
            "ERR_AGREEMENT_NOT_FOUND",
            |c| c.advance_case(U64(9), 0),
        );
        expect_rejected(
            &mut c,
            id,
            "stranger.test.near",
            t0,
            "ERR_LINE:LineNotFound",
            |c| c.advance_case(id, 3),
        );
        set_ctx("buyer.test.near", NOW + 11);
        c.accept_line(id, 0);
        expect_rejected(
            &mut c,
            id,
            "stranger.test.near",
            u64::MAX,
            "ERR_LINE:NotAdvanceable",
            |c| c.advance_case(id, 0),
        );
        set_ctx("stranger.test.near", NOW + 96 * HOUR);
        c.advance_case(id, 1);
        expect_rejected(
            &mut c,
            id,
            "supplier.test.near",
            NOW + 96 * HOUR + 1,
            "ERR_LINE:NotAdvanceable",
            |c| c.advance_case(id, 1),
        );
        // Unfunded line in another agreement.
        let (id2, _) = agreed(&mut c, 2, 1);
        expect_rejected(
            &mut c,
            id2,
            "stranger.test.near",
            u64::MAX,
            "ERR_LINE:NotAdvanceable",
            |c| c.advance_case(id2, 0),
        );
        assert_eq!(c.custody_total, 3 * P);
        assert_eq!(c.custody_total, unpaid_buckets(&c));
    }

    #[test]
    fn lf006b_three_line_isolation() {
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 3);
        submit(&mut c, id, 1, "supplier.test.near", NOW + 10);
        let snap = |c: &Contract| -> Vec<Vec<u8>> {
            c.agreements
                .get(&id.0)
                .expect("a")
                .lines
                .iter()
                .map(|l| near_sdk::borsh::to_vec(l).expect("b"))
                .collect()
        };
        let before = snap(&c);
        set_ctx("stranger.test.near", NOW + 10 + REVIEW);
        c.advance_case(id, 1);
        let after = snap(&c);
        assert_eq!(
            (after[0].clone(), after[2].clone()),
            (before[0].clone(), before[2].clone()),
            "other lines byte-identical"
        );
        assert_ne!(after[1], before[1]);
    }

    #[test]
    fn lf006b_view_reports_reason_and_t0() {
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 1);
        submit(&mut c, id, 0, "supplier.test.near", NOW + 10);
        let t0 = NOW + 10 + REVIEW;
        set_ctx("stranger.test.near", t0 + 3 * HOUR);
        assert_eq!(line_view(&c, id, 0).no_response_t0_ns, Some(U64(t0)));
        c.advance_case(id, 0);
        let l = line_view(&c, id, 0);
        assert_eq!(
            (
                l.status.as_str(),
                l.dispute_reason.as_str(),
                l.dispute_t0_ns
            ),
            ("DISPUTED", "NO_RESPONSE", U64(t0))
        );
        assert_eq!(
            l.no_response_t0_ns, None,
            "no longer eligible once disputed"
        );
        assert_eq!(
            (l.locked, l.supplier_claimable),
            (U128(P), U128(0)),
            "no settlement"
        );
    }

    // ---- LF-007 mutual settlement (contract level) -----------------------------

    const B_: &str = "buyer.test.near";
    const S_: &str = "supplier.test.near";

    /// Every requested line funded, line `line` submitted then disputed by the
    /// buyer at T0 = NOW + 11.
    fn disputed_line(c: &mut Contract, nonce: u64, lines: usize, line: u32) -> U64 {
        let (id, _) = funded(c, nonce, lines);
        submit(c, id, line, S_, NOW + 10);
        set_ctx(B_, NOW + 11);
        c.open_dispute(id, line);
        id
    }

    fn propose(c: &mut Contract, id: U64, line: u32, who: &str, b: u128, s: u128) -> U64 {
        set_ctx(who, NOW + 12);
        c.propose_split(id, line, b.to_string(), s.to_string())
    }

    #[test]
    fn lf007_roles() {
        for (proposer, acceptor) in [(B_, S_), (S_, B_)] {
            fresh_chain();
            let mut c = init(5);
            let id = disputed_line(&mut c, 1, 1, 0);
            for who in [
                "primary.test.near",
                "backup.test.near",
                "stranger.test.near",
                "escrow.test.near",
            ] {
                expect_rejected(&mut c, id, who, NOW + 12, "ERR_LINE:NotAuthorized", |c| {
                    c.propose_split(id, 0, "1".into(), (P - 1).to_string());
                });
            }
            let pid = propose(&mut c, id, 0, proposer, 400_000, 600_000);
            assert_eq!(pid, U64(1));
            for who in [
                "primary.test.near",
                "backup.test.near",
                "stranger.test.near",
            ] {
                expect_rejected(&mut c, id, who, NOW + 13, "ERR_LINE:NotAuthorized", |c| {
                    c.accept_split(id, 0, "1".into(), "400000".into(), "600000".into());
                });
            }
            expect_rejected(
                &mut c,
                id,
                proposer,
                NOW + 13,
                "ERR_LINE:OwnProposal",
                |c| {
                    c.accept_split(id, 0, "1".into(), "400000".into(), "600000".into());
                },
            );
            set_ctx(acceptor, NOW + 13);
            c.accept_split(id, 0, "1".into(), "400000".into(), "600000".into());
            let l = line_view(&c, id, 0);
            assert_eq!(
                (
                    l.status.as_str(),
                    l.buyer_claimable,
                    l.supplier_claimable,
                    l.locked
                ),
                ("ALLOCATED", U128(400_000), U128(600_000), U128(0))
            );
            assert_eq!(c.custody_total, P, "E unchanged by allocation");
            drop(c);
        }
    }

    #[test]
    fn lf007_amount_parsing() {
        let mut c = init(5);
        let id = disputed_line(&mut c, 1, 1, 0);
        for (b, s, code) in [
            ("+400000", "600000", "ERR_AMOUNT_FORMAT:NonCanonicalDecimal"),
            ("0400000", "600000", "ERR_AMOUNT_FORMAT:NonCanonicalDecimal"),
            ("400000", "", "ERR_AMOUNT_FORMAT:NonCanonicalDecimal"),
            ("-1", "1000001", "ERR_AMOUNT_FORMAT:NonCanonicalDecimal"),
            ("4e5", "600000", "ERR_AMOUNT_FORMAT:NonCanonicalDecimal"),
            (" 400000", "600000", "ERR_AMOUNT_FORMAT:NonCanonicalDecimal"),
            (
                "400000",
                "340282366920938463463374607431768211456",
                "ERR_AMOUNT_FORMAT:DecimalOverflow",
            ),
        ] {
            expect_rejected(&mut c, id, B_, NOW + 12, code, |c| {
                c.propose_split(id, 0, b.into(), s.into());
            });
        }
        let pid = propose(&mut c, id, 0, B_, 400_000, 600_000);
        for (i, b, s, code) in [
            (
                "+1",
                "400000",
                "600000",
                "ERR_AMOUNT_FORMAT:NonCanonicalDecimal",
            ),
            (
                "01",
                "400000",
                "600000",
                "ERR_AMOUNT_FORMAT:NonCanonicalDecimal",
            ),
            (
                "1",
                "+400000",
                "600000",
                "ERR_AMOUNT_FORMAT:NonCanonicalDecimal",
            ),
            (
                "18446744073709551616",
                "400000",
                "600000",
                "ERR_AMOUNT_FORMAT:DecimalOverflow",
            ),
        ] {
            expect_rejected(&mut c, id, S_, NOW + 13, code, |c| {
                c.accept_split(id, 0, i.into(), b.into(), s.into());
            });
        }
        assert_eq!(pid, U64(1));
        // Zero is canonical.
        let pid = propose(&mut c, id, 0, B_, 0, P);
        set_ctx(S_, NOW + 13);
        c.accept_split(id, 0, pid.0.to_string(), "0".into(), P.to_string());
        assert_eq!(line_view(&c, id, 0).supplier_claimable, U128(P));
    }

    #[test]
    fn lf007_rejections_leave_state_and_e_unchanged() {
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 3);
        submit(&mut c, id, 0, S_, NOW + 10);
        // Line 0 SUBMITTED, line 1 FUNDED: not settleable.
        for (line, code) in [
            (0u32, "ERR_LINE:WrongState"),
            (1, "ERR_LINE:WrongState"),
            (3, "ERR_LINE:LineNotFound"),
        ] {
            expect_rejected(&mut c, id, B_, NOW + 12, code, |c| {
                c.propose_split(id, line, "1".into(), (P - 1).to_string());
            });
        }
        set_ctx(B_, NOW + 11);
        c.open_dispute(id, 0);
        for (b, s) in [(P, 1u128), (0, P - 1), (P - 1, 0)] {
            expect_rejected(
                &mut c,
                id,
                B_,
                NOW + 12,
                "ERR_LINE:AllocationSumMismatch",
                |c| {
                    c.propose_split(id, 0, b.to_string(), s.to_string());
                },
            );
        }
        expect_rejected(&mut c, id, S_, NOW + 12, "ERR_LINE:NoActiveProposal", |c| {
            c.accept_split(id, 0, "1".into(), "1".into(), (P - 1).to_string());
        });
        let p1 = propose(&mut c, id, 0, B_, 1, P - 1);
        let p2 = propose(&mut c, id, 0, S_, 2, P - 2);
        assert_eq!((p1, p2), (U64(1), U64(2)));
        expect_rejected(&mut c, id, S_, NOW + 13, "ERR_LINE:StaleProposal", |c| {
            c.accept_split(id, 0, "1".into(), "1".into(), (P - 1).to_string());
        });
        expect_rejected(&mut c, id, B_, NOW + 13, "ERR_LINE:ProposalMismatch", |c| {
            c.accept_split(id, 0, "2".into(), "1".into(), (P - 1).to_string());
        });
        expect_rejected(&mut c, id, B_, NOW + 13, "ERR_AGREEMENT_NOT_FOUND", |c| {
            c.accept_split(U64(99), 0, "2".into(), "2".into(), (P - 2).to_string());
        });
        set_ctx(B_, NOW + 13);
        c.accept_split(id, 0, "2".into(), "2".into(), (P - 2).to_string());
        for (who, code) in [
            (S_, "ERR_LINE:AlreadyFinalized"),
            (B_, "ERR_LINE:AlreadyFinalized"),
        ] {
            expect_rejected(&mut c, id, who, NOW + 14, code, |c| {
                c.accept_split(id, 0, "2".into(), "2".into(), (P - 2).to_string());
            });
            expect_rejected(&mut c, id, who, NOW + 14, code, |c| {
                c.propose_split(id, 0, "3".into(), (P - 3).to_string());
            });
        }
        assert_eq!(c.custody_total, 3 * P);
    }

    #[test]
    fn lf007_three_line_isolation() {
        let mut c = init(5);
        let id = disputed_line(&mut c, 1, 3, 1);
        let snap = |c: &Contract| -> Vec<Vec<u8>> {
            c.agreements
                .get(&id.0)
                .expect("a")
                .lines
                .iter()
                .map(|l| near_sdk::borsh::to_vec(l).expect("b"))
                .collect()
        };
        let before = snap(&c);
        let pid = propose(&mut c, id, 1, S_, 250_000, 750_000);
        set_ctx(B_, NOW + 13);
        c.accept_split(id, 1, pid.0.to_string(), "250000".into(), "750000".into());
        let after = snap(&c);
        assert_eq!(
            (after[0].clone(), after[2].clone()),
            (before[0].clone(), before[2].clone()),
            "other lines byte-identical"
        );
        assert_ne!(after[1], before[1]);
        // Proposal ids are per line: line 0 cannot be settled with line 1's id.
        expect_rejected(&mut c, id, B_, NOW + 14, "ERR_LINE:WrongState", |c| {
            c.accept_split(id, 0, "1".into(), "250000".into(), "750000".into());
        });
        assert_eq!(c.custody_total, 3 * P);
    }

    #[test]
    fn lf007_view_reports_proposal_and_allocation() {
        let mut c = init(5);
        let id = disputed_line(&mut c, 1, 1, 0);
        let l = line_view(&c, id, 0);
        assert_eq!(
            (
                l.proposal_status.as_str(),
                l.proposal_id,
                l.allocation_mode.as_str()
            ),
            ("NONE", U64(0), "NONE")
        );
        let pid = propose(&mut c, id, 0, S_, 300_000, 700_000);
        let l = line_view(&c, id, 0);
        assert_eq!(
            (
                l.proposal_status.as_str(),
                l.proposal_id,
                l.proposal_proposer.as_str(),
                l.proposal_buyer_amount,
                l.proposal_supplier_amount,
                l.proposal_created_at_ns,
            ),
            (
                "OPEN",
                pid,
                "SUPPLIER",
                U128(300_000),
                U128(700_000),
                U64(NOW + 12)
            )
        );
        set_ctx(B_, NOW + 20);
        c.accept_split(id, 0, "1".into(), "300000".into(), "700000".into());
        let l = line_view(&c, id, 0);
        assert_eq!(
            (
                l.proposal_status.as_str(),
                l.allocation_mode.as_str(),
                l.allocation_buyer_amount,
                l.allocation_supplier_amount,
                l.allocation_source_id,
                l.allocation_finalized_at_ns,
            ),
            (
                "ACCEPTED",
                "MUTUAL",
                U128(300_000),
                U128(700_000),
                U64(1),
                U64(NOW + 20)
            )
        );
    }

    // ---- LF-008 timed arbitration and fallback (contract level) -----------------

    const PRIM: &str = "primary.test.near";
    const BACK: &str = "backup.test.near";
    const T0_: u64 = NOW + 11; // disputed_line(): buyer dispute at NOW + 11
    const PS_: u64 = T0_ + 48 * HOUR;
    const BS_: u64 = PS_ + 72 * HOUR;
    const FS_: u64 = BS_ + 72 * HOUR;

    fn rule(c: &mut Contract, id: U64, line: u32, who: &str, now: u64, b: u128, s: u128) {
        set_ctx(who, now);
        c.submit_ruling(id, line, b.to_string(), s.to_string());
    }

    #[test]
    fn lf008_roles() {
        let mut c = init(5);
        let id = disputed_line(&mut c, 1, 1, 0);
        for who in [B_, S_, "stranger.test.near", "escrow.test.near"] {
            expect_rejected(&mut c, id, who, PS_, "ERR_LINE:NotAuthorized", |c| {
                c.submit_ruling(id, 0, "1".into(), (P - 1).to_string());
            });
        }
        expect_rejected(&mut c, id, BACK, PS_, "ERR_LINE:NotRulingWindow", |c| {
            c.submit_ruling(id, 0, "1".into(), (P - 1).to_string());
        });
        expect_rejected(&mut c, id, PRIM, PS_ - 1, "ERR_LINE:NotRulingWindow", |c| {
            c.submit_ruling(id, 0, "1".into(), (P - 1).to_string());
        });
        expect_rejected(&mut c, id, PRIM, BS_, "ERR_LINE:NotRulingWindow", |c| {
            c.submit_ruling(id, 0, "1".into(), (P - 1).to_string());
        });
        rule(&mut c, id, 0, PRIM, PS_, 1, P - 1);
        let l = line_view(&c, id, 0);
        assert_eq!(
            (
                l.status.as_str(),
                l.allocation_mode.as_str(),
                l.buyer_claimable,
                l.supplier_claimable
            ),
            ("ALLOCATED", "PRIMARY_RULING", U128(1), U128(P - 1))
        );
        assert_eq!(c.custody_total, P, "E unchanged");
        // Backup in its own window on a fresh line.
        fresh_chain();
        let mut c = init(5);
        let id = disputed_line(&mut c, 1, 1, 0);
        rule(&mut c, id, 0, BACK, FS_ - 1, P, 0);
        assert_eq!(line_view(&c, id, 0).allocation_mode, "BACKUP_RULING");
        drop(c);
    }

    #[test]
    fn lf008_amount_parsing() {
        let mut c = init(5);
        let id = disputed_line(&mut c, 1, 1, 0);
        for (b, s) in [
            ("+1", "999999"),
            ("01", "999999"),
            ("1", ""),
            ("1.0", "999999"),
        ] {
            expect_rejected(
                &mut c,
                id,
                PRIM,
                PS_,
                "ERR_AMOUNT_FORMAT:NonCanonicalDecimal",
                |c| {
                    c.submit_ruling(id, 0, b.into(), s.into());
                },
            );
        }
        expect_rejected(
            &mut c,
            id,
            PRIM,
            PS_,
            "ERR_LINE:AllocationSumMismatch",
            |c| {
                c.submit_ruling(id, 0, "1".into(), "1".into());
            },
        );
    }

    #[test]
    fn lf008_rejections_leave_state_and_e_unchanged() {
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 2);
        submit(&mut c, id, 0, S_, NOW + 10);
        set_ctx(B_, NOW + 11);
        c.open_dispute(id, 0);
        for now in [T0_, PS_, BS_, FS_ - 1] {
            expect_rejected(
                &mut c,
                id,
                "stranger.test.near",
                now,
                "ERR_LINE:FallbackNotEligible",
                |c| {
                    c.trigger_fallback(id, 0);
                },
            );
        }
        // Line 1 is FUNDED, not disputed.
        expect_rejected(&mut c, id, PRIM, PS_, "ERR_LINE:WrongState", |c| {
            c.submit_ruling(id, 1, "1".into(), (P - 1).to_string());
        });
        expect_rejected(
            &mut c,
            id,
            "stranger.test.near",
            FS_,
            "ERR_LINE:WrongState",
            |c| {
                c.trigger_fallback(id, 1);
            },
        );
        set_ctx("stranger.test.near", FS_);
        c.trigger_fallback(id, 0);
        let fin = line_view(&c, id, 0);
        for (who, f) in [
            (
                PRIM,
                Box::new(|c: &mut Contract| c.submit_ruling(id, 0, "1".into(), (P - 1).to_string()))
                    as Box<dyn FnOnce(&mut Contract)>,
            ),
            (
                BACK,
                Box::new(|c: &mut Contract| {
                    c.submit_ruling(id, 0, "1".into(), (P - 1).to_string())
                }),
            ),
            (
                "stranger.test.near",
                Box::new(|c: &mut Contract| c.trigger_fallback(id, 0)),
            ),
            (
                S_,
                Box::new(|c: &mut Contract| {
                    c.propose_split(id, 0, "1".into(), (P - 1).to_string());
                }),
            ),
        ] {
            expect_rejected(&mut c, id, who, FS_ + 1, "ERR_LINE:AlreadyFinalized", f);
        }
        assert_eq!(line_view(&c, id, 0), fin);
        assert_eq!(c.custody_total, 2 * P);
    }

    #[test]
    fn lf008_three_line_isolation_and_e() {
        let mut c = init(5);
        let id = disputed_line(&mut c, 1, 3, 2);
        let snap = |c: &Contract| -> Vec<Vec<u8>> {
            c.agreements
                .get(&id.0)
                .expect("a")
                .lines
                .iter()
                .map(|l| near_sdk::borsh::to_vec(l).expect("b"))
                .collect()
        };
        let before = snap(&c);
        set_ctx("stranger.test.near", FS_);
        c.trigger_fallback(id, 2);
        let after = snap(&c);
        assert_eq!((&after[0], &after[1]), (&before[0], &before[1]));
        assert_ne!(after[2], before[2]);
        assert_eq!(c.custody_total, 3 * P, "E unchanged by fallback");
        let l = line_view(&c, id, 2);
        assert_eq!(l.allocation_mode, "FALLBACK");
        assert_eq!(
            l.buyer_claimable.0.checked_add(l.supplier_claimable.0),
            Some(P)
        );
    }

    #[test]
    fn lf008_view_reports_phase() {
        let mut c = init(5);
        let id = disputed_line(&mut c, 1, 1, 0);
        for (now, want) in [
            (T0_, "NEGOTIATION"),
            (PS_ - 1, "NEGOTIATION"),
            (PS_, "PRIMARY"),
            (BS_, "BACKUP"),
            (FS_, "FALLBACK"),
        ] {
            set_ctx("stranger.test.near", now);
            let l = line_view(&c, id, 0);
            assert_eq!(l.dispute_phase, want, "at {now}");
            assert_eq!(
                (l.primary_start_ns, l.backup_start_ns, l.fallback_start_ns),
                (Some(U64(PS_)), Some(U64(BS_)), Some(U64(FS_)))
            );
        }
        rule(&mut c, id, 0, PRIM, PS_, P, 0);
        let l = line_view(&c, id, 0);
        assert_eq!(
            (l.dispute_phase.as_str(), l.primary_start_ns),
            ("NONE", None)
        );
    }

    // ---- LF-009 withdrawals and the private callback (contract level) ---------

    const ESC: &str = "escrow.test.near";

    /// Context for `withdraw`: caller, deposit (yocto) and prepaid gas (Tgas).
    fn wctx(who: &str, now: u64, yocto: u128, tgas: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc(ESC))
            .predecessor_account_id(acc(who))
            .signer_account_id(acc(who))
            .block_timestamp(now)
            .attached_deposit(NearToken::from_yoctonear(yocto))
            .prepaid_gas(Gas::from_tgas(tgas));
        testing_env!(b.build());
    }

    /// Context for the callback: predecessor `who` and the promise results.
    fn cbctx(who: &str, now: u64, results: Vec<near_sdk::PromiseResult>) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc(ESC))
            .predecessor_account_id(acc(who))
            .signer_account_id(acc(who))
            .block_timestamp(now)
            .prepaid_gas(Gas::from_tgas(15));
        testing_env!(
            b.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
    }

    fn ok() -> Vec<near_sdk::PromiseResult> {
        vec![near_sdk::PromiseResult::Successful(vec![])]
    }
    fn failed() -> Vec<near_sdk::PromiseResult> {
        vec![near_sdk::PromiseResult::Failed]
    }

    /// Agreement with `lines` funded lines; line `line` settled 400 000 /
    /// 600 000 (buyer / supplier) by an accepted proposal.
    fn settled(c: &mut Contract, lines: usize, line: u32) -> U64 {
        let id = disputed_line(c, 1, lines, line);
        let pid = propose(c, id, line, B_, 400_000, 600_000);
        set_ctx(S_, NOW + 13);
        c.accept_split(
            id,
            line,
            pid.0.to_string(),
            "400000".into(),
            "600000".into(),
        );
        id
    }

    fn wd(c: &mut Contract, id: U64, line: u32, who: &str, ben: &str) {
        wctx(who, NOW + 20, 1, 300);
        let _ = c.withdraw(id, line, ben.to_string());
    }

    fn slot(c: &Contract, id: U64, line: u32, ben: &str) -> WithdrawalView {
        c.get_withdrawal(id, line, ben.to_string()).expect("slot")
    }

    /// Rejection with an arbitrary context: panics with `code`, agreement,
    /// E and the LF-009 counters unchanged.
    fn rejects_ctx(
        c: &mut Contract,
        id: U64,
        code: &str,
        setup: impl FnOnce(),
        f: impl FnOnce(&mut Contract),
    ) {
        let before = c
            .agreements
            .get(&id.0)
            .map(|a| near_sdk::borsh::to_vec(a).expect("b"));
        let root = (c.custody_total, c.last_withdrawal_id, c.open_withdrawals);
        setup();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(c)));
        let m = panic_message(r.expect_err("must be rejected"));
        assert_eq!(
            err_codes(&m),
            vec![code.to_string()],
            "expected exactly {code}, got {m}"
        );
        let after = c
            .agreements
            .get(&id.0)
            .map(|a| near_sdk::borsh::to_vec(a).expect("b"));
        assert_eq!(after, before, "rejected ({code}) changed the agreement");
        assert_eq!(
            (c.custody_total, c.last_withdrawal_id, c.open_withdrawals),
            root
        );
    }

    #[test]
    fn lf009_withdraw_requires_one_yocto() {
        let mut c = init(5);
        let id = settled(&mut c, 1, 0);
        for y in [0u128, 2, 1_000_000_000_000_000_000_000_000] {
            rejects_ctx(
                &mut c,
                id,
                "ERR_WITHDRAW:DepositMustBeOneYocto",
                || wctx(B_, NOW + 20, y, 300),
                |c| {
                    let _ = c.withdraw(id, 0, "BUYER".into());
                },
            );
        }
    }

    #[test]
    fn lf009_withdraw_gas_floor() {
        let mut c = init(5);
        let id = settled(&mut c, 1, 0);
        let need = (GAS_FT_TRANSFER.as_gas()
            + GAS_WITHDRAW_CALLBACK.as_gas()
            + GAS_WITHDRAW_SELF.as_gas())
            / 1_000_000_000_000;
        rejects_ctx(
            &mut c,
            id,
            "ERR_WITHDRAW:InsufficientGas",
            || wctx(B_, NOW + 20, 1, need - 1),
            |c| {
                let _ = c.withdraw(id, 0, "BUYER".into());
            },
        );
        wctx(B_, NOW + 20, 1, need);
        let _ = c.withdraw(id, 0, "BUYER".into());
        assert_eq!(slot(&c, id, 0, "BUYER").state, "PENDING");
    }

    #[test]
    fn lf009_only_own_beneficiary() {
        let mut c = init(5);
        let id = settled(&mut c, 1, 0);
        for (who, ben, code) in [
            (B_, "SUPPLIER", "ERR_LINE:NotAuthorized"),
            (S_, "BUYER", "ERR_LINE:NotAuthorized"),
            (PRIM, "BUYER", "ERR_LINE:NotAuthorized"),
            (BACK, "SUPPLIER", "ERR_LINE:NotAuthorized"),
            ("stranger.test.near", "BUYER", "ERR_LINE:NotAuthorized"),
            (ESC, "SUPPLIER", "ERR_LINE:NotAuthorized"),
            (B_, "buyer", "ERR_WITHDRAW:BadBeneficiary"),
            (B_, "", "ERR_WITHDRAW:BadBeneficiary"),
        ] {
            rejects_ctx(
                &mut c,
                id,
                code,
                || wctx(who, NOW + 20, 1, 300),
                |c| {
                    let _ = c.withdraw(id, 0, ben.into());
                },
            );
        }
    }

    #[test]
    fn lf009_not_allocated_or_nothing_to_withdraw() {
        let mut c = init(5);
        let id = disputed_line(&mut c, 1, 2, 0);
        rejects_ctx(
            &mut c,
            id,
            "ERR_LINE:WrongState",
            || wctx(B_, NOW + 20, 1, 300),
            |c| {
                let _ = c.withdraw(id, 0, "BUYER".into());
            },
        );
        let pid = propose(&mut c, id, 0, B_, 0, P);
        set_ctx(S_, NOW + 13);
        c.accept_split(id, 0, pid.0.to_string(), "0".into(), P.to_string());
        rejects_ctx(
            &mut c,
            id,
            "ERR_LINE:NothingToWithdraw",
            || wctx(B_, NOW + 20, 1, 300),
            |c| {
                let _ = c.withdraw(id, 0, "BUYER".into());
            },
        );
        rejects_ctx(
            &mut c,
            id,
            "ERR_AGREEMENT_NOT_FOUND",
            || wctx(B_, NOW + 20, 1, 300),
            |c| {
                let _ = c.withdraw(U64(99), 0, "BUYER".into());
            },
        );
    }

    #[test]
    fn lf009_no_second_withdrawal_while_pending() {
        let mut c = init(5);
        let id = settled(&mut c, 1, 0);
        wd(&mut c, id, 0, B_, "BUYER");
        rejects_ctx(
            &mut c,
            id,
            "ERR_LINE:WithdrawalAlreadyPending",
            || wctx(B_, NOW + 21, 1, 300),
            |c| {
                let _ = c.withdraw(id, 0, "BUYER".into());
            },
        );
        let l = line_view(&c, id, 0);
        assert_eq!(
            (l.buyer_claimable, l.buyer_pending),
            (U128(0), U128(400_000))
        );
        assert_eq!(c.custody_total, P, "E unchanged by withdraw");
        assert_eq!(c.custody_summary().open_withdrawals, U64(1));
    }

    #[test]
    fn lf009_ids_contract_wide_monotonic() {
        let mut c = init(5);
        let id = settled(&mut c, 2, 0);
        submit(&mut c, id, 1, S_, NOW + 10);
        set_ctx(B_, NOW + 11);
        c.open_dispute(id, 1);
        let pid = propose(&mut c, id, 1, B_, 1, P - 1);
        set_ctx(S_, NOW + 13);
        c.accept_split(id, 1, pid.0.to_string(), "1".into(), (P - 1).to_string());
        for (line, who, ben, want) in [
            (0u32, B_, "BUYER", 1u64),
            (0, S_, "SUPPLIER", 2),
            (1, S_, "SUPPLIER", 3),
            (1, B_, "BUYER", 4),
        ] {
            wd(&mut c, id, line, who, ben);
            let w = slot(&c, id, line, ben);
            assert_eq!(
                (w.withdrawal_id, w.epoch, w.state.as_str()),
                (U64(want), 1, "PENDING")
            );
        }
        assert_eq!(c.custody_summary().last_withdrawal_id, U64(4));
        assert_eq!(c.custody_summary().open_withdrawals, U64(4));
    }

    #[test]
    fn lf009_callback_success_paid_and_e_decrements() {
        let mut c = init(5);
        let id = settled(&mut c, 1, 0);
        wd(&mut c, id, 0, S_, "SUPPLIER");
        cbctx(ESC, NOW + 21, ok());
        let r = c.on_withdrawal_transfer(id, 0, "SUPPLIER".into(), U64(1), 1);
        assert_eq!(r.outcome, "PAID");
        assert!(near_sdk::test_utils::get_logs().contains(&"LF_WITHDRAWAL_PAID:1".to_string()));
        let w = slot(&c, id, 0, "SUPPLIER");
        assert_eq!(
            (
                w.state.as_str(),
                w.amount,
                w.resolved_at_ns,
                w.recipient.as_str()
            ),
            ("PAID", U128(600_000), U64(NOW + 21), S_)
        );
        let l = line_view(&c, id, 0);
        assert_eq!(
            (l.supplier_pending, l.supplier_paid, l.buyer_claimable),
            (U128(0), U128(600_000), U128(400_000))
        );
        assert_eq!(
            c.custody_total,
            P - 600_000,
            "E decremented by exactly the slot amount"
        );
        assert_eq!(c.custody_summary().open_withdrawals, U64(0));
    }

    #[test]
    fn lf009_callback_failure_restores_once_then_retry() {
        let mut c = init(5);
        let id = settled(&mut c, 1, 0);
        wd(&mut c, id, 0, B_, "BUYER");
        cbctx(ESC, NOW + 21, failed());
        assert_eq!(
            c.on_withdrawal_transfer(id, 0, "BUYER".into(), U64(1), 1)
                .outcome,
            "FAILED"
        );
        let l = line_view(&c, id, 0);
        assert_eq!(
            (l.buyer_claimable, l.buyer_pending, l.buyer_paid),
            (U128(400_000), U128(0), U128(0))
        );
        assert_eq!(c.custody_total, P, "E unchanged on definite failure");
        // Replaying the failure does not restore twice.
        cbctx(ESC, NOW + 22, failed());
        assert_eq!(
            c.on_withdrawal_transfer(id, 0, "BUYER".into(), U64(1), 1)
                .outcome,
            "IGNORED"
        );
        assert_eq!(line_view(&c, id, 0).buyer_claimable, U128(400_000));
        // Retry: new id, next epoch, then success.
        wd(&mut c, id, 0, B_, "BUYER");
        let w = slot(&c, id, 0, "BUYER");
        assert_eq!((w.withdrawal_id, w.epoch), (U64(2), 2));
        cbctx(ESC, NOW + 23, ok());
        assert_eq!(
            c.on_withdrawal_transfer(id, 0, "BUYER".into(), U64(2), 2)
                .outcome,
            "PAID"
        );
        assert_eq!(c.custody_total, P - 400_000);
    }

    #[test]
    fn lf009_callback_forged_by_outsider_rejected() {
        let mut c = init(5);
        let id = settled(&mut c, 1, 0);
        wd(&mut c, id, 0, B_, "BUYER");
        for who in [B_, S_, PRIM, "stranger.test.near", FT] {
            rejects_ctx(
                &mut c,
                id,
                "ERR_WITHDRAW:CallbackNotPrivate",
                || cbctx(who, NOW + 21, ok()),
                |c| {
                    let _ = c.on_withdrawal_transfer(id, 0, "BUYER".into(), U64(1), 1);
                },
            );
        }
        assert_eq!(slot(&c, id, 0, "BUYER").state, "PENDING");
    }

    #[test]
    fn lf009_callback_mismatch_and_duplicate_ignored() {
        let mut c = init(5);
        let id = settled(&mut c, 2, 0);
        wd(&mut c, id, 0, B_, "BUYER");
        let snap = |c: &Contract| {
            (
                c.agreements
                    .get(&id.0)
                    .map(|a| near_sdk::borsh::to_vec(a).expect("b")),
                c.custody_total,
                c.open_withdrawals,
            )
        };
        let before = snap(&c);
        for (agr, line, ben, wid, ep) in [
            (id, 0u32, "BUYER", 2u64, 1u32), // wrong id
            (id, 0, "BUYER", 1, 2),          // stale / future epoch
            (id, 0, "SUPPLIER", 1, 1),       // other beneficiary (not pending)
            (id, 1, "BUYER", 1, 1),          // other line
            (id, 7, "BUYER", 1, 1),          // unknown line
            (U64(99), 0, "BUYER", 1, 1),     // unknown agreement
            (id, 0, "buyer", 1, 1),          // malformed beneficiary
        ] {
            for res in [ok(), failed()] {
                cbctx(ESC, NOW + 21, res);
                assert_eq!(
                    c.on_withdrawal_transfer(agr, line, ben.into(), U64(wid), ep)
                        .outcome,
                    "IGNORED"
                );
                assert_eq!(snap(&c), before, "mismatch changed state");
            }
        }
        for res in [
            vec![],
            vec![
                near_sdk::PromiseResult::Successful(vec![]),
                near_sdk::PromiseResult::Failed,
            ],
        ] {
            cbctx(ESC, NOW + 21, res);
            assert_eq!(
                c.on_withdrawal_transfer(id, 0, "BUYER".into(), U64(1), 1)
                    .outcome,
                "IGNORED"
            );
            assert_eq!(snap(&c), before);
        }
        cbctx(ESC, NOW + 21, ok());
        assert_eq!(
            c.on_withdrawal_transfer(id, 0, "BUYER".into(), U64(1), 1)
                .outcome,
            "PAID"
        );
        let paid = snap(&c);
        // Duplicate success and a late failure for the same withdrawal.
        for res in [ok(), failed()] {
            cbctx(ESC, NOW + 22, res);
            assert_eq!(
                c.on_withdrawal_transfer(id, 0, "BUYER".into(), U64(1), 1)
                    .outcome,
                "IGNORED"
            );
            assert_eq!(snap(&c), paid, "duplicate changed state");
        }
    }

    #[test]
    fn lf009_custody_underflow_stays_pending_incident() {
        let mut c = init(5);
        let id = settled(&mut c, 1, 0);
        wd(&mut c, id, 0, S_, "SUPPLIER");
        c.custody_total = 599_999; // forced inconsistency: E < slot amount
        let before = c
            .agreements
            .get(&id.0)
            .map(|a| near_sdk::borsh::to_vec(a).expect("b"));
        cbctx(ESC, NOW + 21, ok());
        assert_eq!(
            c.on_withdrawal_transfer(id, 0, "SUPPLIER".into(), U64(1), 1)
                .outcome,
            "PENDING"
        );
        assert!(
            near_sdk::test_utils::get_logs()
                .contains(&"LF_INCIDENT:CustodyUnderflow:1".to_string())
        );
        assert_eq!(
            c.agreements
                .get(&id.0)
                .map(|a| near_sdk::borsh::to_vec(a).expect("b")),
            before
        );
        assert_eq!((c.custody_total, c.open_withdrawals), (599_999, 1));
        assert_eq!(slot(&c, id, 0, "SUPPLIER").state, "PENDING");
    }

    #[test]
    fn lf009_inconclusive_has_no_state_changing_path() {
        // Without the callback the record stays PENDING: every withdrawal path
        // rejects it, and no other method touches it (interface: T068).
        let mut c = init(5);
        let id = settled(&mut c, 1, 0);
        wd(&mut c, id, 0, B_, "BUYER");
        for later in [NOW + 21, NOW + 365 * 24 * HOUR] {
            rejects_ctx(
                &mut c,
                id,
                "ERR_LINE:WithdrawalAlreadyPending",
                || wctx(B_, later, 1, 300),
                |c| {
                    let _ = c.withdraw(id, 0, "BUYER".into());
                },
            );
        }
        let w = slot(&c, id, 0, "BUYER");
        assert_eq!(
            (w.state.as_str(), w.amount, w.withdrawal_id, w.started_at_ns),
            ("PENDING", U128(400_000), U64(1), U64(NOW + 20))
        );
        let s = c.custody_summary();
        assert_eq!(
            (s.outstanding_liabilities, s.open_withdrawals),
            (U128(P), U64(1))
        );
    }

    #[test]
    fn lf009_three_line_isolation_and_u128_e() {
        let mut c = init(5);
        let id = settled(&mut c, 3, 1);
        let snap = |c: &Contract| -> Vec<Vec<u8>> {
            c.agreements
                .get(&id.0)
                .expect("a")
                .lines
                .iter()
                .map(|l| near_sdk::borsh::to_vec(l).expect("b"))
                .collect()
        };
        let before = snap(&c);
        wd(&mut c, id, 1, S_, "SUPPLIER");
        cbctx(ESC, NOW + 21, ok());
        c.on_withdrawal_transfer(id, 1, "SUPPLIER".into(), U64(1), 1);
        let after = snap(&c);
        assert_eq!((&after[0], &after[2]), (&before[0], &before[2]));
        assert_eq!(c.custody_total, 3 * P - 600_000);
        // E arithmetic at the u128 edge (forced root value; the slot amount
        // is subtracted exactly, never saturated).
        drop(c);
        fresh_chain();
        let mut c2 = init(5);
        let id2 = settled(&mut c2, 1, 0);
        wd(&mut c2, id2, 0, S_, "SUPPLIER");
        c2.custody_total = u128::MAX;
        cbctx(ESC, NOW + 21, ok());
        c2.on_withdrawal_transfer(id2, 0, "SUPPLIER".into(), U64(1), 1);
        assert_eq!(c2.custody_total, u128::MAX - 600_000);
        drop(c2);
    }

    #[test]
    #[ignore = "probe: prints mocked-VM gas use of withdraw"]
    fn lf009_probe_withdraw_gas() {
        let mut c = init(5);
        let id = settled(&mut c, 3, 0);
        wctx(B_, NOW + 20, 1, 300);
        let _ = c.withdraw(id, 0, "BUYER".into());
        println!(
            "PROBE used_gas_total={} prepaid=300T static_alloc={}",
            env::used_gas().as_gas(),
            (GAS_FT_TRANSFER.as_gas() + GAS_WITHDRAW_CALLBACK.as_gas())
        );
    }

    #[test]
    #[cfg(not(feature = "test-starve-callback"))]
    fn lf009_starve_feature_off_in_this_build() {
        const { assert!(!cfg!(feature = "test-starve-callback")) };
        assert_eq!(GAS_WITHDRAW_CALLBACK, Gas::from_tgas(15));
        set_ctx(B_, NOW);
        let c = init(5);
        assert_eq!(c.contract_version(), CONTRACT_VERSION);
    }

    // ---- LF-009 property B9: E conservation through withdrawals / callbacks -----

    #[derive(Debug, Clone, Copy)]
    enum B9Op {
        /// (line, caller 0 buyer / 1 supplier / 2 primary / 3 stranger,
        /// beneficiary 0 BUYER / 1 SUPPLIER, exact 1 yocto?)
        Withdraw(u32, u8, u8, bool),
        /// (line, beneficiary, result 0 success / 1 failure / 2 no callback,
        /// tamper 0 none / 1 id+1 / 2 epoch+1 / 3 other line / 4 outsider)
        Callback(u32, u8, u8, u8),
    }

    fn arb_b9op() -> impl proptest::strategy::Strategy<Value = B9Op> {
        use proptest::prelude::*;
        prop_oneof![
            5 => (0u32..4, prop_oneof![4 => 0u8..2, 1 => 2u8..4], 0u8..2, prop::bool::weighted(0.9))
                .prop_map(|(l, w, b, y)| B9Op::Withdraw(l, w, b, y)),
            5 => (0u32..3, 0u8..2, prop_oneof![5 => Just(0u8), 3 => Just(1u8), 1 => Just(2u8)], prop_oneof![6 => Just(0u8), 1 => 1u8..5])
                .prop_map(|(l, b, r, t)| B9Op::Callback(l, b, r, t)),
        ]
    }

    /// Model slot: (claimable, pending amount, id, epoch, paid, state).
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct B9Slot {
        claimable: u128,
        pending: u128,
        id: u64,
        epoch: u32,
        paid: u128,
        state: &'static str,
    }

    fn b9_case(splits: &[u128], ops: &[B9Op]) -> Result<(), proptest::test_runner::TestCaseError> {
        use proptest::test_runner::TestCaseError as E;
        let fail = |m: String| E::fail(m);
        fresh_chain();
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 3);
        let mut m = [[B9Slot {
            claimable: 0,
            pending: 0,
            id: 0,
            epoch: 0,
            paid: 0,
            state: "EMPTY",
        }; 2]; 3];
        for line in 0..3u32 {
            submit(&mut c, id, line, S_, NOW + 10);
            set_ctx(B_, NOW + 11);
            c.open_dispute(id, line);
            let b = splits[line as usize] % (P + 1);
            let pid = propose(&mut c, id, line, B_, b, P - b);
            set_ctx(S_, NOW + 13);
            c.accept_split(
                id,
                line,
                pid.0.to_string(),
                b.to_string(),
                (P - b).to_string(),
            );
            m[line as usize][0].claimable = b;
            m[line as usize][1].claimable = P - b;
        }
        let mut e = 3 * P;
        let (mut last, mut open) = (0u64, 0u64);
        let who = [B_, S_, PRIM, "stranger.test.near"];
        let ben = ["BUYER", "SUPPLIER"];
        for (k, op) in ops.iter().enumerate() {
            let now = NOW + 100 + k as u64;
            let before = near_sdk::borsh::to_vec(c.agreements.get(&id.0).expect("a")).expect("b");
            let root = (c.custody_total, c.last_withdrawal_id, c.open_withdrawals);
            let (ok, pred) = match *op {
                B9Op::Withdraw(line, w, b, yocto) => {
                    let li = line as usize;
                    let pred = li < 3
                        && yocto
                        && usize::from(w) == usize::from(b)
                        && m[li][b as usize].state != "PENDING"
                        && m[li][b as usize].claimable > 0;
                    wctx(who[w as usize], now, if yocto { 1 } else { 0 }, 300);
                    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let _ = c.withdraw(id, line, ben[b as usize].to_string());
                    }));
                    // Every rejection must carry the code of the first failing
                    // check, in the contract's check order.
                    if !pred {
                        let want = if !yocto {
                            "ERR_WITHDRAW:DepositMustBeOneYocto"
                        } else if usize::from(w) != usize::from(b) {
                            "ERR_LINE:NotAuthorized"
                        } else if li >= 3 {
                            "ERR_LINE:LineNotFound"
                        } else if m[li][b as usize].state == "PENDING" {
                            "ERR_LINE:WithdrawalAlreadyPending"
                        } else {
                            "ERR_LINE:NothingToWithdraw"
                        };
                        match &r {
                            Err(p) => {
                                let msg = panic_message_ref(p);
                                if err_codes(&msg) != vec![want.to_string()] {
                                    return Err(fail(format!(
                                        "op {k} {op:?}: expected {want}, got {msg}"
                                    )));
                                }
                            }
                            Ok(()) => {
                                return Err(fail(format!(
                                    "op {k} {op:?}: expected {want}, call succeeded"
                                )));
                            }
                        }
                    }
                    if pred {
                        let s = &mut m[li][b as usize];
                        last += 1;
                        open += 1;
                        *s = B9Slot {
                            claimable: 0,
                            pending: s.claimable,
                            id: last,
                            epoch: s.epoch + 1,
                            paid: s.paid,
                            state: "PENDING",
                        };
                    }
                    (r.is_ok(), pred)
                }
                B9Op::Callback(line, b, res, tamper) => {
                    let li = line as usize;
                    let s = m[li][b as usize];
                    if res == 2 {
                        continue; // no callback at all: nothing may change
                    }
                    let (cl, wid, ep, caller) = match tamper {
                        1 => (line, s.id + 1, s.epoch, ESC),
                        2 => (line, s.id, s.epoch + 1, ESC),
                        3 => ((line + 1) % 3, s.id, s.epoch, ESC),
                        4 => (line, s.id, s.epoch, B_),
                        _ => (line, s.id, s.epoch, ESC),
                    };
                    let target = m[cl as usize][b as usize];
                    let pred = caller == ESC
                        && target.state == "PENDING"
                        && target.id == wid
                        && target.epoch == ep;
                    cbctx(caller, now, if res == 0 { ok() } else { failed() });
                    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        c.on_withdrawal_transfer(id, cl, ben[b as usize].to_string(), U64(wid), ep)
                    }));
                    let changed =
                        matches!(&r, Ok(v) if v.outcome == "PAID" || v.outcome == "FAILED");
                    // Exact outcome / rejection code.
                    if caller != ESC {
                        match &r {
                            Err(p)
                                if panic_message_ref(p)
                                    .contains("ERR_WITHDRAW:CallbackNotPrivate") => {}
                            other => {
                                return Err(fail(format!(
                                    "op {k}: outsider callback gave {:?}",
                                    other
                                        .as_ref()
                                        .map(|v| v.outcome.clone())
                                        .map_err(panic_message_ref)
                                )));
                            }
                        }
                    } else {
                        let out = match &r {
                            Ok(v) => v.outcome.clone(),
                            Err(p) => {
                                return Err(fail(format!(
                                    "op {k}: genuine callback panicked: {}",
                                    panic_message_ref(p)
                                )));
                            }
                        };
                        let want = if pred {
                            if res == 0 { "PAID" } else { "FAILED" }
                        } else {
                            "IGNORED"
                        };
                        if out != want {
                            return Err(fail(format!(
                                "op {k} {op:?}: outcome {out}, expected {want}"
                            )));
                        }
                        if !pred {
                            let code = if target.state != "PENDING" {
                                "WithdrawalNotPending"
                            } else {
                                "WithdrawalIdMismatch"
                            };
                            let tag = format!("LF_WITHDRAWAL_IGNORED:{code}:{wid}");
                            if !near_sdk::test_utils::get_logs().contains(&tag) {
                                return Err(fail(format!(
                                    "op {k} {op:?}: missing log {tag}, logs {:?}",
                                    near_sdk::test_utils::get_logs()
                                )));
                            }
                        }
                    }
                    if pred {
                        let t = &mut m[cl as usize][b as usize];
                        open -= 1;
                        if res == 0 {
                            e -= t.pending;
                            t.paid += t.pending;
                            t.state = "PAID";
                        } else {
                            t.claimable += t.pending;
                            t.state = "FAILED";
                        }
                        t.pending = 0;
                    }
                    if caller != ESC && r.is_ok() {
                        return Err(fail(format!("op {k}: outsider callback not rejected")));
                    }
                    (changed, pred)
                }
            };
            if ok != pred {
                return Err(fail(format!("op {k} {op:?}: real={ok} predicted={pred}")));
            }
            if !ok {
                let after =
                    near_sdk::borsh::to_vec(c.agreements.get(&id.0).expect("a")).expect("b");
                if after != before
                    || (c.custody_total, c.last_withdrawal_id, c.open_withdrawals) != root
                {
                    return Err(fail(format!("op {k} {op:?}: rejected but state changed")));
                }
            }
            // Invariants after every step.
            if c.custody_total != e || c.custody_total != unpaid_buckets(&c) {
                return Err(fail(format!(
                    "op {k}: E={} model={e} unpaid={}",
                    c.custody_total,
                    unpaid_buckets(&c)
                )));
            }
            if (c.last_withdrawal_id, c.open_withdrawals) != (last, open) {
                return Err(fail(format!(
                    "op {k}: counters ({}, {}) != model ({last}, {open})",
                    c.last_withdrawal_id, c.open_withdrawals
                )));
            }
            let a = c.agreements.get(&id.0).expect("a");
            for (li, line) in a.lines.iter().enumerate() {
                let g = &line.ledger;
                for (bi, (cl, pe, pa, sl)) in [
                    (
                        g.buyer_claimable,
                        g.buyer_pending,
                        g.buyer_paid,
                        &line.buyer_withdrawal,
                    ),
                    (
                        g.supplier_claimable,
                        g.supplier_pending,
                        g.supplier_paid,
                        &line.supplier_withdrawal,
                    ),
                ]
                .into_iter()
                .enumerate()
                {
                    let ms = m[li][bi];
                    if (cl, pe, pa, sl.state.as_str(), sl.withdrawal_id, sl.epoch)
                        != (ms.claimable, ms.pending, ms.paid, ms.state, ms.id, ms.epoch)
                    {
                        return Err(fail(format!(
                            "op {k}: line {li} ben {bi} real {:?} model {ms:?}",
                            (cl, pe, pa, sl)
                        )));
                    }
                }
            }
        }
        drop(c);
        Ok(())
    }

    /// B9 profiles as B4: quick 200 (default), full 10 000 (`LINEFAIR_PROPTEST_PROFILE=full`).
    /// Seed sha256("linefair/lf009/v1/b9").
    #[test]
    fn lf009_e_conservation_prop() {
        use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};
        let cases = match std::env::var("LINEFAIR_PROPTEST_PROFILE").as_deref() {
            Ok("full") => 10_000,
            Ok("diag") => 50,
            _ => 200,
        };
        let seed = near_sdk::env::sha256_array(b"linefair/lf009/v1/b9");
        eprintln!(
            "B9 START cases={cases} seed_hex={}",
            encode_hex_lower(&seed)
        );
        let mut runner = TestRunner::new_with_rng(
            Config {
                cases,
                failure_persistence: None,
                ..Config::default()
            },
            TestRng::from_seed(RngAlgorithm::ChaCha, &seed),
        );
        let strategy = (
            proptest::collection::vec(proptest::prelude::any::<u128>(), 3),
            proptest::collection::vec(arb_b9op(), 1..=40),
        );
        let r = runner.run(&strategy, |(splits, ops)| b9_case(&splits, &ops));
        eprintln!(
            "B9 END cases={cases} result={}",
            if r.is_ok() { "PASS" } else { "FAIL" }
        );
        if let Err(e) = r {
            panic!("B9 failed: {e}");
        }
    }

    // ---- LF-010A creator allowlist (tests written before the implementation) ----

    fn init_with(list: Vec<AccountId>) -> Contract {
        set_ctx("escrow.test.near", NOW);
        Contract::new(
            "sandbox".into(),
            acc("ft.test.near"),
            acc("treasury.test.near"),
            5,
            list,
        )
    }

    fn init_rejects(list: Vec<AccountId>, code: &str) {
        let r = std::panic::catch_unwind(|| init_with(list.clone()));
        let m = panic_message(
            r.err()
                .unwrap_or_else(|| panic!("{list:?} must be rejected")),
        );
        assert_eq!(err_codes(&m), vec![code.to_string()], "{list:?}: {m}");
    }

    #[test]
    fn allowlist_init_rejects_empty_oversized_duplicate_reserved() {
        init_rejects(vec![], "ERR_INIT_CREATOR_ALLOWLIST_SIZE");
        let eleven: Vec<AccountId> = (0..11).map(|i| acc(&format!("c{i}.test.near"))).collect();
        init_rejects(eleven, "ERR_INIT_CREATOR_ALLOWLIST_SIZE");
        init_rejects(
            vec![acc("a.test.near"), acc("b.test.near"), acc("a.test.near")],
            "ERR_INIT_CREATOR_ALLOWLIST_DUPLICATE",
        );
        for reserved in ["escrow.test.near", "ft.test.near", "treasury.test.near"] {
            init_rejects(
                vec![acc("a.test.near"), acc(reserved)],
                "ERR_INIT_CREATOR_ALLOWLIST_RESERVED",
            );
        }
        // Boundaries accepted: 1 and 10 entries.
        let c = init_with(vec![acc("a.test.near")]);
        assert_eq!(c.get_config().creator_allowlist, vec![acc("a.test.near")]);
        drop(c);
        fresh_chain();
        let ten: Vec<AccountId> = (0..10).map(|i| acc(&format!("c{i}.test.near"))).collect();
        let c = init_with(ten.clone());
        assert_eq!(c.get_config().creator_allowlist, ten);
        drop(c);
    }

    #[test]
    fn allowlist_stranger_create_rejected_storage_unchanged() {
        let mut c = init(5);
        for who in [
            "stranger.test.near",
            "primary.test.near",
            "backup.test.near",
            "escrow.test.near",
            "treasury.test.near",
        ] {
            set_ctx(who, NOW);
            let su = env::storage_usage();
            let root = near_sdk::borsh::to_vec(&c).expect("b");
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                c.create_agreement(terms_json(1, 3))
            }));
            let m = panic_message(r.expect_err("must be rejected"));
            assert_eq!(
                err_codes(&m),
                vec!["ERR_CREATOR_NOT_ALLOWLISTED".to_string()],
                "{who}: {m}"
            );
            assert_eq!(env::storage_usage(), su, "{who}: storage changed");
            assert_eq!(
                near_sdk::borsh::to_vec(&c).expect("b"),
                root,
                "{who}: root state changed"
            );
            assert_eq!(c.next_agreement_id, 0, "{who}: slot consumed");
        }
        // Allowlisted but not the buyer: the existing rule still applies.
        set_ctx("supplier.test.near", NOW);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_agreement(terms_json(1, 3))
        }));
        let m = panic_message(r.expect_err("must be rejected"));
        assert_eq!(err_codes(&m), vec!["ERR_NOT_BUYER".to_string()], "{m}");
        assert_eq!(c.next_agreement_id, 0);
    }

    #[test]
    fn allowlist_member_creates() {
        let mut c = init_with(vec![acc("buyer.test.near")]);
        set_ctx("buyer.test.near", NOW);
        assert_eq!(c.create_agreement(terms_json(1, 3)), U64(0));
        assert_eq!(c.get_config().agreements_created, U64(1));
    }

    #[test]
    fn allowlist_has_no_mutation_path() {
        // Interface inspection of the shipped source: the list is written in
        // exactly one place (the `new` initializer) and never mutated.
        let src = include_str!("lib.rs");
        let prod = &src[..src.find("#[cfg(test)]").expect("test module")];
        assert_eq!(
            prod.matches("creator_allowlist,\n").count()
                + prod.matches("creator_allowlist: list").count(),
            1,
            "single initializer write"
        );
        for forbidden in [
            "self.creator_allowlist =",
            "creator_allowlist.push",
            "creator_allowlist.retain",
            "creator_allowlist.remove",
            "creator_allowlist.clear",
            "creator_allowlist.insert",
            "&mut self.creator_allowlist",
            "creator_allowlist.truncate",
        ] {
            assert!(
                !prod.contains(forbidden),
                "mutation path found: {forbidden}"
            );
        }
    }

    #[test]
    fn allowlist_non_creator_permissions_unchanged() {
        // Only the buyer is listed: supplier and both arbitrators are not, and
        // still accept, deliver, rule and withdraw exactly as before.
        set_ctx("escrow.test.near", NOW);
        let mut c = Contract::new(
            "sandbox".into(),
            acc("ft.test.near"),
            acc("treasury.test.near"),
            5,
            vec![acc("buyer.test.near")],
        );
        let (id, _) = funded(&mut c, 1, 2);
        submit(&mut c, id, 0, S_, NOW + 10);
        set_ctx(B_, NOW + 11);
        c.open_dispute(id, 0);
        rule(&mut c, id, 0, PRIM, PS_, 100, P - 100);
        wd(&mut c, id, 0, S_, "SUPPLIER");
        cbctx(ESC, NOW + 21, ok());
        assert_eq!(
            c.on_withdrawal_transfer(id, 0, "SUPPLIER".into(), U64(1), 1)
                .outcome,
            "PAID"
        );
        submit(&mut c, id, 1, S_, NOW + 10);
        set_ctx(B_, NOW + 11);
        c.open_dispute(id, 1);
        rule(&mut c, id, 1, BACK, BS_, P, 0);
        assert_eq!(line_view(&c, id, 1).allocation_mode, "BACKUP_RULING");
        assert_eq!(c.custody_total, 2 * P - (P - 100));
    }

    // ---- LF-010 role × method × state authorization matrix (docs/29) ----------

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum MxState {
        Unfunded,
        Funded,
        FundedLate,
        Submitted,
        SubmittedLate,
        Negotiation,
        Primary,
        Backup,
        Fallback,
        Allocated,
        Pending,
        Paid,
        Failed,
    }

    const MX_STATES: [MxState; 13] = [
        MxState::Unfunded,
        MxState::Funded,
        MxState::FundedLate,
        MxState::Submitted,
        MxState::SubmittedLate,
        MxState::Negotiation,
        MxState::Primary,
        MxState::Backup,
        MxState::Fallback,
        MxState::Allocated,
        MxState::Pending,
        MxState::Paid,
        MxState::Failed,
    ];
    const MX_METHODS: [&str; 10] = [
        "submit_delivery",
        "accept_line",
        "open_dispute",
        "advance_case",
        "propose_split",
        "accept_split",
        "submit_ruling",
        "trigger_fallback",
        "withdraw_BUYER",
        "withdraw_SUPPLIER",
    ];
    const MX_CALLERS: [&str; 7] = [
        B_,
        S_,
        PRIM,
        BACK,
        "stranger.test.near",
        ESC,
        "ft.test.near",
    ];

    /// Build one single-line agreement in `st`; returns (contract, id, call time).
    fn mx_build(st: MxState) -> (Contract, U64, u64) {
        fresh_chain();
        let mut c = init(5);
        let dispute_at = |c: &mut Contract| {
            let (id, _) = funded(c, 1, 1);
            submit(c, id, 0, S_, NOW + 10);
            set_ctx(B_, NOW + 11);
            c.open_dispute(id, 0);
            id
        };
        let allocated = |c: &mut Contract| {
            let id = dispute_at(c);
            let pid = propose(c, id, 0, B_, 400_000, 600_000);
            set_ctx(S_, NOW + 13);
            c.accept_split(id, 0, pid.0.to_string(), "400000".into(), "600000".into());
            id
        };
        match st {
            MxState::Unfunded => {
                let (id, _) = agreed(&mut c, 1, 1);
                (c, id, NOW + 20)
            }
            MxState::Funded | MxState::FundedLate => {
                let (id, _) = funded(&mut c, 1, 1);
                (
                    c,
                    id,
                    if st == MxState::Funded {
                        NOW + 20
                    } else {
                        NOW + 96 * HOUR
                    },
                )
            }
            MxState::Submitted | MxState::SubmittedLate => {
                let (id, _) = funded(&mut c, 1, 1);
                submit(&mut c, id, 0, S_, NOW + 10);
                (
                    c,
                    id,
                    if st == MxState::Submitted {
                        NOW + 20
                    } else {
                        NOW + 10 + REVIEW
                    },
                )
            }
            MxState::Negotiation | MxState::Primary | MxState::Backup | MxState::Fallback => {
                let id = dispute_at(&mut c);
                let t = match st {
                    MxState::Negotiation => T0_ + 1,
                    MxState::Primary => PS_,
                    MxState::Backup => BS_,
                    _ => FS_,
                };
                (c, id, t)
            }
            MxState::Allocated => {
                let id = allocated(&mut c);
                (c, id, NOW + 20)
            }
            MxState::Pending => {
                let id = allocated(&mut c);
                wd(&mut c, id, 0, B_, "BUYER");
                (c, id, NOW + 30)
            }
            MxState::Paid => {
                let id = allocated(&mut c);
                wd(&mut c, id, 0, B_, "BUYER");
                cbctx(ESC, NOW + 21, ok());
                c.on_withdrawal_transfer(id, 0, "BUYER".into(), U64(1), 1);
                wd(&mut c, id, 0, S_, "SUPPLIER");
                cbctx(ESC, NOW + 22, ok());
                c.on_withdrawal_transfer(id, 0, "SUPPLIER".into(), U64(2), 1);
                (c, id, NOW + 40)
            }
            MxState::Failed => {
                let id = allocated(&mut c);
                wd(&mut c, id, 0, B_, "BUYER");
                cbctx(ESC, NOW + 21, failed());
                c.on_withdrawal_transfer(id, 0, "BUYER".into(), U64(1), 1);
                (c, id, NOW + 40)
            }
        }
    }

    /// The oracle: `docs/06` authorization table + `docs/08` windows + LF-007/8/9
    /// rules, written independently of the implementation. `None` = success.
    fn mx_expected(st: MxState, method: &str, caller: &str) -> Option<&'static str> {
        use MxState::*;
        let disputed = matches!(st, Negotiation | Primary | Backup | Fallback);
        let finalized = matches!(st, Allocated | Pending | Paid | Failed);
        let party = caller == B_ || caller == S_;
        match method {
            "submit_delivery" => match (caller == S_, st) {
                (false, _) => Some("ERR_LINE:NotAuthorized"),
                (true, Funded) => None,
                (true, FundedLate) => Some("ERR_LINE:SubmissionDeadlinePassed"),
                _ => Some("ERR_LINE:WrongState"),
            },
            "accept_line" | "open_dispute" => match (caller == B_, st) {
                (false, _) => Some("ERR_LINE:NotAuthorized"),
                (true, Submitted) => None,
                (true, SubmittedLate) => Some("ERR_LINE:ReviewWindowClosed"),
                _ => Some("ERR_LINE:WrongState"),
            },
            "advance_case" => match st {
                FundedLate | SubmittedLate => None,
                Funded | Submitted => Some("ERR_LINE:NotEligible"),
                _ => Some("ERR_LINE:NotAdvanceable"),
            },
            "propose_split" | "accept_split" => {
                if !party {
                    Some("ERR_LINE:NotAuthorized")
                } else if finalized {
                    Some("ERR_LINE:AlreadyFinalized")
                } else if !disputed {
                    Some("ERR_LINE:WrongState")
                } else if method == "accept_split" {
                    Some("ERR_LINE:NoActiveProposal")
                } else {
                    None
                }
            }
            "submit_ruling" => {
                if caller != PRIM && caller != BACK {
                    Some("ERR_LINE:NotAuthorized")
                } else if finalized {
                    Some("ERR_LINE:AlreadyFinalized")
                } else if !disputed {
                    Some("ERR_LINE:WrongState")
                } else if (caller == PRIM && st == Primary) || (caller == BACK && st == Backup) {
                    None
                } else {
                    Some("ERR_LINE:NotRulingWindow")
                }
            }
            "trigger_fallback" => {
                if finalized {
                    Some("ERR_LINE:AlreadyFinalized")
                } else if !disputed {
                    Some("ERR_LINE:WrongState")
                } else if st == Fallback {
                    None
                } else {
                    Some("ERR_LINE:FallbackNotEligible")
                }
            }
            _ => {
                let buyer_side = method == "withdraw_BUYER";
                let me = if buyer_side { B_ } else { S_ };
                if caller != me {
                    Some("ERR_LINE:NotAuthorized")
                } else if !finalized {
                    Some("ERR_LINE:WrongState")
                } else {
                    match (st, buyer_side) {
                        (Pending, true) => Some("ERR_LINE:WithdrawalAlreadyPending"),
                        (Paid, _) => Some("ERR_LINE:NothingToWithdraw"),
                        _ => None,
                    }
                }
            }
        }
    }

    fn mx_call(c: &mut Contract, id: U64, method: &str, caller: &str, now: u64) {
        if let Some(ben) = method.strip_prefix("withdraw_") {
            wctx(caller, now, 1, 300);
            let _ = c.withdraw(id, 0, ben.to_string());
            return;
        }
        set_ctx(caller, now);
        match method {
            "submit_delivery" => c.submit_delivery(id, 0, EV.to_string()),
            "accept_line" => c.accept_line(id, 0),
            "open_dispute" => c.open_dispute(id, 0),
            "advance_case" => c.advance_case(id, 0),
            "propose_split" => {
                let _ = c.propose_split(id, 0, "400000".into(), "600000".into());
            }
            "accept_split" => c.accept_split(id, 0, "1".into(), "400000".into(), "600000".into()),
            "submit_ruling" => c.submit_ruling(id, 0, "400000".into(), "600000".into()),
            "trigger_fallback" => c.trigger_fallback(id, 0),
            other => panic!("unknown method {other}"),
        }
    }

    #[test]
    fn lf010_role_method_state_matrix() {
        let (mut ok_cells, mut rej_cells) = (0u32, 0u32);
        for st in MX_STATES {
            for method in MX_METHODS {
                for caller in MX_CALLERS {
                    let (mut c, id, now) = mx_build(st);
                    let want = mx_expected(st, method, caller);
                    let before =
                        near_sdk::borsh::to_vec(c.agreements.get(&id.0).expect("a")).expect("b");
                    let root = (
                        c.custody_total,
                        c.last_withdrawal_id,
                        c.open_withdrawals,
                        c.next_agreement_id,
                    );
                    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        mx_call(&mut c, id, method, caller, now)
                    }));
                    let got: Option<String> = match &r {
                        Ok(()) => None,
                        Err(p) => {
                            let codes = err_codes(&panic_message_ref(p));
                            assert_eq!(codes.len(), 1, "{st:?} {method} {caller}: codes {codes:?}");
                            Some(codes[0].clone())
                        }
                    };
                    println!(
                        "MATRIX {st:?},{method},{caller},{},{}",
                        want.unwrap_or("OK"),
                        got.as_deref().unwrap_or("OK")
                    );
                    assert_eq!(got.as_deref(), want, "{st:?} {method} {caller}");
                    if want.is_some() {
                        rej_cells += 1;
                        let after = near_sdk::borsh::to_vec(c.agreements.get(&id.0).expect("a"))
                            .expect("b");
                        assert_eq!(
                            after, before,
                            "{st:?} {method} {caller}: rejected but agreement changed"
                        );
                        assert_eq!(
                            (
                                c.custody_total,
                                c.last_withdrawal_id,
                                c.open_withdrawals,
                                c.next_agreement_id
                            ),
                            root,
                            "{st:?} {method} {caller}: rejected but root changed"
                        );
                    } else {
                        ok_cells += 1;
                        // Every success keeps Rule B and conservation.
                        assert_eq!(
                            c.custody_total,
                            unpaid_buckets(&c),
                            "{st:?} {method} {caller}: E != unpaid"
                        );
                    }
                    drop(c);
                }
            }
        }
        println!(
            "MATRIX SUMMARY cells={} ok={ok_cells} rejected={rej_cells}",
            ok_cells + rej_cells
        );
        assert_eq!(ok_cells + rej_cells, 13 * 10 * 7);
    }

    /// State-isolated authorization (founder 2026-11-05): for each method, the
    /// state is prepared so that the call *can* succeed; then every caller is
    /// tried. Exactly the authorized callers succeed; everyone else fails with
    /// an authorization/role code — never with a state code that could mask
    /// a missing permission check.
    #[test]
    fn lf010_authorization_isolated() {
        // (method, ready state, proposal by, authorized callers, role code for
        // an otherwise-authorized role in the wrong capacity)
        type Case = (
            &'static str,
            MxState,
            Option<&'static str>,
            &'static [&'static str],
            &'static [(&'static str, &'static str)],
        );
        let anyone: &'static [&'static str] = &MX_CALLERS;
        let cases: [Case; 12] = [
            ("submit_delivery", MxState::Funded, None, &[S_], &[]),
            ("accept_line", MxState::Submitted, None, &[B_], &[]),
            ("open_dispute", MxState::Submitted, None, &[B_], &[]),
            ("advance_case", MxState::FundedLate, None, anyone, &[]),
            ("propose_split", MxState::Negotiation, None, &[B_, S_], &[]),
            (
                "accept_split",
                MxState::Negotiation,
                Some(B_),
                &[S_],
                &[(B_, "ERR_LINE:OwnProposal")],
            ),
            (
                "accept_split",
                MxState::Negotiation,
                Some(S_),
                &[B_],
                &[(S_, "ERR_LINE:OwnProposal")],
            ),
            (
                "submit_ruling",
                MxState::Primary,
                None,
                &[PRIM],
                &[(BACK, "ERR_LINE:NotRulingWindow")],
            ),
            (
                "submit_ruling",
                MxState::Backup,
                None,
                &[BACK],
                &[(PRIM, "ERR_LINE:NotRulingWindow")],
            ),
            ("trigger_fallback", MxState::Fallback, None, anyone, &[]),
            ("withdraw_BUYER", MxState::Allocated, None, &[B_], &[]),
            ("withdraw_SUPPLIER", MxState::Allocated, None, &[S_], &[]),
        ];
        let mut cells = 0;
        for (method, st, proposer, allowed, role_codes) in cases {
            for caller in MX_CALLERS {
                let (mut c, id, now) = mx_build(st);
                if let Some(p) = proposer {
                    let (b, s) = (400_000u128, 600_000u128);
                    set_ctx(p, now);
                    let _ = c.propose_split(id, 0, b.to_string(), s.to_string());
                }
                let before =
                    near_sdk::borsh::to_vec(c.agreements.get(&id.0).expect("a")).expect("b");
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    mx_call(&mut c, id, method, caller, now)
                }));
                let got = r.as_ref().err().map(|p| err_codes(&panic_message_ref(p)));
                let want: Option<&str> = if allowed.contains(&caller) {
                    None
                } else if let Some((_, code)) = role_codes.iter().find(|(who, _)| *who == caller) {
                    Some(code)
                } else {
                    Some("ERR_LINE:NotAuthorized")
                };
                println!(
                    "AUTHZ {method},{st:?},{},{caller},{},{:?}",
                    proposer.unwrap_or("-"),
                    want.unwrap_or("OK"),
                    got
                );
                match want {
                    None => assert!(
                        got.is_none(),
                        "{method} {st:?}: authorized {caller} rejected: {got:?}"
                    ),
                    Some(code) => {
                        assert_eq!(
                            got,
                            Some(vec![code.to_string()]),
                            "{method} {st:?}: {caller}"
                        );
                        let after = near_sdk::borsh::to_vec(c.agreements.get(&id.0).expect("a"))
                            .expect("b");
                        assert_eq!(
                            after, before,
                            "{method} {st:?}: rejected {caller} changed state"
                        );
                    }
                }
                cells += 1;
                drop(c);
            }
        }
        assert_eq!(cells, 12 * 7);
        println!("AUTHZ SUMMARY cells={cells}");
    }

    // ---- F3 funding guard at the contract edge (NEP-141 refunds) ---------------

    #[test]
    fn f3_late_deposit_full_refund_zero_liability() {
        // terms_json(): delivery NOW + 96 h, grace 0, review 72 h → limit NOW + 24 h
        // (funding deadline NOW + 48 h is later, so F3 binds first).
        let limit = NOW + 96 * HOUR - 72 * HOUR;
        let mut c = init(5);
        let (id, h) = agreed(&mut c, 1, 3);
        let created = c.next_agreement_id;
        for (line, now) in [(0u32, limit + 1), (1, NOW + 48 * HOUR - 1)] {
            assert_refund(
                &mut c,
                id,
                FT,
                "buyer.test.near",
                P,
                &msg(id, line, &h),
                now,
                "DeliveryTimeTooShort",
            );
        }
        assert_eq!(c.custody_total, 0, "no liability created");
        assert_eq!(
            c.next_agreement_id, created,
            "no agreement capacity consumed"
        );
        assert_eq!(
            c.get_agreement(id).expect("a").status,
            "AGREED",
            "rejected deposits do not activate the agreement"
        );
        // Exactly at the limit and one ns before: credited.
        assert_eq!(
            deposit(&mut c, FT, "buyer.test.near", P, &msg(id, 0, &h), limit),
            0
        );
        assert_eq!(
            deposit(&mut c, FT, "buyer.test.near", P, &msg(id, 1, &h), limit - 1),
            0
        );
        assert_eq!(c.custody_total, 2 * P);
        // Line 2 still refused after the limit; credited lines unaffected.
        assert_refund(
            &mut c,
            id,
            FT,
            "buyer.test.near",
            P,
            &msg(id, 2, &h),
            limit + 1,
            "DeliveryTimeTooShort",
        );
        assert_eq!(c.custody_total, 2 * P);
        assert_eq!(c.custody_total, unpaid_buckets(&c));
    }

    #[test]
    fn f3_review_window_cannot_be_zero_or_below_minimum() {
        // D is never 0: terms validation keeps every window in [60 s, 30 d].
        for bad in ["0", "59999999999"] {
            let mut c = init(5);
            set_ctx("buyer.test.near", NOW);
            let mut t = terms_json(7, 1);
            t.review_window_ns = bad.into();
            let r =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.create_agreement(t)));
            let m = panic_message(r.expect_err("must be rejected"));
            assert_eq!(
                err_codes(&m),
                vec!["ERR_TERMS_INVALID:WindowOutOfRange".to_string()],
                "{bad}: {m}"
            );
            drop(c);
            fresh_chain();
        }
    }

    #[test]
    fn f3_later_lifecycle_unchanged() {
        // A line funded on time still has the unchanged submission cutoff,
        // NON_DELIVERY T0 and dispute windows.
        let mut c = init(5);
        let (id, _) = funded(&mut c, 1, 1);
        let l = line_view(&c, id, 0);
        assert_eq!(l.status, "FUNDED");
        set_ctx("stranger.test.near", NOW + 96 * HOUR);
        assert_eq!(
            line_view(&c, id, 0).non_delivery_t0_ns,
            Some(U64(NOW + 96 * HOUR))
        );
    }
}
