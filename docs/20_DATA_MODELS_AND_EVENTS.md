# Proposed contract data models, encoding and event shapes
**Reference-level schemas: engineer must match actual near-sdk data types, Borsh/JSON constraints and event standards before compiling.**

## AgreementTermsV1
`schema_version:u16`, `buyer_id:AccountId`, `supplier_id:AccountId`, `primary_arbitrator_id:AccountId`, `backup_arbitrator_id:AccountId`, `ft_contract_id:AccountId`, `agreement_nonce:u64` or unique key, `acceptance_deadline_ns:u64`, `funding_deadline_ns:u64`, `review_window_ns:u64`, `negotiation_window_ns:u64`, `primary_window_ns:u64`, `backup_window_ns:u64`, `lines: Vec<LineTermsV1>`.

`LineTermsV1`: `line_id:u32`, `principal:U128` (JSON decimal-string; internal `u128`), `delivery_deadline_ns:u64`, `acceptance_criteria_commitment:Base64Bytes32`, `fallback_buyer_bps:u16`, `fallback_supplier_bps:u16`. Sum 10k. All four role IDs distinct.

## Canonical terms digest
Do **not** trust caller-provided digest. Define domain `linefair/agreement/v1`, deterministic encoding (e.g. strict well-defined Borsh of versioned terms), and compute SHA-256 `hash(domain || 0x00 || canonical_bytes)` onchain. Document encoding fixtures and test Rust vs TypeScript matching hash. Avoid unordered map fields or ambiguous JSON serialization.

## LineStateV1
`agreement_id`, `line_id`, `work_status`, `initial_principal`, `funded_at_ns?`, `evidence_commitment?`, `submitted_at_ns?`, `dispute_reason?`, `dispute_t0_ns?`, `final_allocation_id?`, `ledger`.

## LineLedgerV1
`locked_u128`, `buyer_claimable_u128`, `supplier_claimable_u128`, `buyer_pending_u128`, `supplier_pending_u128`, `buyer_paid_u128`, `supplier_paid_u128`. Derived total must equal exact deposit when funded.

## Dispute and withdrawal models
`SplitProposalV1`: id/nonce, agreement_id/line_id, proposer, buyer_amount, supplier_amount, evidence_commitment?, status; authorized other party accepts exact ID. `WithdrawalV1`: unique id, line, beneficiary role, recipient fixed by agreement, amount, FT contract, created_at_ns, state, resolution receipt id (if known). Never create a second pending withdrawal of same claim.

## Public chain events (proposed)
`agreement_proposed`, `role_accepted`, `agreement_active`, `line_funded`, `delivery_committed`, `line_accepted`, `line_disputed`, `allocation_finalized`, `withdrawal_started`, `withdrawal_succeeded`, `withdrawal_failed` with `{schema_version, agreement_id, line_id?, tx/ref identifiers?, amount?}`. No private invoice descriptions, emails, file URLs, unsalted evidence strings. Match official standards once implementation starts.

## Canonical terms encoding v1 — FROZEN 2026-10-27 (OQ-11 approved with conditions; includes OQ-02/03, FD-06)
This section supersedes the `AgreementTermsV1` / `LineTermsV1` field lists and the "Canonical terms digest" paragraph above where they differ. The **Rust implementation is the serialization reference**. TypeScript must reproduce its golden vectors byte for byte. Any change requires `schema_version` 2 and domain `linefair/agreement/v2`.

### Preimage
```text
terms_hash = SHA-256( "linefair/agreement/v1"        // 21 ASCII bytes, no length prefix
                      || 0x00                         // separator
                      || bstr(network_id)             // immutable contract init value: "sandbox" | "testnet" only
                      || bstr(escrow_contract_id)     // env::current_account_id()
                      || AgreementTermsV1 )           // Borsh, field order below
bstr(x)  = u32 little-endian byte length || UTF-8 bytes
```
`terms_hash` itself, `agreement_id`, acceptance flags and every runtime state are **not** in the preimage.

