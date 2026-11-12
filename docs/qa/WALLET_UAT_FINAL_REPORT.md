# Wallet UAT — final report (branch `qa/wallet-uat-final`, 2026-11-12)

Scope: frontend wallet integration (Intear via NEAR Wallet Selector 10.1.4) and client-environment exposure. NEAR testnet only. The escrow contract, its deployed bytecode, the startup contract checks, the Intear message guard, config validation, the transaction builders and the key scanner are **unchanged**. No transactions were signed and nothing was deployed.

Base: `main` = `25bdb1f44bdd3aa6acf6e41a17784793649f98f2`. Live escrow verified again: code hash `5nN5ua65yntBYmNZC6JEtdWYBbbuBkVxuHC7GZxpBgcQ`, `contract_version` `linefair-escrow 0.1.0 (lf-012 f3)`.

## Problems, root causes, fixes

| # | Problem | Root cause | Fix |
|---|---|---|---|
| 1 | Every `VITE_*` build variable was in the public JS. On Vercel this included the commit author login and name, the commit message, and the project and deployment IDs. | `main.tsx` passed the whole `import.meta.env` object to `parseConfig`. | `main.tsx` now reads the 5 public keys by name. A build guard (`vite.config.ts` → `src/lib/envGuard.ts`) fails the build on secret-like `VITE_*` names or credential-like values, and on any other `VITE_*` name or value in the output. The runtime `parseConfig` secret-name check is unchanged. |
| 2 | "Opening wallet…" could stay forever. | intear-wallet 10.1.4 `signIn()` settles only on `connected` or `close`-with-message. A `close` without a message, or a connector that fails to load, never settles. | `walletController.ts` watches the connector. If it closes without a session the attempt ends as "interrupted". If it never opens within 15 s it ends as "did not open". Every attempt has a 5-minute limit, after which the overlay is removed. |
| 3 | If the wallet window was closed within about 0.5 s, the user waited 15 s and saw the wrong message. This was found by the browser retry check. | The poll could miss a connector that opened and closed between two polls. | The port records that the connector opened at the moment `signIn()` is called, since Intear appends its iframe synchronously. |
| 4 | A malformed saved session permanently disabled the Connect button. | Intear `getAccounts()` reads `accounts[0]` unchecked, so `setupWalletSelector` rejects. The old UI then set status "error", which disabled the button. | Malformed records are removed before the library starts and the user sees a notice. A library failure shows "Retry wallet" instead of a disabled button. |
| 5 | A restored session was displayed without the checks that sign-in applies. | Restore used the selector's store directly. | On restore and on any account change, the session must pass `checkIntearSession` and match the store account. Otherwise it is signed out and the user is told why. |
| 6 | Disconnect could hang, or leave Intear records behind. | Intear `signOut()` calls its logout service before clearing storage, and the old code returned early if the selector thought it was not signed in. | Disconnect always calls the Intear module, has a 10 s limit, and always clears the local records. |
| 7 | Raw wallet error text was shown to users. | Messages were passed through unchanged. | Errors are now classified as cancelled, popup blocked or failed, each with a plain message. Arbitrary wallet text is shown only as a short single-line excerpt. |
| 9 | The first Vercel preview build of `5a65a90` failed. | The env guard's output value check matched `VITE_VERCEL_GIT_REPO_OWNER=iamebuskycrypto` against the footer's GitHub link, which is legitimate text, not a leak. Reproduced locally. | The value check is replaced by an exact source check: whole-object `import.meta.env` use and non-public `import.meta.env.VITE_*` reads are refused. The output still must not contain any non-public `VITE_*` name. A regression test with realistic Vercel preview variables was added. |
| 8 | Signing checks ran after the wallet library loaded. | Order of operations in `signAndSend`. | The session and signer check now runs first. The check itself is unchanged. |

## Files changed
`apps/web/src/main.tsx`, `vite.config.ts`, `package.json` (test lists), `src/app/App.tsx`, `src/app/context.tsx`, `src/styles.css` (notice layout), `src/lib/near/wallet.ts`, `browser-check/main.tsx` (stub shape).
New: `src/lib/envGuard.ts`, `src/lib/near/walletController.ts`, and the tests and checks below.

