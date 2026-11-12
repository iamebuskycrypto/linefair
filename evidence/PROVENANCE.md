# Evidence provenance (public release candidate, prepared 2026-11-11)

This tree is a curated export of the project's private working repository. Unless listed below, every file is byte-identical to the private repository at commit `ec19c48`.

That commit is:
- the tested MVP source `2b5adf8`;
- plus licence metadata only (`7990950`);
- plus a frontend presentation refresh in four files: `apps/web/src/styles.css`, `apps/web/src/app/App.tsx`, `apps/web/src/app/screens/AgreementScreen.tsx`, `apps/web/src/app/screens/WithdrawalPanel.tsx`.

The refresh changes no contract, encoding, financial-library, wallet or validation code. The escrow release WASM is unchanged and byte-identical to the qualified and deployed release (sha256 `470db97b…f2e1`). Root files `README.md`, `SECURITY.md`, `LICENSE` and `.gitignore` were written for this release (`.gitignore` is a verbatim copy).

## Files that differ from the private repository

| Public path | Change | Original sha256 |
|---|---|---|
| `apps/web/ARCHITECTURE.md` | The 3 mentions of `docs/30` are annotated "(internal testnet demo plan, not published)". No other bytes changed. | `971ae597042d98e910351dfa10ad784e3c75c5f4c103bd1d928e0be40dada27c` |

## Evidence copied to shorter public paths (bytes unchanged)

| Public path | Original path (private repo) | sha256 | Last commit |
|---|---|---|---|
| `evidence/testnet/FINAL-ACCOUNTING-AUDIT-20261111T132549Z.log.txt` | `evidence/escrow2/agreement-0/FINAL-ACCOUNTING-AUDIT-20261111T132549Z.log.txt` | `ab7923383b3e83883ffedd412696613a2f4446314034ae34a3092b461658085a` | `de4dd32` |
| `evidence/testnet/FINAL-WITHDRAWALS-AUDIT-20261111T132929Z.log.txt` | `evidence/escrow2/agreement-0/FINAL-WITHDRAWALS-AUDIT-20261111T132929Z.log.txt` | `6e905fa8a8ebcf5289eaccbe711169a6245ff76ac332fac8a41152c2aa6a5d2c` | `de4dd32` |
| `evidence/tests/contract-cargo-test-20261111T125501Z.log.txt` | `evidence/final-regression/contract-cargo-test-20261111T125501Z.log.txt` | `31b44b87354be9f514e64de24e5afde7a670fc390a2bb2f2b0ff34fc21947188` | `de4dd32` |
| `evidence/tests/frontend-final-20261111T133203Z.log.txt` | `evidence/final-regression/frontend-final-20261111T133203Z.log.txt` | `71a7b0d0097e51dbf54c9102917616516abac5b8eda0efdc3bfe5b857e50bc30` | `de4dd32` |

## Screenshots

`evidence/screens/` holds screenshots of the local read-only app at the frontend of `ec19c48`, reading testnet agreement #0. They were captured on 2026-11-12 by an isolated headless-Chrome check, using a fresh profile on loopback only.

The automated check passed at 375, 390, 768 and 1280 px:
- no horizontal overflow;
- no squeezed or pathologically wrapped value;
- all 5 payouts and all 3 settled lines rendered.

| File | sha256 |
|---|---|
| `agreement0-completed-desktop-1280.png` | `afc6e0303a3b6270c6798abfcc5938d2c44bd161e457b4c402418f87d595d940` |
| `agreement0-completed-mobile-390.png` | `54a223625dd36aecb06ebc272900e3575c4ccfc037308e83890611908c7daaac` |

## References intentionally left unresolved

Some design documents, code comments and `tests/SCENARIO_MATRIX.csv` cite private development records that are not published:
- milestone evidence under `evidence/lf005` … `evidence/lf012`, `evidence/m1`, `evidence/frontend`, `evidence/hardening` and `evidence/deploy-prep` (`FINAL-VERIFICATION.md`, `*-spec-and-test-plan.md`, logs);
- `docs/30` (superseded testnet demo plan);
- `CLAUDE.md` (internal engineering instructions);
- `TESTNET_WALLET_TEST.md` and `INTEAR-REVIEW-AND-CONNECTION-TEST.md` (manual wallet test procedures).

They stay private because they are operational records, and some contain local filesystem paths. Those references are therefore unresolved in this tree. The public verification path is the testnet transactions in `README.md`, the audit logs above, and running the test suites.

Public transactions are verifiable at `https://testnet.nearblocks.io/txns/<hash>`.
