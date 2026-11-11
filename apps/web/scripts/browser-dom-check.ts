// Real-browser DOM check of the LF-008 panel, the LF-009 claim cards, the
// LF-010A creation gate, the fail-closed startup gate and (founder
// authorization 2026-11-05) the acceptance panel, the per-line fund / deliver
// / review / advance actions, funding outcomes, post-transaction re-read
// results and the wallet-return banner (three page loads: plain, with
// ?transactionHashes=…, with ?errorCode=…), using
// the locally installed Chrome in headless mode (no npm dependency). Loads
// the offline browser-check page (FIXTURE views, not chain data; no wallet,
// no network) and asserts what each role sees in the rendered DOM.
//
// Usage: node scripts/browser-dom-check.ts <chrome-binary> <http://127.0.0.1:PORT/>

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [chrome, url] = process.argv.slice(2);
if (chrome === undefined || url === undefined) throw new Error("usage: browser-dom-check.ts <chrome-binary> <url>");
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url)) throw new Error("loopback URL only");

function dump(target: string): string {
  // Fresh profile per load: no localStorage carries over between loads.
  const profile = mkdtempSync(join(tmpdir(), "lf-dom-check-"));
  try {
    return execFileSync(
      chrome as string,
      ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, "--virtual-time-budget=10000", "--dump-dom", target],
      { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] },
    );
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}
function sectionsOf(h: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const x of h.matchAll(/<section[^>]*data-scenario="([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/section>/g)) m.set(x[1], x[2]);
  // The acceptance panel is itself a <section>: re-extract those scenarios up to the scenario's closing tag.
  for (const x of h.matchAll(/<section[^>]*data-scenario="(accept-[a-z0-9-]+)"[^>]*>([\s\S]*?)<\/section><\/section>/g)) m.set(x[1], x[2]);
  return m;
}
const TXHASH = "8xNqvK3m5pQ2rT7uW9yZaBcDeFgHiJkLmNoPqRsTuVwX";
const html = dump(url);
const htmlTx = dump(`${url}?transactionHashes=${TXHASH}`);
const htmlErr = dump(`${url}?errorCode=userRejected&errorMessage=User%20rejected%20transaction`);
console.log(`chrome: ${execFileSync(chrome, ["--version"], { encoding: "utf8" }).trim()}`);
console.log(`dom bytes: ${html.length} / ${htmlTx.length} / ${htmlErr.length} (plain / tx-hash return / error return)`);

const sections = sectionsOf(html);

let failures = 0;
function check(name: string, ok: boolean): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}
const get = (id: string) => sections.get(id) ?? "";
const count = (s: string, re: RegExp) => [...s.matchAll(re)].length;

const ARB = ["negotiation-buyer", "negotiation-primary", "primary-primary", "primary-backup", "primary-supplier", "backup-backup", "backup-primary", "fallback-stranger", "fallback-disconnected"];
const CLAIM = [
  "claim-claimable-owner", "claim-claimable-other", "claim-claimable-disconnected", "claim-claimable-unregistered",
  "claim-pending", "claim-inconclusive", "claim-reported-paid-record-pending", "claim-confirming",
  "claim-paid", "claim-paid-reported", "claim-failed", "claim-failed-unregistered", "claim-paid-inconsistent",
];
const CREATE = ["create-preview", "create-connect", "create-not-allowlisted", "create-not-buyer", "create-allowed"];
const STARTUP = ["startup-ok", "startup-wrong-code", "startup-starve-build", "startup-wrong-network", "startup-wrong-chain", "startup-unreachable"];
check(`all ${ARB.length + CLAIM.length + CREATE.length + STARTUP.length} scenarios rendered`, [...ARB, ...CLAIM, ...CREATE, ...STARTUP].every((id) => sections.has(id)));

