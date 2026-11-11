# Operator budget: NEAR storage and gas (OQ-05)
**Founder direction 2026-10-27:** a dedicated testnet operator budget pays NEAR storage and gas; it is kept separate from all customer escrow principal. Every number below is an **estimate** unless marked *measured*. Sandbox measurement (T056–T058) replaces each estimate before LF-014.

## Hard separation rules
1. Customer principal exists only as NEP-141 FT balances recorded in line ledgers. NEAR (the native token) is never part of any ledger, and FT principal is never used, swapped or "borrowed" to pay NEAR costs.
2. Founder (2026-10-27): operating NEAR must **not** become permanently unrecoverable without a reviewed treasury policy. The only exit for NEAR is the restricted excess-recovery method below. No method can move escrowed FT tokens except beneficiary withdrawals (`06`, `27`).
3. The operator account is not a role in any agreement and has no contract privileges. It only sends NEAR and signs `storage_deposit` on the FT contract.

## Live protocol parameters (*measured* 2026-10-27T19:21Z, `https://rpc.testnet.near.org`, protocol_version 88, node 2.14.0-rc.5)
| Parameter | Value | Meaning |
|---|---|---|
| `storage_amount_per_byte` | 10¹⁹ yoctoNEAR | 1 NEAR locks 100 000 bytes |
| `gas_price` | 10⁸ yoctoNEAR/gas | 1 Tgas = 0.0001 NEAR; 300 Tgas = 0.03 NEAR (unused prepaid gas is refunded) |
| `max_total_prepaid_gas` / `max_gas_burnt` | 10¹⁵ gas (1 000 Tgas) | per-receipt ceiling |
| `max_contract_size` | 4 194 304 bytes | WASM upload limit |

## Who pays what
| Cost | Payer | Mechanism | Estimate |
|---|---|---|---|
| Escrow WASM storage | Operator | Fund the escrow account before deploy | 150–350 KB → **1.5–3.5 NEAR** (toolchain probe with no logic: 51 996 bytes, *measured*) |
| Agreement state | Operator, via an escrow-account **storage pool** | `create_agreement` takes 0 attached deposit and is paid from the pre-funded escrow balance, within the caps below | ≈ 1.4 KB per 3-line agreement (field-size arithmetic from `20`); cap 4 KB → **≤ 0.04 NEAR/agreement** |
| FT contract WASM + state | Operator | Fund the FT account before deploy | **2–4 NEAR** (measure) |
| FT NEP-145 registrations (escrow, buyer, supplier) | Operator | `storage_deposit(account_id=…)` signed by operator; amount read from `storage_balance_bounds().min`, never hardcoded | ≈ 0.00125 NEAR each (measure) |
| Transaction gas | Each signer from their own throwaway testnet wallet, topped up by operator | Users always sign their own actions; the operator never signs on their behalf (no relayer in P0) | typical call 5–30 Tgas burnt ≈ 0.0005–0.003 NEAR; one full 3-line demo ≈ 30 txs ≤ **0.9 NEAR worst case** |
| `ft_transfer` 1 yoctoNEAR deposit | Withdrawing beneficiary | Attached to the withdraw call and forwarded | 10⁻²⁴ NEAR |

## Limits (enforced in contract, values pending sign-off)
- `max_agreements: u32`, set immutably at `init`. Proposed: **25**. Bounds total storage-pool exposure to 25 × 4 KB = 100 KB ≈ 1 NEAR and limits griefing by strangers creating junk agreements (each still needs `predecessor == buyer_id`).
- `MAX_AGREEMENT_BYTES`, a constant. Proposed: **4 096**. `create_agreement` measures `env::storage_usage()` before and after and panics if the delta exceeds it.
- **Pre-allocation:** all per-line records (ledger buckets, one withdrawal slot per beneficiary per line, one active split proposal per line) are written at creation. Funding, acceptance, disputes, rulings, withdrawals and callbacks only overwrite fixed-size fields, so storage is ~constant after creation. History lives in events, not growing state.
- **Withdraw gas floor:** `withdraw` rejects (before moving claimable → pending) unless `env::prepaid_gas()` ≥ the transfer gas + callback gas + margin. Constants are measured in sandbox, not guessed.
- **NOT IMPLEMENTED (AI review F5, 2026-11-05):** the view and pre-check below are design only; a short NEAR balance makes `create_agreement` fail atomically with the runtime's LackBalanceForState error, not a stable code. - Operator monitoring view: `storage_budget() -> { agreements_used, max_agreements, available_bytes }`, derived from `env::account_balance()` and `env::storage_usage()`.