## Tests and exact results (final build)
| Gate | Result |
|---|---|
| TypeScript typecheck | exit 0 |
| Web unit tests (`npm test`) | **182/182** pass. 144 existing + 38 new: controller 24 (simulated), signing gate 5 (simulated), env guard 9. |
| Bundle tests (`npm run test:bundle`, real Vite builds) | **5/5**, including the Vercel-preview regression test. Vercel canaries absent, public config and contract version present, secret name refused, NEAR-secret value refused, and the old whole-env pattern is refused by the guard. |
| Shared-schema tests | **25/25** |
| Production build with demo env | ok. 0 `VITE_VERCEL` strings in the output. |
| Key-material scan of `dist` | 0 hits (7 files) |
| Real-browser wallet check (`scripts/wallet-browser-check.ts`, headless Chrome, 390 and 1440 px) | **45/45**. Network hosts: the app, `rpc.testnet.fastnear.com` and `wallet.intear.tech` only. |
| Offline DOM check (`scripts/browser-dom-check.ts`) | **Not re-run** in this pass (stopped at the founder's direction). Only its wallet stub's shape changed, and the typecheck covers it. |
| `npm audit` | 12 low, 0 moderate/high/critical. See below. |

The browser check uses the real build, the real Intear module and the real `wallet.intear.tech` connector. Steps labelled SIMULATED inject storage records or remove the connector. They test how LineFair handles those outcomes and are **not** a real-wallet connection.

## Acceptance criteria
| Criterion | Status | Evidence |
|---|---|---|
| Wallet initialisation | PASS | unit + browser |
| Valid account connection state | PASS (simulated) / **BLOCKED (real)** | unit + browser; needs founder |
| Session restoration after refresh | PASS (simulated) / **BLOCKED (real)** | unit + browser |
| Restoration after reopening | PASS (simulated) / **BLOCKED (real)** | unit + browser (new tab) |
| Disconnect | PASS (simulated) / **BLOCKED (real)** | unit + browser |
| No restoration after explicit disconnect | PASS (simulated) / **BLOCKED (real)** | unit + browser |
| Reconnect | PASS (simulated) / **BLOCKED (real)** | unit |
| Account mismatch / account change | PASS | unit |
| User cancellation | PASS | unit |
| Popup closure (including very quick close) | PASS | unit + browser |
| Unexpected message origins | PASS | browser (forged message ignored) + existing guard tests |
| Invalid / malformed sessions | PASS | unit + browser |
| Connection failure, time-out, recovery and retry | PASS | unit + browser |
| Prevention of unauthorized transaction calls | PASS | `walletSigning.test.ts` |
| Env exposure fixed; secret detection not weakened | PASS | env guard + bundle tests |
| Startup contract verification intact | PASS | browser + bundle test (version string present) |
| No signing permission or transaction on connect (real wallet) | **BLOCKED** | founder protocol |
| Vercel preview of this branch | **BLOCKED** | the branch is not pushed yet; see below |

## Security findings
- **npm audit, 12 low:** all trace to one advisory, GHSA-848j-6mx2-7j84 (`elliptic`, used by `secp256k1` ← `@near-js/crypto` ← `@near-wallet-selector/core` 10.1.4). No patched `elliptic` exists. npm's only "fix" is a major downgrade to wallet-selector 9.5.4, which was **not applied**. LineFair never signs with secp256k1 locally (Intear session keys are ed25519, and transactions are confirmed in the wallet), so practical exposure is low. Optional: remove the unused direct dependency `@near-wallet-selector/my-near-wallet` (nothing imports it), which removes one of the 12 entries. Upgrade when wallet-selector ships a patched `@near-js/crypto`.
- **Vercel setting:** turn off *Project → Settings → Environment Variables → "Automatically expose System Environment Variables"*. The code fix already keeps these values out of the bundle, so this is defence in depth only. Change nothing else.

## Outstanding risks
- Real Intear sign-in, restore, disconnect and reconnect have not been run on this branch with a real wallet.
- Transaction signing through Intear has still never been exercised (unchanged from `main`).
- The Intear module is third-party: if a future version changes its connector, the connector watch may need updating (the version is pinned).
- Public RPC rate limits can delay the startup check.

## Real-wallet protocol (founder, about 5 minutes, dedicated testnet wallet)
Run it on the branch preview URL once it exists, or on a local `npm run preview:local` of this branch. Never share a password, seed phrase, key or session data. Record PASS or FAIL for each step:
1. Click **Connect testnet wallet** → Intear → Web, and approve in Intear. The header shows your testnet account.
2. Reload the page. The same account is still shown.
3. Close the tab, open the URL again. The same account is still shown.
4. In Intear's connected-apps list: LineFair has no function-call key, and no transaction was requested.
5. Click **Disconnect** → "Wallet disconnected on this device." Reload: still disconnected.
6. Connect again: the same account is shown.

## Commits
See the git log of `qa/wallet-uat-final`. The commit hash is recorded in the founder handoff.
