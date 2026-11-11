# LineFair web app — frontend architecture plan

**Status: PLANNED, NOT IMPLEMENTED.** Written 2026-11-01 (UTC) against `main` `d78b482` (contract `linefair-escrow 0.1.0 (lf-006)`).

**Update 2026-11-03 (LF-007 frontend slice, branch `frontend/m2-encoder-ui`):** the app skeleton now exists (S01, S02, S04 and the S08 settlement panel). It has been checked against `main` `cd6afa7` (`linefair-escrow 0.1.0 (lf-007)`) through committed read-only fixtures (`fixtures/contract-main`, `MANIFEST.json`) and the cargo-near ABI of that build (WASM sha256 `86b1a513…d5f2`). The builders were also run against that WASM on a **local sandbox** (`scripts/sandbox-lf007-demo.ts`, `evidence/frontend/sandbox-lf007-demo-*.log.txt`). That run used a local signer, **not wallet integration**. The wallet path (`lib/near/wallet.ts`) has still never signed a transaction against a deployed contract, so the §12 checklist is still open and the UI is still not functional.

**Update 2026-11-04 (LF-008 frontend slice + LF-009 preparation, branch `frontend/m2-encoder-ui`):** fixtures regenerated from `main` `b28d33b` (`linefair-escrow 0.1.0 (lf-008)`, WASM sha256 `40df085a…c645`, equal to `evidence/lf008/FINAL-VERIFICATION.md`). Added: `submit_ruling` / `trigger_fallback` builders, `NotRulingWindow` / `FallbackNotEligible` copy, `LineView.dispute_phase` + three phase starts, `lib/contract/arbitration.ts` (timeline, per-role ruling form, permissionless fallback with an exact preview equal to 17 Rust vectors) and `ArbitrationPanel`. Checked by: drift/ABI tests, a local-sandbox run of the builders against that WASM (`scripts/sandbox-lf008-demo.ts`, 55/55; **local sandbox, not wallet integration**) and an offline headless-Chrome DOM check of the rendered panel from fixture views (`browser-check/`, `scripts/browser-dom-check.ts`). LF-009 claim states (`lib/contract/withdrawals.ts`) are **spec-based and not ABI-verified**: they read only fields already in the main ABI; method/field names of `withdraw`, `get_withdrawal`, `custody_summary` and the `ERR_WITHDRAW` copy come from the frozen spec on `lf-009/withdrawals` `0a9e9f5` and are gated by a test that fails once the main ABI contains them. There is no withdraw builder or button. The wallet path still has never signed against a deployed contract; the §12 checklist is still open and the UI is still not functional.

**Update 2026-11-05 (LF-009 frontend slice, branch `frontend/m2-encoder-ui`):** fixtures regenerated from `main` `b66913f` (`linefair-escrow 0.1.0 (lf-009)`); the scratch-export build reproduced WASM sha256 `c3c896cb…efc2` (= `evidence/lf009/FINAL-VERIFICATION.md`). The LF-009 gate failed on the new fixture as designed (`evidence/frontend/lf009-fixtures-check-*-FAILED-1`) and was flipped to `abi-verified` only after every method, argument, field, log prefix and outcome was compared with the ABI / `lib.rs` (spec-vs-ABI differences: `withdrawals.ts` `LF009_SPEC_VS_ABI`). Added: `withdrawCall` (payable, exactly 1 yoctoNEAR, 100 Tgas; the 55 Tgas floor is re-derived from `lib.rs` in a test), `get_withdrawal` / `custody_summary` / token `storage_balance_of` reads, one-block snapshots (`lib/near/snapshot.ts`, `block_id` queries), verified `ERR_WITHDRAW` copy, `claimPanel` and `WithdrawalPanel` / `ClaimCard` on ALLOCATED lines. Claim display rules: withdraw only for the connected immutable recipient after a fresh re-read and a registration check; "Paid" only after a second, later snapshot confirms the same PAID record; the transaction's own result is shown as "reported by the transaction"; PENDING after the transaction ended = inconclusive with the permanent-limitation notice and no action; token balances never decide anything. Checked by: unit tests (88/88, incl. a 24 000-case exhaustive claim-panel sweep), an offline headless-Chrome DOM check of 13 claim scenarios (75 checks), and a local-sandbox run against the release WASM and the `test-starve-callback` build (`scripts/sandbox-lf009-demo.ts`, 54/54; **local sandbox, not wallet integration**). That run found and fixed a real bug: `NearRpc` rejected every real block header (u64 `timestamp` is a JSON number > 2^53), so `finalBlock()` had never worked against a node. The wallet path still has never signed against a deployed contract (the MyNearWallet redirect flow may also return no transaction result, in which case only the re-read counts); the §12 checklist is still open and the UI is still not functional.

**Update 2026-11-05 (withdrawal wording, founder decision 2026-11-05, branch `frontend/m2-encoder-ui`):** the claim cards now use four exact founder-approved messages (`withdrawals.ts` `WITHDRAWAL_MESSAGES`; §5.2): FAILED with the share restored → "The transfer failed. Your funds are available to withdraw again."; recipient not registered on the token (`storage_balance_of` null) → "Your account must be registered with this token before you can withdraw."; PENDING (incl. after the transaction finished or failed) → "Payment outcome unconfirmed. Do not retry this withdrawal."; PAID confirmed by the second-snapshot rule → "Payment completed successfully." ("Confirming the contract record…" before that). Each comes only from contract-state reads, never from a transaction result, browser event or token balance. Unit tests, the 24 000-case sweep and the headless-Chrome DOM check compare them by exact equality. The wallet path still has never signed against a deployed contract; the UI is still not functional.

**Update 2026-11-05T19:01Z (F3 on `main` `8ec0816`; no deployment, no transaction):** fixtures regenerated from `main` `8ec081679b4b5d4e1dbaaca54acd93cad0583b3b` (`linefair-escrow 0.1.0 (lf-012 f3)`); `git archive` scratch build reproduced release WASM sha256 `470db97b62cd04701e68f6a87d7589dd8af9b8d122b96e4f5e12788d4405f2e1` (code hash `5nN5ua65yntBYmNZC6JEtdWYBbbuBkVxuHC7GZxpBgcQ`, `evidence/frontend/main-wasm-abi-build-20261105T185734Z.log.txt`). Drift tests went RED (5/128) on the old pins before the update, as designed. `DeliveryTimeTooShort` is now in the fixture (31 LineError arms) and no refund code is mapped ahead (`ANTICIPATED_REFUND_CODES = []`). Startup check rejects the superseded `lf-010a` code hash and version. Preflight example config on `lf-011` (`fe3f40c`) pins the same artifact and forbids both starve builds and the superseded release. Checks: `evidence/frontend/f3-fixtures-frontend-check-20261105T190114Z.log.txt` (a `-FAILED-1` run is kept: the DOM check pinned the old base58).

