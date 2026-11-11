// LOCAL SANDBOX ONLY — NOT WALLET INTEGRATION.
//
// The canonical 3-line demonstration (docs/32 §5) on a local near-sandbox
// node, driven ONLY by the integrated frontend's own code: transaction
// builders (src/lib/near/tx.ts), read path (NearRpc + readLineSnapshot),
// lifecycle / arbitration / withdrawal UI models, error and refund copy,
// evidence commitments and the expected-deployment constants. Contract: the
// qualified F3 release WASM (lf-012 f3); optional test-only starve WASM for
// the inconclusive-withdrawal case.
//
//   1. deployment identity: code hash == EXPECTED_CODE_HASH, exact version, get_config
//   2. creator allowlist: a non-allowlisted creator is refused
//   3. 3-line agreement: buyer + supplier accept_terms, arbitrators accept_appointment
//   4. funding (ft_transfer_call): all three lines "Secured in escrow"
//   5. F3: a second agreement whose F3 limit passes before its funding deadline
//      (grace 30 s counted): UI disables funding with the too-late copy; a deposit
//      sent anyway is refunded in full (LF_FT_REFUND:DeliveryTimeTooShort), E unchanged
//   6. submit_delivery with salted evidence commitments
//   7. A accept_line; B open_dispute + mutual split; C buyer silent -> advance_case
//      (permissionless) NO_RESPONSE -> primary arbitrator ruling in its window
//   8. withdrawals: unregistered supplier -> FAILED restored -> storage_deposit ->
//      PAID only after a confirming re-read; every beneficiary paid; E = 0
//   9. (starve WASM) callback cannot finish -> PENDING, "Payment outcome unconfirmed."
//
// Signing uses @near-js KeyPairSigner with ephemeral in-memory keys and the
// sandbox home's local validator key; nothing is written to disk and no key
// is printed. This is not the browser wallet path (wallet.ts).
//
// Usage (Node >= 24):
//   node scripts/sandbox-f3-demo.ts <sandbox-home> <rpc-url> <escrow.wasm> <test-ft.wasm> [<escrow-starve.wasm>]
// Refuses any RPC URL that is not loopback and any chain that is not localnet.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Account } from "@near-js/accounts";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators } from "@near-js/transactions";

import {
  acceptAppointmentCall,
  acceptLineCall,
  acceptSplitCall,
  acceptTermsCall,
  advanceCaseCall,
  createAgreementCall,
  fundLineCall,
  openDisputeCall,
  proposeSplitCall,
  submitDeliveryCall,
  submitRulingCall,
  withdrawCall,
  type FunctionCallSpec,
} from "../src/lib/near/tx.ts";
import { NearRpc } from "../src/lib/near/rpc.ts";
import { claimSnapshot, readLineSnapshot, type LineSnapshot } from "../src/lib/near/snapshot.ts";
import { describeError, extractErrorCode } from "../src/lib/contract/errors.ts";
import { claimPanel, parseWithdrawResult, type Registration, type TxRecord, type Who } from "../src/lib/contract/withdrawals.ts";
import type { AgreementView, LineView } from "../src/lib/contract/types.ts";
import { checkTerms, fundAvail, fundingOutcome, fundingWindow, lineActionVerdict, LIFECYCLE_COPY } from "../src/lib/contract/lifecycle.ts";
import { rulingAvailability } from "../src/lib/contract/arbitration.ts";
import { contentDigest, evidenceCommitmentHex, newSalt } from "../src/lib/commitment.ts";
import { EXPECTED_CODE_HASH, EXPECTED_DEPLOYMENT } from "../src/lib/deployment.ts";
import { parseTermsJson, termsHashHex } from "../src/lib/terms.ts";