### AgreementTermsV1 (Borsh, exact order)
| # | Field | Type / bytes | Validation (contract rejects otherwise) |
|---|---|---|---|
| 1 | `schema_version` | u16 LE | = 1 |
| 2 | `deadline_rules_version` | u16 LE | = 1 (`08` §Deadline rules v1) |
| 3 | `buyer_id` | bstr | valid NEAR `AccountId` (2–64 chars, `[a-z0-9_-]` parts separated by `.`) |
| 4 | `supplier_id` | bstr | same |
| 5 | `primary_arbitrator_id` | bstr | same |
| 6 | `backup_arbitrator_id` | bstr | same; 3–6 pairwise distinct and ≠ escrow, FT, operator treasury (FD-05, OQ-09) |
| 7 | `ft_contract_id` | bstr | = the single allowlisted FT set at init |
| 8 | `agreement_nonce` | u64 LE | any; identical full preimage already registered → reject (T078) |
| 9 | `acceptance_deadline_ns` | u64 LE | `now <` it |
| 10 | `funding_deadline_ns` | u64 LE | ≥ acceptance deadline |
| 11 | `delivery_grace_period_ns` | u64 LE | 0 ..= 2 592 000 000 000 000 (default 0) |
| 12 | `review_window_ns` | u64 LE | 60 000 000 000 ..= 2 592 000 000 000 000 (default 259 200 000 000 000 = 72h) |
| 13 | `negotiation_window_ns` | u64 LE | same bounds (default 172 800 000 000 000 = 48h) |
| 14 | `primary_window_ns` | u64 LE | same bounds (default 72h) |
| 15 | `backup_window_ns` | u64 LE | same bounds (default 72h) |
| 16 | `lines` | u32 LE count, then elements | 1 ≤ count ≤ 3 |

### LineTermsV1 (Borsh, exact order)
| # | Field | Type / bytes | Validation |
|---|---|---|---|
| 1 | `line_id` | u32 LE | = its position (0, 1, 2), so ids are unique and ordered |
| 2 | `principal` | u128 LE (16 bytes) | > 0 |
| 3 | `delivery_deadline_ns` | u64 LE | ≥ funding deadline; `+ grace` and every window sum is `checked_add` within u64 |
| 4 | `acceptance_criteria_commitment` | [u8; 32] raw, no prefix | exactly 32 bytes |
| 5 | `fallback_buyer_bps` | u16 LE | 0..=10 000 |
| 6 | `fallback_supplier_bps` | u16 LE | buyer + supplier = 10 000 exactly (FD-04) |

Derived (not stored, not hashed): `accelerated_test_timing = any window < its default`.

### JSON edge (`schemas/agreement-terms-v1.schema.json`)
u64/u128 are canonical decimal strings `^(0|[1-9][0-9]*)$` (no leading zeros, no sign, no exponent; range-checked on parse). Commitments are `^[0-9a-f]{64}$` (lowercase only). Unknown fields are rejected. The JSON form is never hashed; it is parsed into the struct, which is then encoded.

### Commitments (32 bytes, salted, computed offchain; contract checks length only)
- Acceptance criteria: `SHA-256("linefair/criteria/v1" || 0x00 || bstr(network_id) || bstr(escrow_contract_id) || u64 agreement_nonce || u32 line_id || content_digest[32] || salt[32])`
- Delivery evidence (`09`): `SHA-256("linefair/evidence/v1" || 0x00 || bstr(network_id) || bstr(escrow_contract_id) || u64 agreement_id || u32 line_id || u16 evidence_version || content_digest[32] || salt[32])`
- The salt is ≥ 32 CSPRNG bytes, kept offchain with the access-controlled file, and never placed in events or logs. No raw commercial description or private document ever goes onchain.

### Hash-mismatch rejection
- `accept_terms(agreement_id, terms_hash)` and `accept_appointment(agreement_id, terms_hash)` panic unless `terms_hash` equals the stored contract-computed digest (T065).
- FT funding msg v1 = `{"version":1,"agreement_id":"<u64>","line_id":<0..2>,"terms_hash":"<hex64>"}` (`schemas/ft-funding-message-v1.schema.json`). On any mismatch or parse failure `ft_on_transfer` returns the full amount and credits nothing (T066).

### Shared test vectors (`packages/shared-schemas/vectors/terms_v1.json`, generated by Rust)
T059 golden digest · T060 each of the 22 fields changed (16 terms + 6 per line) → distinct digest · T061 reordered lines → validation reject, and a digest differing from the ordered form · T062 malformed inputs (bad account id, uppercase/short hex, 0 or 4 lines, id gap, non-canonical decimal, u64/u128 overflow, bps sum ≠ 10 000) → rejected identically by Rust and TS · T063 network `sandbox` vs `testnet` → distinct digest · T064 escrow id changed → distinct digest.

