# 28 — Creator allowlist (LF-010A, slot-exhaustion mitigation): specification and security test plan
**Status: APPROVED (founder 2026-11-05) — implementation in progress on `lf-010a/creator-allowlist`** (from `main` = `b66913f`). Spec written before code (`f90d7a7`).
written_at: 2026-11-05 (UTC) · founder approval 2026-11-05 (testnet-only mitigation; not a production permissionless solution) · source analysis: `docs/25` §Security finding (M1 S3), §Creator allowlist analysis.

## Change (only this)
1. `new(network_id, allowlisted_ft_id, operator_treasury_id, max_agreements, creator_allowlist: Vec<AccountId>)` — **one new init argument**.
   Validation at init (panic = no deploy state): 1 ≤ len ≤ 10 (`ERR_INIT_CREATOR_ALLOWLIST_SIZE`); entries pairwise distinct (`ERR_INIT_CREATOR_ALLOWLIST_DUPLICATE`); no entry equals the escrow, the FT contract or the treasury (`ERR_INIT_CREATOR_ALLOWLIST_RESERVED`).
2. Root state: `creator_allowlist: Vec<AccountId>` appended (4 + Σ(4 + len(id)) bytes; ≤ 684 B at 10 × 64-char ids). **Immutable: no method can add, remove or edit it** (ADR-005: no admin).
3. `create_agreement`: first check `predecessor ∈ creator_allowlist`, else `ERR_CREATOR_NOT_ALLOWLISTED` (before semantic parsing/validation of the terms and before any storage write; near-sdk has already deserialized the JSON argument, so a malformed argument from anyone fails with the SDK's deserialization error, also with no storage write — AI review F7). All existing checks stay, in their order, after it (predecessor == buyer_id, terms validation, duplicate registry, `max_agreements`, 4 096 B cap).
4. `get_config` adds `creator_allowlist: Vec<AccountId>`.

## Authority model (frozen before coding)
| Question | Answer |
|---|---|
| **Administrator authority** | **None.** There is no admin, owner or operator role in the contract (ADR-005). No account gains any power over agreements, tokens, allocations, withdrawals or the list itself. `operator_treasury_id` keeps its existing meaning only (it is not a creator unless listed, and it must not be listed). |
| **Allowlist updates** | **None after initialization.** No method adds, removes or replaces an entry. Changing the list means deploying a **new** contract account with a new list; agreements and funds on the old account are untouched and continue to work there (no migration, no transfer between contracts). |
| **Initialization** | Exactly once, in `new`, by the deployment transaction (as today: `#[init]`, `PanicOnDefault`); the list is validated there and stored in root state. Re-initialization is impossible (state exists). |
| **Permanent restrictions** | (a) the list only gates `create_agreement`; (b) a listed creator must still be the terms' `buyer_id`; (c) a listed creator has no extra rights in any agreement (it is an ordinary buyer); (d) no method lets any account move tokens except the existing beneficiary `withdraw` of its own claim; (e) no finalization path is added: allocations still only via `accept_line`, `accept_split`, `submit_ruling` (in window) and `trigger_fallback` (after longstop); (f) list entries can never be the escrow, the FT contract or the treasury. |
| **Alternative considered and rejected (needs a separate founder decision)** | An admin-updatable list would add a new admin power over who may create agreements. Even bounded to list edits only, it creates a privileged key that must be protected and disclosed, and it conflicts with ADR-005. Not specified, not implemented. |

## Unchanged (explicitly)
Every other method and its caller rule: `accept_terms` / `accept_appointment` (any named role), funding (`ft_on_transfer`), submit / accept / dispute, `advance_case` (anyone), `propose_split` / `accept_split`, `submit_ruling`, `trigger_fallback` (anyone), `withdraw`, the private callback, all views. No payout, allocation, recipient or arbitration authority is added to allowlisted accounts — the list only gates who may *propose* an agreement as its buyer. Terms hash v1 / canonical encoding unaffected (config, not terms). FD-05 / OQ-09 / OQ-13 unaffected.

## Compatibility impact
- Init signature changes: every deploy script and test init passes the list (sandbox `deploy_with_ft`, unit `init`, S6 is unaffected — it uses `AgreementV1` directly).
- ABI: `new` gains an argument; `ConfigView` gains a field → frontend fixtures regenerate; the frontend's drift/ABI tests will flag it.
- `docs/06` authorization row "create agreement: creator (buyer intended)" becomes "allowlisted creator who is the buyer" (explicit edit, ADR entry in `03`).
- Judges: on the public testnet contract a judge can be named as supplier / arbitrator by an allowlisted buyer if the judge gives a testnet account before the agreement is created; full self-exercise (including acting as buyer) via the scripted local-sandbox path (README, LF-015) where the judge passes their own accounts in `creator_allowlist`. Never share keys.

## Residual risks (to disclose)
Allowlisted (founder-controlled) accounts can still use all `max_agreements` slots (rehearsals!). The list is frozen at deploy; a judge cannot be added as a *creator* later. Not a permissionless production design.

## Named tests (before code)
Unit: `allowlist_init_rejects_empty_oversized_duplicate_reserved` · `allowlist_stranger_create_rejected_storage_unchanged` (also a non-allowlisted account naming itself buyer, and an allowlisted account naming *another* buyer → `ERR_NOT_BUYER` unchanged) · `allowlist_member_creates` · `allowlist_has_no_mutation_path` (ABI/interface inspection: no method writes it) · `allowlist_non_creator_permissions_unchanged` (supplier/arbitrators not on the list complete accept → fund → … → withdraw) · `allowlist_root_layout` (exact bytes). Sandbox (genuine token): `allowlist_stranger_cannot_consume_slots` (25 junk attempts rejected, cap unaffected) · `allowlist_full_flow_with_non_listed_roles` · storage / gas re-measured. Exact error-code assertions as in LF-009.

## Founder conditions 2026-11-05 — additional disclosures
**State immutability is not code immutability.** No contract *method* can change the list, but any account holding a full-access key on the contract account can deploy new WASM, which can change any state (including the list, agreements and the logic that guards token transfers). Immutability therefore holds only while no deployment authority remains: OQ-06 (delete the contract account's full-access keys after deploy and verification) must be executed and shown (explorer: zero access keys) before the allowlist — or any other onchain guarantee — is described as permanent. Until then it is "immutable by the contract's own methods", not "immutable".

**Misconfigured allowlist — consequences.** (a) A required creator is missing: nobody can be the buyer for that account; existing agreements are unaffected; fix = redeploy. (b) A wrong or compromised account is listed: it can create agreements (as buyer only) and consume slots up to `max_agreements`; it gains no financial authority over any other agreement, and it cannot move tokens except as the buyer of its own agreements under the normal rules. (c) A typo in an account id that is still a valid id: that slot in the list is dead (same as (a) for the intended account). Init rejects only empty, oversized, duplicate, reserved and syntactically invalid entries; it cannot know whether an account exists or who controls it.

**Testnet redeployment procedure (no migration).** 1) Create a **new** contract account (never reuse/upgrade the old one while it holds funds). 2) Build the release WASM from the qualified commit and verify its sha256. 3) Deploy and call `new` with the corrected list in one reviewed transaction; check `get_config` (list, network, FT, treasury, cap). 4) Register the new account on the test token (`storage_deposit`). 5) Delete the new account's full-access keys after verification (OQ-06) and record the explorer evidence. 6) Point the frontend config to the new account. 7) The old contract is left as is: its agreements, claims and withdrawals keep working there; nothing is moved between contracts. 8) Record both account ids, WASM hashes and receipts in `18`.

**Out of scope for LF-010A:** any production-grade slot reclamation (e.g. freeing expired unaccepted proposals, option (d) in `25`).

**Unversioned state (AI review F6, 2026-11-05).** Root and agreement state are plain Borsh without a version tag and there is no migration. Deploying a newer WASM onto an account that already holds state (e.g. LF-010A's appended `creator_allowlist` onto an LF-009 account) makes every state read fail, including withdrawals, until the old code is redeployed. Rule: **never deploy a different WASM onto a funded or initialised account**; a new version always gets a new account (procedure above). The LF-014 deploy script must check the target account has no state before deploying.
