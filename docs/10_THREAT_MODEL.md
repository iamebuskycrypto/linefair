# Threat model, abuse cases and security stop conditions
## Protected assets
Escrowed token principal; binding agreement rules; payout destinations; beneficiary claims; private evidence; wallet credentials; honest time windows; reputation and ability to audit.

## Adversaries
Dishonest buyer/supplier, colluding arbiters, compromised frontend/backend, malicious FT contract, third-party API outages, attacker with leaked key, malicious evidence uploader and inattentive operator.

| Threat | Required control | Proof before release |
|---|---|---|
| Fake FT funding event | Reject any `ft_on_transfer` whose immediate caller != exact approved token; verify buyer/amount/msg | Fake contract sandbox call and no credited funds |
| Duplicate/fractional deposit | Exact one-time amount and per-line state | Retry/underpay/overpay malicious payload tests |
| Terms change after acceptance | Onchain canonical terms hash with version, both parties sign | Alter any field -> reject |
| Unauthorized buyer approval | Predecessor account authentication, wallet-signature discipline | Supplier/stranger cannot accept for buyer |
| Colluding arbitrator theft | Only immutable buyer/supplier recipients, line-local cap | Arbitrator third-party destination rejection |
| Timeout manipulation | Immutable timestamps and exclusive interval boundaries | Nanosecond boundary tests |
| Overpayment from concurrent withdrawal | Claim->pending state locked before external transfer | Two same-time claims and duplicate callback tests |
| Forged callback | Private/self-only callback + promise result validation + withdrawal ID | Forged/replayed callback rejected |
| Lost callback | Pending frozen until manual audited reconciliation | Simulate indeterminate receipt, forbid retry |
| Malicious token implementation | Single verified canonical FT test contract, FT resolver/storage tests | Interop tests, allowlist pinned |
| Private evidence leak | Encrypted, access-controlled offchain storage; salted commitments | Unauthorized access and logging checks |
| Frontend phishing | Wallet domain/contract ID shown; signing intent and amount verified | User review + domain/contract confirmation |
| Insider admin misuse | No arbitrary custody/upgrade function; restrict deploy key | Interface inspection and threat review |
| Economic griefing via forced lock | Clear dispute terms, bounds, pre-agreed fallback; disclosed limits | End-to-end stalled dispute tests |
| Unfair default split | No universal default, exact pre-approved per-line bps | Signoff + UI disclosures tested |

## Trust not removed by blockchain
Appointed arbiters can be wrong or collude; user signs transactions; offchain files may disappear; chain commitments do not prove work quality; a hacked frontend can trick users; custody/payment law may apply. Do not call product fully trustless, safe, independently audited, or guaranteed fair.

## Gate severity
P0 blockers: principal conservation failure; reentrancy/double claim; any unauthorized payout; adversarial FT credit; unreviewed upgrade/admin sweep; callback ambiguity silently settled; wrong role/time ruling; leaking keys; nonexistent verified testnet transfer. No waiver without explicit founder security approval and documented mitigations; no mainnet waiver via hackathon urgency.

## Reviews
Static dependency/secret scan, independent threat-model walk-through, property-based financial tests, NEAR sandbox token tests, mocked bad-token tests, testnet receipt inspection. External professional audit required before real assets.
