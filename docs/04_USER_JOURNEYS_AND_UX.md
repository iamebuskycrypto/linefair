# Personas, end-to-end journeys, UX copy
## Actors
Buyer is commissioning Web3 agency, supplier is service contractor, primary/backup are pre-named NEAR accounts. Operator hosts UI and offchain files, never makes token allocations.

## Happy path (buyer → supplier)
1. Buyer drafts 1–3 independently priced lines (delivery criteria, deadline, agreed dispute path, fallback split), previews exact terms and creates proposed contract.
2. Supplier checks terms and accepts exact hash; arbiters separately accept appointment. Until all accept: **Agreement awaiting approval**.
3. Buyer funds each line in separate wallet-confirmed FT transfer; UI shows **Funding transaction processing**, then actual chain-confirmed **Secured in escrow**.
4. Supplier submits deliverable pointer and immutable salted evidence commitment, then sees review countdown.
5. Buyer accepts line A, disputes B and leaves C pending. A immediately becomes **Ready to withdraw** for supplier (not Paid), B remains **Disputed — secured**, C **Under review**.
6. For B, supplier proposes split; buyer confirms matching allocation. B moves locked -> both party claims atomically. Each separately withdraws.
7. Withdrawal becomes **Processing transfer**; after success callback becomes **Paid**. On verified failure show **Action required — retry**, with original claim restored. *(Superseded 2026-11-05 by founder wording below; kept as history.)*
   **Withdrawal wording (founder decision 2026-11-05, exact UI strings; each shown only after an authoritative contract read, never from a transaction result, browser event or token balance):** confirmed failure with restored claim — "The transfer failed. Your funds are available to withdraw again." · recipient not registered on the token — "Your account must be registered with this token before you can withdraw." · inconclusive / pending — "Payment outcome unconfirmed. Do not retry this withdrawal." · confirmed paid — "Payment completed successfully."

## Exceptional paths
- Unfunded line: 'Not funded: this deliverable is not payment-protected. Do not begin work on the assumption that escrow exists.'
- Wrong token or amount: 'Deposit was not accepted. Verify token, exact amount, and deadline before trying again. Check the token transaction before another attempt.'
- Review period expired: 'The review window has ended. This line enters the agreed dispute process; funds are not automatically paid.'
- Primary arbiter silent: show countdown until backup eligibility, not 'auto approved'.
- Neither arbiter acts: show exact fallback percentages and deadline, already accepted by both parties.
- Pending callback inconclusive: 'Transfer status cannot be verified yet. This claim is temporarily frozen to prevent a duplicate payment. Contact support with transaction ID.' No retries from UI.
- Lost account key: irreversible blockchain limitation; explain inability to recover without key or agreed migration system (not provided in P0).
- One party disappears: phase moves via permissionless onchain call; no backdoor confiscation.

## Screens (priority)
S01 Agreement list; S02 Draft agreement + priced line editor; S03 Terms sign-off (must emphasize fallback); S04 Detail/timeline; S05 Funding per line; S06 Supplier delivery; S07 Buyer review; S08 Dispute and proposed split; S09 Claim withdrawal + FT storage check; S10 Testnet transaction receipt; S11 Judge demo overview. No unrelated dashboard graphs.

## UX conditions of acceptance
- Every transaction has actor, amount, token, network, current state and clickable explorer link after verified receipt.
- No stale index shown as canonical; chain fetch or clearly labeled 'refreshing'.
- Defer crypto jargon; show primary business action in plain English. Never hide contract address, gas, risk or who controls money when relevant.
- Accessibility: visible focus state, label/input association, non-color-only statuses, min 44px actionable targets on touch, sensible responsive layout and reduced-motion behavior.
- Synthetic demo invoices only; no real client document in public repository.