## Implementation notes — M1 S5 (`afa6175`, 2026-11-01)
`docs/20` field lists are reference-level. The implementation differs as follows; the canonical **terms** encoding v1 is not affected (stored state is not hashed).
- `LineStateV1` has no `agreement_id` / `line_id`; both are implied by its position in `AgreementV1.lines`. It has no `Option` fields: every record is fixed-size (`docs/25` pre-allocation), with explicit `None` enum variants and zero values before the relevant state. `initial_principal` stays in the immutable terms.
- `final_allocation_id?` is a fixed-size `AllocationRecordV1 {mode, buyer_amount, supplier_amount, source_id, finalized_at_ns}`. `source_id` is the accepted proposal id for `Mutual` (LF-007), 0 otherwise.
- `WithdrawalV1` is one fixed-size `WithdrawalSlotV1 {state, withdrawal_id, epoch, amount, started_at_ns, resolved_at_ns}` per beneficiary per line. The recipient is not stored: it is always the immutable buyer_id / supplier_id. The FT contract is the single allowlisted one. The receipt id and the contract-wide id counter are added with LF-009.

## Implementation note — root state layout after hardening (`7e8b1ae`, 2026-11-01)
Contract root (`STATE`, Borsh): `network` u8 enum (1) · `allowlisted_ft_id` bstr (4 + len) · `operator_treasury_id` bstr (4 + len) · `max_agreements` u32 (4) · `next_agreement_id` u64 (8) · `agreements` LookupMap prefix (4 + 1) · `terms_index` LookupMap prefix (4 + 1) · **`custody_total` u128 (16, Rule B)**. Measured in sandbox: 92 B before vs 108 B after, the same init arguments, **+16 B exactly** (`evidence/hardening/sandbox-ft-hardening.log.txt`). Unit test `rule_b_state_layout_adds_exactly_16_bytes` pins the formula. Per-agreement layout is unchanged.

## Implementation note — LF-007 proposal record (branch `lf-007/mutual-settlement`, 2026-11-03)
`LineStateV1` gains a fixed-size `proposal: SplitProposalV1 {status: NONE|OPEN|ACCEPTED (1), proposer: NONE|BUYER|SUPPLIER (1), proposal_id u64 (8), buyer_amount u128 (16), supplier_amount u128 (16), created_at_ns u64 (8)}` = 50 B, appended after the withdrawal slots; `LineStateV1` 309 → 359 B in every state (unit test `lf007_layout_fixed_size`, S6 `LINE_STATE_BYTES`). There is no `agreement_id` / `line_id` inside (implied by position) and no `evidence_commitment?` (not required by the approved workflow; offchain evidence stays LF-012). `proposal_id` is the per-line nonce (monotonic from 1); `AllocationRecordV1.source_id` = accepted `proposal_id` for MUTUAL. The canonical **terms** encoding v1 is unaffected (stored state is not hashed).

## Implementation note — LF-008 (branch `lf-008/timed-arbitration`, 2026-11-04)
No stored-layout change: `LineStateV1` stays 359 B and per-agreement storage stays 772 / 1 195 / 1 618 B. `LineParams` (in-memory, not stored) gains the hashed `negotiation_window_ns`, `primary_window_ns`, `backup_window_ns`. `LineView` adds read-only `dispute_phase`, `primary_start_ns`, `backup_start_ns`, `fallback_start_ns`, computed at view time from the fixed T0.

## Implementation note — LF-009 (branch `lf-009/withdrawals`, 2026-11-04)
Root state +16 B: `last_withdrawal_id` u64 and `open_withdrawals` u64 appended after `custody_total` (108 → 124 B, measured in sandbox; unit and sandbox layout tests). Per-agreement storage unchanged (772 / 1 195 / 1 618 B); `WithdrawalSlotV1` already pre-allocated, so withdraw and callback have storage delta 0. Logs (codes and ids only): `LF_WITHDRAWAL_PAID:<id>`, `LF_WITHDRAWAL_FAILED:<id>`, `LF_WITHDRAWAL_IGNORED:<code>:<id>`, `LF_WITHDRAWAL_INCONCLUSIVE:<id>`, `LF_INCIDENT:<code>:<id>`.
