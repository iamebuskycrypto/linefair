// LOCAL SANDBOX ONLY — NOT WALLET INTEGRATION.
//
// Drives the main cd6afa7 escrow WASM on a local near-sandbox node with the
// frontend's OWN transaction builders (src/lib/near/tx.ts) and decodes the
// resulting views with the frontend's own state/settlement/error modules.
// Signing uses @near-js/accounts KeyPairSigner with ephemeral keys
// generated in memory (sub-accounts) and the sandbox home's local validator
// key; nothing is written to disk and no key is printed. This is not the
// browser wallet path (wallet.ts) and proves nothing about it.
//
// Usage (Node >= 24, type stripping):
//   node scripts/sandbox-lf007-demo.ts <sandbox-home> <rpc-url> <escrow.wasm> <test-ft.wasm>
// Refuses any RPC URL that is not loopback.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Account } from "@near-js/accounts";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators } from "@near-js/transactions";

import {
  acceptAppointmentCall,
  acceptSplitCall,
  acceptTermsCall,
  createAgreementCall,
  fundLineCall,
  openDisputeCall,
  proposeSplitCall,
  submitDeliveryCall,
  type FunctionCallSpec,
} from "../src/lib/near/tx.ts";
import { describeError, extractErrorCode } from "../src/lib/contract/errors.ts";
import { agreementStatusLabel, lineStateLabel, u128 } from "../src/lib/contract/states.ts";
import { allocationState, moneyRows, proposalState, recheckBeforeAccept, splitAvailability } from "../src/lib/contract/settlement.ts";
import { LINE_VIEW_FIELDS, type AgreementView, type LineView } from "../src/lib/contract/types.ts";
import { parseTermsJson, termsHashHex } from "../src/lib/terms.ts";

