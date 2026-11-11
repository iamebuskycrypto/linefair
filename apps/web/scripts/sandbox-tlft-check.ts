// LOCAL SANDBOX ONLY — rehearsal of the founder-approved replacement test token
// (demo-ft): the pinned test-FT WASM initialised with `new` and the exact
// metadata/supply, then the 400 / 1,000 / 1,000 tLFT three-line funding flow
// through the frontend's own builders, parser and formatter, against the
// qualified escrow release WASM. Ephemeral in-memory keys + the sandbox home's
// validator key; nothing written to disk, no key printed.
//
// Usage: node scripts/sandbox-tlft-check.ts <sandbox-home> <rpc-url> <escrow.wasm> <test-ft.wasm>

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Account } from "@near-js/accounts";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators } from "@near-js/transactions";

import { acceptAppointmentCall, acceptTermsCall, createAgreementCall, fundLineCall, type FunctionCallSpec } from "../src/lib/near/tx.ts";
import { formatUnits, parseUnits } from "../src/lib/format.ts";
import { fundingOutcome } from "../src/lib/contract/lifecycle.ts";
import type { AgreementView, LineView } from "../src/lib/contract/types.ts";
import { parseTermsJson, termsHashHex } from "../src/lib/terms.ts";

const [home, rpcUrl, escrowWasm, ftWasm] = process.argv.slice(2);
if (home === undefined || rpcUrl === undefined || escrowWasm === undefined || ftWasm === undefined) throw new Error("usage: sandbox-tlft-check.ts <home> <rpc> <escrow.wasm> <test-ft.wasm>");
const host = new URL(rpcUrl).hostname;
if (host !== "127.0.0.1" && host !== "localhost") throw new Error("local sandbox RPC only");

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const out = (k: string, v: unknown) => console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}`);
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  out(`${ok ? "PASS" : "FAIL"} ${name}`, detail ?? "");
};

const provider = new JsonRpcProvider({ url: rpcUrl });
const status = (await provider.status()) as { chain_id: string };
if (status.chain_id !== "localnet") throw new Error("refusing: not localnet");
out("escrow wasm sha256", sha(escrowWasm));
out("test-ft wasm sha256", sha(ftWasm));
check("artifacts are the pinned builds", sha(escrowWasm) === "470db97b62cd04701e68f6a87d7589dd8af9b8d122b96e4f5e12788d4405f2e1" && sha(ftWasm) === "c26d0ac1e4592fd7c099219ed4e1ca1400d1e7bcf6824afde42e02a63874b78d");

const vk = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8")) as { account_id: string; secret_key: KeyPairString };
const root = new Account(vk.account_id, provider, KeyPairSigner.fromSecretKey(vk.secret_key));
const NEAR = 10n ** 24n;
const RUN = randomBytes(3).toString("hex");
async function make(name: string, near: bigint): Promise<Account> {
  const kp = KeyPair.fromRandom("ed25519");
  const id = `${name}-${RUN}.${vk.account_id}`;
  await root.createAccount(id, kp.getPublicKey(), near * NEAR);
  return new Account(id, provider, new KeyPairSigner(kp));
}
async function send(acc: Account, spec: FunctionCallSpec) {
  const o = await acc.signAndSendTransaction({ receiverId: spec.receiverId, actions: [actionCreators.functionCall(spec.methodName, spec.args, spec.gas, spec.deposit)], throwOnFailure: false });
  const st = o.status as { SuccessValue?: string; Failure?: unknown };
  const logs = o.receipts_outcome.flatMap((r) => r.outcome.logs);
  if (st.Failure !== undefined) return { ok: false, value: undefined as unknown, logs, error: JSON.stringify(st.Failure) };
  const raw = Buffer.from(st.SuccessValue ?? "", "base64").toString("utf8");
  return { ok: true, value: raw === "" ? null : (JSON.parse(raw) as unknown), logs, error: undefined as string | undefined };
}
const view = <T>(c: string, m: string, a: Record<string, unknown> = {}) => provider.callFunction(c, m, a) as unknown as Promise<T>;
const nowNs = async () => BigInt((await provider.viewBlock({ finality: "final" })).header.timestamp_nanosec);

const escrow = await make("escrow", 20n);
const ft = await make("demoft", 10n);
const operator = await make("operator", 5n);
const buyer = await make("buyer", 5n);
const supplier = await make("supplier", 5n);
const primary = await make("primary", 5n);
const backup = await make("backup", 5n);
await make("treasury", 1n);
const FT = ft.accountId, E = escrow.accountId, OP = operator.accountId, B = buyer.accountId;

// ---- 1. the exact founder-approved initializer ----
const METADATA = { spec: "ft-1.0.0", name: "LineFair Test Token (testnet)", symbol: "tLFT", icon: null, reference: null, reference_hash: null, decimals: 6 };
const SUPPLY = "1000000000000";
await ft.deployContract(new Uint8Array(readFileSync(ftWasm)));
await ft.callFunction({ contractId: FT, methodName: "new", args: { owner_id: OP, total_supply: SUPPLY, metadata: METADATA } });
const md = await view<Record<string, unknown>>(FT, "ft_metadata");
check("1 ft_metadata equals the approved metadata exactly", JSON.stringify(md) === JSON.stringify(METADATA), md);
check("1 ft_total_supply == 1000000000000", (await view<string>(FT, "ft_total_supply")) === SUPPLY);
check("1 operator holds the whole supply", (await view<string>(FT, "ft_balance_of", { account_id: OP })) === SUPPLY);
check("1 frontend formats the supply as 1,000,000 tLFT", `${formatUnits(BigInt(SUPPLY), 6)} ${md.symbol as string}` === "1,000,000 tLFT", formatUnits(BigInt(SUPPLY), 6));
const again = await ft.signAndSendTransaction({ receiverId: FT, actions: [actionCreators.functionCall("new", { owner_id: OP, total_supply: SUPPLY, metadata: METADATA }, 30_000_000_000_000n, 0n)], throwOnFailure: false });
const againErr = JSON.stringify((again.status as { Failure?: unknown }).Failure ?? null);
check("1 a second `new` is refused (cannot re-initialize)", (again.status as { Failure?: unknown }).Failure !== undefined && /already (been )?initiali[sz]ed/i.test(againErr), againErr.slice(0, 160));

// ---- 2. amounts through the frontend parser ----
const P = ["400", "1,000", "1000"].map((s) => parseUnits(s, 6));
check("2 parseUnits: 400 / 1,000 / 1000 tLFT -> 400000000 / 1000000000 / 1000000000 raw", P.every((p) => p.ok) && P.map((p) => (p.ok ? p.value.toString() : "")).join("/") === "400000000/1000000000/1000000000");
check("2 parseUnits rejects 7 decimals (never rounds)", !parseUnits("0.0000001", 6).ok);
const principals = P.map((p) => (p.ok ? p.value : 0n));

// ---- 3. escrow + token setup (local) ----
await escrow.deployContract(new Uint8Array(readFileSync(escrowWasm)));
await escrow.callFunction({ contractId: E, methodName: "new", args: { network_id: "sandbox", allowlisted_ft_id: FT, operator_treasury_id: `treasury-${RUN}.${vk.account_id}`, max_agreements: 25, creator_allowlist: [B] } });
const bounds = await view<{ min: string }>(FT, "storage_balance_bounds");
for (const who of [E, B, supplier.accountId]) await operator.callFunction({ contractId: FT, methodName: "storage_deposit", args: { account_id: who, registration_only: true }, deposit: BigInt(bounds.min) });
const toBuyer = parseUnits("10,000", 6);
await operator.callFunction({ contractId: FT, methodName: "ft_transfer", args: { receiver_id: B, amount: toBuyer.ok ? toBuyer.value.toString() : "0" }, deposit: 1n });
check("3 buyer received 10,000 tLFT (10000000000 raw)", (await view<string>(FT, "ft_balance_of", { account_id: B })) === "10000000000");

// ---- 4. three-line agreement funded via the frontend's builders ----
const t0 = await nowNs();
const HOUR = 3_600_000_000_000n;
const terms = {
  schema_version: 1, deadline_rules_version: 1, buyer_id: B, supplier_id: supplier.accountId, primary_arbitrator_id: primary.accountId, backup_arbitrator_id: backup.accountId,
  ft_contract_id: FT, agreement_nonce: "1", acceptance_deadline_ns: (t0 + HOUR).toString(), funding_deadline_ns: (t0 + 2n * HOUR).toString(), delivery_grace_period_ns: "0",
  review_window_ns: "60000000000", negotiation_window_ns: "60000000000", primary_window_ns: "60000000000", backup_window_ns: "60000000000",
  lines: principals.map((p, i) => ({ line_id: i, principal: p.toString(), delivery_deadline_ns: (t0 + 9n * HOUR).toString(), acceptance_criteria_commitment: `0${i + 1}`.repeat(32), fallback_buyer_bps: 5000, fallback_supplier_bps: 5000 })),
};
const parsed = parseTermsJson(JSON.stringify(terms));
check("4 terms parse in the TS encoder", parsed.ok);
check("4 TS terms hash == contract compute_terms_hash", parsed.ok && (await termsHashHex("sandbox", E, parsed.terms)) === (await view<string>(E, "compute_terms_hash", { terms })));
const c = await send(buyer, createAgreementCall(E, terms as never));
check("4 create_agreement", c.ok, c.error);
const id = String(c.value);
let a = (await view<AgreementView>(E, "get_agreement", { agreement_id: id })) as AgreementView;
for (const [acc, spec] of [[buyer, acceptTermsCall(E, id, a.terms_hash)], [supplier, acceptTermsCall(E, id, a.terms_hash)], [primary, acceptAppointmentCall(E, id, a.terms_hash)], [backup, acceptAppointmentCall(E, id, a.terms_hash)]] as const) {
  const r = await send(acc, spec);
  check(`4 ${spec.methodName} by ${acc.accountId.split("-")[0]}`, r.ok, r.error);
}
for (let i = 0; i < 3; i++) {
  const spec = fundLineCall(FT, E, id, i, principals[i], a.terms_hash);
  check(`4 line ${i} ft_transfer_call amount encodes as "${principals[i]}"`, (spec.args as { amount: string }).amount === principals[i].toString() && spec.deposit === 1n);
  const f = await send(buyer, spec);
  const fresh = ((await view<AgreementView>(E, "get_agreement", { agreement_id: id })) as AgreementView).lines[i] as LineView;
  const o = fundingOutcome(fresh, principals[i], { usedAmount: f.value === null || f.value === undefined ? null : String(f.value), logs: f.logs, failure: f.error ?? null });
  check(`4 line ${i} funded: ${formatUnits(principals[i], 6)} tLFT "Secured in escrow"`, f.ok && f.value === principals[i].toString() && o.key === "secured", { used: f.value, ui: o.title });
}
const E2 = (await view<{ outstanding_liabilities: string }>(E, "custody_summary")).outstanding_liabilities;
check("4 custody E = 2,400 tLFT (2400000000 raw)", E2 === "2400000000" && `${formatUnits(BigInt(E2), 6)} tLFT` === "2,400 tLFT", E2);
check("4 buyer balance 7,600 tLFT", formatUnits(BigInt(await view<string>(FT, "ft_balance_of", { account_id: B })), 6) === "7,600");
a = (await view<AgreementView>(E, "get_agreement", { agreement_id: id })) as AgreementView;
check("4 agreement ACTIVE", a.status === "ACTIVE", a.status);

out("RESULT", failures === 0 ? "ALL CHECKS PASSED (local sandbox, not testnet)" : `${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
