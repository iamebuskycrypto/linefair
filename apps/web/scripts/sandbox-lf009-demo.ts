// LOCAL SANDBOX ONLY — NOT WALLET INTEGRATION.
//
// Drives the main b66913f (lf-009) escrow WASM on a local near-sandbox node
// with the frontend's OWN withdraw builder (src/lib/near/tx.ts), its OWN
// read path (NearRpc + readLineSnapshot: views at one exact block) and its
// OWN claim model (withdrawals.ts claimPanel / parseWithdrawResult /
// errors.ts). Scenarios:
//   A (release WASM): supplier not registered on the token -> UI blocks;
//     withdraw sent anyway -> FAILED, amount restored -> storage_deposit ->
//     retry -> PAID only after a confirming re-read; buyer + supplier PAID on
//     a mutually split line; every ERR_WITHDRAW / ERR_LINE rejection mapped.
//   B (test-starve-callback WASM, optional 6th arg): the callback cannot
//     finish -> slot stays PENDING after the tx ended -> inconclusive; the
//     recipient's token balance rose, and the UI still never says Paid.
// Signing uses @near-js KeyPairSigner with ephemeral in-memory keys and the
// sandbox home's local validator key; nothing is written to disk and no key
// is printed. This is not the browser wallet path (wallet.ts).
//
// Usage (Node >= 24, type stripping):
//   node scripts/sandbox-lf009-demo.ts <sandbox-home> <rpc-url> <escrow.wasm> <test-ft.wasm> [<escrow-starve.wasm>]
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
  createAgreementCall,
  fundLineCall,
  openDisputeCall,
  proposeSplitCall,
  submitDeliveryCall,
  withdrawCall,
  type FunctionCallSpec,
} from "../src/lib/near/tx.ts";
import { NearRpc } from "../src/lib/near/rpc.ts";
import { claimSnapshot, readLineSnapshot, type LineSnapshot } from "../src/lib/near/snapshot.ts";
import { describeError, extractErrorCode } from "../src/lib/contract/errors.ts";
import { claimPanel, parseWithdrawResult, type Registration, type TxRecord, type Who } from "../src/lib/contract/withdrawals.ts";
import { CUSTODY_SUMMARY_VIEW_FIELDS, WITHDRAWAL_RESULT_VIEW_FIELDS, WITHDRAWAL_VIEW_FIELDS, type AgreementView } from "../src/lib/contract/types.ts";
import { parseTermsJson, termsHashHex } from "../src/lib/terms.ts";

