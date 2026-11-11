// LOCAL SANDBOX ONLY — NOT WALLET INTEGRATION.
//
// Drives the main b28d33b (lf-008) escrow WASM on a local near-sandbox node
// with the frontend's OWN transaction builders (src/lib/near/tx.ts) and
// decodes every view with the frontend's own arbitration / state / claim /
// error modules. Three lines, each disputed by the buyer, with the shortest
// allowed windows (N = A = B = 60 s):
//   line 0 -> primary arbitrator ruling in PRIMARY
//   line 1 -> backup arbitrator ruling in BACKUP
//   line 2 -> permissionless fallback in FALLBACK (P = 1 001, supplier 3 333 bps -> 668 / 333)
// Wrong-window, wrong-caller and post-final rejections are mapped through
// errors.ts. Signing uses @near-js KeyPairSigner with ephemeral in-memory keys
// (sub-accounts) and the sandbox home's local validator key; nothing is
// written to disk and no key is printed. This is not the browser wallet path
// (wallet.ts) and proves nothing about it.
//
// Usage (Node >= 24, type stripping):
//   node scripts/sandbox-lf008-demo.ts <sandbox-home> <rpc-url> <escrow.wasm> <test-ft.wasm>
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
  acceptTermsCall,
  createAgreementCall,
  fundLineCall,
  openDisputeCall,
  proposeSplitCall,
  submitDeliveryCall,
  submitRulingCall,
  triggerFallbackCall,
  type FunctionCallSpec,
} from "../src/lib/near/tx.ts";
import { describeError, extractErrorCode } from "../src/lib/contract/errors.ts";
import { u128 } from "../src/lib/contract/states.ts";
import { allocationState, moneyRows } from "../src/lib/contract/settlement.ts";
import {
  disputeTimeline,
  fallbackAvailability,
  fallbackPreview,
  recheckBeforeDecision,
  rulingAvailability,
} from "../src/lib/contract/arbitration.ts";
import { claimState } from "../src/lib/contract/withdrawals.ts";
import { LINE_VIEW_FIELDS, type AgreementView, type LineView } from "../src/lib/contract/types.ts";
import { parseTermsJson, termsHashHex } from "../src/lib/terms.ts";
import { formatNsLocal, formatNsUtc } from "../src/lib/format.ts";

const [home, rpcUrl, escrowWasm, ftWasm] = process.argv.slice(2);
if (home === undefined || rpcUrl === undefined || escrowWasm === undefined || ftWasm === undefined) {
  throw new Error("usage: sandbox-lf008-demo.ts <sandbox-home> <rpc-url> <escrow.wasm> <test-ft.wasm>");
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

const vk = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8")) as { account_id: string; secret_key: KeyPairString };
const root = new Account(vk.account_id, provider, KeyPairSigner.fromSecretKey(vk.secret_key));
const NEAR = 10n ** 24n;

async function make(name: string, near: bigint): Promise<Account> {
  const kp = KeyPair.fromRandom("ed25519");
  const id = `${name}.${vk.account_id}`;
  await root.createAccount(id, kp.getPublicKey(), near * NEAR);
  return new Account(id, provider, new KeyPairSigner(kp));
}

interface Sent { ok: boolean; value?: unknown; error?: string; code?: string | null; tx: string; logs: string[] }

/** Send one builder-produced FunctionCallSpec exactly as built (receiver, method, args, gas, deposit). */
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
    return { ok: false, error, code: extractErrorCode(error), tx: o.transaction.hash, logs };
  }
  const raw = Buffer.from(st.SuccessValue ?? "", "base64").toString("utf8");
  return { ok: true, value: raw === "" ? null : JSON.parse(raw), tx: o.transaction.hash, logs };
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
const E = escrow.accountId;
const TREASURY = `treasury.${vk.account_id}`;