**Update 2026-11-05 (LF-010A + real-wallet testnet preparation, branch `frontend/m2-encoder-ui`; no deployment, no transaction):** fixtures regenerated from `main` `2ccd058` (`linefair-escrow 0.1.0 (lf-010a)`); a `git archive` scratch build reproduced release WASM sha256 `1b024ec1…f53a` (code hash `2pS3pvSs…QuU5`, `evidence/frontend/main-wasm-abi-build-20261105T140630Z.log.txt`). The drift/ABI tests failed on the new fixture as designed (`lf010a-fixtures-check-*-FAILED-1`) and pass after mapping `ERR_CREATOR_NOT_ALLOWLISTED`, pinning the init-only `ERR_INIT_CREATOR_ALLOWLIST_{SIZE,DUPLICATE,RESERVED}` and adding `ConfigView.creator_allowlist`. **Startup check (fail closed):** `lib/deployment.ts` is the one place that records the accepted release (commit, `contract_version`, WASM sha256 → base58 code hash); `StartupGate` renders nothing interactive until RPC `status.chain_id`, `view_account(escrow).code_hash`, `contract_version()` and `get_config()` (network, token, allowlist shape) all match, and otherwise shows "LineFair will not start" with the reasons (mirrors the post-deploy checks of the founder's `deploy/testnet_preflight.py`). `VITE_FT_ID` is now required with `VITE_ESCROW_ID`. With no escrow configured the app stays a local preview. **Creation gate:** "Create agreement" is shown only to a connected account that is in the verified `creator_allowlist` and is the terms' buyer (`lib/creation.ts`, `CreateControl.tsx`); everyone else sees why (docs/28) and that supplier/arbitrator roles remain open. The contract stays the authority. Manual real-wallet script: `TESTNET_WALLET_TEST.md` (**not executed**). It records a blocker: the UI has no buttons yet for `accept_terms`, `accept_appointment`, funding `ft_transfer_call`, `submit_delivery`, `accept_line`, `open_dispute`, `advance_case` (builders exist), so demo steps 3–6 cannot be done in the UI. The wallet path still has never signed against a deployed contract; the UI is still not functional.

**Update 2026-11-05 (real-user lifecycle actions, founder authorization 2026-11-05, branch `frontend/m2-encoder-ui`; no deployment, no transaction):** the agreement page now offers every missing P0 action, built on the existing ABI-verified builders: `AcceptancePanel` (who has accepted from the contract's `acceptances`; `accept_terms` for buyer/supplier, `accept_appointment` for primary/backup, enabled only when the local re-encode == stored `terms_hash` == the `compute_terms_hash` view and the local validator passes at chain time, before the acceptance deadline) and, per line (`LineLifecycle`), funding via the token's `ft_transfer_call` (buyer only; exact principal, 1 yoctoNEAR, 30 Tgas, funding message v1; escrow `storage_balance_of` and buyer `ft_balance_of` read first; funding deadline and, when it binds, the F3 "last moment to fund" in UTC + local), `submit_delivery` (supplier; salted 32-byte evidence commitment computed in the browser per `docs/20` §Commitments, `lib/commitment.ts`; only the commitment is sent; the salt goes into a private receipt the supplier downloads), `accept_line` / `open_dispute` (buyer, inside `[submitted_at, submitted_at + review)`, end shown), and `advance_case` (anyone, only when the view reports `no_response_t0_ns` / `non_delivery_t0_ns`; fixed T0 explained). Pure rules in `lib/contract/lifecycle.ts` mirror `docs/06` / `agreement.rs` / `line.rs` (role × state × time; disabled actions carry a reason; other roles see a note and no button). Every action re-reads `get_agreement` right before signing, stores a non-secret pending-action hint, signs, then re-reads (bounded, ≤ 4 reads 1.5 s apart); the transaction's result is "reported by the transaction" until the re-read agrees. Funding: "Secured in escrow" only for `FUNDED` with `locked == principal`; an `UNFUNDED` line with `LF_FT_REFUND:<code>` in the receipts (JSON-RPC `tx`) shows "Nothing was credited. The deposit was returned." plus the reason (incl. `DeliveryTimeTooShort` → "Too late to fund: the supplier would have less than the review window to deliver.", mapped ahead of the F3 contract). Wallet return (`WalletReturnBanner`, `lib/near/walletReturn.ts`): `transactionHashes` / `errorCode` / `errorMessage` are read once, the hash is shown with an explorer link as "reported by the wallet", the parameters are stripped with `history.replaceState` (#route kept), then the contract is re-read. Draft editor: F3 fundability warning (not a validation error) when `delivery + grace < funding deadline + review` for a line. Checked by unit tests (lifecycle 14 incl. a 1 600-case role × state × time sweep, commitment 5, wallet return 4, ABI +2, RPC +1, errors +1, draft +1) and the offline headless-Chrome DOM check (three page loads: plain, `?transactionHashes=…`, `?errorCode=…`). The withdrawal flow and its four founder strings, the startup check and the creation gate are unchanged. **The wallet path still has never signed against a deployed contract; the UI is still not functional (§12).**

No UI exists. `apps/web` holds only `.keep`. Nothing in this document is functional, and no screen, flow or state may be described as working until the acceptance checklist at the end passes with real wallet signatures against a deployed sandbox or testnet escrow (`CLAUDE.md`; `18` G5). This plan is subordinate to `docs/00`–`docs/27`. Where it conflicts with them, they win. The inconsistencies found while writing it are listed in §11, not resolved here.

Source abbreviations: `04` = `docs/04_USER_JOURNEYS_AND_UX.md`, `lib.rs` = `contracts/escrow/src/lib.rs`, and so on.

---

## 1. Hard constraints (from `CLAUDE.md`, restated for the UI)
- NEAR **sandbox/testnet only**, plus one allowlisted NEP-141 test token. The contract's `get_config().network_id` is `sandbox` or `testnet`; mainnet init is rejected (`lib.rs` `ERR_INIT_NETWORK`, OQ-13). The UI refuses to start if the configured RPC, the contract's `network_id` and the wallet network disagree.
- The UI never labels anything **Paid** unless the contract reports it (`PAID` slot state from the authenticated callback, LF-009). It never says "Secured" before a credited deposit is visible in contract state (`19` §Critical UX copy).
- No secrets in the repo, the bundle or logs. No private keys in the browser beyond what the wallet holds. No `.env` with credentials committed.
- The operator never signs for users. There is no relayer in P0 (`25` §Transaction gas).
- The UI is human-designed and restrained (`19`, FD-13). It is not a default AI dashboard. It has no decorative wallet balances and no chat feature.
- Canonical financial state always comes from contract views. An indexer or backend is a cache and must be labeled as one (`05` §Security boundaries, `09` §Indexer reconciliation).

## 2. Proposed stack (all versions PENDING verification)
`21` rule: never invent versions. Every row below is a **candidate**. It becomes a pin only after it is installed with a lockfile, built, and recorded in `docs/21_TOOLCHAIN_LOCK.md` with command output (the frontend rows there are PENDING until LF-011).

| Concern | Candidate | Version | Notes |
|---|---|---|---|
| Runtime | Node + npm already on host | v24.15.0 / 11.12.1 (host-observed, `21`) | Confirm the framework supports it before pinning |
| Framework | Next.js (App Router) + React + TypeScript, per `05` §Proposed components | PENDING | Prefer static export or client components only. No server-side signing and no API routes that touch funds |
| Wallet | NEAR Wallet Selector (`@near-wallet-selector/*`) with 1–2 testnet wallet modules | PENDING | Verify the current official package names, the testnet support and the `signAndSendTransaction` semantics from the official repo at pin time. Do not assume API shapes |
| RPC client | `near-api-js` or the provider bundled with the wallet selector | PENDING | Only `query` (`call_function` views), `block` and `tx` status are needed |
| SHA-256 | WebCrypto `crypto.subtle.digest("SHA-256")` | browser built-in | No dependency. Node test runner uses `node:crypto` |
| Terms encoder | Own code in `packages/shared-schemas` (see `packages/shared-schemas/TS_ENCODER_TEST_PLAN.md`) | — | No Borsh library is required. A hand-written encoder of the frozen layout is smaller and easier to audit. Using a library is a proposal that needs separate verification |
| Styling | Plain CSS modules or one small utility layer | PENDING | Tokens from `19` palette. No component kit that imposes a generic dashboard look |
| Unit tests | `node:test` (built-in) or Vitest | PENDING | See the TS test plan |
| E2E | Playwright against a local sandbox | PENDING | Only after LF-009 |

Low-dependency rule (`CLAUDE.md`): every added package needs a reason, a pinned exact version, a lockfile entry and a licence check (LF-015 MIT condition).

## 3. Module layout (proposal; nothing exists)
```text
apps/web/
  app/                        # routes = screens S01–S11 (§4)
    page.tsx                  # S01 agreement list
    agreements/new/           # S02 draft + line editor
    agreements/[id]/          # S04 detail/timeline (hosts S03, S05–S09 as panels)
    agreements/[id]/receipt/[tx]/  # S10 receipt
    demo/                     # S11 judge overview (real data only)
  components/                 # MoneyState, LineCard, TxDrawer, NetworkBanner, Countdown, ErrorCard
  lib/
    config.ts                 # network, rpc url, escrow id, ft id (public values only; no secrets)
    near/rpc.ts               # view calls: get_agreement, get_config, compute_terms_hash,
                              #   outstanding_liabilities, contract_version; FT views
    near/wallet.ts            # wallet selector setup; signAndSendTransaction wrapper
    near/tx.ts                # builds FunctionCall actions; gas/deposit constants (§6)
    contract/types.ts         # mirrors lib.rs views exactly (AgreementView, LineView, ConfigView, ...)
    contract/states.ts        # money-state derivation (§5); pure, unit-tested
    contract/errors.ts        # ERR_* / LF_FT_REFUND:* → user copy (§8); pure, unit-tested
    funding/message.ts        # funding msg v1 builder (§6)
packages/shared-schemas/
  src/terms/                  # strict JSON parser, validator, encoder, digest (TS plan)
  vectors/terms_v1.json       # Rust-generated; read-only for TS
```
Rule: `contract/states.ts` and `contract/errors.ts` are pure functions over view JSON. They are the only place that turns contract strings into user copy, so they can be tested exhaustively without a browser.

## 4. Contract-method map per screen
Every LineFair method is **non-payable** today: attached NEAR is rejected (`lib.rs` header comment; near-sdk default for methods without `#[payable]`). The only deposit the UI attaches is **exactly 1 yoctoNEAR on the token's `ft_transfer_call`** (NEP-141 requirement; `sandbox_ft_funding.rs` uses `.deposit(1 yocto)`). The future `withdraw` is planned to need 1 yocto as well (`25` §line 83); see §11 item 1. `new` is `#[init] #[private]` (deploy-time, operator only) and is never called from the UI.

Views (no signer): `get_agreement(agreement_id: U64) -> Option<AgreementView>`, `get_config() -> ConfigView`, `compute_terms_hash(terms) -> String`, `outstanding_liabilities() -> U128`, `contract_version() -> String`. Token views: `ft_balance_of`, `storage_balance_of`, `storage_balance_bounds`, `ft_metadata` (NEP-141/145; to be confirmed against the pinned test FT, `21`).

| Screen (`04`) | Reads | Signed call (signer role) | Contract / check |
|---|---|---|---|
| S01 Agreement list | `get_config` (network, FT, `agreements_created`), `get_agreement(id)` for ids `0..agreements_created` | — | No list view exists; iterate ids (≤ 25, `MAX_AGREEMENTS_LIMIT`). Filter client-side by the connected account's role in `terms` |
| S02 Draft + line editor | `get_config` (FT id, treasury id for the distinctness check, network), latest block timestamp | `create_agreement(terms: AgreementTermsJsonV1) -> U64` — **buyer** (`ERR_NOT_BUYER` otherwise) | Before signing: local parse+validate+encode, then `compute_terms_hash(terms)` view must equal the local digest (§7). Creation does **not** imply buyer acceptance (`03` S3 review) |
| S03 Terms sign-off (fallback emphasis) | `get_agreement(id)` → `terms`, `terms_hash`, `acceptances`, `accelerated_test_timing` | `accept_terms(agreement_id, terms_hash)` — **buyer, supplier**; `accept_appointment(agreement_id, terms_hash)` — **primary, backup arbitrator** | Re-encode `terms` locally; digest must equal both `terms_hash` and `compute_terms_hash(terms)` before the button is enabled. Show per-line fallback bps and the exact token split `floor(P·S/10000)` / remainder (FD-04, `07` §Allocation formula). Disabled when `now ≥ acceptance_deadline_ns` |
| S04 Detail / timeline | `get_agreement(id)`, `outstanding_liabilities`, FT `ft_balance_of(escrow)` | — | Shows status (`PROPOSED`/`EXPIRED`/`AGREED`/`ACTIVE`), lines, deadlines in UTC and local time (`08`), reconciliation (§5.3) |
| S05 Funding per line | `get_agreement(id)` (line `UNFUNDED`, principal, `terms_hash`), FT `storage_balance_of(escrow)`, `ft_balance_of(buyer)` | **token** `ft_transfer_call(receiver_id=escrow, amount=P, msg=v1)` — **buyer**, 1 yocto, ≥ 30 Tgas | §6. Success is judged only by a re-read of the line, not by tx status |
| S06 Supplier delivery | `get_agreement(id)` | `submit_delivery(agreement_id, line_id, evidence_commitment)` — **supplier** | Line `FUNDED`, `now < delivery_deadline_ns + delivery_grace_period_ns`. Commitment = 64 lowercase hex salted digest (`20` §Commitments). Salt and file stay off chain (LF-012) |
| S07 Buyer review | `get_agreement(id)` (`submitted_at_ns`, `review_window_ns`) | `accept_line(agreement_id, line_id)` or `open_dispute(agreement_id, line_id)` — **buyer** | Only while `now < submitted_at_ns + review_window_ns` (`08` half-open). After that, show `no_response_t0_ns` eligibility; the transition method `advance_case` is **PROPOSED, not implemented** (`06`) |
| S08 Dispute + proposed split | `get_agreement(id)` (`dispute_reason`, `dispute_t0_ns`, `proposal_*`, `allocation_*`), latest final block timestamp | **LF-007 (on main):** `propose_split(agreement_id: U64, line_id: u32, buyer_amount: String, supplier_amount: String) -> U64`, the **buyer or supplier**. `accept_split(agreement_id, line_id, proposal_id: String, buyer_amount: String, supplier_amount: String)`, the **counterparty of the proposer**. Arbitrator rulings and fallback (LF-008) are not on main and are not offered | `SettlementPanel.tsx`, `contract/settlement.ts`. Offered only on a DISPUTED line with no allocation when chain time ≥ `dispute_t0_ns`. Input uses strict token decimals and is never rounded. B + S must equal P exactly, and zero legs are allowed. Accepting re-reads `get_agreement` first and signs only if the freshly read id and both amounts equal what the user reviewed (`recheckBeforeAccept`). The outcome is shown only from a re-read. Shown only when the terms hash verifies locally |
| S09 Claim withdrawal + FT storage check | `get_agreement(id)` (claimable/pending/paid, slot states), FT `storage_balance_of(beneficiary)` | **None yet.** `withdraw` and its private callback are LF-009 | Read-only until LF-009. Storage check is a token view only |
| S10 Testnet receipt | RPC `tx` status by hash + signer, explorer link | — | Link only after a verified final receipt (`04` §UX conditions). Show actor, amount, token, network, state |
| S11 Judge demo overview | Same reads as S04 for the demo agreement | — | Real chain data only. Accelerated windows labeled "Accelerated timing — test only" (`08`, from `accelerated_test_timing`) |

Signer-role checks are advisory in the UI (hide/disable buttons). The contract enforces them (`ERR_LINE:NotAuthorized`, `ERR_ACCEPT:NotAuthorizedForMethod`, `ERR_NOT_BUYER`).

## 5. Money-state vocabulary (exact mapping to `LineView`)
`LineView.status` ∈ `UNFUNDED | FUNDED | SUBMITTED | DISPUTED | ALLOCATED` (`line.rs`). Slot states `buyer_withdrawal` / `supplier_withdrawal` ∈ `EMPTY | PENDING | PAID | FAILED`. Amounts are `U128` decimal strings, parsed with `BigInt` only and never `Number` (`07` header).

### 5.1 Line state → label
| Contract condition | Label (copy source) | Never say |
|---|---|---|
| `UNFUNDED` | "Not funded" + `04` warning: "Not funded: this deliverable is not payment-protected. Do not begin work on the assumption that escrow exists." | "Secured", "Pending payment" |
| funding tx sent, line still `UNFUNDED` on re-read | "Funding transaction processing" (`04` step 3) | "Secured" |
| `FUNDED` and `locked == principal` | "Secured in escrow" (`19`: only after a recognized FT deposit) | "Paid" |
| `SUBMITTED` | "Under review" with countdown to `submitted_at_ns + review_window_ns` | "Accepted" |
| `SUBMITTED`, `no_response_t0_ns` present | "The review window has ended. This line enters the agreed dispute process; funds are not automatically paid." (`04`) | "Auto-approved" |
| `FUNDED`, `non_delivery_t0_ns` present | Delivery deadline passed; non-delivery dispute eligible (`06` PROPOSED) | "Refunded" |
| `DISPUTED` | "Disputed — secured", with the line and exact `locked` amount (`19`) and reason (`BUYER_DISPUTE` / `NO_RESPONSE` / `NON_DELIVERY`) | "Frozen by LineFair" |
| `ALLOCATED`, beneficiary `*_claimable > 0`, slot `EMPTY` | "Ready to withdraw" (`04` step 5, `19`) | **"Paid"** |

### 5.2 Withdrawal slot → label (per beneficiary; LF-009 makes these reachable)
| Slot | Ledger | Label |
|---|---|---|
| `EMPTY` | `claimable > 0` | "Ready to withdraw" |
| `PENDING` | `pending > 0` | **"Payment outcome unconfirmed. Do not retry this withdrawal."** (founder decision 2026-11-05; was "Processing — outcome unconfirmed") + limitation notice once the transaction has ended + receipt link if known (`27` item 5). No retry button. Never the paid message, never "Ready to withdraw". The contract cannot tell an in-flight transfer from an inconclusive one, so both use this label |
| `PAID` | `paid > 0`, `pending == 0` | **"Payment completed successfully."** (founder decision 2026-11-05; was "Paid") + explorer receipt, only after a second, later snapshot confirms the same PAID record; "Confirming the contract record…" until then. This is the only path to a paid message (`19`, `27` item 2) |
| `FAILED` | `claimable > 0` again | **"The transfer failed. Your funds are available to withdraw again."** (founder decision 2026-11-05; was "Transfer failed — amount restored", itself changed 2026-11-04 from "Action required — retry", `04` step 7): no tokens left the escrow, the claim was restored exactly once by the authenticated callback, and a new withdrawal is possible. The UI uses the stricter share-based `withdrawals.ts claimState` (the whole share must sit in the one bucket that matches the slot, else incident) |
| any withdrawable slot, recipient not registered on the token | `storage_balance_of(recipient)` = null | **"Your account must be registered with this token before you can withdraw."** (founder decision 2026-11-05), followed by the `storage_deposit` how-to; the withdraw button is disabled |

Lines are independent. There is no agreement-level "Paid" (`06` §Line money: "Never add a global PAID Boolean").

### 5.3 Reconciliation display (Rule B, `07`; `27` R-2)
- **E** = `outstanding_liabilities()` = Σ (locked + claimable + pending) over all lines of all agreements. Paid is excluded.
- **O** = token `ft_balance_of(escrow_id)`.
- Show both, with block height and observation time. `O == E`: "Balanced". `O > E`: "Uncredited surplus of O − E (direct transfers or refunds in flight; never credited or swept)" — **observation only**. `O < E`: "Shortfall — incident", with a link to `13`.
- O is never used to infer, display or change a withdrawal outcome (`07` Rule B table, `27` item 3). A PENDING withdrawal stays "Payment outcome unconfirmed. Do not retry this withdrawal." whatever O shows.
- O and E are read in two separate RPC calls, so they may straddle a block. Read both at the same `block_id` (RPC `query` with `block_id`) or label the result "not atomic".

### 5.4 Display rules
- Format base units to token decimals from `ft_metadata` using BigInt division and remainder only, and show the raw base units on hover. Never use floats (`07`).
- Stale data: every panel shows the block height it was read at, and a "refreshing" state is never styled like a completed state (`04`, `19`).
- Status always has text plus an icon, never colour alone (`19`).

## 6. Funding flow (S05)
Contract path: `ft_on_transfer` (`lib.rs`) checks predecessor == allowlisted FT, then parses the msg strictly, then checks that the agreement exists, then `terms_hash` equality, then `fund_line` (agreement AGREED/ACTIVE, sender == buyer, line UNFUNDED, `now < funding_deadline_ns`, `amount == principal`), then Rule B `checked_add`. It returns `U128(0)` when credited and the full amount otherwise, logging `LF_FT_REFUND:<code>`.

1. Preconditions shown before the button: agreement `AGREED` or `ACTIVE`; connected account == `terms.buyer_id`; line `UNFUNDED`; `now < funding_deadline_ns`; escrow registered on the token (`storage_balance_of(escrow)` not null; the operator registers it, `25`); buyer token balance ≥ P.
2. Message v1 (`schemas/ft-funding-message-v1.schema.json`, FROZEN; `funding.rs`). Minified, exact keys, no extras:
   `{"version":1,"agreement_id":"<canonical u64 decimal>","line_id":<0|1|2>,"terms_hash":"<64 lowercase hex>"}`
   `agreement_id` is a string, `line_id` is a JSON integer, and `terms_hash` is the stored `get_agreement(id).terms_hash`, cross-checked against the local re-encode (§7).
3. Transaction: receiver = **token contract** (`get_config().allowlisted_ft_id`), method `ft_transfer_call`, args `{receiver_id: <escrow>, amount: "<P>", msg: <v1 string>}` (`memo` omitted), **deposit exactly 1 yoctoNEAR**, **gas ≥ 30 Tgas** (`25` LF-005: ≈ 6.21 Tgas burnt, failure ≤ 9.0 Tgas, success ≥ 9.5 Tgas; frontend attaches ≥ 3× measured). Proposed constant `FUND_GAS = 30 Tgas`. Re-measure on testnet at LF-014 (`21` finding 2).
4. Outcome. Tx success is **not** funding success, because a refunded deposit is still a successful transaction. Funding counts as credited only if (a) the `ft_transfer_call` return value (used amount) equals P, **and** (b) a fresh `get_agreement` shows the line `FUNDED` with `locked == P`. If the used amount is `"0"` or a log `LF_FT_REFUND:*` is present, show the refund copy (§8). A timeout is not a failure (`07` §Async gotchas): show "Funding transaction processing" and re-poll.
5. One line per transaction (FD-03). No batching of several lines into one wallet confirmation in P0.

## 7. Client-side terms encoding and pre-signature verification
Specification: `20` §Canonical terms encoding v1 (FROZEN). Test plan: `packages/shared-schemas/TS_ENCODER_TEST_PLAN.md`. The Rust implementation is the reference.

- **Create (S02).** Build `AgreementTermsJsonV1` → strict-parse it with the TS parser (same rules as `terms_json.rs`) → validate it with context `{now_ns: latest block timestamp, escrow_id, allowlisted_ft_id, operator_treasury_id}` from `get_config` → encode the preimage → SHA-256. Then call view `compute_terms_hash(terms)`. The wallet prompt is offered **only if the two digests are equal**. Local validation is a usability pre-check. The contract re-validates with its own clock, which may reject when the acceptance deadline is close.
- **Accept (S03).** From `get_agreement(id)`, re-encode `terms` locally. Require local digest == `terms_hash` == `compute_terms_hash(terms)`. Then display the decoded terms (the human-readable view comes from the same parsed struct that was hashed) and sign `accept_terms` / `accept_appointment` with that hash. Any mismatch blocks signing and shows "Terms could not be verified. Do not sign." `compute_terms_hash` does not validate, so the local validator also runs.
- **Fund (S05).** The funding msg uses the hash verified in the previous step.
- `network_id` and `escrow_id` come from `get_config().network_id` and the configured contract account. Both are in the preimage, so a wrong escrow id produces a mismatch rather than a wrong signature (`20` T063/T064).
- Commitments (criteria, evidence) are computed client-side with a CSPRNG salt of ≥ 32 bytes (`20` §Commitments). Salts and plaintext never go to chain, logs or analytics (`09`). How the salt is stored and recovered belongs to LF-012 and is out of scope here.

## 8. Error-code mapping
Panics surface as `FunctionCallError`/`ExecutionError` strings containing the code. Parse by **exact code token** (regex `\b(ERR_[A-Z_]+(?::[A-Za-z]+)?)\b`), never by free text. Unknown codes fall back to "The contract rejected this action (code shown). Nothing was changed." because every rejected call reverts.

| Code (source) | Meaning | Recommended next action (`19`: error cards include one) |
|---|---|---|
| `ERR_TERMS_PARSE:{Json,InvalidAccountId,NonCanonicalDecimal,DecimalOverflow,InvalidCommitmentHex}` (`terms_json.rs`) | Terms JSON rejected at the edge | Indicates a client bug, because the local parser should have caught it. Block and report |
| `ERR_TERMS_INVALID:{UnsupportedSchemaVersion,UnsupportedDeadlineRulesVersion,FtNotAllowlisted,RolesNotDistinct,RoleIsReservedAccount,AcceptanceDeadlineNotInFuture,FundingDeadlineBeforeAcceptance,DeliveryGraceOutOfRange,WindowOutOfRange,LineCountOutOfRange,LineIdMismatch,ZeroPrincipal,BpsOutOfRange,BpsSumInvalid,DeliveryDeadlineBeforeFunding,SubmissionCutoffOverflow,PhaseScheduleOverflow,PrincipalSumOverflow}` (`terms.rs`) | Cross-field rule failed | Field-specific fix in S02. `AcceptanceDeadlineNotInFuture` → "choose a later acceptance deadline" |
| `ERR_NOT_BUYER` | Creator ≠ `buyer_id` | Connect the buyer account |
| `ERR_AGREEMENT_CAP_REACHED` | `max_agreements` reached (≤ 25) | Demo capacity exhausted; contact operator |
| `ERR_DUPLICATE_TERMS` | Identical preimage already registered (T078) | Change `agreement_nonce` |
| `ERR_AGREEMENT_TOO_LARGE`, `ERR_STORAGE_ACCOUNTING`, `ERR_AGREEMENT_ID_OVERFLOW` | Storage/id guards | Report to operator |
| `ERR_TERMS_HASH_FORMAT` | Hash not 64 lowercase hex | Client bug; block |
| `ERR_AGREEMENT_NOT_FOUND` | Unknown id | Re-check link |
| `ERR_ACCEPT:{NotAuthorizedForMethod,AcceptanceDeadlinePassed,TermsHashMismatch,AlreadyAccepted}` (`agreement.rs`) | Acceptance rejected | Wrong account/method, expired, terms differ ("do not sign; re-verify"), or already done |
| `ERR_EVIDENCE_COMMITMENT_FORMAT` | Commitment not 64 lowercase hex | Client bug; block |
| `ERR_LINE:{LineNotFound,AgreementNotAgreed,NotAuthorized}` (`agreement.rs` `LineOpError`) | No such line, agreement not agreed, or wrong signer (arbitrators included, for `propose_split` / `accept_split`) | Refresh / connect the account named for this role |
| `ERR_LINE:{WrongState,FundingDeadlinePassed,SubmissionDeadlinePassed,ReviewWindowClosed,BeforeWindowStart,DeadlineOverflow,NotEligible,NotAdvanceable,AmountMismatch,ZeroCommitment}` (`line.rs` `LineError`, LF-005/006/006b) | Line transition rejected | Refresh the line. `ReviewWindowClosed` → explain the NO_RESPONSE path. `SubmissionDeadlinePassed` → explain the NON_DELIVERY path. `BeforeWindowStart` on a settlement → chain time is before T0 |
| `ERR_LINE:{AllocationSumMismatch,NoActiveProposal,StaleProposal,ProposalMismatch,OwnProposal,AlreadyFinalized,ProposalNonceOverflow}` (`line.rs`, LF-007) | Settlement rejected. Nothing is proposed, accepted or moved | Sum ≠ P → fix amounts. No open proposal / stale id / different amounts → "Nothing was accepted. Reload and decide again". Own proposal → only the other party can accept. Already finalized → show the recorded allocation. Nonce overflow → incident |
| `ERR_LINE:{InvalidDecisionMode,FallbackMismatch,NothingToWithdraw,WithdrawalAlreadyPending,NonMonotonicWithdrawalId,WithdrawalNotPending,WithdrawalIdMismatch,EpochOverflow,Ledger,Split,InvariantViolated}` (`line.rs`) | Not reachable from any public method on main with valid input (internal or LF-008/009) | Explicit copy, severity incident or "do not retry". Never success |
| `ERR_AMOUNT_FORMAT:{NonCanonicalDecimal,DecimalOverflow}` (`lib.rs` `amount()` / `parse_u64` → `terms_json.rs` `ParseError::code()`) | `buyer_amount` / `supplier_amount` / `proposal_id` not a canonical decimal (no sign, no leading zeros, no fraction) or out of range | NonCanonicalDecimal is an app bug, because the builders refuse such values; block it. Overflow → check amounts. The other `ParseError` codes (`Json`, `InvalidAccountId`, `InvalidCommitmentHex`) are not produced by these parsers and fall back to app-bug copy |

**Drift check:** `src/lib/contract/errors.test.ts` extracts every string returned by `LineError::code()` and `LineOpError::code()` (28 + 3) and by `ParseError::code()`, plus every `fail("<AREA>"` area and literal `ERR_*` panic in `lib.rs`, from the committed fixture copy of `main` `cd6afa7`. It fails if any of them lacks a mapping. It also fails if a fixture file's sha256 differs from `MANIFEST.json`. To move to a newer `main`, regenerate the fixtures with the commands in `MANIFEST.json`.
| `ERR_INIT_*` | Deploy-time only | Not shown in UI |

Funding refunds are **not panics**. They are logs `LF_FT_REFUND:<code>` on a successful receipt, with the used amount 0. Codes: `UnexpectedToken`, `MsgJson`, `MsgVersion`, `MsgAgreementIdNonCanonical`, `MsgAgreementIdOverflow`, `MsgLineIdOutOfRange`, `MsgTermsHash`, `AgreementNotFound`, `TermsHashMismatch`, `LineNotFound`, `AgreementNotAgreed`, `NotAuthorized`, `WrongState`, `FundingDeadlinePassed`, `AmountMismatch`, `CustodyOverflow` (and any other `LineError` code). All of them map to the `04` copy: "Deposit was not accepted. Verify token, exact amount, and deadline before trying again. Check the token transaction before another attempt." The specific reason is added below it, and the copy says that the token's resolver returns the amount to the buyer. `CustodyOverflow` is unreachable with a standard token (`07`) and is shown as an incident if it ever appears.

## 9. Out of scope until the named ticket lands
| Ticket | What the UI must not offer before it lands |
|---|---|
| ~~LF-006b~~ | **On main.** `advance_case` is offered (2026-11-05) to any connected account, only when the view reports `no_response_t0_ns` / `non_delivery_t0_ns`, subject to §12 |
| ~~LF-007~~ | **Landed on main `cd6afa7`**. Propose/accept split is offered (S08), subject to §12 (no wallet signature yet) |
| ~~LF-008~~ | **Landed on main `b28d33b`**. Timeline, ruling form (only the arbitrator whose window the view reports open) and fallback button (anyone, FALLBACK only) are offered (`ArbitrationPanel`), subject to §12 (no wallet signature yet) |
| LF-009 | `withdraw` (no builder, no button), every PENDING/PAID/FAILED transition, `get_withdrawal` / `custody_summary` reads, FT storage check as a precondition for withdrawal. Labels and spec types exist in `withdrawals.ts` (spec-only, gated) |
| LF-011 | The app itself, wallet pinning, the `21` frontend rows |
| LF-012 | Evidence upload/download, salt custody, NEAR challenge-signature auth (`09`) |
| LF-013 | Dispute timelines and resolution approval screens |
| LF-014 | Any testnet deployment, real explorer receipts, testnet account ids |

Until LF-009, S09 and the PENDING/PAID labels exist only as unit-tested mapping code with fixture views. They are never shown as live behaviour.

## 10. Risks
| Risk | Mitigation |
|---|---|
| TS encoder diverges from Rust → user signs a hash for different terms | Byte-for-byte vector suite plus a live `compute_terms_hash` cross-check before every signature (§7, TS plan) |
| `JSON.parse` loses u64/u128 precision or silently keeps duplicate keys | Custom strict parser; BigInt only (TS plan) |
| Refunded deposit shown as success | Used-amount check plus line re-read (§6.4) |
| PENDING withdrawal shown as Paid or retryable | Single mapping module, exhaustive tests, no retry control (§5.2) |
| Surplus O > E misread as customer money or as payout proof | Observation-only copy; never feeds state (§5.3) |
| Wallet selector API drift | Pin exact versions; verify against the official repo at LF-011; wrap in `lib/near/wallet.ts` |
| Gas too low on testnet (sandbox 2.13.4 vs testnet 2.14.x) | 30 Tgas floor; re-measure at LF-014 (`21` finding 2) |
| Stale indexer shown as canonical | Views only for money states; block height on every panel |
| Clock skew: browser time vs chain time | Use the latest block timestamp for countdowns and pre-checks; the contract decides |
| Accidental mainnet | Network triple-check (§1); contract rejects mainnet at init |
| Private data leakage | No business text on chain; only commitments; no analytics on evidence routes (`09`) |
| Agreement list scaling | Fine for ≤ 25 ids; an indexer is optional and cache-only (`05`) |

## 11. Inconsistencies observed (recorded, not fixed)
1. **Payable methods.** `lib.rs` says every method rejects attached NEAR (true today). `25` line 83 says that `withdraw` (LF-009) will require exactly 1 yoctoNEAR. The UI map must change at LF-009.
2. **Agreement status comment.** `AgreementView.status` doc comment in `lib.rs` lists `PROPOSED`, `EXPIRED`, `AGREED`, but `agreement.rs` also returns `ACTIVE` after the first funding.
3. **Line state names.** `06` names `NO_RESPONSE` and `DISPUTED_NON_DELIVERY` as line states and `CLAIMABLE → WITHDRAW_PENDING → PAID_CONFIRMED` as claim states. The contract uses `DISPUTED` + `dispute_reason` and slot states `EMPTY/PENDING/PAID/FAILED`. The UI follows the contract strings.
4. **Withdrawal copy.** `04` uses "Processing transfer" and, for inconclusive, "Transfer status cannot be verified yet…". `19` uses "Transfer processing". `27` item 5 (later, binding for OQ-01) uses "Processing — outcome unconfirmed". This plan uses the `27` wording for every PENDING slot.
5. **Views named in `27`** (`get_withdrawal(id)`, `custody_summary()`) do not exist yet. `outstanding_liabilities()` is the implemented E view.
6. **Agreement CLOSED** (`06`) and unfunded-line expiry are not represented in contract state yet.

7. **`docs/06` LF-007 heading is stale.** On `main` `cd6afa7` it still reads "branch `lf-007/mutual-settlement`, not merged". The code is on `main` (`8957408`).
8. **Check order differs from `docs/06`.** The table lists the canonical-decimal check after the state checks. In `lib.rs` the amounts (and `proposal_id`) are parsed **before** the agreement or line is looked up. A malformed amount on any line, or on a missing agreement, therefore yields `ERR_AMOUNT_FORMAT:*`, not `WrongState` / `ERR_AGREEMENT_NOT_FOUND`. The UI handles both.
9. **`lib.rs` crate doc is stale.** It lists only LF-005/LF-006 line transitions and does not mention `advance_case` / `propose_split` / `accept_split`. Comment only.
10. **Never-accepted OPEN proposal on an ALLOCATED line.** This can only arise after LF-008 (a ruling or fallback while a proposal is open). `get_agreement` then keeps `proposal_status: OPEN`. The UI labels it "Proposal #n not accepted" and offers nothing, and `accept_split` would fail with `AlreadyFinalized`.

11. **`docs/06` LF-008 heading is stale.** On `main` `b28d33b` it reads "branch `lf-008/timed-arbitration`, not merged"; the code is on `main`.
12. **`BEFORE_T0` phase string.** `deadlines.rs DisputePhase` has `BEFORE_T0`; `docs/06` and the `LineView.dispute_phase` doc comment list only `NONE / NEGOTIATION / PRIMARY / BACKUP / FALLBACK`. Unreachable for a stored DISPUTED line; the UI treats it as an incident.
13. **Phase view swallows an overflow.** `get_agreement` builds the phase with `a.dispute_phase(..).ok().flatten()`, so a (validation-prevented) `DeadlineOverflow` would show a DISPUTED line with `dispute_phase: NONE` and null starts instead of an error. The UI treats DISPUTED + `NONE` as an incident.
14. **`get_withdrawal` key.** `27` item 3 names `get_withdrawal(id)`; the LF-009 spec keys it by `(agreement_id, line_id, beneficiary)` (spec design choice 1, awaiting founder confirmation). `withdrawals.ts` follows the spec, unverified.
15. **LF-009 rejection codes.** The spec names `ERR_WITHDRAW:{DepositMustBeOneYocto, InsufficientGas, BadBeneficiary, IdOverflow}` and `ERR_LINE:NotAuthorized`, but not the codes for "not ALLOCATED", "slot PENDING" or "claimable 0". `line.rs` on main already has `NothingToWithdraw` / `WithdrawalAlreadyPending` (mapped in `errors.ts`); whether `withdraw` surfaces them is unknown until the ABI lands.
16. **FAILED copy.** `04` step 7 says "Action required — retry"; the founder brief for this slice asks for failed-and-restored. The UI now says "Transfer failed — amount restored" (§5.2). **→ Resolved by founder decision 2026-11-05:** the exact text is "The transfer failed. Your funds are available to withdraw again." (also fixed: PENDING, not-registered and confirmed-PAID wording, §5.2).
17. **(LF-009, resolves 1, 5, 14, 15.)** `withdraw` is the only payable method (exactly 1 yocto); `get_withdrawal(agreement_id, line_id, beneficiary)` and `custody_summary()` exist; `withdraw` surfaces `ERR_LINE:NotAuthorized` / `WrongState` / `WithdrawalAlreadyPending` / `NothingToWithdraw` / `LineNotFound` and `ERR_AGREEMENT_NOT_FOUND` (sandbox-verified for NothingToWithdraw, NotAuthorized, WithdrawalAlreadyPending, ERR_AGREEMENT_NOT_FOUND and four `ERR_WITHDRAW` codes).
18. **Frozen spec prose vs merged ABI** (`withdrawals.ts` `LF009_SPEC_VS_ABI`): `withdraw` returns the callback's `WithdrawalResultView`, not a bare id; `custody_summary.last_withdrawal_id` (spec: next), `ft_contract_id` (spec: FT id); extra `ERR_WITHDRAW:OpenCountOverflow` / `CallbackNotPrivate`; extra logs `LF_WITHDRAWAL_INCONCLUSIVE:<id>` and `LF_INCIDENT:OpenCountUnderflow:<id>`.
19. **`docs/27` R-2 section text** (lines 26–31) still describes `reconcile_withdrawal`, a lock and a balance-based PAID, while item 3 and the founder decision (2026-10-27) make R-2 observation-only with no reconciliation method. The UI follows item 3: nothing is ever labelled from balances.
20. **§12 checklist item "FAILED shows 'Action required — retry'"** conflicts with the founder brief and item 16; the UI says "Transfer failed — amount restored" and offers "Withdraw again". The checklist wording needs founder confirmation. **→ Resolved by founder decision 2026-11-05;** the §12 item now uses the approved strings.
21. **`evidence/lf009/FINAL-VERIFICATION.md` header** says "not merged, not pushed" although `main` `b66913f` contains it (record written before the merge).
22. **Inconclusive transaction status.** With the starve build the `withdraw` transaction ends as a Failure with no `ERR_*` code while the token transfer succeeded (sandbox log). A wallet will show this as "failed"; the UI therefore never maps a failed transaction to "nothing changed" for withdraw, and only the re-read record decides (PENDING → inconclusive).
23. **Final-finality lag.** Views at `final` lag a just-executed call by a block or two (sandbox: `storage_balance_of` still null right after `storage_deposit`). The panel keeps the action disabled until its bounded post-transaction re-reads see a new withdrawal id that is not PENDING.
24. **(LF-010A) `docs/30` (internal testnet demo plan, not published) "Verified ABI" line** says the fixtures are from `main` `b66913f`; they are now from `2ccd058` (this update). Re-run before the demo if the deploy commit differs.
25. **`docs/30` (internal testnet demo plan, not published) step 3** lists only supplier, primary and backup as accepting; the buyer must also call `accept_terms` (creation is not acceptance: `AgreementV1::propose` starts with all acceptances false). `TESTNET_WALLET_TEST.md` step 3 includes the buyer.
26. **`deploy/testnet_preflight.py`** (referenced by the task brief as "on main") is not on `main` `2ccd058`; it exists only as an untracked file in the main checkout. The startup check mirrors its post-deploy checks (chain id, code hash, `contract_version`, `get_config`), not its balance, access-key or FT-registration checks, and not the pinned test-token code hash (`c26d0ac1…b78d`, `docs/30` (internal testnet demo plan, not published)).
27. **`new` is `#[init] #[private]`** in the ABI (only the contract account itself can initialise). §4 says "operator only"; it is the contract account, in the deployment transaction.
28. **Unused legacy labels.** `states.ts` `withdrawalLabel` (used only by tests, not by any screen) still returns "Ready to withdraw" and "Paid"; the screens use `withdrawals.ts` (`Claimable — allocated, not paid`, founder strings). `04` step 5 still says "Ready to withdraw". Not changed here.
29. **Startup check runs once per page load.** A redeploy onto the configured account while a page is open is not detected until reload (docs/28 forbids redeploying onto a funded account; F6).
30. **(2026-11-05) MyNearWallet 10.1.4 signs in a popup, not a redirect.** The installed module opens `window.open(<wallet>/sign?…&callbackUrl=<this page>)` and waits for a `postMessage`; the wallet's callback (`?transactionHashes=…` / `?errorCode=…`) therefore loads this app inside the popup. Earlier text here and in `TESTNET_WALLET_TEST.md` said "redirecting the page". The wallet-return banner handles both; which one happens is to be recorded in the real run.
31. **Wallet library post-processing may throw after a successful signature.** `signAndSendTransactionsMNW` returns `provider.txStatus(hash, "unused", "NONE")`; if that RPC call fails, `signAndSend` throws although the transaction exists. The new panels map a throw without an `ERR_*` code to "The wallet did not report a result. This does not mean nothing happened." and re-read the contract. The older `sign()` used by the settlement / arbitration panels shows the generic "reason is not known" copy plus "Re-read the line" (unchanged here).
32. **`ARCHITECTURE.md` §6.4 asks for (a) used amount == P and (b) a re-read FUNDED.** In the popup flow the return value is often unavailable, so the implementation decides "Secured in escrow" on (b) alone (the contract can only be FUNDED with `locked == P` after crediting exactly P) and shows (a) as "reported by the transaction".
33. **Evidence commitment has no shared Rust vector.** `docs/20` defines the envelope; the contract checks only 64-hex format and non-zero. `commitment.test.ts` pins a TS-local known answer and an independent byte construction. Salt custody remains LF-012; the app only offers a local "private receipt" download.
34. **F3 not in `lf-010a`.** The UI applies `min(funding deadline − 1 ns, delivery + grace − review)` and maps `LF_FT_REFUND:DeliveryTimeTooShort` (only refund code not in the fixture; `errors.test.ts` pins this). The deployed `lf-010a` contract would still credit later deposits. The shared golden sample (T059, `goldenSampleDraft`) violates F3 on line 1 (delivery 2027-01-19 < funding 2027-01-17 + 72 h): demo terms must not copy it.
35. **§4 rows S07/S09 and §9 are partly stale.** `advance_case` is on main since LF-006b and is now offered; S09 withdraw exists since LF-009. The tables are left as history except the §9 LF-006b row.
36. **Two verification levels.** New signatures (acceptance, funding) require local == stored == `compute_terms_hash`; the existing settlement / arbitration / withdrawal panels still gate on local == stored only (unchanged to preserve the withdrawal behaviour). The stricter check could be applied to them in a later slice.
37. **Pre-sign balance/registration for funding are read once per panel load** (plus "Re-check balance and registration"); the pre-sign re-read checks the agreement and line state, not the token views again. The token refunds any deposit the contract does not credit.

## 12. Acceptance checklist — when the UI may be called functional
All items need executed evidence (command output, commit SHA, tx hashes) recorded in `18` (G5). Until then the UI is "not functional".
- [ ] Frontend versions pinned with a lockfile and recorded in `21` with command output.
- [ ] TS encoder suite passes every vector in `terms_v1.json` and rejects all 39 malformed cases with the Rust stage/code (TS plan), with the run log saved.
- [ ] Against a sandbox escrow built from the recorded WASM: TS digest == `compute_terms_hash` == stored `terms_hash` for a created agreement.
- [ ] Four distinct wallet accounts sign `create_agreement`, `accept_terms` ×2 and `accept_appointment` ×2 through the real wallet integration (not a mock signer). The resulting status is `AGREED`.
- [ ] A real `ft_transfer_call` funds a line. The UI shows "Secured in escrow" only after the re-read shows `FUNDED`, `locked == P`. A deliberately wrong amount shows the refund copy, and `outstanding_liabilities` is unchanged.
- [ ] `submit_delivery`, `accept_line`, `open_dispute` work from the UI with the right signer (buttons exist since 2026-11-05; offline DOM-checked only). Each wrong signer is rejected by the contract and mapped to the right copy.
- [ ] "Ready to withdraw" appears for an accepted line, and the word "Paid" appears nowhere. A grep of the built bundle and the screenshots confirms it before LF-009.
- [ ] After LF-009 (wording: founder decision 2026-11-05, exact equality): PENDING shows "Payment outcome unconfirmed. Do not retry this withdrawal." with no retry; "Payment completed successfully." only after the authenticated callback recorded PAID and a second, later snapshot confirmed it, and in no other state; FAILED shows "The transfer failed. Your funds are available to withdraw again." with "Withdraw again"; an unregistered recipient sees "Your account must be registered with this token before you can withdraw." with the withdraw button disabled; a forced inconclusive callback (T040) stays PENDING in the UI.
- [ ] The reconciliation panel shows E and O at the same block, and a direct `ft_transfer` to the escrow shows up as surplus without changing any line.
- [ ] Accessibility: keyboard route, visible focus, 44 px targets, reduced motion, statuses not colour-only; checked at 1440 / 768 / 390 px (`19`).
- [ ] Testnet run (LF-014, founder approval) with real explorer receipts linked from S10.
- [ ] No secrets in the repo or bundle (scan output saved). The testnet banner is visible on every screen.
