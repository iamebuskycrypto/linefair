# Withdrawal recovery and reconciliation design (OQ-01)
**Status: DECIDED by founder 2026-10-27.** R-1 approved · R-2 conditionally approved (observation only) · R-3 deferred. The binding MVP rules are in §"Founder decision and MVP design". The sections after it keep the original analysis as the rationale record. **The unresolved recovery gap is a blocker for production and any real-money use (G8)**, but not for the controlled testnet demonstration.

## Founder decision and MVP design (binding)
1. **R-1 approved.** Implement it: claimable is reserved into pending before the transfer; each withdrawal has a unique monotonic id and epoch; at most one open withdrawal per beneficiary per line; the gas floor is checked up front; the private callback is authenticated (`predecessor == current_account`, matching id/epoch, `PENDING` state) and handles every `PromiseResult` without panicking; replayed or duplicate callbacks have no effect.
2. Only the authenticated callback changes withdrawal state: success → `PAID`; definite failure → `CLAIMABLE`, restored exactly once.
3. **R-2 conditional: observation only.** No method may mark a withdrawal `PAID` (or `CLAIMABLE`) from aggregate token balances. The contract has no way to verify transaction-specific evidence (a receipt proof), so **the MVP contains no reconciliation state transition at all**. Observation happens offchain and read-only: the views `get_withdrawal(id)` and `custody_summary()` (unpaid ledger total E and the open withdrawals) plus the FT `ft_balance_of`. An operator report may compare them and cite explorer receipts, but it changes nothing onchain. This also removes the reconciliation lock, deposit refusal and lock expiry from the original R-2 proposal (less code, less risk).
4. **R-3 deferred.** No arbitrator-attested restoration in the hackathon MVP.
5. **Inconclusive withdrawal** (callback did not complete): the record stays `PENDING` with full accounting (id, beneficiary, amount, created_at, epoch). Its amount remains counted in the line invariant as `pending`. No retry, no new withdrawal of that amount, no timer-based change. The UI shows it as "Processing — outcome unconfirmed" with an explicit limitation notice and a link to the transfer receipt if known, never "Paid" and never "Ready to withdraw".
6. Required tests: success (T037), definite failure → restore once (T036/T038), duplicate/concurrent withdrawal prevention (T042), forged and replayed callbacks (T039), a forced inconclusive callback that stays frozen with no state-changing path (T040, T067), conservation after every step.
7. **Forcing the inconclusive case in tests:** a cargo feature `test-starve-callback` (never enabled in release builds; the build script for the deploy artifact asserts it is off) sets the callback gas below need. The test proves the record stays `PENDING` and every withdrawal/claim method rejects that amount.
8. Production path (post-hackathon, needs independent review): per-agreement custody isolation, protocol-level receipt proofs, or a reviewed multi-party process. Not designed further now.

## The problem, precisely
`withdraw` moves `claimable → pending(id, A)` and issues `ft_transfer(beneficiary, A)` with a private callback. On NEAR, the callback receipt runs whether or not the transfer succeeded, and it receives the transfer's result. An **inconclusive** state arises only if the callback itself does not complete (gas exhaustion, panic, storage failure). After that, the transfer outcome is not available to the contract. The outcome exists in a public receipt, but contracts cannot verify receipt proofs. The two possible errors have different consequences:
- Wrongly concluding **failure** lets the beneficiary withdraw again. That is a double payment, and it is funded by other customers' escrow (shortfall).
- Wrongly concluding **success** means the beneficiary loses A. The tokens stay in escrow as untracked surplus.

## Original analysis (rationale record; superseded where it conflicts with the decision above)

## R-1 Prevention (primary control, P0)
- Fixed gas constants for `ft_transfer` and the callback, measured in sandbox with ≥ 2× margin. `withdraw` rejects before moving any state when `prepaid_gas` is below the sum (T058).
- The callback is total and panic-free: no `unwrap`/`expect`, it handles every `PromiseResult`, does O(1) work, is storage-neutral (pre-allocated slot, `25`), and checks `predecessor == current_account` and the withdrawal id/epoch.
- Tests: success, definite failure (unregistered recipient), forged/replayed callback, and a test that forces a callback gas shortfall to produce the inconclusive state on purpose (T040).

## R-2 Permissionless balance reconciliation (sound for "paid", P0)
`reconcile_withdrawal(id)`, callable by anyone:
1. Eligible only if `id` is `PENDING`, `now ≥ pending_at + RECONCILE_MIN_AGE`, and `id` is the **only** open withdrawal in the contract. Time only grants eligibility; it never decides the outcome.
2. Arms a global `reconciliation_lock {id, epoch, expires_at}`. While the lock is armed, new `withdraw` calls are rejected and `ft_on_transfer` returns the full amount (deposit refused and refunded by the FT resolver). The lock moves no money. If the balance callback is lost, the lock expires, and a stale callback with an old epoch is ignored.
3. Calls `ft_balance_of(escrow)` → private `on_reconcile_balance(id, epoch)`, which compares the observed balance **O** with **E**, the contract's running total of unpaid ledger custody (Σ locked + claimable + pending over all lines, including this A):
   - `O ≤ E − A` → tokens left the escrow. While the lock is armed, nothing else can send FT out, and NEP-141 balances can't be decreased by third parties. So: mark **PAID** and emit `withdrawal_reconciled_paid`. If `O < E − A`, also emit `custody_shortfall_detected` (incident, `13`).
   - `E − A < O < E` → impossible for a single transfer → stays frozen, emit incident.
   - `O ≥ E` → no outflow observed. This is **not** proof of failure: inflows (direct transfers, or refunds in flight) can mask an outflow. Record `no_outflow_observed_at` and remain PENDING. Restoration requires R-3.