await escrow.deployContract(new Uint8Array(readFileSync(escrowWasm)));
await escrow.callFunction({ contractId: E, methodName: "new", args: { network_id: "sandbox", allowlisted_ft_id: ft.accountId, operator_treasury_id: TREASURY, max_agreements: 25 } });
await ft.deployContract(new Uint8Array(readFileSync(ftWasm)));
await ft.callFunction({ contractId: ft.accountId, methodName: "new_default_meta", args: { owner_id: ft.accountId, total_supply: "1000000000000" } });
const bounds = await view<{ min: string }>(ft.accountId, "storage_balance_bounds");
for (const who of [E, buyer.accountId, supplier.accountId]) {
  await ft.callFunction({ contractId: ft.accountId, methodName: "storage_deposit", args: { account_id: who, registration_only: true }, deposit: BigInt(bounds.min) });
}
await ft.callFunction({ contractId: ft.accountId, methodName: "ft_transfer", args: { receiver_id: buyer.accountId, amount: "1000000000" }, deposit: 1n });
const version = await view<string>(E, "contract_version");
out("contract_version", version);
check("contract is lf-008", version === "linefair-escrow 0.1.0 (lf-008)", version);

// --- terms: three lines, shortest allowed dispute windows (60 s each) ---
const HOUR = 3_600_000_000_000n;
const MIN = 60_000_000_000n;
const PRINCIPALS = [500_000_000n, 300_000_000n, 1_001n];
const acc = (await nowNs()) + 600_000_000_000n; // +10 min
const terms = {
  schema_version: 1,
  deadline_rules_version: 1,
  buyer_id: buyer.accountId,
  supplier_id: supplier.accountId,
  primary_arbitrator_id: primary.accountId,
  backup_arbitrator_id: backup.accountId,
  ft_contract_id: ft.accountId,
  agreement_nonce: "8",
  acceptance_deadline_ns: acc.toString(),
  funding_deadline_ns: (acc + HOUR).toString(),
  delivery_grace_period_ns: "0",
  review_window_ns: (72n * HOUR).toString(),
  negotiation_window_ns: MIN.toString(),
  primary_window_ns: MIN.toString(),
  backup_window_ns: MIN.toString(),
  lines: PRINCIPALS.map((p, i) => ({
    line_id: i,
    principal: p.toString(),
    delivery_deadline_ns: (acc + 48n * HOUR).toString(),
    acceptance_criteria_commitment: `0${i + 1}`.repeat(32),
    fallback_buyer_bps: i === 2 ? 6667 : 5000,
    fallback_supplier_bps: i === 2 ? 3333 : 5000,
  })),
};
const parsed = parseTermsJson(JSON.stringify(terms));
if (!parsed.ok) throw new Error("local parse failed");
const localHash = await termsHashHex("sandbox", E, parsed.terms);
check("TS terms hash == compute_terms_hash", localHash === (await view<string>(E, "compute_terms_hash", { terms })), localHash);

const created = await send(buyer, createAgreementCall(E, terms as never));
check("create_agreement (buyer)", created.ok && created.value === "0", created.tx);
const id = String(created.value);
const read = async () => (await view<AgreementView | null>(E, "get_agreement", { agreement_id: id })) as AgreementView;
let a = await read();
check("accelerated_test_timing reported", a.accelerated_test_timing === true);
check("LineView keys == LINE_VIEW_FIELDS (live view, 32 incl. LF-008)", JSON.stringify(Object.keys(a.lines[0]).sort()) === JSON.stringify([...LINE_VIEW_FIELDS].sort()), Object.keys(a.lines[0]).length);
for (const [who, spec] of [
  [buyer, acceptTermsCall(E, id, a.terms_hash)],
  [supplier, acceptTermsCall(E, id, a.terms_hash)],
  [primary, acceptAppointmentCall(E, id, a.terms_hash)],
  [backup, acceptAppointmentCall(E, id, a.terms_hash)],
] as const) {
  check(`${spec.methodName} (${who.accountId})`, (await send(who, spec)).ok);
}
for (let i = 0; i < 3; i++) {
  const f = await send(buyer, fundLineCall(ft.accountId, E, id, i, PRINCIPALS[i], a.terms_hash));
  check(`fund line ${i}`, f.ok && f.value === PRINCIPALS[i].toString(), f.value);
}
for (let i = 0; i < 3; i++) check(`submit_delivery line ${i}`, (await send(supplier, submitDeliveryCall(E, id, i, randomBytes(32).toString("hex")))).ok);
for (let i = 0; i < 3; i++) check(`open_dispute line ${i}`, (await send(buyer, openDisputeCall(E, id, i))).ok);
a = await read();
const E0 = await view<string>(E, "outstanding_liabilities");
check("E == sum of principals after disputes", E0 === (PRINCIPALS[0] + PRINCIPALS[1] + PRINCIPALS[2]).toString(), E0);