const [home, rpcUrl, escrowWasm, ftWasm, starveWasm] = process.argv.slice(2);
if (home === undefined || rpcUrl === undefined || escrowWasm === undefined || ftWasm === undefined) {
  throw new Error("usage: sandbox-f3-demo.ts <sandbox-home> <rpc-url> <escrow.wasm> <test-ft.wasm> [<escrow-starve.wasm>]");
}
const host = new URL(rpcUrl).hostname;
if (host !== "127.0.0.1" && host !== "localhost") throw new Error("local sandbox RPC only (loopback)");

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const out = (k: string, v: unknown) => console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}`);
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  out(`${ok ? "PASS" : "FAIL"} ${name}`, detail ?? "");
}
function must(name: string, ok: boolean, detail?: unknown): void {
  check(name, ok, detail);
  if (!ok) throw new Error(`stopping: ${name}`);
}

const provider = new JsonRpcProvider({ url: rpcUrl });
const status = (await provider.status()) as { chain_id: string };
out("chain_id", status.chain_id);
if (status.chain_id !== "localnet") throw new Error("refusing: chain_id is not localnet");
out("escrow wasm sha256", sha(escrowWasm));
out("test-ft wasm sha256", sha(ftWasm));
if (starveWasm !== undefined) out("escrow STARVE (test-only) wasm sha256", sha(starveWasm));
must("escrow WASM is the qualified release (EXPECTED_DEPLOYMENT.wasmSha256)", sha(escrowWasm) === EXPECTED_DEPLOYMENT.wasmSha256, sha(escrowWasm));

const rpc = new NearRpc(rpcUrl);
const vk = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8")) as { account_id: string; secret_key: KeyPairString };
const root = new Account(vk.account_id, provider, KeyPairSigner.fromSecretKey(vk.secret_key));
const NEAR = 10n ** 24n;
const SEC = 1_000_000_000n;
const RUN = randomBytes(3).toString("hex");
out("run tag", RUN);
async function make(name: string, near: bigint): Promise<Account> {
  const kp = KeyPair.fromRandom("ed25519");
  const id = `${name}-${RUN}.${vk.account_id}`;
  await root.createAccount(id, kp.getPublicKey(), near * NEAR);
  return new Account(id, provider, new KeyPairSigner(kp));
}

interface Sent { ok: boolean; successValue: string | null; value?: unknown; error?: string; code?: string | null; tx: string; logs: string[] }
async function send(acc: Account, spec: FunctionCallSpec): Promise<Sent> {
  const o = await acc.signAndSendTransaction({
    receiverId: spec.receiverId,
    actions: [actionCreators.functionCall(spec.methodName, spec.args, spec.gas, spec.deposit)],
    throwOnFailure: false,
  });
  const logs = o.receipts_outcome.flatMap((r) => r.outcome.logs);
  const st = o.status as { SuccessValue?: string; Failure?: unknown };
  if (st.Failure !== undefined) {
    const error = JSON.stringify(st.Failure);
    return { ok: false, successValue: null, error, code: extractErrorCode(error), tx: o.transaction.hash, logs };
  }
  const raw = Buffer.from(st.SuccessValue ?? "", "base64").toString("utf8");
  return { ok: true, successValue: st.SuccessValue ?? null, value: raw === "" ? null : JSON.parse(raw), tx: o.transaction.hash, logs };
}
const view = <T>(contract: string, method: string, args: Record<string, unknown> = {}) => provider.callFunction(contract, method, args) as unknown as Promise<T>;
const nowNs = async () => BigInt((await provider.viewBlock({ finality: "final" })).header.timestamp_nanosec);
async function waitUntil(ns: bigint, label: string): Promise<void> {
  for (;;) {
    const n = await nowNs();
    if (n >= ns) return void out(`waited for ${label}`, `chain time ${n} >= ${ns}`);
    await sleep(Math.min(5000, Math.max(500, Number((ns - n) / 1_000_000n))));
  }
}
const getAgreement = async (escrowId: string, id: string) => (await view<AgreementView>(escrowId, "get_agreement", { agreement_id: id })) as AgreementView;
const lineOf = async (escrowId: string, id: string, i: number): Promise<LineView> => (await getAgreement(escrowId, id)).lines[i] as LineView;

// --- accounts and contracts (ephemeral, local) ---
const escrow = await make("escrow", 20n);
const ft = await make("ft", 20n);
const buyer = await make("buyer", 10n);
const buyerSpare = await make("buyerspare", 2n);
const supplier = await make("supplier", 10n);
const primary = await make("primary", 5n);
const backup = await make("backup", 5n);
const stranger = await make("stranger", 5n);
await make("treasury", 1n);
const TREASURY = `treasury-${RUN}.${vk.account_id}`;
const FT = ft.accountId;
const B = buyer.accountId;
const S = supplier.accountId;
const ALLOWLIST = [B, buyerSpare.accountId];

async function deployEscrow(acc: Account, wasm: string): Promise<string> {
  await acc.deployContract(new Uint8Array(readFileSync(wasm)));
  await acc.callFunction({
    contractId: acc.accountId,
    methodName: "new",
    args: { network_id: "sandbox", allowlisted_ft_id: FT, operator_treasury_id: TREASURY, max_agreements: 25, creator_allowlist: ALLOWLIST },
  });
  return acc.accountId;
}
const E = await deployEscrow(escrow, escrowWasm);
await ft.deployContract(new Uint8Array(readFileSync(ftWasm)));
await ft.callFunction({ contractId: FT, methodName: "new_default_meta", args: { owner_id: FT, total_supply: "1000000000000" } });
const bounds = await view<{ min: string }>(FT, "storage_balance_bounds");
const register = (who: string) => ft.callFunction({ contractId: FT, methodName: "storage_deposit", args: { account_id: who, registration_only: true }, deposit: BigInt(bounds.min) });
for (const who of [E, B]) await register(who); // supplier deliberately NOT registered yet (step 8)
const BUYER_START = 1_000_000_000n;
await ft.callFunction({ contractId: FT, methodName: "ft_transfer", args: { receiver_id: B, amount: BUYER_START.toString() }, deposit: 1n });

// ---- 1. deployment identity (what the startup gate compares) ----
const acct = await rpc.viewAccount(E);
check("1 on-chain code hash == EXPECTED_CODE_HASH (release)", acct.value.code_hash === EXPECTED_CODE_HASH, acct.value.code_hash);
const version = await view<string>(E, "contract_version");
check("1 contract_version() exactly EXPECTED_DEPLOYMENT.contractVersion", version === EXPECTED_DEPLOYMENT.contractVersion && version === "linefair-escrow 0.1.0 (lf-012 f3)", version);
const cfg = await view<{ allowlisted_ft_id: string; creator_allowlist: string[]; max_agreements: number }>(E, "get_config");
check("1 get_config: token, cap, creator allowlist", cfg.allowlisted_ft_id === FT && cfg.max_agreements === 25 && JSON.stringify(cfg.creator_allowlist) === JSON.stringify(ALLOWLIST), cfg);

// ---- terms ----
const HOUR = 3_600_000_000_000n;
interface Timing { acc: bigint; fund: bigint; grace: bigint; review: bigint; deliveries: bigint[] }
function termsFor(t: Timing, principals: bigint[], nonce: string) {
  return {
    schema_version: 1, deadline_rules_version: 1, buyer_id: B, supplier_id: S, primary_arbitrator_id: primary.accountId, backup_arbitrator_id: backup.accountId,
    ft_contract_id: FT, agreement_nonce: nonce, acceptance_deadline_ns: t.acc.toString(), funding_deadline_ns: t.fund.toString(), delivery_grace_period_ns: t.grace.toString(),
    review_window_ns: t.review.toString(), negotiation_window_ns: (60n * SEC).toString(), primary_window_ns: (60n * SEC).toString(), backup_window_ns: (60n * SEC).toString(),
    lines: principals.map((p, i) => ({ line_id: i, principal: p.toString(), delivery_deadline_ns: t.deliveries[i].toString(), acceptance_criteria_commitment: `0${i + 1}`.repeat(32), fallback_buyer_bps: 5000, fallback_supplier_bps: 5000 })),
  };
}
async function createAndAccept(escrowId: string, terms: ReturnType<typeof termsFor>, label: string): Promise<AgreementView> {
  const parsed = parseTermsJson(JSON.stringify(terms));
  must(`${label} terms parse in the TS encoder`, parsed.ok);
  const local = parsed.ok ? await termsHashHex("sandbox", escrowId, parsed.terms) : "";
  const onchain = await view<string>(escrowId, "compute_terms_hash", { terms });
  check(`${label} TS terms hash == contract compute_terms_hash`, local === onchain, local);
  const c = await send(buyer, createAgreementCall(escrowId, terms as never));
  must(`${label} create_agreement by allowlisted buyer`, c.ok, c.error);
  const id = String(c.value);
  let a = await getAgreement(escrowId, id);
  const tc = checkTerms(local, a.terms_hash, onchain);
  check(`${label} UI terms check ok (local == stored == contract)`, tc.ok, tc);
  for (const [who, spec, name] of [
    [buyer, acceptTermsCall(escrowId, id, a.terms_hash), "buyer accept_terms"],
    [supplier, acceptTermsCall(escrowId, id, a.terms_hash), "supplier accept_terms"],
    [primary, acceptAppointmentCall(escrowId, id, a.terms_hash), "primary accept_appointment"],
    [backup, acceptAppointmentCall(escrowId, id, a.terms_hash), "backup accept_appointment"],
  ] as const) {
    const r = await send(who, spec);
    must(`${label} ${name}`, r.ok, r.error);
  }
  a = await getAgreement(escrowId, id);
  must(`${label} status AGREED after four acceptances`, a.status === "AGREED", a.status);
  return a;
}
const ftBalance = async (who: string) => BigInt(await view<string>(FT, "ft_balance_of", { account_id: who }));
const custodyE = async (escrowId: string) => (await view<{ outstanding_liabilities: string }>(escrowId, "custody_summary")).outstanding_liabilities;

// ---- 2. creator allowlist ----
{
  const t0 = await nowNs();
  const terms = termsFor({ acc: t0 + HOUR, fund: t0 + 2n * HOUR, grace: 0n, review: 60n * SEC, deliveries: [t0 + 9n * HOUR] }, [5n], "1");
  const r = await send(stranger, createAgreementCall(E, { ...terms, buyer_id: stranger.accountId } as never));
  const d = r.error === undefined ? null : describeError(r.error);
  check("2 non-allowlisted creator refused: ERR_CREATOR_NOT_ALLOWLISTED (mapped copy)", !r.ok && r.code === "ERR_CREATOR_NOT_ALLOWLISTED" && d !== null && !d.unknown, { code: r.code, copy: d?.title });
}

// ---- 3. agreements: main (M, 3 lines) and late-funding (L, 1 line, grace 30 s) ----
const T = await nowNs();
const PA = 400n, PB = 1000n, PC = 1000n;
const M = termsFor({ acc: T + 90n * SEC, fund: T + 180n * SEC, grace: 0n, review: 60n * SEC, deliveries: [T + HOUR, T + HOUR, T + HOUR] }, [PA, PB, PC], "2");
// L: delivery == funding deadline (allowed); F3 limit = delivery + grace − review = acc + 30 s < funding deadline.
const accL = T + 75n * SEC;
const L = termsFor({ acc: accL, fund: accL + 60n * SEC, grace: 30n * SEC, review: 60n * SEC, deliveries: [accL + 60n * SEC] }, [700n], "3");
let a = await createAndAccept(E, M, "3 [M]");
const id = a.agreement_id;
const aL = await createAndAccept(E, L, "3 [L]");
const idL = aL.agreement_id;

// ---- 4. funding M ----
for (const [i, p] of [[0, PA], [1, PB], [2, PC]] as const) {
  const now = await nowNs();
  const av = fundAvail(a, a.lines[i] as LineView, "buyer", B, now, { ok: true } as never, { escrowRegistered: true, buyerBalance: await ftBalance(B) });
  check(`4 UI: Fund enabled for line ${i}`, av.kind === "enabled", av);
  const f = await send(buyer, fundLineCall(FT, E, id, i, p, a.terms_hash));
  const fresh = await lineOf(E, id, i);
  const o = fundingOutcome(fresh, p, { usedAmount: f.value === undefined || f.value === null ? null : String(f.value), logs: f.logs, failure: f.error ?? null });
  check(`4 fund line ${i}: token kept ${p}, UI "Secured in escrow" from a fresh read`, f.ok && f.value === p.toString() && o.key === "secured", { used: f.value, ui: o.title, tx: f.tx });
}
a = await getAgreement(E, id);
check("4 custody E == 2400, agreement ACTIVE", (await custodyE(E)) === (PA + PB + PC).toString() && a.status === "ACTIVE", { E: await custodyE(E), status: a.status });

// ---- 5. F3 late deposit on L ----
{
  const w = fundingWindow(aL, 0);
  check("5 UI funding window: F3 binds, last creditable = delivery + grace − review = acc + 30 s", w.f3Binding && w.lastCreditableNs === accL + 30n * SEC && w.deadlineNs === accL + 60n * SEC, w);
  await waitUntil((w.lastCreditableNs ?? 0n) + 2n * SEC, "past the F3 limit (still before the funding deadline)");
  const now = await nowNs();
  check("5 still before L's funding deadline", now < w.deadlineNs, { now, deadline: w.deadlineNs });
  const av = fundAvail(aL, aL.lines[0] as LineView, "buyer", B, now, { ok: true } as never, { escrowRegistered: true, buyerBalance: await ftBalance(B) });
  check("5 UI: Fund disabled with the exact too-late copy", av.kind === "disabled" && "reason" in av && av.reason === LIFECYCLE_COPY.tooLate, av);
  const before = { buyer: await ftBalance(B), escrow: await ftBalance(E), E: await custodyE(E) };
  const f = await send(buyer, fundLineCall(FT, E, idL, 0, 700n, aL.terms_hash)); // sent anyway (the UI would not)
  const fresh = await lineOf(E, idL, 0);
  const o = fundingOutcome(fresh, 700n, { usedAmount: f.value === undefined || f.value === null ? null : String(f.value), logs: f.logs, failure: f.error ?? null });
  const after = { buyer: await ftBalance(B), escrow: await ftBalance(E), E: await custodyE(E) };
  check("5 late deposit: token kept 0, log LF_FT_REFUND:DeliveryTimeTooShort", f.ok && f.value === "0" && f.logs.some((l) => l.includes("LF_FT_REFUND:DeliveryTimeTooShort")), { used: f.value, tx: f.tx });
  check("5 UI: \"Nothing was credited. The deposit was returned.\" with the F3 reason", o.key === "refunded" && o.refund.reason === LIFECYCLE_COPY.tooLate, o);
  check("5 zero liability: line UNFUNDED, buyer/escrow balances and E unchanged", fresh.status === "UNFUNDED" && fresh.locked === "0" && after.buyer === before.buyer && after.escrow === before.escrow && after.E === before.E, { before, after });
}

// ---- 6. deliveries with salted evidence commitments ----
const commitments: string[] = [];
for (const i of [0, 1, 2]) {
  const doc = new TextEncoder().encode(`synthetic deliverable for line ${i} (demo only, never on chain)`);
  const c = await evidenceCommitmentHex({ network: "sandbox", escrowId: E, agreementId: BigInt(id), lineId: i, version: 1, contentDigest: await contentDigest(doc), salt: newSalt() });
  commitments.push(c);
  const r = await send(supplier, submitDeliveryCall(E, id, i, c));
  const v = lineActionVerdict("submit_delivery", await lineOf(E, id, i), { evidenceCommitment: c });
  check(`6 submit_delivery line ${i}: confirmed by a fresh read with this commitment`, r.ok && v.confirmed, { tx: r.tx, text: v.text });
}

// ---- 7. outcomes ----
{
  const r = await send(buyer, acceptLineCall(E, id, 0));
  check("7 A accept_line: confirmed (supplier claimable 400)", r.ok && lineActionVerdict("accept_line", await lineOf(E, id, 0)).confirmed, r.tx);
  const d = await send(buyer, openDisputeCall(E, id, 1));
  check("7 B open_dispute: confirmed", d.ok && lineActionVerdict("open_dispute", await lineOf(E, id, 1)).confirmed, d.tx);
  const prop = await send(supplier, proposeSplitCall(E, id, 1, 300n, 700n, PB));
  check("7 B propose_split 300/700 (supplier)", prop.ok, prop.value);
  const acc = await send(buyer, acceptSplitCall(E, id, 1, String(prop.value), "300", "700"));
  const lb = await lineOf(E, id, 1);
  check("7 B accept_split: ALLOCATED MUTUAL 300/700", acc.ok && lb.status === "ALLOCATED" && lb.allocation_mode === "MUTUAL" && lb.buyer_claimable === "300" && lb.supplier_claimable === "700", lb.allocation_mode);
  // C: buyer stays silent through the review window.
  const lc0 = await lineOf(E, id, 2);
  await waitUntil(BigInt(lc0.submitted_at_ns) + 60n * SEC + SEC, "C review window end");
  const adv = await send(stranger, advanceCaseCall(E, id, 2));
  const lc1 = await lineOf(E, id, 2);
  check("7 C advance_case by a stranger (permissionless): DISPUTED NO_RESPONSE, fixed T0 = submission + review", adv.ok && lineActionVerdict("advance_case", lc1).confirmed && lc1.dispute_reason === "NO_RESPONSE" && lc1.dispute_t0_ns === (BigInt(lc0.submitted_at_ns) + 60n * SEC).toString(), { t0: lc1.dispute_t0_ns, tx: adv.tx });
  const early = rulingAvailability(lc1, "primary_arbitrator");
  check("7 C UI: primary cannot rule during negotiation", !early.canRule, early);
  await waitUntil(BigInt(lc1.dispute_t0_ns) + 60n * SEC + SEC, "C primary window start (T0 + N)");
  const lc2 = await lineOf(E, id, 2);
  const ra = rulingAvailability(lc2, "primary_arbitrator");
  check("7 C UI: primary ruling form shown in the PRIMARY phase only", ra.canRule && lc2.dispute_phase === "PRIMARY" && !rulingAvailability(lc2, "backup_arbitrator").canRule, lc2.dispute_phase);
  const ru = await send(primary, submitRulingCall(E, id, 2, 250n, 750n, PC));
  const lc3 = await lineOf(E, id, 2);
  check("7 C submit_ruling 250/750 by primary: ALLOCATED PRIMARY_RULING", ru.ok && lc3.status === "ALLOCATED" && lc3.allocation_mode === "PRIMARY_RULING" && lc3.buyer_claimable === "250" && lc3.supplier_claimable === "750", { mode: lc3.allocation_mode, tx: ru.tx });
}

// ---- 8. withdrawals through the UI claim model ----
async function registration(account: string): Promise<Registration> {
  try {
    return (await rpc.storageBalanceOf(FT, account)).value === null ? "not_registered" : "registered";
  } catch {
    return "unknown";
  }
}
function panel(s: LineSnapshot, who: Who, o: { confirm?: LineSnapshot; registration: Registration; tx?: TxRecord | null }) {
  return claimPanel({
    who, recipient: who === "buyer" ? B : S, ftId: FT, snap: claimSnapshot(s, who),
    confirm: o.confirm === undefined ? undefined : claimSnapshot(o.confirm, who),
    connected: who === "buyer" ? B : S, registration: o.registration, tx: o.tx ?? null,
  });
}
const snapshot = (escrowId: string, aid: string, line: number) => readLineSnapshot(rpc, escrowId, aid, line);
async function uiWithdraw(signer: Account, escrowId: string, aid: string, line: number, who: Who) {
  const pre = await snapshot(escrowId, aid, line);
  const beforeId = (who === "buyer" ? pre.buyer : pre.supplier)?.withdrawal_id ?? "0";
  const r = await send(signer, withdrawCall(escrowId, aid, line, who === "buyer" ? "BUYER" : "SUPPLIER"));
  const reported = r.successValue === null ? null : parseWithdrawResult(r.successValue);
  let s = await snapshot(escrowId, aid, line);
  for (let n = 1; n < 5; n++) {
    const rec = who === "buyer" ? s.buyer : s.supplier;
    if (rec !== null && rec.withdrawal_id !== beforeId && rec.state !== "PENDING") break;
    await sleep(1500);
    s = await snapshot(escrowId, aid, line);
  }
  const tx: TxRecord = { phase: "ended", txHash: r.tx, reported, error: r.error ?? null, rereadDone: true };
  const reg = await registration(who === "buyer" ? B : S);
  let confirm: LineSnapshot | undefined;
  if ((who === "buyer" ? s.line.buyer_withdrawal : s.line.supplier_withdrawal) === "PAID") {
    await sleep(1200);
    confirm = await snapshot(escrowId, aid, line);
  }
  const final = panel(s, who, { registration: reg, tx, ...(confirm !== undefined ? { confirm } : {}) });
  return { r, reported, s, final, tx };
}
{
  let w = await uiWithdraw(supplier, E, id, 0, "supplier");
  check("8 A supplier unregistered: FAILED, exactly \"The transfer failed. Your funds are available to withdraw again.\"", w.reported?.outcome === "FAILED" && w.final.label === "The transfer failed. Your funds are available to withdraw again." && w.s.line.supplier_claimable === PA.toString(), { label: w.final.label, tx: w.r.tx });
  check("8 UI shows the registration notice exactly", w.final.notices.some((n) => n.text.includes("Your account must be registered with this token before you can withdraw.")), w.final.notices.map((n) => n.text));
  await register(S);
  for (let n = 0; n < 10 && (await registration(S)) !== "registered"; n++) await sleep(1000);
  w = await uiWithdraw(supplier, E, id, 0, "supplier");
  check("8 A retry after storage_deposit: exactly \"Payment completed successfully.\" only after a confirming re-read", w.reported?.outcome === "PAID" && w.final.key === "paid" && w.final.label === "Payment completed successfully." && w.final.amount === PA, { label: w.final.label, tx: w.r.tx });
  for (const [line, acc, who, amt] of [[1, buyer, "buyer", 300n], [1, supplier, "supplier", 700n], [2, buyer, "buyer", 250n], [2, supplier, "supplier", 750n]] as const) {
    w = await uiWithdraw(acc, E, id, line, who);
    check(`8 line ${line} ${who}: Paid ${amt} after confirmation`, w.final.key === "paid" && w.final.amount === amt && w.reported?.outcome === "PAID", { key: w.final.key, tx: w.r.tx });
  }
  const s = await snapshot(E, id, 2);
  check("8 custody: E = 0, no open withdrawals", s.custody.outstanding_liabilities === "0" && s.custody.open_withdrawals === "0", s.custody);
  check("8 escrow token balance 0 == E", (await ftBalance(E)) === 0n);
  check("8 balances reconcile: buyer 1e9 − 2400 + 300 + 250; supplier 400 + 700 + 750", (await ftBalance(B)) === BUYER_START - PA - PB - PC + 550n && (await ftBalance(S)) === PA + 700n + 750n, { buyer: await ftBalance(B), supplier: await ftBalance(S) });
}

// ---- 9. starve WASM (test only, never deployable) ----
if (starveWasm !== undefined) {
  const E2 = await deployEscrow(await make("starve", 20n), starveWasm);
  await register(E2);
  const v2 = await view<string>(E2, "contract_version");
  const code2 = (await rpc.viewAccount(E2)).value.code_hash;
  check("9 starve build reports +test-starve-callback and is NOT the expected code hash (startup gate would refuse it)", v2 === "linefair-escrow 0.1.0 (lf-012 f3) +test-starve-callback" && code2 !== EXPECTED_CODE_HASH, { v2, code2 });
  const t = await nowNs();
  const a2 = await createAndAccept(E2, termsFor({ acc: t + HOUR, fund: t + 2n * HOUR, grace: 0n, review: 60n * SEC, deliveries: [t + 9n * HOUR] }, [500n], "4"), "9 [starve]");
  const id2 = a2.agreement_id;
  must("9 fund", (await send(buyer, fundLineCall(FT, E2, id2, 0, 500n, a2.terms_hash))).value === "500");
  must("9 submit", (await send(supplier, submitDeliveryCall(E2, id2, 0, "ab".repeat(32)))).ok);
  must("9 accept_line", (await send(buyer, acceptLineCall(E2, id2, 0))).ok);
  const before = await ftBalance(S);
  const st = await uiWithdraw(supplier, E2, id2, 0, "supplier");
  check("9 record stays PENDING after the tx ended (no retry, no timer)", st.s.supplier?.state === "PENDING" && st.s.line.supplier_pending === "500", st.s.supplier);
  check("9 UI: exactly \"Payment outcome unconfirmed. Do not retry this withdrawal.\", no action", st.final.key === "inconclusive" && st.final.label === "Payment outcome unconfirmed. Do not retry this withdrawal." && st.final.action.kind === "none", st.final.label);
  check("9 token moved yet the UI never says paid; E still counts it", (await ftBalance(S)) - before === 500n && st.final.key !== "paid" && st.s.custody.outstanding_liabilities === "500", st.s.custody);
}

out("RESULT", failures === 0 ? "ALL CHECKS PASSED (local sandbox, not wallet integration)" : `${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