## Measured in sandbox — M1 S3 (`3fab104`, 2026-11-01T13:07:59Z, nearcore sandbox 2.13.4)
- 3-line `create_agreement`: **537 bytes** added (*measured*, sandbox role ids `buyer.test.near` etc.; longer testnet ids add ≈ 2 × id length per role). Estimate was ≈ 1.4 KB; well under the 4 096-byte cap. Ledger/withdrawal pre-allocation (S4+) will add more: re-measure then.
- Gas burnt (*measured*): `create_agreement` 2.2 Tgas, `accept_terms` 1.9 Tgas.
- **Reconciliation (2026-11-01, founder item 7):** the two figures are two different calls, not two measurements of creation. Saved evidence `evidence/m1/s3-test-full.txt` line 114 = `create_agreement` (printed at `tests/sandbox_agreement.rs:73-78`), line 115 = `accept_terms` by the buyer (`:90`). Both were near-gas `Display` values, which **round up** to the next 0.1 Tgas (`near-gas-0.3.7/src/trait_impls/display.rs`). S4 (`29b3257`) prints exact units: `create_agreement` **2 123 406 485 578 gas (2.12 Tgas)**, `accept_terms` **1 812 398 513 684 gas (1.81 Tgas)** (`evidence/m1/s4-test-full.txt`).
- ~~Projected (not yet stored): each `LineLedgerV1` is a fixed 112 bytes … about 873 B in total plus withdrawal slots.~~ Superseded by the S5 measurement below. The projection counted only the ledger and was low.
- **Measured after ledger integration (M1 S5 `afa6175`, 2026-11-01T13:31:53Z, sandbox 2.13.4, sandbox ids `*.test.near`):** `create_agreement` adds **722 B (1 line), 1 095 B (2 lines), 1 468 B (3 lines)**, i.e. **373 B per additional line**: the 309-byte pre-allocated `LineStateV1` (status, timestamps, evidence commitment, dispute fields, allocation record, 7-bucket ledger, 2 withdrawal slots) plus 64 B of line terms. The line state is the same size in every state (unit-tested), so later transitions should not grow storage; that is confirmed in sandbox only when entry points exist (LF-005/LF-009, T058). Gas (*measured*, exact units): create 1/2/3 lines 2 065 205 285 986 / 2 140 800 611 704 / 2 178 517 903 780 – 2 199 556 411 258 gas (the 3-line spread is between two sandbox runs with different prior contract state); `accept_terms` 1 934 692 906 801 gas (up from 1.81 Tgas because the stored agreement is larger). WASM 169 134 B. With the provisional cap 25 × 1 468 B ≈ 36.7 KB ≈ 0.37 NEAR of storage pool.
- Sandbox is 2.13.4, testnet 2.14.x: re-measure on testnet at LF-014.

- **Re-measured after S5b (`ec36f1b`, 2026-11-01T14:00:10Z):** storage unchanged, 722 / 1 095 / 1 468 B (stored structs identical to S5). Gas +21.8 M units on create and accept (create 3 lines 2 178 539 689 680 / 2 199 578 197 158; `accept_terms` 1 934 714 692 701), consistent with the WASM growing by 20 B (169 154 B).

- **LF-005 funding (`63fa991`, 2026-11-01T15:41:51Z, sandbox 2.13.4, genuine pinned token):** a successful `ft_transfer_call` funding one line burns **≈ 6.21 Tgas** in total (6 214 504 717 307 – 6 214 519 526 915 gas units; token + escrow `ft_on_transfer` + resolver). The escrow's **storage delta per funding is 0 B** (pre-allocated fields only). Measured gas thresholds for the attached gas: ≤ 8.0 Tgas the whole transaction fails before any transfer; 8.5–9.0 Tgas the escrow receipt fails and the resolver refunds (T057); ≥ 9.5 Tgas funding succeeds. The frontend must attach ≥ 30 Tgas (≥ 3× measured). Escrow WASM 195 430 B (≈ 1.95 NEAR storage). Token registration: the operator pays `storage_balance_bounds().min` per account (read at runtime). The escrow, supplier and stranger were registered this way in the sandbox. `create_agreement` storage unchanged (722 / 1 095 / 1 468 B).

