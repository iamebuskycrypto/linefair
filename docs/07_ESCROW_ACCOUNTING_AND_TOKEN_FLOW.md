# Escrow accounting and token transfer specification
**All figures are token base units, not dollars or floating point.**

## Single funded-line invariant
`funded_principal = locked_unallocated + buyer_claimable + supplier_claimable + buyer_pending + supplier_pending + buyer_paid_confirmed + supplier_paid_confirmed`

No funds are minted by dispute decisions. No claim can be allocated twice. `initial_principal` remains fixed after an exact valid FT deposit. Onchain token balance at intermediate asynchronous receipts is not identical to ledger pending totals; reconcile in quiescent state, accounting for unsolicited/unrecognized FT transfers separately.

## Allocation formula
For principal P and supplier bps S: `supplier = floor(P*S/10000)` with checked wider intermediate arithmetic; `buyer = P - supplier`. For final mutually agreed amount, buyer + supplier == P in exact base units. Example P=1,001, S=3,333 -> supplier=333, buyer=668. Document who receives rounding remainder (buyer in bps-based fallback). For mutual negotiated allocations use exact integer amounts with conservation check.

## Recognized deposit flow
1. Ensure escrow and buyer FT storage accounts are registered as required by verified token.
2. Buyer calls official token `ft_transfer_call(receiver_id=escrow, amount=exact line P, msg=canonical {agreement_id,line_id,version})` and approves wallet signing.
3. Token invokes escrow `ft_on_transfer(sender_id, amount, msg)`; verify `predecessor_account_id` is approved FT contract and `sender_id` is buyer; line state FUNDED-eligible and amount exact.
4. Valid call stores one funding credit and returns `U128(0)`. Invalid call must return full unused amount, without a ledger credit; verify FT resolver refunds in integration test.
5. If token deviates from standard or callback/resolver fails, stop and resolve with sandbox tests; no optimistic 'secured' UI claims.
6. Direct FT transfers without message are not credited to an agreement. Record any unauthorized onchain token balance surplus for incident analysis; do not permit admin sweeping.

## Authorized settlement
`locked(P) -> claimable_supplier(P)` on accepted line; or `locked(P) -> claimable_buyer(B)+claimable_supplier(S)` on dispute, where B+S=P. No outgoing token call occurs at allocation time.

## Withdrawal state diagram
`claimable(amount) -> pending(id, amount) -> paid_confirmed(amount)` on authenticated successful private callback; or `pending -> claimable` on authenticated definite failure. If callback inconclusive/missing: stay **pending frozen**, never time-reset to claimable until receipt and token reconciliation establishes final outcome. MVP rule (OQ-01 decision 2026-10-27, `27`): there is no onchain reconciliation transition. Inconclusive stays PENDING, and observation is read-only. One pending withdrawal per beneficiary claim; unique monotonic withdrawal ID; target immutable beneficiary account, not arbitrary parameter.

## Async NEAR gotchas
- Cross-contract execution is asynchronous and does **not** revert the initiating call on external failure.
- Promise callbacks must be private / self-authorized. Verify result type and withdrawal ID, reject forged/replayed callbacks.
- Account may need FT `storage_deposit` / NEP-145 registration before receiving payout.
- `ft_transfer` typically requires 1 yoctoNEAR attached plus gas; reserve separately. Never consume buyer escrow FT principal for NEAR gas.
- A backend transaction timeout is NOT conclusive token-transfer failure.
- Verify actual FT implementation and pinned SDK before coding callback signatures or gas parameters.

## Instrumented audit fields
Deposit: token_tx_hash, sender, line_id, amount, FT contract, callback/receipt IDs; allocation: mode, authorizer(s), nonce, timestamp, exact buyer/supplier amounts; withdrawal: id, beneficiary, amount, token target, pending_at, resolved_at, promise result, explorer receipts. Public logs avoid PII/evidence plaintext.

## Property tests
Randomize initial P, fallback bps, acceptance/dispute ordering, two beneficiary withdrawal orders, callback success/failure and replay, split race, overflows, deadline boundaries. Invariant must hold after **every** state mutation.

## ~~PROPOSED~~ → APPROVED and IMPLEMENTED (see next section): aggregate amount bounds (S6 finding, founder Phase B)
**Finding.** Validation bounds each line's principal (`0 < P ≤ u128::MAX`) but not the sum across lines. Production stays correct: each line is conserved on its own, and cross-line totals are checked (`ledger_total()` returns `None`, never wraps).

**Funding concurrency (from the specs).** Each line is funded by its own `ft_transfer_call` with exactly P (§Recognized deposit flow, step 2). Nothing serializes funding or releases one line before the next, so the funded, unpaid lines of **all** agreements are held concurrently. `27` §R-2 already defines **E** = Σ (locked + claimable + pending) over all lines as the contract's unpaid custody for `custody_summary()`.