for (const id of ARB) {
  const s = get(id);
  check(`${id}: timeline with 4 phases, exactly one current`, s.includes("Dispute timeline") && count(s, /<li class="phase /g) === 4 && count(s, /aria-current="step"/g) === 1);
  check(`${id}: exact UTC and local time shown`, s.includes("2027-01-15 08:00 UTC") && s.includes("2027-01-15 08:01 UTC") && / local</.test(s));
  check(`${id}: fallback preview 668 / 333 tFT`, s.includes("668 tFT") && s.includes("333 tFT"));
  const form = s.includes("Your ruling as");
  const want = id === "primary-primary" || id === "backup-backup";
  check(`${id}: ruling form ${want ? "shown" : "absent"}`, form === want);
  const fb = s.includes("Apply the agreed fallback split");
  check(`${id}: fallback button ${id.startsWith("fallback") ? "shown" : "absent"}`, fb === id.startsWith("fallback"));
}
check("primary-primary: form says primary arbitrator", get("primary-primary").includes("Your ruling as primary arbitrator"));
check("backup-backup: form says backup arbitrator", get("backup-backup").includes("Your ruling as backup arbitrator"));
check("negotiation-primary / primary-backup: window not open yet", get("negotiation-primary").includes("not open yet") && get("primary-backup").includes("not open yet"));
check("backup-primary: window has ended", get("backup-primary").includes("has ended"));
check("non-arbitrators see no arbitrator message", !/arbitrator window/.test(get("negotiation-buyer")) && !/arbitrator window (is|has)/.test(get("primary-supplier")));
check("fallback-stranger: button enabled", /<button[^>]*>Apply the agreed fallback split/.test(get("fallback-stranger")) && !/<button[^>]*disabled[^>]*>Apply the agreed fallback split/.test(get("fallback-stranger")));
check("fallback-disconnected: button disabled + connect hint", /<button[^>]*disabled[^>]*>Apply the agreed fallback split/.test(get("fallback-disconnected")) && get("fallback-disconnected").includes("Connect any account"));

const enabledBtn = (x: string, label: string) => new RegExp(`<button(?![^>]*disabled)[^>]*>${label}`).test(x);
const anyBtn = (x: string) => /<button/.test(x);
const stateKey = (x: string) => /data-claim-key="([a-z_]+)"/.exec(x)?.[1] ?? "";
const NEVER = /Ready to withdraw/;
// Founder decision 2026-11-05: exact withdrawal-state messages (exact equality below).
const FAILED_MSG = "The transfer failed. Your funds are available to withdraw again.";
const UNREG_MSG = "Your account must be registered with this token before you can withdraw.";
const PENDING_MSG = "Payment outcome unconfirmed. Do not retry this withdrawal.";
const PAID_MSG = "Payment completed successfully.";
const CONFIRMING = "Confirming the contract record…";
/** Exact text of the claim's status label (the Status span). */
const statusOf = (x: string) => /<span class="status [^"]*"[^>]*>([^<]*)<\/span>/.exec(x)?.[1] ?? "";
/** Exact texts of the claim's notices (<div class="notice ..."><p>TEXT</p></div>). */
const noticesOf = (x: string) => [...x.matchAll(/<div class="notice[^"]*"[^>]*><p>([^<]*)<\/p><\/div>/g)].map((m) => m[1]);
const WANT_STATUS: Record<string, string> = {
  "claim-pending": PENDING_MSG,
  "claim-inconclusive": PENDING_MSG,
  "claim-reported-paid-record-pending": PENDING_MSG,
  "claim-confirming": CONFIRMING,
  "claim-paid": PAID_MSG,
  "claim-paid-reported": PAID_MSG,
  "claim-failed": FAILED_MSG,
  "claim-failed-unregistered": FAILED_MSG,
};
for (const id of CLAIM) {
  const want = WANT_STATUS[id];
  if (want !== undefined) check(`${id}: status label is exactly "${want}"`, statusOf(get(id)) === want);
}
for (const id of CLAIM) {
  const n = noticesOf(get(id)).filter((t) => t === UNREG_MSG).length;
  const want = id === "claim-claimable-unregistered" || id === "claim-failed-unregistered" ? 1 : 0;
  check(`${id}: registration message ${want === 1 ? "shown exactly once as a notice" : "absent"}`, n === want && get(id).split(UNREG_MSG).length - 1 === want);
}
check(`"${PAID_MSG}" appears exactly twice in the page, only as the status of claim-paid and claim-paid-reported`,
  html.split(PAID_MSG).length - 1 === 2 && CLAIM.filter((id) => get(id).includes(PAID_MSG)).join(",") === "claim-paid,claim-paid-reported" && ["claim-paid", "claim-paid-reported"].every((id) => get(id).split(PAID_MSG).length - 1 === 1));
check(`"${PENDING_MSG}" only in the three PENDING scenarios`, CLAIM.filter((id) => get(id).includes(PENDING_MSG)).join(",") === "claim-pending,claim-inconclusive,claim-reported-paid-record-pending");
check(`"${FAILED_MSG}" only in the two FAILED scenarios`, CLAIM.filter((id) => get(id).includes(FAILED_MSG)).join(",") === "claim-failed,claim-failed-unregistered");

const own = get("claim-claimable-owner");
check("claimable/owner: Claimable — allocated, not paid; enabled Withdraw 333 tFT", own.includes("Claimable — allocated, not paid") && enabledBtn(own, "Withdraw") && own.includes("333 tFT") && !own.includes("Withdraw again"));
check("claimable/owner: says it attaches exactly 1 yoctoNEAR", own.includes("exactly 1 yoctoNEAR"));
const other = get("claim-claimable-other");
check("claimable/other account: button disabled, only the recipient may withdraw", anyBtn(other) && !enabledBtn(other, "Withdraw") && other.includes("Only supplier.test.near can withdraw"));
const disc = get("claim-claimable-disconnected");
check("claimable/disconnected: button disabled, connect hint", !enabledBtn(disc, "Withdraw") && disc.includes("Connect supplier.test.near"));
const unreg = get("claim-claimable-unregistered");
check("claimable/unregistered: disabled + registration message first + storage_deposit how-to", !enabledBtn(unreg, "Withdraw") && noticesOf(unreg)[0] === UNREG_MSG && unreg.includes("no storage registration on the token ft.test.near") && unreg.includes("storage_deposit") && unreg.includes("storage_balance_bounds"));

const pend = get("claim-pending");
check("pending: unconfirmed message, no button, id #4 and start time", statusOf(pend) === PENDING_MSG && !anyBtn(pend) && pend.includes("#4") && pend.includes("Started") && pend.includes("2027-01-15 08:00 UTC"));
check("pending: says do not retry, no automatic retry", pend.includes("Do not retry") && pend.includes("no automatic retry"));
const inc = get("claim-inconclusive");
check("inconclusive: unconfirmed message + permanent-limitation notice, no button", stateKey(inc) === "inconclusive" && statusOf(inc) === PENDING_MSG && inc.includes("Limitation of this version") && !anyBtn(inc));
check("inconclusive: transaction error shown as reported, not final", inc.includes("The transaction reported an error and no withdrawal result"));
const rpp = get("claim-reported-paid-record-pending");
check("tx reported PAID but record PENDING: reported text + Not final, unconfirmed message, never the paid message", rpp.includes("Reported by the transaction: PAID (withdrawal #4). Not final") && statusOf(rpp) === PENDING_MSG && !rpp.includes(PAID_MSG) && rpp.includes('data-reported="unconfirmed"'));
check("tx hash links to the explorer", rpp.includes('href="https://testnet.nearblocks.io/txns/8xFixtureTxHash"'));
const conf = get("claim-confirming");
check("PAID read once: exactly Confirming the contract record…, never the paid message", statusOf(conf) === CONFIRMING && !conf.includes(PAID_MSG) && !anyBtn(conf));
const paid = get("claim-paid");
check("paid (confirmed by a later read): paid message, amount and recipient", statusOf(paid) === PAID_MSG && paid.includes("Paid to supplier.test.near") && paid.includes("333 tFT") && paid.includes("Confirmed") && !anyBtn(paid));
const pr = get("claim-paid-reported");
check("paid + tx report: paid message + The contract record agrees", statusOf(pr) === PAID_MSG && pr.includes("The contract record agrees.") && pr.includes('data-reported="agrees"'));
const fail = get("claim-failed");
check("failed: failed-restored message, enabled Withdraw again", statusOf(fail) === FAILED_MSG && enabledBtn(fail, "Withdraw again"));
check("failed: common cause (not registered, storage_deposit) shown", fail.includes("not registered on the token contract") && fail.includes("storage_deposit"));
check("failed: tx report FAILED agrees", fail.includes("Reported by the transaction: FAILED (withdrawal #4). The contract record agrees."));
const fu = get("claim-failed-unregistered");
check("failed/unregistered: retry disabled + registration message + storage_deposit how-to", !enabledBtn(fu, "Withdraw again") && noticesOf(fu).includes(UNREG_MSG) && fu.includes("storage_deposit on ft.test.near with account_id supplier.test.near"));
const pi = get("claim-paid-inconsistent");
check("paid-inconsistent: incident, never the paid message, no button", pi.includes("incident") && !pi.includes(PAID_MSG) && !anyBtn(pi));
check("no claim shows Ready to withdraw", CLAIM.every((id) => !NEVER.test(get(id))));
check("the bare word Paid never appears as a state label", count(html, />Paid</g) === 0);
check("no Withdraw button in pending / inconclusive / confirming / paid / incident", ["claim-pending", "claim-inconclusive", "claim-reported-paid-record-pending", "claim-confirming", "claim-paid", "claim-paid-reported", "claim-paid-inconsistent"].every((id) => !anyBtn(get(id))));

// ---- LF-010A creation gate (CREATION_COPY in src/lib/creation.ts) ----
const NOT_LISTED = "Agreement creation is limited to authorized testnet creators: the accounts fixed when this contract was deployed. This account is not one of them, so it cannot create agreements here.";
const STILL = "It can still take part: when an authorized creator names this account as supplier, primary arbitrator or backup arbitrator, it can accept, deliver, rule and withdraw as that role.";
const createBtn = (s: string) => /<button[^>]*>Create agreement<\/button>/.test(s);
check("Create agreement button only in create-allowed", CREATE.filter((id) => createBtn(get(id))).join(",") === "create-allowed");
check("create-allowed: enabled button + signing-as line", !/<button[^>]*disabled[^>]*>Create agreement/.test(get("create-allowed")) && get("create-allowed").includes("an authorized testnet creator and the buyer in these terms"));
const na = get("create-not-allowlisted");
check("create-not-allowlisted: limited-to-authorized-creators text (notice + gate) and still-roles text", na.split(NOT_LISTED).length - 1 === 2 && na.split(STILL).length - 1 === 2 && na.includes('data-create-gate="not_allowlisted"'));
check("create-not-buyer: buyer explanation, no limited-creator text", get("create-not-buyer").includes("an agreement can only be created by the buyer named in its terms") && !get("create-not-buyer").includes(NOT_LISTED));
check("create-connect: connect hint", get("create-connect").includes("Connect your testnet wallet. Only authorized testnet creators can create agreements"));
check("create-preview: preview text", get("create-preview").includes("This page is a local preview."));
check("limited-creator text only in create-not-allowlisted", CREATE.filter((id) => get(id).includes(NOT_LISTED)).join(",") === "create-not-allowlisted");

// ---- fail-closed startup gate (src/app/StartupGate.tsx) ----
const BLOCKED = "LineFair will not start";
const rendered = (s: string) => s.includes('data-app="rendered"');
check("startup-ok: app rendered with the verified allowlist, no blocking screen", rendered(get("startup-ok")) && get("startup-ok").includes("creators: buyer.lf-demo.testnet") && !get("startup-ok").includes(BLOCKED));
for (const id of STARTUP.slice(1)) check(`${id}: blocking screen, app NOT rendered`, get(id).includes(BLOCKED) && get(id).includes('data-startup="blocked"') && !rendered(get(id)));
check("startup-wrong-code: names the observed and expected code hash", get("startup-wrong-code").includes("EBFuNotxobEuwVGj9Ha46KddtdPKYZHEYNwStPc9VWXb") && get("startup-wrong-code").includes("5nN5ua65yntBYmNZC6JEtdWYBbbuBkVxuHC7GZxpBgcQ") && get("startup-wrong-code").includes("is not the expected LineFair release build"));
check("startup-starve-build: version mismatch named", get("startup-starve-build").includes('expected exactly "linefair-escrow 0.1.0 (lf-012 f3)"'));
check("startup-wrong-network: get_config network mismatch named", get("startup-wrong-network").includes('get_config().network_id is "mainnet"'));
check("startup-wrong-chain: RPC chain mismatch named", get("startup-wrong-chain").includes('serves chain "mainnet"'));
check("startup-unreachable: every read failed, reported", get("startup-unreachable").split("RPC unreachable").length - 1 === 4);
check("blocking screen shows the release WASM sha256", get("startup-wrong-code").includes("470db97b62cd04701e68f6a87d7589dd8af9b8d122b96e4f5e12788d4405f2e1"));

// ---- lifecycle actions (founder authorization 2026-11-05) ----
const btn = (x: string, label: string) => new RegExp(`<button[^>]*>${label}</button>`).test(x);
const btnOn = (x: string, label: string) => new RegExp(`<button(?![^>]*disabled)[^>]*>${label}</button>`).test(x);
const btnOff = (x: string, label: string) => new RegExp(`<button[^>]*disabled[^>]*>${label}</button>`).test(x);
const reasonOf = (x: string) => /data-reason="disabled">([^<]*)</.exec(x)?.[1] ?? "";
const noteOf = (x: string) => /data-reason="other-role">([^<]*)</.exec(x)?.[1] ?? "";
const DO_NOT_SIGN = "Terms could not be verified. Do not sign.";
const TOO_LATE = "Too late to fund: the supplier would have less than the review window to deliver.";

const ACC = ["accept-buyer", "accept-supplier-done", "accept-primary", "accept-backup-mismatch", "accept-invalid", "accept-stranger", "accept-disconnected", "accept-deadline", "accept-expired", "accept-agreed"];
const FUNDS = ["fund-buyer", "fund-buyer-unregistered", "fund-buyer-low-balance", "fund-buyer-f3-too-late", "fund-buyer-mismatch", "fund-buyer-proposed", "fund-supplier", "fund-disconnected"];
const LINESC = ["deliver-supplier", "deliver-buyer", "deliver-supplier-late", "review-buyer", "review-supplier", "review-buyer-ended", "advance-no-response-stranger", "advance-non-delivery-disconnected", "advance-not-eligible"];
const OUTS = ["outcome-secured", "outcome-refund-amount", "outcome-refund-f3", "outcome-processing", "outcome-not-credited"];
const RES = ["result-confirmed", "result-unconfirmed", "result-rejected", "result-funding-refunded"];
check(`all ${ACC.length + FUNDS.length + LINESC.length + OUTS.length + RES.length + 1} lifecycle scenarios rendered`, [...ACC, ...FUNDS, ...LINESC, ...OUTS, ...RES, "wallet-return"].every((id) => sections.has(id)));

// acceptance
for (const id of ACC) {
  const s = get(id);
  check(`${id}: all four parties listed with contract acceptance state`, ["buyer", "supplier", "primary_arbitrator", "backup_arbitrator"].every((r) => s.includes(`data-accepted="${r}"`)));
  check(`${id}: acceptance deadline in UTC and local time`, s.includes("2027-01-15 08:00 UTC") && / local</.test(s));
}
check("accept-buyer: enabled Accept terms, marked (you), 1 of 4", btnOn(get("accept-buyer"), "Accept terms") && get("accept-buyer").includes("Buyer (you)") && get("accept-buyer").includes("1 of 4 accepted") && get("accept-buyer").includes('data-accepted="supplier">✓ accepted'));
check("accept-buyer: says creation is not acceptance", get("accept-buyer").includes("Creating an agreement is not acceptance"));
check("accept-supplier-done: disabled, already accepted", btnOff(get("accept-supplier-done"), "Accept terms") && reasonOf(get("accept-supplier-done")) === "You have already accepted (contract record).");
check("accept-primary: enabled Accept appointment (never Accept terms)", btnOn(get("accept-primary"), "Accept appointment") && !btn(get("accept-primary"), "Accept terms"));
const am = get("accept-backup-mismatch");
check("accept-backup-mismatch: Do not sign notice, button disabled with the same reason, no 'equal to compute_terms_hash'", btnOff(am, "Accept appointment") && am.includes(`<strong>${DO_NOT_SIGN}`) && reasonOf(am).startsWith(DO_NOT_SIGN) && !am.includes("equal to compute_terms_hash"));
check("accept-invalid: disabled, Do not sign + local validation reason", btnOff(get("accept-invalid"), "Accept terms") && reasonOf(get("accept-invalid")).startsWith(DO_NOT_SIGN) && reasonOf(get("accept-invalid")).includes("dispute window"));
check("accept-stranger: no button, not-named note", !/<button/.test(get("accept-stranger")) && noteOf(get("accept-stranger")).includes("not one of them"));
check("accept-disconnected: no button, connect note", !/<button/.test(get("accept-disconnected")) && noteOf(get("accept-disconnected")).includes("Connect your testnet wallet"));
check("accept-deadline: now == deadline is closed (disabled)", btnOff(get("accept-deadline"), "Accept terms") && reasonOf(get("accept-deadline")).includes("acceptance deadline has passed"));
check("accept-expired: disabled, expired reason", btnOff(get("accept-expired"), "Accept terms") && reasonOf(get("accept-expired")).includes("can no longer be accepted"));
check("accept-agreed: 4 of 4, no accept button", get("accept-agreed").includes("4 of 4 accepted") && !/<button/.test(get("accept-agreed")));

// funding
for (const id of FUNDS) check(`${id}: funding deadline shown in UTC and local time`, get(id).includes("Funding deadline") && get(id).includes("2027-01-16 00:40 UTC") && / local</.test(get(id)));
const fb = get("fund-buyer");
check("fund-buyer: enabled Fund line 1, exact amount, 1 yoctoNEAR, registration yes, balance read", btnOn(fb, "Fund line 1") && fb.includes("1,001 tFT") && fb.includes("1 yoctoNEAR") && fb.includes('data-check="escrow-registered">yes') && fb.includes('data-check="buyer-balance"><span class="num" title="5000 base units">5,000 tFT') && !fb.includes('data-f3="binding"'));
check("fund-buyer-unregistered: disabled, operator must register escrow", btnOff(get("fund-buyer-unregistered"), "Fund line 1") && get("fund-buyer-unregistered").includes('data-check="escrow-registered">no') && reasonOf(get("fund-buyer-unregistered")).includes("not registered on the token"));
check("fund-buyer-low-balance: disabled, below exact amount", btnOff(get("fund-buyer-low-balance"), "Fund line 1") && reasonOf(get("fund-buyer-low-balance")).includes("below the exact line amount"));
const f3 = get("fund-buyer-f3-too-late");
check("fund-buyer-f3-too-late: last moment to fund shown (delivery + grace − review), disabled with the exact F3 copy", f3.includes('data-f3="binding"') && f3.includes("2027-01-15 23:00 UTC") && btnOff(f3, "Fund line 2") && reasonOf(f3) === TOO_LATE);
check("fund-buyer-mismatch: disabled, Do not sign", btnOff(get("fund-buyer-mismatch"), "Fund line 1") && reasonOf(get("fund-buyer-mismatch")).startsWith(DO_NOT_SIGN));
check("fund-buyer-proposed: disabled until all four accept", btnOff(get("fund-buyer-proposed"), "Fund line 1") && reasonOf(get("fund-buyer-proposed")).includes("All four parties must accept"));
check("fund-supplier: no button, only-the-buyer note", !btn(get("fund-supplier"), "Fund line 1") && noteOf(get("fund-supplier")) === "Only the buyer (buyer.test.near) can fund this line.");
check("fund-disconnected: no button, connect note", !btn(get("fund-disconnected"), "Fund line 1") && noteOf(get("fund-disconnected")).includes("Connect your testnet wallet"));
check("no funding scenario shows Secured in escrow before a contract read", FUNDS.every((id) => !get(id).includes("Secured in escrow")));

// delivery / review / advance
const ds = get("deliver-supplier");
check("deliver-supplier: cutoff shown, file input enabled, submit disabled until commitment + saved receipt, says only the commitment is sent", ds.includes("2027-01-18 19:20 UTC") && /<input[^>]*type="file"(?![^>]*disabled)/.test(ds) && btnOff(ds, "Submit delivery for line 1") && ds.includes("Only the commitment is sent") && ds.includes('data-reason="needs-commitment"'));
check("deliver-buyer: no submit button, only-the-supplier note", !btn(get("deliver-buyer"), "Submit delivery for line 1") && noteOf(get("deliver-buyer")) === "Only the supplier (supplier.test.near) can submit delivery for this line.");
check("deliver-supplier-late: submit disabled, cutoff passed + non-delivery path; advance offered", btnOff(get("deliver-supplier-late"), "Submit delivery for line 1") && reasonOf(get("deliver-supplier-late")).includes("delivery cutoff has passed") && btnOn(get("deliver-supplier-late"), "Move line 1 into the dispute process"));
const rb = get("review-buyer");
check("review-buyer: enabled Accept delivery + Open dispute, review window end in UTC and local", btnOn(rb, "Accept delivery") && btnOn(rb, "Open dispute") && rb.includes("Review window ends") && rb.includes("2027-01-17 03:20 UTC") && rb.includes("(exclusive)"));
check("review-buyer: no advance offered inside the window", !btn(rb, "Move line 1 into the dispute process"));
check("review-supplier: no buttons, only-the-buyer note", !/<button/.test(get("review-supplier")) && noteOf(get("review-supplier")) === "Only the buyer (buyer.test.near) can accept or dispute this delivery.");
check("review-buyer-ended: both disabled with the no-response reason; advance enabled for the buyer too", btnOff(get("review-buyer-ended"), "Accept delivery") && btnOff(get("review-buyer-ended"), "Open dispute") && reasonOf(get("review-buyer-ended")).includes("review window has ended") && btnOn(get("review-buyer-ended"), "Move line 1 into the dispute process"));
const an = get("advance-no-response-stranger");
check("advance-no-response-stranger: enabled for anyone, fixed T0 = review end, fixed-T0 explanation", btnOn(an, "Move line 1 into the dispute process") && an.includes("Dispute T0 (fixed)") && an.includes("2027-01-17 03:20 UTC") && an.includes("T0 is fixed at the missed deadline") && an.includes("Anyone may do this."));
const ad = get("advance-non-delivery-disconnected");
check("advance-non-delivery-disconnected: disabled with connect-any-account reason, T0 = delivery cutoff", btnOff(ad, "Move line 1 into the dispute process") && reasonOf(ad).includes("Connect any account") && ad.includes("No delivery") && ad.includes("2027-01-18 19:20 UTC"));
check("advance-not-eligible: no advance control (view reports no eligibility)", !get("advance-not-eligible").includes("Move line 1 into the dispute process") && !get("advance-not-eligible").includes("Dispute T0 (fixed)"));

// funding outcomes (pure FundingOutcomeCard over fundingOutcome)
const statusText = (x: string) => /<span class="status [^"]*"[^>]*>([^<]*)<\/span>/.exec(x)?.[1] ?? "";
check("outcome-secured: Secured in escrow with the exact principal", get("outcome-secured").includes('data-funding-outcome="secured"') && statusText(get("outcome-secured")) === "Secured in escrow" && get("outcome-secured").includes("1,001 tFT"));
check("outcome-refund-amount: Not funded, nothing credited, refund copy + reason + code", get("outcome-refund-amount").includes('data-funding-outcome="refunded"') && statusText(get("outcome-refund-amount")) === "Not funded" && get("outcome-refund-amount").includes("Nothing was credited") && get("outcome-refund-amount").includes("Deposit was not accepted.") && get("outcome-refund-amount").includes('data-refund-code="AmountMismatch"'));
check("outcome-refund-f3: DeliveryTimeTooShort mapped to the exact too-late copy", get("outcome-refund-f3").includes('data-refund-code="DeliveryTimeTooShort"') && get("outcome-refund-f3").includes(`Reason: ${TOO_LATE}`));
check("outcome-processing: tx reported P used, contract UNFUNDED -> processing, never Secured", statusText(get("outcome-processing")) === "Funding transaction processing" && !get("outcome-processing").includes("Secured in escrow") && get("outcome-processing").includes("Reported by the transaction"));
check("outcome-not-credited: failed tx -> Not funded, nothing credited", statusText(get("outcome-not-credited")) === "Not funded" && get("outcome-not-credited").includes("Nothing was credited."));
check("Secured in escrow appears in exactly one outcome scenario", OUTS.filter((id) => get(id).includes("Secured in escrow")).join(",") === "outcome-secured");

// post-transaction re-read results
const rc = get("result-confirmed");
check("result-confirmed: tx hash linked to the explorer, reported text, confirmed verdict, block", rc.includes(`href="https://testnet.nearblocks.io/txns/${TXHASH}"`) && rc.includes('data-reported="tx"') && rc.includes('data-verdict="confirmed"') && rc.includes("Contract read at block 778"));
check("result-unconfirmed: verdict unconfirmed, 'not proof', warning tone", get("result-unconfirmed").includes('data-verdict="unconfirmed"') && get("result-unconfirmed").includes("not proof") && get("result-unconfirmed").includes('class="notice warning"'));
check("result-rejected: exact ERR_LINE:ReviewWindowClosed copy, negative notice", get("result-rejected").includes('data-error-code="ERR_LINE:ReviewWindowClosed"') && get("result-rejected").includes("The review window has closed.") && get("result-rejected").includes('class="notice negative"'));
check("result-funding-refunded: hash link + refund outcome, no Secured", get("result-funding-refunded").includes(`txns/${TXHASH}`) && get("result-funding-refunded").includes('data-refund-code="FundingDeadlinePassed"') && !get("result-funding-refunded").includes("Secured in escrow"));

// wallet return banner (three loads)
check("plain load: no wallet-return banner", !get("wallet-return").includes("data-wallet-return"));
const wt = sectionsOf(htmlTx).get("wallet-return") ?? "";
check("tx-hash return: banner kind success, hash linked to the explorer, labelled reported by the wallet", wt.includes('data-wallet-return="success"') && wt.includes(`href="https://testnet.nearblocks.io/txns/${TXHASH}"`) && wt.includes("Reported by the wallet, not a result"));
check("tx-hash return: params stripped (replaceState), address bar now without transactionHashes", /data-url-after="http:\/\/127\.0\.0\.1:\d+\/"/.test(wt) && /data-location-now="http:\/\/127\.0\.0\.1:\d+\/"/.test(wt) && !/data-location-now="[^"]*transactionHashes/.test(wt));
check("tx-hash return: re-read the contract (block 777) and show the refund from the tx logs, line Not funded, never Secured", wt.includes('data-reread="done"') && wt.includes("Contract read at block 777") && wt.includes("Line state (contract): Not funded") && wt.includes('data-refund-code="AmountMismatch"') && !wt.includes("Secured in escrow"));
const we = sectionsOf(htmlErr).get("wallet-return") ?? "";
check("error return: banner kind error, userRejected copy, wallet message, no tx link", we.includes('data-wallet-return="error"') && we.includes('data-wallet-error="userRejected"') && we.includes("You rejected the request in the wallet.") && we.includes("User rejected transaction") && !we.includes("/txns/"));
check("error return: params stripped", /data-location-now="http:\/\/127\.0\.0\.1:\d+\/"/.test(we) && !/data-location-now="[^"]*errorCode/.test(we));
check("error return: contract re-read shows the acceptance is NOT recorded", we.includes('data-reread="done"') && we.includes('data-verdict="unconfirmed"') && we.includes("does not show your acceptance yet"));
check("other scenarios identical across the three loads (wallet params affect only the banner)", ["fund-buyer", "accept-buyer", "review-buyer"].every((id) => sectionsOf(htmlTx).get(id) === get(id) && sectionsOf(htmlErr).get(id) === get(id)));

console.log(failures === 0 ? "RESULT: ALL DOM CHECKS PASSED (offline fixture page in headless Chrome; not chain data, not wallet integration)" : `RESULT: ${failures} DOM CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