- **Rule B storage impact (hardening `7e8b1ae`, 2026-11-01, measured):** root state 92 → 108 B (+16 B = `custody_total`); account `storage_usage` after init 195 749 → 196 666 (+917 B = +901 B code + 16 B state). +16 B costs 1.6 × 10⁻⁴ NEAR once per contract. Escrow WASM 196 331 B ≈ 1.963 NEAR. Per-agreement storage unchanged: 722 / 1 095 / 1 468 B (`MAX_AGREEMENT_BYTES` 4 096 not affected). Escrow budget at the provisional cap: ≈ 1.963 (code) + 0.367 (25 × 1 468 B) + 0.001 (root) ≈ **2.33 NEAR**, within the proposed 5 NEAR escrow allocation. Gas: `create_agreement` 3 lines 2 209 424 963 879 – 2 230 463 471 357 gas (+≈3 M vs LF-005, larger WASM).

### Pre-testnet storage-budget action (LF-014 gate, recorded 2026-11-01)
- **LF-007 (`8957408`, 2026-11-03T18:27:33Z, sandbox 2.13.4, measured):** `create_agreement` now adds **772 / 1 195 / 1 618 B** for 1 / 2 / 3 lines (+50 B per line = `SplitProposalV1`); `propose_split` ≈ 2.04 Tgas, `accept_split` ≈ 1.98–2.04 Tgas, storage delta 0 for both. The observed-capacity estimate below scales accordingly (1 618 B instead of 1 468 B); the worst-case reserve stays computed on the 4 096 B cap.

- **LF-008 (`193ac66`, 2026-11-04T13:48:05Z, measured):** `submit_ruling` ≈ 1.99 Tgas, `trigger_fallback` ≈ 1.91–1.97 Tgas, storage delta 0; per-agreement storage unchanged (772 / 1 195 / 1 618 B).

The ≈ 2.33 NEAR figure above is an **observed-capacity estimate** from sandbox agreements of 1 468 B with short `*.test.near` ids. It is **not** the worst-case reserve. The contract only enforces `MAX_AGREEMENT_BYTES = 4 096` per agreement, so the reserve must cover **max_agreements × 4 096 B** = 25 × 4 096 = 102 400 B ≈ 1.024 NEAR, plus code ≈ 1.963 NEAR, root state, and the `SAFETY_BUFFER` (proposed 1 NEAR) ⇒ **≈ 4.0 NEAR worst case** at the provisional cap, before gas. Actions before LF-014: (1) measure a worst-case agreement on testnet (3 lines, five 64-character account ids, maximum-length values) and confirm it stays ≤ 4 096 B; (2) fund the escrow reserve from the worst-case formula, not from the observed size; (3) re-measure WASM size and gas on the testnet protocol version.

## Security finding (M1 S3) — cap griefing — FOUNDER DECISION NEEDED before LF-014
Any account can call `create_agreement` naming itself as buyer and three arbitrary other accounts. Because proposals and the duplicate-hash registry are never deleted (by design, for T078), **25 junk proposals permanently exhaust `max_agreements`** on a deployed demo contract. Funds are not at risk (no tokens exist at creation), and each costs the attacker only gas. Options, none implemented: (a) accept for the hackathon demo; redeploy if griefed. (b) A creator allowlist fixed at `init`. (c) A per-buyer proposal limit. (d) Free the cap slot, but not the hash registry, when a proposal has expired unaccepted. Recommendation: (d) or (b), but only after your sign-off, because it changes who may create agreements or what the cap counts.

## Creator allowlist analysis (founder preference 2026-11-01) — PROPOSED, NOT IMPLEMENTED
**Proposal.** `new` takes an immutable `creator_allowlist: Vec<AccountId>` (for example 1..=5 entries, each distinct from escrow, FT and treasury). `create_agreement` additionally requires `predecessor ∈ creator_allowlist`. Everything else is unchanged: predecessor must still equal `buyer_id`, the cap stays, the duplicate registry stays.