// --- live timeline decoded by the frontend ---
for (const l of a.lines) {
  const t = disputeTimeline(l, a.terms);
  check(`line ${l.line_id} timeline consistent, phase NEGOTIATION`, t.ok && t.current === "NEGOTIATION", t.ok ? t.steps.map((s) => `${s.key}@${formatNsUtc(s.startNs)} / ${formatNsLocal(s.startNs, "UTC")}`) : t.label.detail);
}

async function expectCode(name: string, who: Account, spec: FunctionCallSpec, code: string) {
  const r = await send(who, spec);
  const d = r.error !== undefined ? describeError(r.error) : null;
  check(`${name} -> ${code}`, !r.ok && r.code === code && d !== null && !d.unknown, { code: r.code, copy: d?.title, tx: r.tx });
}

/** Wait until the contract view reports `phase` on line `i` (polling, chain time). */
async function waitPhase(i: number, phase: string): Promise<LineView> {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const l = (await read()).lines[i];
    if (l.dispute_phase === phase) return l;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${phase} on line ${i} (at ${l.dispute_phase})`);
    await sleep(2_000);
  }
}

// NEGOTIATION: nobody can rule, fallback not eligible; UI offers no form.
const l0n = a.lines[0];
check("UI: no ruling form in NEGOTIATION (primary)", !rulingAvailability(l0n, "primary_arbitrator").canRule);
await expectCode("primary rules in NEGOTIATION", primary, submitRulingCall(E, id, 0, 1n, PRINCIPALS[0] - 1n, PRINCIPALS[0]), "ERR_LINE:NotRulingWindow");
await expectCode("fallback in NEGOTIATION", stranger, triggerFallbackCall(E, id, 2), "ERR_LINE:FallbackNotEligible");

// PRIMARY on line 0.
let l0 = await waitPhase(0, "PRIMARY");
check("UI: ruling form for primary only in PRIMARY", rulingAvailability(l0, "primary_arbitrator").canRule && !rulingAvailability(l0, "backup_arbitrator").canRule && rulingAvailability(l0, "buyer").reason === null);
await expectCode("backup rules in PRIMARY", backup, submitRulingCall(E, id, 0, 1n, PRINCIPALS[0] - 1n, PRINCIPALS[0]), "ERR_LINE:NotRulingWindow");
await expectCode("buyer calls submit_ruling", buyer, submitRulingCall(E, id, 0, 1n, PRINCIPALS[0] - 1n, PRINCIPALS[0]), "ERR_LINE:NotAuthorized");
await expectCode("stranger calls submit_ruling", stranger, submitRulingCall(E, id, 0, 1n, PRINCIPALS[0] - 1n, PRINCIPALS[0]), "ERR_LINE:NotAuthorized");
const rawRuling = (b: string, s: string): FunctionCallSpec => ({ receiverId: E, methodName: "submit_ruling", args: { agreement_id: id, line_id: 0, buyer_amount: b, supplier_amount: s }, gas: 30_000_000_000_000n, deposit: 0n });
await expectCode("primary raw sum mismatch", primary, rawRuling("1", "1"), "ERR_LINE:AllocationSumMismatch");
await expectCode("primary raw '01'", primary, rawRuling("01", (PRINCIPALS[0] - 1n).toString()), "ERR_AMOUNT_FORMAT:NonCanonicalDecimal");
l0 = (await read()).lines[0];
check("recheckBeforeDecision ok (primary)", recheckBeforeDecision(l0, "primary").ok);
const r0 = await send(primary, submitRulingCall(E, id, 0, 125_000_000n, 375_000_000n, PRINCIPALS[0]));
check("submit_ruling (primary) in PRIMARY", r0.ok, r0.tx);
l0 = (await read()).lines[0];
check("line 0 ALLOCATED PRIMARY_RULING 125/375", l0.status === "ALLOCATED" && l0.allocation_mode === "PRIMARY_RULING" && l0.buyer_claimable === "125000000" && l0.supplier_claimable === "375000000", allocationState(l0, PRINCIPALS[0]).label);
check("line 0 phase NONE after allocation, starts null", l0.dispute_phase === "NONE" && l0.primary_start_ns === null);
check("recheckBeforeDecision refuses decided line", !recheckBeforeDecision(l0, "primary").ok);
await expectCode("primary rules again", primary, submitRulingCall(E, id, 0, 1n, PRINCIPALS[0] - 1n, PRINCIPALS[0]), "ERR_LINE:AlreadyFinalized");

// BACKUP on line 1.
let l1 = await waitPhase(1, "BACKUP");
check("UI: ruling form for backup only in BACKUP", rulingAvailability(l1, "backup_arbitrator").canRule && !rulingAvailability(l1, "primary_arbitrator").canRule);
await expectCode("primary rules in BACKUP", primary, submitRulingCall(E, id, 1, 1n, PRINCIPALS[1] - 1n, PRINCIPALS[1]), "ERR_LINE:NotRulingWindow");
check("recheckBeforeDecision ok (backup)", recheckBeforeDecision(l1, "backup").ok);
const r1 = await send(backup, submitRulingCall(E, id, 1, PRINCIPALS[1], 0n, PRINCIPALS[1]));
check("submit_ruling (backup) in BACKUP, all to buyer", r1.ok, r1.tx);
l1 = (await read()).lines[1];
check("line 1 ALLOCATED BACKUP_RULING", l1.status === "ALLOCATED" && l1.allocation_mode === "BACKUP_RULING" && l1.buyer_claimable === PRINCIPALS[1].toString(), allocationState(l1, PRINCIPALS[1]).label);
check("claimState: buyer claimable, supplier nothing (zero leg)", claimState(l1, "buyer").key === "claimable" && claimState(l1, "supplier").key === "none");

// FALLBACK on line 2.
let l2 = await waitPhase(2, "FALLBACK");
await expectCode("backup rules in FALLBACK", backup, submitRulingCall(E, id, 2, 1n, PRINCIPALS[2] - 1n, PRINCIPALS[2]), "ERR_LINE:NotRulingWindow");
const t2 = a.terms.lines[2];
const pv = fallbackPreview(PRINCIPALS[2], t2.fallback_supplier_bps, t2.fallback_buyer_bps);
check("UI fallback preview 1001 x 3333 bps -> buyer 668 / supplier 333", pv.buyer === 668n && pv.supplier === 333n, pv);
check("UI: fallback offered to any connected account", fallbackAvailability(l2, true).canTrigger);
check("recheckBeforeDecision ok (fallback)", recheckBeforeDecision(l2, "fallback").ok);
const f2 = await send(stranger, triggerFallbackCall(E, id, 2));
check("trigger_fallback (stranger) in FALLBACK", f2.ok, f2.tx);
l2 = (await read()).lines[2];
check("line 2 ALLOCATED FALLBACK equals the UI preview", l2.status === "ALLOCATED" && l2.allocation_mode === "FALLBACK" && u128(l2.buyer_claimable) === pv.buyer && u128(l2.supplier_claimable) === pv.supplier, { buyer: l2.buyer_claimable, supplier: l2.supplier_claimable });
await expectCode("fallback again", stranger, triggerFallbackCall(E, id, 2), "ERR_LINE:AlreadyFinalized");
await expectCode("mutual proposal after fallback", supplier, proposeSplitCall(E, id, 2, 1n, PRINCIPALS[2] - 1n, PRINCIPALS[2]), "ERR_LINE:AlreadyFinalized");

// Money: allocation moved nothing; nothing is labelled paid.
a = await read();
const E1 = await view<string>(E, "outstanding_liabilities");
const O = await view<string>(ft.accountId, "ft_balance_of", { account_id: E });
check("E unchanged by rulings and fallback", E1 === E0, { E0, E1 });
check("escrow token balance O == E (no token moved)", O === E1, { O });
const states = a.lines.flatMap((l) => (["buyer", "supplier"] as const).map((w) => `${l.line_id}:${w}:${claimState(l, w).key}`));
check("claim states: claimable/none only, never paid/pending", states.every((s) => /:(claimable|none)$/.test(s)), states);
check("money rows: no paid row", a.lines.every((l) => moneyRows(l).every((r) => r.key !== "paid")));

out("RESULT", failures === 0 ? "ALL CHECKS PASSED (local sandbox, not wallet integration)" : `${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