**Which bound is the safety rule.** A per-agreement bound is necessary but not sufficient: 25 agreements can each sum to ≤ u128::MAX and still exceed it together. The real custody invariant is contract-wide: **E ≤ escrow FT balance ≤ u128::MAX**. A standard NEP-141 token already caps the escrow balance at u128 (its `internal_deposit` uses `checked_add`), so E cannot overflow while the ledger is correct. An explicit checked E makes that defence enforced rather than assumed, and makes `custody_summary()` exact.

**Proposed rules (both or either; founder decides):**
| Rule | Exact statement | Compatibility |
|---|---|---|
| A — terms validation | `lines.iter().try_fold(0u128, \|acc, l\| acc.checked_add(l.principal))` must be `Some(_)`; otherwise `TermsError::PrincipalSumOverflow` (checked after the per-line rules, before the deadline sums) | Encoding v1, Borsh layout, hash, `schema_version` and JSON schema are **unchanged** (cross-field rule, like bps). Narrows valid terms only to those that could never be fully funded. No agreements exist on chain. Shared vectors gain one malformed case (TS must implement it). S6 extreme generator must keep the sum within u128 |
| B — contract-wide custody counter | Contract state gains `custody_total: u128` = E. `ft_on_transfer` computes `custody_total.checked_add(P)`; on `None` it refunds the full amount (`LF_FT_REFUND:CustodyOverflow`) and writes nothing. The counter decreases only on authenticated PAID (LF-009); allocation and definite-failure restore leave it unchanged | Adds 16 B of root state (not in terms, not hashed). New refund reason. Unreachable with a standard token (defence in depth). Fits `custody_summary()` (LF-009) |

**Recommendation:** adopt **A** now (cheap, makes per-agreement totals total functions) and **B** with LF-005/LF-009 (the actual concurrent-liability invariant). No stricter business cap is needed for safety. A demo-size cap would be a product decision, not a safety rule.

**Tests on approval.** A: lines (MAX−1, 1) pass; (MAX, 1) → `PrincipalSumOverflow`; (MAX/3 + 1) × 3 → overflow; one line MAX passes; exact-error vector case; S6 property "validate ok ⇒ Σ fits". B: unit test with `custody_total` near MAX → deposit refunded and state byte-identical; property E == Σ(locked + claimable + pending) after every step; E unchanged by allocation and failure restore; E decreases by exactly A on PAID; sandbox reconciliation `ft_balance_of(escrow) ≥ E`.

## APPROVED and IMPLEMENTED (2026-11-01, hardening `7e8b1ae`): Rules A and B
**Rule A, terms validation.** After every per-line rule, `Σ principal` (checked) must fit u128, else `TermsError::PrincipalSumOverflow`. AgreementTermsV1 encoding, field order, `schema_version` 1, domain and SHA-256 are unchanged (golden digest `9257a5bf…a33c`). Shared vectors gained one malformed case (`principal sum overflow` → `validate:PrincipalSumOverflow`); the TypeScript encoder must reproduce it.

**Rule B, outstanding customer token liabilities E** (root state `custody_total: u128`, +16 B; view `outstanding_liabilities()`).
E = Σ over all agreements and lines of (locked + buyer_claimable + supplier_claimable + buyer_pending + supplier_pending). Paid is excluded. E is **not** a lifetime deposit counter.
| Event | Effect on E | Status |
|---|---|---|
| Credited deposit (exact valid `ft_on_transfer`) | `checked_add(P)` before any write; `None` → full refund `LF_FT_REFUND:CustodyOverflow`, nothing written | implemented + tested |
| Any refunded / invalid deposit | unchanged | implemented + tested (every refund test asserts it) |
| Inflow not credited as funding (plain `ft_transfer`, refunds in flight, unknown sources) | unchanged; shows up as surplus `O − E` in the token balance O | sandbox-tested |
| Allocation (accept / finalize), withdrawal start (claimable → pending), definite failure (pending → claimable) | unchanged (moves within E) | rule; asserted again when LF-006/LF-009 add those entry points |
| Pending withdrawal with no callback (inconclusive) | unchanged: still a liability, **never** treated as paid | rule (`27` item 5) |
| Authenticated confirmed payout (PAID) | `checked_sub(amount)` in the same private callback that marks PAID. If it would underflow, the callback must not mark PAID: the withdrawal stays PENDING and an incident code is logged | LF-009 |
| Aggregate token balance O | read-only observation offchain. O ≥ E is expected when quiescent; O > E = uncredited surplus (never credited, never swept); O < E = shortfall incident. **Never** used to infer or change any withdrawal outcome (`27` R-2) | rule |

With a standard NEP-141 token, E ≤ O ≤ total supply ≤ u128::MAX, so `CustodyOverflow` is unreachable on chain (defence in depth). It is proven by unit test B2, and the sandbox shows E reaching exactly u128::MAX with a u128::MAX-supply token.