const [home, rpcUrl, escrowWasm, ftWasm] = process.argv.slice(2);
if (home === undefined || rpcUrl === undefined || escrowWasm === undefined || ftWasm === undefined) {
  throw new Error("usage: sandbox-lf007-demo.ts <sandbox-home> <rpc-url> <escrow.wasm> <test-ft.wasm>");
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
out("contract_version", await view<string>(E, "contract_version"));
out("get_config", await view(E, "get_config"));

// --- terms (shape of contracts/escrow/tests/common terms(), one line) ---
const HOUR = 3_600_000_000_000n;
const P = 500_000_000n;
const acc = (await nowNs()) + 600_000_000_000n; // +10 min
const terms = {
  schema_version: 1,
  deadline_rules_version: 1,
  buyer_id: buyer.accountId,
  supplier_id: supplier.accountId,
  primary_arbitrator_id: primary.accountId,
  backup_arbitrator_id: backup.accountId,
  ft_contract_id: ft.accountId,
  agreement_nonce: "1",
  acceptance_deadline_ns: acc.toString(),
  funding_deadline_ns: (acc + HOUR).toString(),
  delivery_grace_period_ns: "0",
  review_window_ns: "259200000000000",
  negotiation_window_ns: "172800000000000",
  primary_window_ns: "259200000000000",
  backup_window_ns: "259200000000000",
  lines: [
    { line_id: 0, principal: P.toString(), delivery_deadline_ns: (acc + 48n * HOUR).toString(), acceptance_criteria_commitment: "01".repeat(32), fallback_buyer_bps: 5000, fallback_supplier_bps: 5000 },
  ],
};
const parsed = parseTermsJson(JSON.stringify(terms));
if (!parsed.ok) throw new Error("local parse failed");
const localHash = await termsHashHex("sandbox", E, parsed.terms);
const remoteHash = await view<string>(E, "compute_terms_hash", { terms });
check("TS terms hash == compute_terms_hash", localHash === remoteHash, localHash);

// --- agreement lifecycle with the frontend builders ---
const created = await send(buyer, createAgreementCall(E, terms as never));
check("create_agreement (buyer)", created.ok && created.value === "0", created);
const id = String(created.value);
const read = async () => (await view<AgreementView | null>(E, "get_agreement", { agreement_id: id })) as AgreementView;
let a = await read();
check("stored terms_hash == TS hash", a.terms_hash === localHash);
check("LineView keys == LINE_VIEW_FIELDS (live view)", JSON.stringify(Object.keys(a.lines[0]).sort()) === JSON.stringify([...LINE_VIEW_FIELDS].sort()), Object.keys(a.lines[0]).length);

for (const [who, spec] of [
  [buyer, acceptTermsCall(E, id, a.terms_hash)],
  [supplier, acceptTermsCall(E, id, a.terms_hash)],
  [primary, acceptAppointmentCall(E, id, a.terms_hash)],
  [backup, acceptAppointmentCall(E, id, a.terms_hash)],
] as const) {
  const r = await send(who, spec);
  check(`${spec.methodName} (${who.accountId})`, r.ok, r.tx);
}
a = await read();
check("agreement AGREED", a.status === "AGREED", agreementStatusLabel(a.status).label);

const fund = await send(buyer, fundLineCall(ft.accountId, E, id, 0, P, a.terms_hash));
check("ft_transfer_call fund line 0 (used amount == P)", fund.ok && fund.value === P.toString(), { value: fund.value, tx: fund.tx });
a = await read();
check("line FUNDED, label 'Secured in escrow'", lineStateLabel(a.lines[0], { principal: P }).label === "Secured in escrow", a.lines[0].locked);

const commitment = randomBytes(32).toString("hex");
check("submit_delivery (supplier)", (await send(supplier, submitDeliveryCall(E, id, 0, commitment))).ok);
check("open_dispute (buyer)", (await send(buyer, openDisputeCall(E, id, 0))).ok);
a = await read();
const t0 = u128(a.lines[0].dispute_t0_ns);
check("line DISPUTED (BUYER_DISPUTE)", a.lines[0].status === "DISPUTED" && a.lines[0].dispute_reason === "BUYER_DISPUTE", { t0 });
const E0 = await view<string>(E, "outstanding_liabilities");

// --- LF-007 rejections, mapped by errors.ts ---
async function expectCode(name: string, who: Account, spec: FunctionCallSpec, code: string) {
  const r = await send(who, spec);
  const d = r.error !== undefined ? describeError(r.error) : null;
  check(`${name} -> ${code}`, !r.ok && r.code === code && d !== null && !d.unknown, { code: r.code, copy: d?.title, tx: r.tx });
}
const now1 = await nowNs();
check("UI gating: arbitrator offered nothing", !splitAvailability(a.lines[0], P, "primary_arbitrator", now1).canPropose);
await expectCode("propose_split by primary arbitrator", primary, proposeSplitCall(E, id, 0, 100n, P - 100n, P), "ERR_LINE:NotAuthorized");
// Raw specs (builders refuse these by design): contract-side format/sum rejections.
const raw = (args: Record<string, unknown>): FunctionCallSpec => ({ receiverId: E, methodName: "propose_split", args, gas: 30_000_000_000_000n, deposit: 0n });
await expectCode("propose_split raw sum mismatch", buyer, raw({ agreement_id: id, line_id: 0, buyer_amount: "1", supplier_amount: "1" }), "ERR_LINE:AllocationSumMismatch");
await expectCode("propose_split raw '+1'", buyer, raw({ agreement_id: id, line_id: 0, buyer_amount: "+1", supplier_amount: (P - 1n).toString() }), "ERR_AMOUNT_FORMAT:NonCanonicalDecimal");
await expectCode("accept_split with no proposal", supplier, acceptSplitCall(E, id, 0, "1", "1", (P - 1n).toString()), "ERR_LINE:NoActiveProposal");

// --- propose, counter-propose, accept with re-read ---
const p1 = await send(buyer, proposeSplitCall(E, id, 0, 300_000_000n, 200_000_000n, P));
check("propose_split (buyer) returns id 1", p1.ok && p1.value === "1", p1.tx);
a = await read();
const ps1 = proposalState(a.lines[0], P);
check("proposalState open #1 by buyer", ps1.key === "open" && ps1.proposal?.proposer === "buyer", ps1.label);
await expectCode("buyer accepts own proposal", buyer, acceptSplitCall(E, id, 0, "1", "300000000", "200000000"), "ERR_LINE:OwnProposal");
const reviewed = ps1.proposal!;

const p2 = await send(supplier, proposeSplitCall(E, id, 0, 100_000_000n, 400_000_000n, P));
check("counter propose_split (supplier) returns id 2", p2.ok && p2.value === "2", p2.tx);
await expectCode("accept stale proposal #1", supplier, acceptSplitCall(E, id, 0, "1", "300000000", "200000000"), "ERR_LINE:StaleProposal");
await expectCode("accept #2 with different amounts", buyer, acceptSplitCall(E, id, 0, "2", "300000000", "200000000"), "ERR_LINE:ProposalMismatch");

a = await read();
// The UI's accept path: the user reviewed #1; the fresh read shows #2, so it refuses to sign.
const stale = recheckBeforeAccept(a.lines[0], P, reviewed, "supplier");
check("recheckBeforeAccept refuses superseded #1", !stale.ok && stale.reason === "changed", stale.ok ? null : stale.message);
const ps2 = proposalState(a.lines[0], P).proposal!;
const fresh = recheckBeforeAccept((await read()).lines[0], P, ps2, "buyer");
check("recheckBeforeAccept ok for #2 (buyer)", fresh.ok);
if (fresh.ok) {
  const acc2 = await send(buyer, acceptSplitCall(E, id, 0, fresh.proposal.id, fresh.proposal.buyerAmount, fresh.proposal.supplierAmount));
  check("accept_split #2 (buyer)", acc2.ok, acc2.tx);
}

a = await read();
const l: LineView = a.lines[0];
check("line ALLOCATED MUTUAL from #2", l.status === "ALLOCATED" && l.allocation_mode === "MUTUAL" && l.allocation_source_id === "2", allocationState(l, P).label);
check("proposalState accepted", proposalState(l, P).key === "accepted");
check("allocationState consistent", allocationState(l, P).key === "mutual", allocationState(l, P).detail);
const rows = moneyRows(l).map((r) => `${r.key}:${r.party ?? ""}:${r.amount}`);
check("money rows: claimable only, nothing paid", JSON.stringify(rows) === JSON.stringify(["claimable:buyer:100000000", "claimable:supplier:400000000"]), rows);
const E1 = await view<string>(E, "outstanding_liabilities");
const O = await view<string>(ft.accountId, "ft_balance_of", { account_id: E });
check("outstanding_liabilities unchanged by allocation (== P)", E0 === P.toString() && E1 === E0, { E0, E1 });
check("escrow token balance O == E (no token moved)", O === E1, { O });
await expectCode("propose after allocation", supplier, proposeSplitCall(E, id, 0, 1n, P - 1n, P), "ERR_LINE:AlreadyFinalized");
check("UI gating: nothing offered on ALLOCATED", !splitAvailability(l, P, "buyer", await nowNs()).canPropose);

out("RESULT", failures === 0 ? "ALL CHECKS PASSED (local sandbox, not wallet integration)" : `${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
