# Exact state machines & authorization — governing P0
## Agreement state
`PROPOSED` -> `AGREED` after exact `terms_hash` approved by buyer+supplier, primary+backup acknowledge role. `AGREED` -> `ACTIVE` when ≥1 line validly funded. `ACTIVE` -> `CLOSED` after each line is unfunded-expired or all money settled and confirmed paid, no pending withdrawals. Proposal expires if acceptance cutoff passes. Never mutate agreed financial terms in place.

## Line money and work state
- `UNFUNDED` → `FUNDED` on **one** exact valid `ft_on_transfer` from allowlisted token for specified line.
- `FUNDED` → `SUBMITTED` on supplier-only evidence commitment by delivery deadline.
- `SUBMITTED` → `ALLOCATED` by buyer acceptance within review window (100% supplier claim).
- `SUBMITTED` → `DISPUTED` by buyer before review deadline, or `NO_RESPONSE` after timeout.
- `FUNDED` → `DISPUTED_NON_DELIVERY` after missed delivery cutoff; supplier retains right to submit evidence in adjudication.
- `DISPUTED` → `ALLOCATED` by mutual split; primary/backup adjudication within exact windows; or preapproved fallback after longstop.
- `ALLOCATED` is **decision state**, not payout state. Buyer/supplier claims independently `CLAIMABLE -> WITHDRAW_PENDING -> PAID_CONFIRMED`; definite failed transfer restores claimable.
- Never add a global PAID Boolean: one party's withdrawal may finish while other's is pending.

## Authorization table
| Action | Allowed signer | Additional check |
|---|---|---|
| create agreement | **allowlisted creator who is the buyer** (LF-010A, `28`; was: creator (buyer intended)) | caller ∈ immutable `creator_allowlist` checked first; then all fields and 4 distinct account IDs validated |
| accept exact terms | specified buyer/supplier | exact onchain-computed terms hash |
| accept appointment | primary or backup | each accepts immutable terms and role |
| fund | buyer via FT contract | predecessor exact approved token, sender buyer, exact amount, one-time; F3: `now + review_window ≤ delivery_deadline + grace` (grace counts as delivery time), else full refund |
| submit delivery | supplier | funded line, before delivery deadline |
| accept | buyer | submitted, review window active, not disputed/final |
| dispute review | buyer | submitted, review window active |
| propose split | buyer or supplier | amounts sum P, nonce, fixed line/state |
| accept split | counterparty | exact proposal ID, mutually approved, no finalized allocation |
| primary rule | primary arbiter | inside primary interval, disputed and not finalized |
| backup rule | backup arbiter | inside backup interval, disputed and not finalized |
| trigger fallback | anyone | after longstop; uses immutable bps, no discretionary allocation |
| advance phase | anyone | derive chain time; never change recorded start/deadline |
| withdraw own claim | buyer/supplier | only own beneficiary account; single pending per claim |
| private callback | escrow itself | exact withdrawal ID and promise result |
| admin reallocate escrow | **nobody** | not exposed |

## State safety
Final allocation is single-writer even if settlement/arbitration/fallback race: compare line final flag and record proposal/ruling nonce atomically; later attempts fail. Callers cannot move deadline by late `advance_case`: phase is derived from original T0. Distinct accounts required; no self-arbitration in MVP.

## Input conditions
Max 3 lines, positive principal integer, 0–10,000 bps, buyer+supplier fallback sum=10,000 each line, bounded hashes and text, monotonic timestamps, immutable token/account identities. Use `checked_add/sub/mul` and safe floor/remainder bps logic. Encode terms deterministically; recompute their digest inside contract.

## APPROVED (founder, 2026-11-01) and IMPLEMENTED (LF-006b `323fd57`; merged into `main` by fast-forward to `cd6afa7` on 2026-11-03): `advance_case`
_Status update 2026-11-01T18:05:49Z. The proposal text below is kept as reviewed; see §Implementation record at the end of this section._
Source authority: this file §Authorization table "advance phase | anyone | derive chain time; never change recorded start/deadline"; `03` FD-07 (APPROVED: review expiry moves the line into the agreed dispute procedure, NO_RESPONSE, T0 = review deadline); `03` OQ-07 (permissionless `advance_case`, T0 fixed; default adopted); `08` §T0 derivation and §Deadline rules v1. This is the approved recourse for the **supplier** when the buyer is silent, and for the **buyer** when the supplier never delivers. It is not a new dispute right.

