# NEAR HACKATHON — LineFair submission preparation (NOT SUBMITTED)

> Prepared 2026-11-12. This document is a draft, not proof of submission. Do not submit, post on X or change payout details without founder approval.

## Official logistics
- Submission deadline: **2026-11-14 23:59 UTC** (2026-11-15 00:59 WAT).
- Read current rules at https://nearhackathon.com/HACKATHON.md and https://nearhackathon.com/ immediately before submission.
- Publish a **public** repository and **public X demo post** with screenshots or video; tag @NEARProtocol and #NEARHackathon; submit both links through https://nearhackathon.com/#apply.
- Do not submit twice. Review all fields before submitting. Organizers offer manual corrections if required.
- A **NEAR mainnet account address for prize payout** is required; this is not the escrow testnet account. Founder supplies and verifies it privately in the submission form.

## Project facts
- Name: **LineFair**
- Category: Two-party milestone/deliverable escrow for service agreements on NEAR Testnet.
- Primary track recommendation: **Real-World Money**. Optional secondary: **Open Innovation**, only if founder considers it relevant; select exact form track labels.
- Public source: https://github.com/iamebuskycrypto/linefair
- Live judge-friendly demo (read-only): https://linefair-ebuskys-projects.vercel.app/#/agreements/0
- Escrow: escrow2.ebusky-linefair.testnet
- Test token: demo-ft.ebusky-linefair.testnet (valueless tLFT).
- Agreement #0: 3 lines, 2,400 tLFT total funded and fully paid out; zero remaining liabilities. Detailed signed testnet transaction links are in README.
- Current app is experimental testnet only, not independently audited; deployed escrow retains a full-access upgrade key.

## Suggested short description
LineFair is a NEAR Testnet escrow prototype for service agreements with separately priced deliverables. Each deliverable can be accepted, disputed and paid independently, so a disagreement over one item does not freeze completed work. Agreement #0 demonstrates 2,400 test tokens funded and fully settled across acceptance, mutual settlement and arbitrator ruling, with on-chain evidence.

## Demo post on X (draft; attach visual media BEFORE posting)
Built LineFair for @NEARProtocol's #NEARHackathon.

One project can have multiple deliverables. Why should a dispute over one freeze payment for all?

LineFair gives each deliverable its own escrow ledger and outcome: accept & pay, settle a dispute together, or use time-bounded arbitration.

Our NEAR testnet demo settled 3 lines and paid out all 2,400 test tokens.

Demo: https://linefair-ebuskys-projects.vercel.app/#/agreements/0
Code: https://github.com/iamebuskycrypto/linefair

Experimental testnet MVP. Not independently audited. No real funds.

## 45–60-second demo media script
1. 0–8 s: Show the LineFair home screen, headline: "What if one dispute didn't freeze every payment?"
2. 8–18 s: Navigate to agreement #0; show 3 individually priced deliverables totaling 2,400 tLFT.
3. 18–28 s: Focus Line A: buyer accepted, supplier received 400 tLFT.
4. 28–40 s: Focus Line B: contested amount settled mutually 300/700 without freezing the other lines.
5. 40–50 s: Focus Line C: deadline-based arbitration allocated 200/800.
6. 50–60 s: Show 2,400 funded = 2,400 paid, outstanding liability 0; overlay live demo + repository links, NEAR Testnet only.

Only show functionality that exists. Do NOT imply the public UI itself was used to execute all original signed on-chain transactions; chain demonstration and the current UI are distinct evidence.

## Judge quickstart
See the 'Judge quickstart' section at the top of README on this documentation branch. It includes explicit "do X, see Y" steps and caveats.

## Final submission checklist
- [ ] Merge reviewed documentation branch into main (founder approval) so judges see the updated README.
- [ ] Open production demo and agreement #0 in an incognito window; ensure no Vercel authentication gate or broken assets.
- [ ] Inspect public repo / README / LICENSE / SECURITY / screenshots and verify no secrets in commit history.
- [ ] Prepare screenshot(s) or a truthful short demo video. No invented on-chain outcomes.
- [ ] Founder publishes public X post with demo media, tag @NEARProtocol and #NEARHackathon.
- [ ] Founder supplies project/team lead, email, team size, and appropriate NEAR **mainnet payout address** via official form; never use private keys or seed phrases.
- [ ] Review chosen track(s), project name, short description, repo URL, public X post URL and other exact form fields.
- [ ] Founder explicitly authorizes final form/API submission, or submits personally; verify confirmation.
- [ ] Keep transaction-signing UI, upgrade authority, audit limitations and sandbox-only behaviours accurately described.

## Scope and limits
No mainnet launch, no independent audit, no real-money use. Frontend real-wallet connect/disconnect was founder-confirmed; frontend transaction-signing lifecycle was not independently completed in current wallet UAT. Backup arbitration and inconclusive transfer recovery remain sandbox-only. Public repo is a sanitized export, not the full private development history.
