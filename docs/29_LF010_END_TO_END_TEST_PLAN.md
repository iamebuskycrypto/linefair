# 29 — LF-010 end-to-end lifecycle and adversarial sandbox test plan
**Status: DONE (2026-11-05)** — all gates passed, clean checkout of `78c1c04` recorded (`evidence/lf010/FINAL-VERIFICATION.md`); not merged. Moved from the session scratchpad draft (2026-11-05) without changing scenarios or matrices. LF-010A (creator allowlist, `28`) is implemented first; LF-010 then includes allowlist cases.
written_at: 2026-11-05 (UTC) · base: `main` after LF-010A (LF-009 integrated as `b66913f` on 2026-11-05) · local sandbox 2.13.4 + genuine pinned token only; no testnet.

## E2E scenarios (genuine token; every step reconciled: E == Σ unpaid, escrow balance == E + surplus, Σ balances == supply; receipts recorded)
1. `lf010_three_line_all_paths` — one agreement, 3 lines: line 0 delivered → buyer accepts → supplier withdraws PAID; line 1 buyer dispute → counter-proposals → accepted split → both withdraw PAID; line 2 non-delivery → `advance_case` → primary ruling → buyer withdraws (first attempt FAILED: unregistered, restored once) → retry PAID. Final: E = 0, payouts equal allocations exactly.
2. `lf010_silence_backup_fallback` — NO_RESPONSE → silent primary → backup ruling on one line, fallback on another (rounding), withdrawals.
3. `lf010_two_agreements_isolation` — two agreements progressing interleaved; every transition of one leaves the other byte-identical.
4. `lf010_inconclusive_with_other_lines_live` (starve build) — one withdrawal frozen PENDING while the other lines/agreements complete normally; E and balances stay consistent.
5. `lf010_cap_and_storage` — create up to `max_agreements`, cap rejection atomic, measure storage of a worst-case agreement (longest ids, 3 lines) against the 4 096 B cap.

## Adversarial authorization matrix
`lf010_role_method_state_matrix`: for each state (UNFUNDED, FUNDED, SUBMITTED, DISPUTED×phase, ALLOCATED, PENDING, PAID, FAILED) × each method × each caller (buyer, supplier, primary, backup, stranger, escrow-as-caller, FT-as-caller), the call either succeeds exactly where `06` allows it or fails with the exact expected code, with agreement bytes, E and counters unchanged. Generated table, exact-code assertions, saved as evidence.
`lf010_replay_every_tx`: re-submit every successful transaction of scenario 1; each replay is rejected or a no-op with unchanged state.
`lf010_deposit_and_gas_abuse`: attached deposits on non-payable methods, wrong yocto on withdraw, low gas on every method.

## Review
Independent code review of `contracts/escrow` by a reviewer who did not write the code (a separate fresh agent given only the code and specs, no conclusions; disclosed as such) plus the founder-arranged human review required by G-gates before any public use. Findings tracked in `17`.

## Gates
All E2E + matrix + replay tests pass; full regression; mutation spot-checks of any new production code (none expected — LF-010 is test-only); clean checkout; evidence under `evidence/lf010/`.
