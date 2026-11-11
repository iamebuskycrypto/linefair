# Security

## Status

LineFair is an **experimental MVP built for the NEAR Hackathon**. It runs on **NEAR testnet only**, with a test token (tLFT) that has no monetary value. It is **not approved for production use or for real money**.

## No independent security audit

**No independent human security audit has been completed.** All code and security reviews so far were performed with AI assistance under the founder's direction.

The project has extensive automated testing:
- unit tests, model-based property tests and adversarial tests;
- sandbox tests against the genuine pinned NEP-141 token contract;
- mutation checks;
- a live testnet accounting audit.

Automated testing, however thorough, **is not an independent audit**. It can only show that the behaviours the authors thought to test work as intended. It cannot show the absence of flaws the authors did not anticipate.

## Deployer upgrade authority on the deployed escrow

The deployed escrow account `escrow2.ebusky-linefair.testnet` **retains its deployer full-access key**. A read-only RPC query at testnet block 277228964 on 2026-11-11 showed one FullAccess key, and the deployed code hash was `5nN5ua65yntBYmNZC6JEtdWYBbbuBkVxuHC7GZxpBgcQ`.

What this means:

- **The contract's guarantees hold only while the code is unchanged.** The contract code has no admin withdrawal, no operator discretion and no way to redirect tokens. Arbitrators can allocate only between the original buyer and supplier. These are properties of the code as deployed.
- **The key holder is not bound by those rules.** Whoever holds the full-access key can:
  - deploy different code to the escrow account, which could change any rule, including how escrowed tokens move;
  - sign transactions as the escrow account itself, including token transfers of funds the escrow holds;
  - delete the account.
- **Users must therefore trust the key holder.** Funds held in this escrow are only as safe as that key and the intentions of its holder. "Immutable terms" means that the contract methods cannot change an agreement's terms; it does not mean that the deployment cannot be upgraded.
- **Current exposure.** The demonstration agreement is fully settled. The escrow's tLFT balance was 0 at testnet block 277228982 (2026-11-11), so no test funds are currently held.

Deleting the key was deliberately deferred for the testnet MVP. The key remains under the founder's control. Before any real-value use, upgrade authority would have to be removed or placed under transparent governance. Options are deleting all access keys after verifying the deployed code hash, or a multi-party or time-locked upgrade process. Either option would itself require an independent audit.

## Other known limitations

- **Sandbox-only behaviours:** these were verified only in the local sandbox and tests, not on testnet:
  - backup-arbitrator ruling;
  - deterministic fallback split;
  - restoration after a failed withdrawal;
  - handling of an inconclusive transfer, which stays pending and is never blindly retried;
  - the late-funding refund guard.
- **Recovery gap:** there is no verifiable recovery path for a withdrawal whose transfer outcome is inconclusive; it stays frozen as pending. That is acceptable for a testnet demo, but it would block production use.
- **Public RPC dependency:** the frontend depends on a public testnet RPC endpoint. It fails closed on read errors and does not retry.
- **Wallet session key:** the Intear wallet keeps a session key in browser storage.

## Reporting a vulnerability

Please **do not open a public issue** for a suspected vulnerability. Report it privately through GitHub's private vulnerability reporting: on this repository, open the **Security** tab and choose **Report a vulnerability**. Reports are visible only to the maintainers until a fix or advisory is published.

Please include:
- the affected component (contract, frontend or deployment scripts);
- reproduction steps;
- the impact you expect.

Because this is a testnet-only project with no real funds, there is no bug bounty.