**Compatibility with existing specifications**
| Spec | Effect |
|---|---|
| `06` authorization table, "create agreement: creator (buyer intended)" | Narrows the signer set. The table row must be edited explicitly; this needs an ADR under `03` §Changes to financial semantics (permission change) |
| `25` "each still needs predecessor == buyer_id"; `max_agreements` | Kept; the allowlist is an additional condition |
| `20` canonical encoding v1 / terms hash | Unaffected: the allowlist is contract config, not terms. No schema v2 |
| FD-05 (4 distinct roles), OQ-09 (roles ≠ escrow/FT/treasury) | Unaffected. Supplier and arbitrators are not restricted |
| OQ-13 network guard | Unaffected |
| OQ-06 key deletion after deploy | **Interaction:** with no admin (ADR-005), the list is frozen at deploy. Judges' accounts cannot be added later, so the list must be final before LF-014 |
| ADR-005 no platform admin | Respected only if there is no method to edit the list. An editable list would be a new admin power and is rejected |

**Can judges exercise the complete demo?**
- *Public testnet contract:* only allowlisted accounts can create (act as buyer). A judge can act as supplier or arbitrator only if an allowlisted buyer names their account in new terms; their accounts are unknown before deploy. In practice judges observe founder-controlled role wallets, the explorer receipts and the UI. That is a full demonstration but not full self-exercise.
- *Local sandbox (official FAQ Q-012 allows a local-only demo if the README is reproducible):* the judge deploys their own instance and passes their own accounts in `creator_allowlist`, so they can exercise every step themselves. This needs a scripted README path (LF-015).
- *Never:* sharing private keys of allowlisted accounts with judges.

**Residual risks.** An allowlisted account can still consume all slots; this is founder-controlled. Rehearsals plus judging may use up 25 slots with expired runs. Combining with option (d) (free the slot, not the hash registry, when a proposal expires unaccepted) would address that, but it is a second permission/cap change and needs its own sign-off.

**Tests to add on approval:** stranger-as-buyer create rejected (`ERR_CREATOR_NOT_ALLOWLISTED`) with storage unchanged; allowlisted buyer succeeds; init rejects an empty, oversized or duplicate list and entries equal to escrow/FT/treasury; `get_config` exposes the list; storage and gas re-measured.

**Recommendation:** approve the immutable allowlist for the public testnet demo, plus a scripted local-sandbox README path for judges. Decide on (d) separately. Implementation is a separate slice after explicit sign-off and before LF-014.

## Restricted recovery of excess operator NEAR (PROPOSED, founder review)
- `operator_treasury_id: AccountId` is set immutably at `init`. It must differ from the escrow, the FT contract and every agreement role; `create_agreement` rejects terms naming it.
- `recover_excess_near(amount: U128)`: predecessor must equal `operator_treasury_id`, and the recipient is always `operator_treasury_id`, never a parameter. It sends **native NEAR only** via `Promise::transfer`. The method contains no FT call, no ledger access and no account parameter.
- Upper bound: `amount ≤ liquid_balance − storage_usage × byte_cost − reserve`, where `reserve = (max_agreements − agreements_used) × MAX_AGREEMENT_BYTES × byte_cost + SAFETY_BUFFER` (proposed 1 NEAR). It is also rejected while any withdrawal is pending (conservative). The MVP has no reconciliation lock (OQ-01 decision).
- Customer NEAR never enters the account. Every method is non-payable except `withdraw`, which requires exactly 1 yoctoNEAR and forwards it to `ft_transfer`. So all NEAR held is operator-funded or protocol gas rewards. There are no NEAR liabilities to customers.
- Emits `operator_near_recovered {amount, remaining_liquid}`. Tests (NOT EXECUTED): T073 non-treasury caller rejected · T074 amount above bound rejected · T075 FT balance and every ledger unchanged after recovery · T076 rejected while a withdrawal is pending · T077 agreements can still be created up to the cap after maximum recovery.

