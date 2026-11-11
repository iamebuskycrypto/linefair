# Architecture and initial design decisions
## Trust-boundary diagram
```text
Buyer/Supplier NEAR wallets ----SIGNED TX----> Immutable LineFair escrow contract
                                               |                   ^
                                               v                   |
                                         Allowlisted FT       private callback
                                               |                   ^
                                               `---- token payout --'

Browser app --read RPC/indexer--> onchain ledger (authoritative for funds)
       |--auth--> evidence API --> encrypted private storage (not payment authority)
       |--read--> application DB/indexer (cache only; lag must be disclosed)
Arbiters --signed onchain rule tx--> escrow contract, not platform-controlled backdoor
```

## Proposed components
- `contracts/escrow`: Rust `near-sdk` escrow, immutable line state, claim ledger, verified NEP-141 callbacks, no confidential plaintext.
- `apps/web`: Next.js/TypeScript, tested NEAR wallet adapter, responsive SaaS UX, status-aware client. This is a proposal, not pinned yet.
- `services/evidence-api`: small Node/TypeScript service with authenticated signed download/upload, metadata and encrypted file storage. For P0, synthetic demo evidence can be hosted behind authenticated minimal infrastructure; no real PII.
- `packages/shared-schemas`: generated/validated serializable payloads and dates, no authoritative balances.
- PostgreSQL optional to index UX records; not a condition for onchain financial correctness.

## Security boundaries
Escrow contract decides allocations; wallet signs intentions; token contract owns token ledger; private evidence API does not decide financial truth; arbitrator cannot choose arbitrary payee; indexing can be delayed or malicious and must never be payout authority.

## ADR-001: Agreement-first line escrow (proposed)
**Decision:** 1–3 indivisible fixed-price lines, separately funded, immutable terms after mutual acceptance. **Because:** restrict scope and reduce stuck entire-invoice balance. **Cost:** partial delivery requires splitting into smaller lines before terms acceptance.

## ADR-002: Claims before async transfers (proposed)
**Decision:** separate locked/claimable/pending/confirmed-paid. **Because:** cross-contract FT transfers are async and independent; UI cannot equate allocation with payment. **Cost:** pending reconciliation and callbacks.

## ADR-003: One token, no bridge (proposed)
**Decision:** NEAR testnet with one allowlisted NEP-141 FT. **Because:** demonstrate financial mechanism without uncertain cross-chain infrastructure. **Cost:** no multi-chain claims or real fiat onboarding.

## ADR-004: Offchain private evidence, onchain commitment (proposed)
**Decision:** hashes (salted, domain-separated) and pointers at most, sensitive files offchain. **Because:** public-chain immutability and confidentiality. **Cost:** evidence availability, auth, key rotation and offchain trust.

## ADR-005: No platform financial admin (proposed)
**Decision:** Operator cannot sweep, rotate beneficiaries, settle disputes or change funded immutable terms. **Because:** minimizes custody and insider abuse. **Cost:** lost keys/blocked claims and severe incidents harder to recover.

## Planned repository
```text
contracts/escrow/src/{lib.rs,model.rs,terms.rs,ledger.rs,dispute.rs,ft.rs,events.rs}
contracts/escrow/tests/{unit.rs,near_workspaces.rs}
apps/web/{app,components,lib}
services/evidence-api/{src,tests}
packages/shared-schemas/
tests/
docs/
```
Folder and file names are proposals, not claims these source files exist.