**Method.** `advance_case(agreement_id: U64, line_id: u32)`. Non-payable. **Caller: anyone** (buyer, supplier, arbitrators, any third party); the outcome does not depend on who calls. No amount, recipient, reason or time parameter.
| From | Condition (chain time, half-open, checked u64) | To | Stored | Funds / E |
|---|---|---|---|---|
| SUBMITTED | `now ≥ submitted_at + review_window` (exactly at equality, per `08`) | DISPUTED | `dispute_reason = NO_RESPONSE`, `dispute_t0 = submitted_at + review_window` (**not** `now`) | unchanged (locked), E unchanged |
| FUNDED (never submitted) | `now ≥ delivery_deadline + grace` | DISPUTED | `dispute_reason = NON_DELIVERY`, `dispute_t0 = delivery_deadline + grace` | unchanged, E unchanged |
| any other state, or not yet eligible | — | rejected (`ERR_LINE:NotEligible` / `WrongState`); the call reverts | nothing | nothing |
These are the read-only `no_response_t0_ns` / `non_delivery_t0_ns` eligibility values that LF-006 already exposes in `get_agreement`.

**Rules.** One transition per line (a second call is rejected). T0 is fixed by stored data: calling 10 days late gives the same T0 (`08` cases). Order with the buyer's window: until `submitted_at + review − 1` only the buyer may accept or dispute; from `submitted_at + review` only `advance_case` is eligible. The windows do not overlap, so there is no race. No ledger move, no allocation, no token call. Storage delta 0 (pre-allocated fields).

**Security consequences.**
- Permissionless is safe because the result is fully determined by stored terms and chain time. A caller cannot choose the reason, T0, an amount or a recipient. Front-running changes nothing, and each caller pays its own gas.
- It prevents indefinite lock-up through counterparty silence: a silent buyer cannot hold a delivered line forever, and a no-show supplier cannot hold a funded line forever. It **cannot** release funds: allocation still requires LF-007 (mutual split) or LF-008 (arbitrators / fallback).
- Fixed T0 is a deliberate trade-off. If nobody calls for a long time, the LF-008 phase windows measured from T0 (negotiation 48 h, primary 72 h, backup 72 h by default) may already have elapsed when the case is advanced, so authority moves straight to backup or the permissionless fallback. "No manager can reset T0" (`08`). The UI must surface eligibility promptly (LF-013).
- NON_DELIVERY: the supplier keeps the right to present evidence to the adjudicator offchain (LF-012). The onchain submission window stays closed.
- UNFUNDED lines past the funding deadline are not covered (nothing is at stake). Their expiry / CLOSED handling is separate and still open.

**Dependency.** On its own, `advance_case` only moves a line into DISPUTED; without LF-007/LF-008 a DISPUTED line has no finalization path and its funds stay locked (safe, not live). LF-008's phase logic consumes the T0 values this method fixes. Proposal: implement `advance_case` as the **first slice of LF-008**, or as LF-006b immediately before LF-007, and in any case before any testnet demo that exercises silence or non-delivery (LF-014). Founder sign-off needed on: permissionless caller, the two transitions, T0 rule, rejection of all other states, error codes.

**Tests on approval.** For both NO_RESPONSE and NON_DELIVERY: eligibility at T0 − 1 (rejected), T0 and T0 + 1 (accepted) and a late call 10 days after T0 (stored T0 unchanged); every caller kind allowed; every other state rejected; replay rejected; buyer accept/dispute at review end − 1 still wins, and `advance_case` at review end succeeds; three-line isolation; ledger, E and storage unchanged; sandbox on genuinely funded lines with chain-time `fast_forward`.

**Implementation record (LF-006b `323fd57`, 2026-11-01T18:05:49Z).** All tests above exist and pass (214 [corrected 2026-11-03T02:27:13Z from 216, arithmetic error] total, also from a clean checkout; `evidence/lf006b/FINAL-VERIFICATION.md`). Gas 1.93 Tgas (NO_RESPONSE) / 1.89 Tgas (NON_DELIVERY), storage delta 0. **Error-code deviation:** premature → `ERR_LINE:NotEligible`; any state other than SUBMITTED/FUNDED, including replay → `ERR_LINE:NotAdvanceable` (new code) instead of `WrongState`. **APPROVED as canonical (founder, 2026-11-03):** `ERR_LINE:NotAdvanceable` = wrong state for `advance_case`; `ERR_LINE:NotEligible` = premature. T0 stays fixed at the review / delivery + grace deadline and is never reset to call time. Attached deposits are rejected (non-payable).