4. Releases the lock in every branch.

**Soundness argument:** inflows can only raise O, which pushes toward "no outflow", never toward "PAID". So R-2 can never trigger a double payment. Its worst case is staying frozen.

## R-3 Verified failure restoration (bounded trust; FOUNDER DECISION)
Inflow masking means no onchain check can prove a transfer failed. A failure conclusion therefore needs people who inspect the public receipt. Proposal:
1. The beneficiary calls `request_restore(id, failed_receipt_id)`, which requires a prior R-2 `no_outflow_observed`.
2. **Both** appointed arbitrators of that agreement call `attest_transfer_failed(id, failed_receipt_id)` after checking the receipt on a public explorer. The receipt id is stored and emitted, so anyone can audit it.
3. A challenge period `RESTORE_CHALLENGE` follows (proposed 24h, bounded like other windows). During it anyone may run R-2 again, and any `O ≤ E − A` result marks PAID and cancels the restoration.
4. After the challenge period, a final R-2 check must again show `O ≥ E`. Only then is `pending(id) → claimable` restored for the **same beneficiary and the exact amount A, once**. `id` becomes terminal `RESTORED`, and any new withdrawal gets a new id.
5. There is never a new recipient, never a different amount, never another line, and no operator involvement.

**Residual risk (must be disclosed):** collusion between the beneficiary and both arbitrators, combined with inflows timed to mask the outflow at both checks, could create a shortfall of up to A, borne by the shared escrow pool. Bounds: one withdrawal amount per incident, public audit trail, 2-of-2 attestations, a challenge period.

**Alternatives considered:**
- (a) Restoration with no human role: unsound (double-pay).
- (b) An operator decides: rejected (ADR-005, no admin).
- (c) Add the counterparty as a third attester: possible, but the counterparty bears none of this risk, so it adds little.
- (d) For production, isolate custody per agreement or use protocol-level receipt proofs. Both are post-hackathon and need independent review.

## Decision record
- [x] R-1 approved — 2026-10-27
- [x] R-2 conditionally approved — observation only, no balance-based PAID; implemented as read-only views (no onchain reconciliation method) — 2026-10-27
- [x] R-3 deferred — not in hackathon MVP — 2026-10-27

## Rule B dependency for LF-009 (recorded 2026-11-01, hardening `7e8b1ae`; not implemented)
Rule B's outstanding liabilities E (`07` §APPROVED and IMPLEMENTED) already include pending amounts. LF-009 must keep it that way. A pending withdrawal stays a liability until an authenticated callback confirms the payout. E changes only by `checked_sub` in the PAID callback, by the exact slot amount, and an underflow means the callback leaves the withdrawal PENDING (incident). E is unchanged by `begin_withdrawal`, by definite failure (pending → claimable), and by an inconclusive or missing callback (item 5). It is never derived from aggregate balances (item 3). Audit of `7e8b1ae`: E is written only at init and on a credited deposit; `unpaid_buckets()` (unit/property) and the sandbox reconciliation both count `buyer_pending` and `supplier_pending`. No payout code exists.

## Implementation record — LF-009 (branch `lf-009/withdrawals`, 2026-11-04; not merged)
R-1 implemented as frozen in `evidence/lf009/lf009-spec-and-test-plan.md`; R-2 as read-only views only (`custody_summary`, `get_withdrawal`); R-3 absent. **Deviation for founder confirmation:** `get_withdrawal` is keyed by (agreement, line, beneficiary) instead of by withdrawal id (item 3), to avoid a per-withdrawal storage index paid by the operator; the slot carries the id. The `test-starve-callback` feature (item 7) uses 10 Ggas callback gas (1 Tgas was measured to be enough to complete the callback, so it did not starve); it is built only into `target/near-starve/`, reports itself in `contract_version()`, and the release WASM hash is unaffected.

**Founder approval 2026-11-05 (MVP):** keyed `get_withdrawal` approved. It returns the slot's active (latest) withdrawal id, epoch, amount and state. There is **no complete onchain withdrawal-history index**: earlier withdrawals of a slot (e.g. a FAILED one followed by a retry) are visible only in transaction receipts and logs (`LF_WITHDRAWAL_*:<id>`). Verified in LF-009 `ad7bb99` (`evidence/lf009/FINAL-VERIFICATION.md`).

**LF-009 evidence index (permanent references; all under `evidence/lf009/`):** spec `lf009-spec-and-test-plan.md` (commit `0a9e9f5`) · implementation commit `ad7bb99`, records `b66913f` (= `main` after the 2026-11-05 fast-forward) · final B9 (10 000 cases, exact error codes, seed `9c231a74fa78ccbde968c755750bdb4b6033666c23026649470ef60e01a09259`, exit 0) `b9-full-release-exact-20261105T031655Z.log.txt` · mutation 11/11 with per-mutant checksum restore `lf009-mutation-check-20261104T144752Z.txt` + `post-mutation-source-check-20261104T144752Z.txt` · final regression 284 passed `test-full-20261105T031655Z.log.txt` · clean checkout of `ad7bb99` (release WASM `c3c896cbdf05f8562a663c6c98df65bb7fcb6dc38e7e5c52d68d4c871afaefc2`) `clean-checkout-ad7bb99.log.txt` · summary `FINAL-VERIFICATION.md`.