const [home, rpcUrl, escrowWasm, ftWasm, starveWasm] = process.argv.slice(2);
if (home === undefined || rpcUrl === undefined || escrowWasm === undefined || ftWasm === undefined) {
  throw new Error("usage: sandbox-lf009-demo.ts <sandbox-home> <rpc-url> <escrow.wasm> <test-ft.wasm> [<escrow-starve.wasm>]");
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

const provider = new JsonRpcProvider({ url: rpcUrl });
const status = (await provider.status()) as { chain_id: string };
out("chain_id", status.chain_id);
if (status.chain_id !== "localnet") throw new Error("refusing: chain_id is not localnet");
out("escrow wasm sha256", sha(escrowWasm));
out("test-ft wasm sha256", sha(ftWasm));
if (starveWasm !== undefined) out("escrow STARVE (test-only) wasm sha256", sha(starveWasm));

/** The frontend's own read-only RPC client (fetch), pointed at the loopback sandbox. */
const rpc = new NearRpc(rpcUrl);

const vk = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8")) as { account_id: string; secret_key: KeyPairString };
const root = new Account(vk.account_id, provider, KeyPairSigner.fromSecretKey(vk.secret_key));
const NEAR = 10n ** 24n;
/** Per-run suffix so the script can run again on the same node. */
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
const view = <T>(contract: string, method: string, args: Record<string, unknown> = {}) => provider.callFunction<T>(contract, method, args) as Promise<T>;
const nowNs = async () => BigInt((await provider.viewBlock({ finality: "final" })).header.timestamp_nanosec);

// --- accounts and contracts (ephemeral, local) ---
const escrow = await make("escrow", 20n);
const ft = await make("ft", 20n);
const buyer = await make("buyer", 10n);
const supplier = await make("supplier", 10n);
const primary = await make("primary", 5n);
const backup = await make("backup", 5n);
const stranger = await make("stranger", 5n);
await make("treasury", 1n);
const TREASURY = `treasury-${RUN}.${vk.account_id}`;
const FT = ft.accountId;
const B = buyer.accountId;
const S = supplier.accountId;

async function deployEscrow(acc: Account, wasm: string): Promise<string> {
  await acc.deployContract(new Uint8Array(readFileSync(wasm)));
  await acc.callFunction({ contractId: acc.accountId, methodName: "new", args: { network_id: "sandbox", allowlisted_ft_id: FT, operator_treasury_id: TREASURY, max_agreements: 25 } });
  return acc.accountId;
}
const E = await deployEscrow(escrow, escrowWasm);
await ft.deployContract(new Uint8Array(readFileSync(ftWasm)));
await ft.callFunction({ contractId: FT, methodName: "new_default_meta", args: { owner_id: FT, total_supply: "1000000000000" } });
const bounds = await view<{ min: string }>(FT, "storage_balance_bounds");
const register = (who: string) => ft.callFunction({ contractId: FT, methodName: "storage_deposit", args: { account_id: who, registration_only: true }, deposit: BigInt(bounds.min) });
// The supplier is deliberately NOT registered on the token yet.
for (const who of [E, B]) await register(who);
await ft.callFunction({ contractId: FT, methodName: "ft_transfer", args: { receiver_id: B, amount: "1000000000" }, deposit: 1n });
const version = await view<string>(E, "contract_version");
check("contract is lf-009 (release)", version === "linefair-escrow 0.1.0 (lf-009)", version);

const HOUR = 3_600_000_000_000n;
const MIN = 60_000_000_000n;
async function agreement(escrowId: string, principals: bigint[], nonce: string): Promise<AgreementView> {
  const acc = (await nowNs()) + 600_000_000_000n;
  const terms = {
    schema_version: 1, deadline_rules_version: 1, buyer_id: B, supplier_id: S, primary_arbitrator_id: primary.accountId, backup_arbitrator_id: backup.accountId,
    ft_contract_id: FT, agreement_nonce: nonce, acceptance_deadline_ns: acc.toString(), funding_deadline_ns: (acc + HOUR).toString(), delivery_grace_period_ns: "0",
    review_window_ns: (72n * HOUR).toString(), negotiation_window_ns: MIN.toString(), primary_window_ns: MIN.toString(), backup_window_ns: MIN.toString(),
    lines: principals.map((p, i) => ({ line_id: i, principal: p.toString(), delivery_deadline_ns: (acc + 48n * HOUR).toString(), acceptance_criteria_commitment: `0${i + 1}`.repeat(32), fallback_buyer_bps: 5000, fallback_supplier_bps: 5000 })),
  };
  const parsed = parseTermsJson(JSON.stringify(terms));
  if (!parsed.ok) throw new Error("local parse failed");
  const local = await termsHashHex("sandbox", escrowId, parsed.terms);
  check(`[${escrowId}] TS terms hash == compute_terms_hash`, local === (await view<string>(escrowId, "compute_terms_hash", { terms })));
  const c = await send(buyer, createAgreementCall(escrowId, terms as never));
  const id = String(c.value);
  const a = (await view<AgreementView>(escrowId, "get_agreement", { agreement_id: id })) as AgreementView;
  for (const [who, spec] of [[buyer, acceptTermsCall(escrowId, id, a.terms_hash)], [supplier, acceptTermsCall(escrowId, id, a.terms_hash)], [primary, acceptAppointmentCall(escrowId, id, a.terms_hash)], [backup, acceptAppointmentCall(escrowId, id, a.terms_hash)]] as const) {
    if (!(await send(who, spec)).ok) throw new Error(`${spec.methodName} failed`);
  }
  for (let i = 0; i < principals.length; i++) {
    const f = await send(buyer, fundLineCall(FT, escrowId, id, i, principals[i], a.terms_hash));
    if (!(f.ok && f.value === principals[i].toString())) throw new Error(`fund line ${i} failed`);
    if (!(await send(supplier, submitDeliveryCall(escrowId, id, i, randomBytes(32).toString("hex")))).ok) throw new Error("submit_delivery failed");
  }
  return (await view<AgreementView>(escrowId, "get_agreement", { agreement_id: id })) as AgreementView;
}

// ---- UI model over live reads ----
async function registration(account: string): Promise<Registration> {
  try {
    return (await rpc.storageBalanceOf(FT, account)).value === null ? "not_registered" : "registered";
  } catch {
    return "unknown";
  }
}
function panel(s: LineSnapshot, who: Who, o: { confirm?: LineSnapshot; connected?: string | null; registration: Registration; tx?: TxRecord | null }) {
  return claimPanel({
    who,
    recipient: who === "buyer" ? B : S,
    ftId: FT,
    snap: claimSnapshot(s, who),
    confirm: o.confirm === undefined ? undefined : claimSnapshot(o.confirm, who),
    connected: o.connected === undefined ? (who === "buyer" ? B : S) : o.connected,
    registration: o.registration,
    tx: o.tx ?? null,
  });
}
const snapshot = (escrowId: string, id: string, line: number) => readLineSnapshot(rpc, escrowId, id, line);
const ftBalance = async (who: string) => BigInt(await view<string>(FT, "ft_balance_of", { account_id: who }));

/** The UI's withdraw flow, minus the browser: builder -> send -> parse result -> bounded re-reads -> confirming re-read. */
async function uiWithdraw(signer: Account, escrowId: string, id: string, line: number, who: Who) {
  const pre = await snapshot(escrowId, id, line);
  const beforeId = (who === "buyer" ? pre.buyer : pre.supplier)?.withdrawal_id ?? "0";
  const r = await send(signer, withdrawCall(escrowId, id, line, who === "buyer" ? "BUYER" : "SUPPLIER"));
  const reported = r.successValue === null ? null : parseWithdrawResult(r.successValue);
  // Same bounded re-read rule as WithdrawalPanel: until a NEW id that is not PENDING.
  let s = await snapshot(escrowId, id, line);
  for (let n = 1; n < 5; n++) {
    const rec = who === "buyer" ? s.buyer : s.supplier;
    if (rec !== null && rec.withdrawal_id !== beforeId && rec.state !== "PENDING") break;
    await sleep(1500);
    s = await snapshot(escrowId, id, line);
  }
  const tx: TxRecord = { phase: "ended", txHash: r.tx, reported, error: r.error ?? null, rereadDone: true };
  const reg = await registration(who === "buyer" ? B : S);
  const first = panel(s, who, { registration: reg, tx });
  let confirm: LineSnapshot | undefined;
  if ((who === "buyer" ? s.line.buyer_withdrawal : s.line.supplier_withdrawal) === "PAID") {
    await sleep(1200);
    confirm = await snapshot(escrowId, id, line);
  }
  const final = panel(s, who, { registration: reg, tx, ...(confirm !== undefined ? { confirm } : {}) });
  return { r, reported, s, confirm, first, final, tx };
}
async function expectCode(name: string, who: Account, spec: FunctionCallSpec, code: string) {
  const r = await send(who, spec);
  const d = r.error !== undefined ? describeError(r.error) : null;
  check(`${name} -> ${code}`, !r.ok && r.code === code && d !== null && !d.unknown, { code: r.code, copy: d?.title, tx: r.tx });
}

// ================= A: release WASM =================
const P0 = 400n;
const P1 = 1001n;
let a = await agreement(E, [P0, P1], "9");
const id = a.agreement_id;
check("accept_line line 0 (buyer)", (await send(buyer, acceptLineCall(E, id, 0))).ok);
check("open_dispute line 1", (await send(buyer, openDisputeCall(E, id, 1))).ok);
const prop = await send(supplier, proposeSplitCall(E, id, 1, 300n, 701n, P1));
check("propose_split 300/701 (supplier)", prop.ok, prop.value);
check("accept_split (buyer)", (await send(buyer, acceptSplitCall(E, id, 1, String(prop.value), "300", "701"))).ok);

let s0 = await snapshot(E, id, 0);
check("snapshot: all four views read at one block", s0.blockHeight > 0n, s0.blockHeight);
check("live WithdrawalView keys == WITHDRAWAL_VIEW_FIELDS", JSON.stringify(Object.keys(s0.supplier ?? {}).sort()) === JSON.stringify([...WITHDRAWAL_VIEW_FIELDS].sort()), s0.supplier);
check("live CustodySummaryView keys == CUSTODY_SUMMARY_VIEW_FIELDS", JSON.stringify(Object.keys(s0.custody).sort()) === JSON.stringify([...CUSTODY_SUMMARY_VIEW_FIELDS].sort()), s0.custody);
const E0 = s0.custody.outstanding_liabilities;
check("custody: E == P0 + P1, nothing open", E0 === (P0 + P1).toString() && s0.custody.open_withdrawals === "0" && s0.custody.last_withdrawal_id === "0", s0.custody);
const bsb = await rpc.storageBalanceOf(FT, B);
check("storage_balance_of(buyer) = {total, available}", bsb.value !== null && JSON.stringify(Object.keys(bsb.value).sort()) === '["available","total"]', bsb.value);
check("storage_balance_of(supplier) = null (not registered)", (await rpc.storageBalanceOf(FT, S)).value === null);

let p = panel(s0, "supplier", { registration: await registration(S) });
check("UI line 0 supplier: claimable 400, withdraw disabled (not registered), storage_deposit shown", p.key === "claimable" && p.share === P0 && !p.action.enabled && p.notices.some((n) => /storage_deposit/.test(n.text)), { key: p.key, reason: p.action.reason });
check("UI line 0 buyer: nothing allocated", panel(s0, "buyer", { registration: "registered" }).key === "none");
check("UI line 0 supplier, buyer connected: no enabled action", !panel(s0, "supplier", { registration: "registered", connected: B }).action.enabled);

// sent anyway (the UI would not): definite failure, amount restored
let w = await uiWithdraw(supplier, E, id, 0, "supplier");
check("withdraw to unregistered supplier: tx result parsed {id 1, FAILED}", w.reported?.withdrawal_id === "1" && w.reported.outcome === "FAILED", w.reported);
check("live WithdrawalResultView keys", JSON.stringify(Object.keys((w.r.value as object) ?? {}).sort()) === JSON.stringify([...WITHDRAWAL_RESULT_VIEW_FIELDS].sort()));
check("logs include LF_WITHDRAWAL_FAILED:1", w.r.logs.includes("LF_WITHDRAWAL_FAILED:1"), w.r.logs);
check("UI: exactly \"The transfer failed. Your funds are available to withdraw again.\", report agrees, retry blocked until registered", w.final.key === "failed_restored" && w.final.label === "The transfer failed. Your funds are available to withdraw again." && w.final.reported?.agrees === true && w.final.action.kind === "retry" && !w.final.action.enabled, { label: w.final.label, reported: w.final.reported?.text });
check("FAILED: claimable restored, E unchanged, supplier token balance 0", w.s.line.supplier_claimable === P0.toString() && w.s.custody.outstanding_liabilities === E0 && (await ftBalance(S)) === 0n);

await register(S);
// Views read at final finality lag the just-executed call by a block or two
// (FAILED-3 run): read again, bounded, as the UI does before signing.
let regS = await registration(S);
check("right after storage_deposit the final view may still lag (observed, not asserted)", true, regS);
for (let n = 0; n < 10 && regS !== "registered"; n++) {
  await sleep(1000);
  regS = await registration(S);
}
check("after storage_deposit: storage_balance_of(supplier) registered (bounded re-read)", regS === "registered", regS);
s0 = await snapshot(E, id, 0);
p = panel(s0, "supplier", { registration: regS });
check("UI: retry enabled for the supplier only", p.action.kind === "retry" && p.action.enabled && !panel(s0, "supplier", { registration: "registered", connected: stranger.accountId }).action.enabled);

w = await uiWithdraw(supplier, E, id, 0, "supplier");
check("retry: tx result {id 2, PAID}", w.reported?.withdrawal_id === "2" && w.reported.outcome === "PAID", w.reported);
check("UI after one read: exactly Confirming the contract record…", w.first.key === "confirming" && w.first.label === "Confirming the contract record…", w.first.label);
check("UI after the confirming later read: exactly \"Payment completed successfully.\", 400 to supplier, report agrees", w.final.key === "paid" && w.final.label === "Payment completed successfully." && w.final.amount === P0 && w.final.recipient === S && w.final.reported?.agrees === true && (w.confirm?.blockHeight ?? 0n) >= w.s.blockHeight, { block: w.s.blockHeight, confirm: w.confirm?.blockHeight });
check("record: PAID id 2 epoch 2", w.s.supplier?.state === "PAID" && w.s.supplier.withdrawal_id === "2" && w.s.supplier.epoch === 2, w.s.supplier);
check("supplier token balance +400 (observation only)", (await ftBalance(S)) === P0);

await expectCode("withdraw again", supplier, withdrawCall(E, id, 0, "SUPPLIER"), "ERR_LINE:NothingToWithdraw");
await expectCode("stranger withdraws BUYER", stranger, withdrawCall(E, id, 1, "BUYER"), "ERR_LINE:NotAuthorized");
await expectCode("buyer withdraws SUPPLIER", buyer, withdrawCall(E, id, 1, "SUPPLIER"), "ERR_LINE:NotAuthorized");
await expectCode("arbitrator withdraws", primary, withdrawCall(E, id, 1, "BUYER"), "ERR_LINE:NotAuthorized");
const raw = (over: Partial<FunctionCallSpec> & { beneficiary?: string }): FunctionCallSpec => ({ ...withdrawCall(E, id, 1, "BUYER"), ...over, args: { agreement_id: id, line_id: 1, beneficiary: over.beneficiary ?? "BUYER" } });
await expectCode("raw deposit 0", buyer, raw({ deposit: 0n }), "ERR_WITHDRAW:DepositMustBeOneYocto");
await expectCode("raw deposit 2 yocto", buyer, raw({ deposit: 2n }), "ERR_WITHDRAW:DepositMustBeOneYocto");
await expectCode("raw 54 Tgas", buyer, raw({ gas: 54_000_000_000_000n }), "ERR_WITHDRAW:InsufficientGas");
await expectCode("raw beneficiary 'buyer'", buyer, raw({ beneficiary: "buyer" }), "ERR_WITHDRAW:BadBeneficiary");
await expectCode("withdraw on unknown agreement", buyer, withdrawCall(E, "99", 0, "BUYER"), "ERR_AGREEMENT_NOT_FOUND");
let s1 = await snapshot(E, id, 1);
check("rejections changed nothing on line 1", s1.line.buyer_claimable === "300" && s1.line.supplier_claimable === "701" && s1.custody.last_withdrawal_id === "2", s1.custody);

for (const [acc, who, amt] of [[buyer, "buyer", 300n], [supplier, "supplier", 701n]] as const) {
  w = await uiWithdraw(acc, E, id, 1, who);
  check(`line 1 ${who}: Paid ${amt} after confirmation`, w.final.key === "paid" && w.final.amount === amt && w.reported?.outcome === "PAID", { reported: w.reported, key: w.final.key });
}
s1 = await snapshot(E, id, 1);
check("custody: E 0, no open withdrawals, last id 4", s1.custody.outstanding_liabilities === "0" && s1.custody.open_withdrawals === "0" && s1.custody.last_withdrawal_id === "4", s1.custody);
check("escrow token balance 0 == E", (await ftBalance(E)) === 0n);
check("balances: buyer 1e9 - 1401 + 300, supplier 1101", (await ftBalance(B)) === 1_000_000_000n - P0 - P1 + 300n && (await ftBalance(S)) === P0 + 701n);

// ================= B: starve WASM (test only) =================
if (starveWasm !== undefined) {
  const starveAcc = await make("starve", 20n);
  const E2 = await deployEscrow(starveAcc, starveWasm);
  await register(E2);
  const v2 = await view<string>(E2, "contract_version");
  check("starve contract reports +test-starve-callback", v2 === "linefair-escrow 0.1.0 (lf-009) +test-starve-callback", v2);
  a = await agreement(E2, [500n], "10");
  const id2 = a.agreement_id;
  check("[starve] accept_line", (await send(buyer, acceptLineCall(E2, id2, 0))).ok);
  const before = await ftBalance(S);
  const st = await uiWithdraw(supplier, E2, id2, 0, "supplier");
  out("starve withdraw tx", { ok: st.r.ok, code: st.r.code ?? null, tx: st.r.tx, logs: st.r.logs });
  check("[starve] tx reports no PAID/FAILED outcome", st.reported === null || st.reported.outcome === "PENDING", st.reported);
  check("[starve] record stays PENDING after the tx ended", st.s.supplier?.state === "PENDING" && st.s.line.supplier_pending === "500", st.s.supplier);
  check("[starve] UI: inconclusive, exactly \"Payment outcome unconfirmed. Do not retry this withdrawal.\", limitation notice, no action", st.final.key === "inconclusive" && st.final.label === "Payment outcome unconfirmed. Do not retry this withdrawal." && st.final.action.kind === "none" && st.final.notices.some((n) => /Limitation of this version/.test(n.text)), st.final.label);
  const after = await ftBalance(S);
  check("[starve] token moved (balance +500) yet the UI never says Payment completed successfully.", after - before === 500n && st.final.key !== "paid" && st.final.label !== "Payment completed successfully." && !/\bPaid\b|Ready to withdraw/.test(st.final.label), { before, after });
  check("[starve] custody still counts it: E 500, 1 open withdrawal", st.s.custody.outstanding_liabilities === "500" && st.s.custody.open_withdrawals === "1", st.s.custody);
  await expectCode("[starve] withdraw again", supplier, withdrawCall(E2, id2, 0, "SUPPLIER"), "ERR_LINE:WithdrawalAlreadyPending");
  const later = await snapshot(E2, id2, 0);
  check("[starve] later read: still PENDING (no retry, no timer)", later.supplier?.state === "PENDING" && panel(later, "supplier", { registration: "registered", tx: st.tx }).key === "inconclusive");
  check("[starve] without session context: plain Processing, no action", panel(later, "supplier", { registration: "registered" }).key === "pending");
}

out("RESULT", failures === 0 ? "ALL CHECKS PASSED (local sandbox, not wallet integration)" : `${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