## IMPLEMENTED (LF-007 `8957408`; merged into `main` by fast-forward to `cd6afa7` on 2026-11-03; founder authorization 2026-11-03): mutual settlement
Spec and named tests written before code: `evidence/lf007/lf007-spec-and-test-plan.md`. Implements the §Authorization rows *propose split* and *accept split* and the `08` rule that mutual settlement is open in every phase `[T0, ∞)` until a final allocation exists.
| Method | Caller | Checks (any failure reverts; agreement and E byte-identical) | Effect |
|---|---|---|---|
| `propose_split(agreement_id: U64, line_id: u32, buyer_amount: String, supplier_amount: String) -> U64` | buyer or supplier | line DISPUTED (ALLOCATED → `AlreadyFinalized`, else `WrongState`); `now ≥ dispute_t0` (`BeforeWindowStart`); canonical decimals (`ERR_AMOUNT_FORMAT:*`); `checked_add(B, S) == P` (`AllocationSumMismatch`); nonce fits u64 (`ProposalNonceOverflow`) | the line's single active proposal `{id = previous id + 1, proposer, B, S, created_at}`; supersedes any earlier proposal; no ledger move |
| `accept_split(agreement_id: U64, line_id: u32, proposal_id: String, buyer_amount: String, supplier_amount: String)` | counterparty of the proposer | DISPUTED / not final as above; OPEN proposal (`NoActiveProposal`); exact id (`StaleProposal`); exact amounts (`ProposalMismatch`); caller ≠ proposer (`OwnProposal`) | single-writer allocation `MUTUAL`, `source_id = proposal_id`; locked → buyer/supplier claimable; proposal ACCEPTED; line ALLOCATED and immutable |
Arbitrators, the escrow and strangers get `ERR_LINE:NotAuthorized`. **Check order (clarified 2026-11-03, no behaviour change):** the contract edge parses `buyer_amount`, `supplier_amount` and `proposal_id` before it looks up the agreement or line, so a malformed value returns `ERR_AMOUNT_FORMAT:*` even for an unknown agreement, a wrong-state line or an unauthorized caller; the remaining checks run in the order listed. The same applies to `submit_ruling` (LF-008). Both methods are non-payable, make no token call and emit no logs. `custody_total` (E) is unchanged (locked and claimable are both inside E); withdrawal slots are untouched (they exist only after ALLOCATED). The generic pure `finalize_dispute` now **rejects `Mutual`** (`InvalidDecisionMode`), so a mutual allocation can only come from an accepted proposal; invariant: `allocation.mode == MUTUAL ⇔ proposal ACCEPTED ∧ source_id = proposal id ∧ amounts equal`. `get_agreement` lines expose `allocation_*` and `proposal_*` fields. Layout: `SplitProposalV1` 50 B per line (`LineStateV1` 309 → 359 B).

**APPROVED (founder, 2026-11-03):** one active proposal per line; monotonic proposal id; replacement of an open proposal by either authorized party; acceptance must match the exact active id and both amounts; mutual settlement available until a final allocation exists; a final allocation is never replaced or applied twice; terms hash and `custody_total` accounting unchanged; no outgoing token transfers in LF-007. Original engineering-default text, kept: (1) one active proposal per line, superseded by any new proposal from either party; no cancel method and no proposal expiry (none is specified; `08` keeps mutual settlement open in every phase); (2) contract-assigned per-line nonce as proposal id, and acceptance must repeat id **and** both amounts (FR-08); (3) amounts as strict decimal strings because near-sdk `U128` JSON accepts `+1` and `007`.

## IMPLEMENTED (LF-008 `193ac66`; merged into `main` by fast-forward to `b28d33b` on 2026-11-04; founder authorization 2026-11-03): timed arbitration and fallback
Spec, phase table and named tests written before code: `evidence/lf008/lf008-spec-and-test-plan.md`. Implements the §Authorization rows *primary rule*, *backup rule* and *trigger fallback* with the `08` phase algorithm (half-open, fixed T0, checked u64).
| Method | Caller | Checks (any failure reverts; agreement and E byte-identical) | Effect |
|---|---|---|---|
| `submit_ruling(agreement_id: U64, line_id: u32, buyer_amount: String, supplier_amount: String)` | `primary_arbitrator_id` in `[T0+N, T0+N+A)`; `backup_arbitrator_id` in `[T0+N+A, T0+N+A+B)` | DISPUTED (ALLOCATED → `AlreadyFinalized`, else `WrongState`); any other caller → `NotAuthorized`; wrong phase for the caller's role → `NotRulingWindow`; strict decimals (`ERR_AMOUNT_FORMAT:*`); `checked_add(B, S) == P` (`AllocationSumMismatch`) | single-writer `PRIMARY_RULING` / `BACKUP_RULING`; locked → buyer/supplier claimable; ALLOCATED, immutable |
| `trigger_fallback(agreement_id: U64, line_id: u32)` | anyone | DISPUTED (ALLOCATED → `AlreadyFinalized`); phase FALLBACK (`now ≥ T0+N+A+B`) else `FallbackNotEligible` | single-writer `FALLBACK` with the hashed bps: supplier = ⌊P·S/10 000⌋, buyer = P − supplier; no amount parameters |
Mutual settlement (LF-007) stays available in every phase. The generic pure finalization is private to the line module, so every allocation passes an authority + time check (`BUYER_ACCEPTED` via `accept_line`, `MUTUAL` via `accept_split`, rulings via `submit_ruling`, `FALLBACK` via `trigger_fallback`). Arbitrators allocate only between the immutable buyer and supplier of the disputed line. No token call, no logs; `custody_total` unchanged (decremented only by LF-009 on authenticated PAID). `get_agreement` lines add read-only `dispute_phase` (`NONE` / `NEGOTIATION` / `PRIMARY` / `BACKUP` / `FALLBACK`) and `primary_start_ns`, `backup_start_ns`, `fallback_start_ns` for DISPUTED lines. Stored layout unchanged (no new fields).

