# Test plan — executable evidence required
## Layers
1. **Pure model unit tests:** states, roles, canonical hashing, exact integer split, checked math and phase windows.
2. **Property/fuzz tests:** all actions in random order preserve per-line money conservation and never allocate twice; include max `u128`, 0, tiny units, rounding.
3. **NEAR sandbox integration:** deploy actual chosen NEP-141 test FT and escrow, register storage accounts, test `ft_transfer_call`, `ft_transfer`, private callback result paths.
4. **Bad-token and bad-actor tests:** fake `ft_on_transfer`, malformed FT msg, unauthorized calls, spoofed callback and duplicated transactions.
5. **UI e2e:** correctly labeled pending/locked/paid, accessible workflow, wallet errors, 3-line demo.
6. **Live testnet smoke:** independent 4 accounts; explorer-verifiable deposits, resolutions, withdrawals and failed-transfer recovery; all tx hashes recorded.

## Critical invariants (assert after every mutating action)
- For each funded line `P = L + CB + CS + PB + PS + DB + DS` (locked, buyer/supplier claimable, buyer/supplier pending, buyer/supplier confirmed distributed).
- If no valid token deposit P=0 and UI cannot claim secured.
- Only immutable buyer/supplier can receive escrow token allocations.
- Buyer/supplier fallback bps sum 10,000; no arbitrary fixed 50/50.
- Exactly one final allocation per line; after final no amount changes.
- Pending claim cannot be paid or retried twice; failed callback restores claim precisely once.
- Every time-window transition is chain-timestamp derived; no backend-clock authority.

## Test suites
`T001-T010` happy path/ledger; `T011-T020` input/role failures; `T021-T030` disputes/races/timers; `T031-T040` FT + callback/registration failures; `T041-T050` UX/operational/reconciliation; see `tests/SCENARIO_MATRIX.csv`.

## Mandatory published evidence
Before marking any ticket complete, attach actual command, exit code, relevant output, commit SHA, and onchain transaction/contract ID if applicable. `NOT EXECUTED` must remain until proof is attached. It is acceptable to stop at a validated testnet MVP; not acceptable to describe a code mockup as safe custody software.

## Example golden scenario
Agreement lines: 500,300,200 test units; all funded. Buyer accepts 500, disputes 300, leaves 200 reviewing. Disputed 300 -> 180 supplier/120 buyer. Before withdrawal ledger: locked=200, supplier claimable=680, buyer claimable=120. After both confirmed withdrawals: locked=200, supplier paid=680, buyer paid=120. Always totals 1000. Verify tx receipts; no assumptions about FT decimals.
