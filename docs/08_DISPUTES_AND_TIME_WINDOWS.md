# Dispute protocol and deadlines
## Pre-agreed parameters (proposed for controlled MVP)
- Review: 72 hours after supplier evidence submission; no automatic acceptance.
- Delivery grace: 0 unless founder explicitly approves a different value before terms acceptance.
- Negotiation: 48 hours from dispute effective T0.
- Primary arbitrator: next 72 hours.
- Backup arbitrator: next 72 hours.
- Fallback eligible: 192 hours after T0; no platform-selected allocation.
All times recorded and compared as onchain block timestamps in **nanoseconds UTC**; frontend displays both exact UTC and user local time. Use overflow checked arithmetic.

## The phase boundary algorithm
Let N=48h, A=72h, B=72h. Intervals: [T0,T0+N) mutual negotiation only; [T0+N,T0+N+A) primary rules or mutual settle; [T0+N+A,T0+N+A+B) backup rules or mutual settle; [T0+N+A+B,∞) permissionless fallback or mutual settlement if no final allocation yet. At each exact boundary, earlier authority expires. Whichever valid final allocation executes first wins. No manager can reset T0.

## T0 derivation
- Buyer disputes during active review: onchain dispute creation timestamp.
- Buyer silent at review deadline: T0 = immutable `submission_timestamp + review_window`, even if advance call occurs later.
- Non-delivery after deadline: T0 = immutable `delivery_deadline + agreed_grace`, even if advance call occurs later.
Use chain time for all predicates, never backend clocks.

## Neutrality and evidence
Primary and backup arbitrators are named in accepted terms, accept their appointment, but demonstration arbiters are not professionally vetted; app must disclose this. Arbitrators review offchain evidence but their onchain authority is narrowly limited to choosing buyer/supplier integer allocations of **the disputed line only**. Any appeal process beyond the backup triggered by inactivity is out of MVP; reject an unrequested appeal ladder.

## The fallback trap
Fallback bps are **not inherently fair**, so reject agreement funding until both parties explicitly accept them line by line. Never silently use 50/50; do not promise claim is arbitrated by a court or an independent juror DAO. 'Signed fallback' in earlier documents means preapproved terms hash, not later administrative signature.

## Cases to test
- Ruling exactly at end of primary window -> reject primary; backup eligible.
- Ruling one nanosecond before end -> allow primary (if other constraints met).
- Settlement and arbitration in same block -> only first valid allocated action wins.
- No-response advanced 10 days later -> T0 still original review deadline.
- Supplier did not deliver -> buyer can dispute, supplier may present contrary evidence to adjudicator; no automated theft of bond.
- Buyer accepts line -> cannot reopen dispute.
- Post-finalization replay and early fallback -> reject.

## Deadline rules v1 (`deadline_rules_version = 1`, hashed in terms; adopted 2026-10-27 per OQ-02/03/07/12)
All intervals are half-open `[start, end)` in chain nanoseconds. Every sum uses `checked_add` on u64, and overflow rejects the terms at creation.
- Terms are valid only if `now < acceptance_deadline_ns ≤ funding_deadline_ns ≤ delivery_deadline_ns(line)` for every line, every window is in [60 s, 30 days], and the grace period is in [0, 30 days].
- Accept terms or appointment: `now < acceptance_deadline_ns`. Fund line: `now < funding_deadline_ns` **and (F3, founder 2026-11-05, `31`) `now + review_window_ns ≤ delivery_deadline_ns + delivery_grace_period_ns`** — the supplier always gets at least the review window to deliver; **the grace period counts toward this permissible funded delivery period**. A deposit failing either rule is refunded in full (`LF_FT_REFUND:FundingDeadlinePassed` / `DeliveryTimeTooShort`) with no liability. Delivery deadlines, the submission cutoff, NON_DELIVERY T0 and every dispute window are unchanged.
- Submit delivery: `now < delivery_deadline_ns + delivery_grace_period_ns`. At equality submission is rejected, and NON_DELIVERY becomes eligible with `T0 = delivery_deadline_ns + delivery_grace_period_ns`.
- Buyer accept or dispute: `now < submitted_at_ns + review_window_ns`. At equality NO_RESPONSE becomes eligible with `T0 = submitted_at_ns + review_window_ns`.
- Phase intervals from T0 are as in "The phase boundary algorithm" above. The window values are those in the hashed terms, not constants.
- Business defaults (FD-06): review 72h, negotiation 48h, primary 72h, backup 72h, grace 0. Any smaller window means the agreement is labeled "Accelerated timing — test only".