**LF-008 view note (clarified 2026-11-04, no behaviour change):** the internal phase enum also has `BEFORE_T0`, which is unreachable for a stored DISPUTED line (T0 ≤ now when the dispute starts); if a phase sum ever overflowed (prevented by `PhaseScheduleOverflow` at creation), `get_agreement` reports `dispute_phase = NONE` with no start times for that line. Clients treat both as incidents.

## IMPLEMENTED (LF-009 `ad7bb99`; merged into `main` by fast-forward to `b66913f` on 2026-11-05; founder authorization 2026-11-04): secure NEP-141 withdrawals
Frozen spec and named tests before code: `evidence/lf009/lf009-spec-and-test-plan.md` (`0a9e9f5`). Implements *withdraw own claim* and *private callback* per `27` R-1.
| Method | Caller | Checks (in this order; any failure reverts, nothing reserved) | Effect |
|---|---|---|---|
| `withdraw(agreement_id: U64, line_id: u32, beneficiary: String) -> Promise` (the only payable method) | the immutable `buyer_id` for `BUYER`, `supplier_id` for `SUPPLIER` | exactly 1 yoctoNEAR (`ERR_WITHDRAW:DepositMustBeOneYocto`); prepaid gas ≥ 55 Tgas = `GAS_FT_TRANSFER` 10 + `GAS_WITHDRAW_CALLBACK` 15 + `GAS_WITHDRAW_SELF` 30 (`ERR_WITHDRAW:InsufficientGas`); `BUYER`/`SUPPLIER` (`ERR_WITHDRAW:BadBeneficiary`); id / count fit u64 (`ERR_WITHDRAW:IdOverflow`, `OpenCountOverflow`); agreement exists (`ERR_AGREEMENT_NOT_FOUND`); caller is that beneficiary (`ERR_LINE:NotAuthorized`); line exists (`ERR_LINE:LineNotFound`), ALLOCATED (`ERR_LINE:WrongState`), slot not PENDING (`ERR_LINE:WithdrawalAlreadyPending`), claimable > 0 (`ERR_LINE:NothingToWithdraw`) | whole claim claimable → pending (E unchanged), contract-wide id + 1, `open_withdrawals` + 1; `ft_transfer(recipient = immutable account, amount, memo None)` on the allowlisted token with the forwarded 1 yocto and 10 Tgas, then `on_withdrawal_transfer` with 15 Tgas static and unused-gas weight 0. The transaction result is the callback result `{withdrawal_id, outcome}` |
| `on_withdrawal_transfer(agreement_id, line_id, beneficiary, withdrawal_id, epoch)` | the escrow only (`#[private]` on the WASM entry **and** an explicit in-method check `ERR_WITHDRAW:CallbackNotPrivate`) | exactly one promise result; slot PENDING with the same id and epoch — anything else returns `IGNORED` and changes nothing (`LF_WITHDRAWAL_IGNORED:<code>:<id>`) | `Failed` → `FAILED`, pending → claimable once, E unchanged; successful receipt → `PAID`, pending → paid and E −= amount via `checked_sub` (underflow: stays PENDING, `LF_INCIDENT:CustodyUnderflow:<id>`); an unknown `PromiseError` variant → stays PENDING (`LF_WITHDRAWAL_INCONCLUSIVE:<id>`). Never panics for the genuine callback |
| `get_withdrawal(agreement_id, line_id, beneficiary)`, `custody_summary()` | views | — | slot record incl. immutable recipient and FT id; E, open withdrawals, last id |
No method can change a PENDING withdrawal except the authenticated callback: no retry, no timer, no reconciliation, no admin path. Gas measured (`evidence/lf009/FINAL-VERIFICATION.md`): withdraw ≈ 2.43, ft_transfer ≈ 1.68, callback ≈ 1.69 Tgas burnt (≥ 5× margin on each allotment); storage delta 0.

**Callback total-ness (AI review F8, clarified 2026-11-05, no behaviour change):** the `Err(_)` branch for an unknown `PromiseError` is unreachable with near-sdk 5.29.1 (the SDK aborts on any status other than success/failure). In that hypothetical case the callback aborts and the withdrawal stays PENDING (the safe inconclusive outcome); "never panics" means no panic path in the contract's own logic for the genuine callback.