## Funding-failure behavior
| Situation | Behavior | Funds effect | Test |
|---|---|---|---|
| Storage pool too low at `create_agreement` | **(NOT IMPLEMENTED — see F5)** Explicit pre-check would panic with `ERR_STORAGE_BUDGET_EXHAUSTED`. The NEAR runtime would also fail the receipt for insufficient balance-for-state; verify which error appears in sandbox. | Atomic: no agreement created. No FT exists yet. | T056 |
| `max_agreements` reached | Reject with `ERR_AGREEMENT_CAP_REACHED`. Existing agreements unaffected. | none | T056 |
| Storage unexpectedly needed during `ft_on_transfer` and the receipt fails | Must not happen (pre-allocation). If it does, the standard FT resolver treats the failed receiver call as fully unused and refunds the buyer. No credit is recorded. | Buyer refunded by FT contract; ledger unchanged | T057 |
| Callback would need new storage | Forbidden by design: the callback only overwrites pre-allocated fields. | none | T058 (storage_usage unchanged across callback) |
| Withdraw with insufficient attached gas | Rejected before claimable → pending. | Claim unchanged | T058 |
| Beneficiary not FT-registered | `ft_transfer` fails definitively; callback restores pending → claimable. Operator registers the account; beneficiary retries. | Claim restored exactly once | T036/T038 |
| Role wallet out of NEAR for gas | Wallet cannot sign; contract state untouched; operator tops up. | none | manual |
| Operator budget itself exhausted | No new deployments or agreements; existing agreements continue, because they need no further operator NEAR. | none | manual |

## Worst-case testnet funding (founder-approved method 2026-11-05; recomputed after LF-009 `ad7bb99`)
Inputs measured in sandbox 2.13.4 except where marked; `storage_amount_per_byte` = 10¹⁹ yocto (measured on testnet 2026-10-27; **re-query before deploy**).
| Item | Bytes | NEAR |
|---|---|---|
| Escrow account after init (release WASM 245 204 B + account + root 124 B), measured `storage_usage` | 245 555 | 2.4556 |
| Creator allowlist (planned, ≤ 10 ids × (4 + 64)) | ≤ 684 | 0.0068 |
| Larger WASM after the allowlist slice — **measured LF-010A `2f71e38`: `storage_usage` after init 248 807 B with a 2-entry list (+3 252 B vs LF-009, incl. the list)** | +3 252 | 0.0325 |
| 25 agreements × 4 096 B enforced cap (includes the terms-index entry: the cap is the measured `storage_usage` delta of `create_agreement`) | 102 400 | 1.0240 |
| Withdrawals, settlement, arbitration, callbacks | 0 (pre-allocated, measured delta 0) | 0 |
| **Storage worst case** | ≈ 350 639 | **≈ 3.51** |
| Operational buffer (≥ 70 %; recovery deferred, so it is locked) | — | 2.50 |
| **Escrow account funding** | | **6 NEAR** (not 5) |
Other accounts: FT account (126 386 B WASM ≈ 1.26 NEAR + state) **3 NEAR** · operator (storage registrations 0.00125 NEAR each from `storage_balance_bounds`, top-ups) **2 NEAR** · 4 role wallets × **1 NEAR** (each signer pays its own gas: create ≈ 2.3 Tgas, withdraw tx ≈ 6.6 Tgas ≈ 0.0007 NEAR; 100 Tgas prepaid is refunded when unused) · contingency 5 NEAR → **≈ 20 testnet NEAR total**. Gas price 10⁸ yocto/gas (testnet 2026-10-27; re-query). Before deploy: query live `storage_amount_per_byte` and gas price, deploy, measure `storage_usage` on testnet, and confirm liquid balance ≥ worst-case storage + buffer.

## Proposed testnet budget (pending measurement)
Escrow account 5 NEAR (code + 1 NEAR pool + reserve) · FT account 4 NEAR · 4 role wallets × 2 NEAR · operator float 3 NEAR → **~20 testnet NEAR**. Faucet availability and limits are unverified; check the current official faucet before LF-014.

## Sign-off (founder)
- [x] Dedicated testnet operator reserve, never customer escrow tokens — APPROVED 2026-10-27
- [x] `max_agreements = 25`, `MAX_AGREEMENT_BYTES = 4096` — PROVISIONAL testnet limits, to be confirmed against measured worst-case storage (T056) before LF-014
- [ ] Restricted excess-NEAR recovery (above) — design PROPOSED; review before LF-014 deploy (not needed for M1)
- [x] No gas relayer; each role signs from its own throwaway wallet topped up by the operator — consistent with existing scope (no new feature)

**1-yocto refunds (AI review F9, 2026-11-05):** when an `ft_transfer` fails, the runtime refunds its attached 1 yoctoNEAR to the escrow (the predecessor), not to the withdrawing user. Negligible, but with excess-NEAR recovery deferred and keys deleted (OQ-06) this NEAR — like the storage pool and gas rewards — is unrecoverable. Accepted for the MVP.
