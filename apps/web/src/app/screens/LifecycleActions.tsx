// Real-user lifecycle actions (founder authorization 2026-11-05):
// acceptance (accept_terms / accept_appointment), funding (token
// ft_transfer_call), supplier delivery (submit_delivery with a salted
// commitment computed in the browser), buyer review (accept_line /
// open_dispute) and the permissionless advance_case.
//
// Rules (apps/web/ARCHITECTURE.md §4, §6, §7; lib/contract/lifecycle.ts):
// - each action is shown only for the role and state the contract allows,
//   with a short reason when it is disabled;
// - every action re-reads the agreement right before signing and refuses to
//   sign if the fresh read no longer allows it;
// - after signing, the agreement is re-read (bounded, a few seconds apart);
//   the transaction's own result is "reported by the transaction" until the
//   contract record agrees; "Secured in escrow" only for FUNDED with
//   locked == principal.
// Wallet signing uses lib/near/wallet.ts, which has NOT been exercised
// against a deployed contract (TESTNET_WALLET_TEST.md, not executed).

import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../context.tsx";
import { Amount, Notice, Status } from "../ui.tsx";
import { signForOutcome } from "../sign.ts";
import { explorerTxUrl } from "../../lib/config.ts";
import { describeError, extractErrorCode, type ErrorCopy } from "../../lib/contract/errors.ts";
import {
  acceptAvail,
  acceptanceRows,
  acceptVerdict,
  advanceInfo,
  deliverAvail,
  fundAvail,
  fundingOutcome,
  fundingWindow,
  lineActionVerdict,
  LIFECYCLE_COPY,
  methodFor,
  parseFundingOutcome,
  reviewAvail,
  reviewEnd,
  submissionCutoff,
  type ActionAvail,
  type FundingOutcome,
  type FundingReport,
  type LineAction,
  type ReReadVerdict,
  type TermsCheck,
} from "../../lib/contract/lifecycle.ts";
import { roleOf } from "../../lib/contract/settlement.ts";
import { u128 } from "../../lib/contract/states.ts";
import type { AgreementView, LineView } from "../../lib/contract/types.ts";
import {
  acceptAppointmentCall,
  acceptLineCall,
  acceptTermsCall,
  advanceCaseCall,
  fundLineCall,
  openDisputeCall,
  submitDeliveryCall,
  type FunctionCallSpec,
} from "../../lib/near/tx.ts";
import { clearPending, savePending, type PendingKind } from "../../lib/near/walletReturn.ts";
import { contentDigest, evidenceCommitmentHex, evidenceReceiptJson, EVIDENCE_VERSION_V1, newSalt, type EvidenceInput } from "../../lib/commitment.ts";
import { formatNsLocal, formatNsUtc } from "../../lib/format.ts";

export function When({ ns }: { ns: bigint }) {
  return (
    <span className="num" title={`${ns.toString()} ns since epoch (chain time)`}>
      {formatNsUtc(ns)}
      <span className="muted"> · {formatNsLocal(ns)} local</span>
    </span>
  );
}

/** Disabled-with-reason / other-role note for an action. */
function AvailNote({ avail }: { avail: ActionAvail }) {
  if (avail.kind === "disabled") return <p className="small muted" data-reason="disabled">{avail.reason}</p>;
  if (avail.kind === "other_role") return <p className="small muted" data-reason="other-role">{avail.note}</p>;
  return null;
}

// ------------------------------------------------------------- result display

export interface ActionResultView {
  readonly txHash: string | null;
  /** What the transaction reported (never final). */
  readonly reported: string | null;
  /** Fresh contract read verdict; null when the re-read failed. */
  readonly verdict: ReReadVerdict | null;
  /** Contract rejection (ERR_* code) or unknown wallet error. */
  readonly error: ErrorCopy | null;
  /** Funding only: outcome from the fresh read. */
  readonly funding?: FundingOutcome;
  readonly readAtBlock: bigint | null;
}

export function FundingOutcomeCard({ outcome, decimals, symbol, principal }: { outcome: FundingOutcome; decimals: number; symbol: string; principal: bigint }) {
  return (
    <div data-funding-outcome={outcome.key}>
      {outcome.key === "secured" && (
        <p>
          <Status state={{ label: "Secured in escrow", tone: "positive" }} /> The contract shows this line as funded with exactly{" "}
          <Amount base={principal} decimals={decimals} symbol={symbol} /> locked.
        </p>
      )}
      {outcome.key === "refunded" && (
        <>
          <p>
            <Status state={{ label: "Not funded", tone: "warning" }} /> <strong>{outcome.title}</strong>
          </p>
          <p>{outcome.refund.title}</p>
          <p data-refund-code={outcome.refund.code}>
            Reason: {outcome.refund.reason} <span className="mono small">(LF_FT_REFUND:{outcome.refund.code})</span>
          </p>
          <p className="small">{outcome.refund.note}</p>
        </>
      )}
      {(outcome.key === "not_credited" || outcome.key === "processing") && (
        <>
          <p>
            <Status state={{ label: outcome.key === "processing" ? "Funding transaction processing" : "Not funded", tone: outcome.key === "processing" ? "info" : "warning" }} />{" "}
            {outcome.key === "not_credited" ? <strong>{outcome.title}</strong> : null}
          </p>
          <p className="small">{outcome.detail}</p>
        </>
      )}
      {(outcome.key === "moved_on" || outcome.key === "incident") && <p className={outcome.key === "incident" ? "err" : undefined}>{outcome.title}</p>}
      {outcome.reported !== null && <p className="small muted" data-reported="funding">{outcome.reported}</p>}
    </div>
  );
}

export function ActionResult({ r, decimals, symbol, principal, onReRead }: { r: ActionResultView; decimals: number; symbol: string; principal: bigint; onReRead: () => void }) {
  const { config } = useApp();
  const tone = r.error !== null && r.error.code !== "UNKNOWN" ? "negative" : r.verdict?.confirmed === true || r.funding?.key === "secured" ? "info" : "warning";
  return (
    <Notice tone={tone}>
      {r.txHash !== null && (
        <p className="small">
          Transaction{" "}
          <a className="mono" href={explorerTxUrl(config, r.txHash)} target="_blank" rel="noreferrer">
            {r.txHash}
          </a>{" "}
          (testnet explorer).
        </p>
      )}
      {r.error !== null && (
        <p data-error-code={r.error.code}>
          <strong>{r.error.title}</strong> {r.error.action}
        </p>
      )}
      {r.reported !== null && <p className="small muted" data-reported="tx">{r.reported}</p>}
      {r.funding !== undefined && <FundingOutcomeCard outcome={r.funding} decimals={decimals} symbol={symbol} principal={principal} />}
      {r.funding === undefined && r.verdict !== null && <p data-verdict={r.verdict.confirmed ? "confirmed" : "unconfirmed"}>{r.verdict.text}</p>}
      {r.verdict === null && r.funding === undefined && <p>The agreement could not be re-read. Nothing is shown as done until a read of the contract confirms it.</p>}
      <p className="small muted">
        {r.readAtBlock !== null ? <>Contract read at block {r.readAtBlock.toString()}. </> : null}
        <button className="button quiet" type="button" onClick={onReRead}>
          Re-read
        </button>
      </p>
    </Notice>
  );
}

// ------------------------------------------------------------- runner

type Run = { state: "idle" } | { state: "busy"; step: string } | { state: "blocked"; message: string } | { state: "done"; result: ActionResultView };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RunSpec {
  readonly kind: PendingKind;
  readonly lineId: number | null;
  /** On the fresh pre-sign read: null = still allowed, else the message (nothing is signed). */
  readonly precheck: (fresh: AgreementView, nowNs: bigint | null) => string | null;
  readonly build: () => FunctionCallSpec;
  /** Verdict from a fresh post-sign read. */
  readonly judge: (fresh: AgreementView, report: FundingReport | null) => { verdict: ReReadVerdict; funding?: FundingOutcome };
  readonly evidenceCommitment?: string;
}

function useRunner(a: AgreementView, onRefresh: () => void) {
  const { config, rpc, wallet } = useApp();
  const [run, setRun] = useState<Run>({ state: "idle" });

  async function go(spec: RunSpec) {
    const signer = wallet.accountId;
    if (signer === null) return;
    try {
      setRun({ state: "busy", step: "Re-reading the agreement from the contract…" });
      const fresh = await rpc.getAgreement(config.escrowId, a.agreement_id);
      if (fresh.value === null) {
        setRun({ state: "blocked", message: "The agreement could not be re-read. Nothing was signed." });
        return;
      }
      const nowNs = await rpc.finalBlock().then((b) => b.timestampNs, () => null);
      const stop = spec.precheck(fresh.value, nowNs);
      if (stop !== null) {
        setRun({ state: "blocked", message: `${stop} Nothing was signed.` });
        onRefresh();
        return;
      }
      const call = spec.build();
      savePending({ kind: spec.kind, agreementId: a.agreement_id, lineId: spec.lineId, signerId: signer, atMs: Date.now(), ...(spec.evidenceCommitment !== undefined ? { evidenceCommitment: spec.evidenceCommitment } : {}) });
      setRun({ state: "busy", step: `Waiting for confirmation in your wallet (checked at block ${fresh.blockHeight.toString()})…` });
      let txHash: string | null = null;
      let reported: string | null = null;
      let error: ErrorCopy | null = null;
      let report: FundingReport | null = null;
      try {
        const out = await signForOutcome(signer, call);
        txHash = out.txHash;
        if (out.failure !== null) {
          const code = extractErrorCode(out.failure);
          error = code !== null ? describeError(out.failure) : null;
          reported = code !== null ? null : "Reported by the transaction: failed without a contract error code. Not final; the contract record decides.";
          report = { usedAmount: null, logs: [], failure: out.failure };
        } else if (out.successValue !== null) {
          reported = "Reported by the transaction: executed. Not final on its own; the contract record decides.";
        } else {
          reported = "The wallet returned no transaction result. Only the contract record decides.";
        }
      } catch (e) {
        const m = (e as Error).message;
        // A contract code means the call was rejected and reverted. Anything else
        // (popup closed, no result) says nothing about the chain: re-read.
        error = extractErrorCode(m) !== null ? describeError(m) : { ...describeError(m), title: "The wallet did not report a result.", action: "This does not mean nothing happened. The contract record below decides; check your wallet's activity before trying again." };
      }
      if (spec.kind === "fund" && txHash !== null) {
        setRun({ state: "busy", step: "Reading the token transaction's logs…" });
        try {
          report = parseFundingOutcome(await rpc.txStatus(txHash, signer));
        } catch {
          /* keep what the wallet reported */
        }
      }
      let verdict: ReReadVerdict | null = null;
      let funding: FundingOutcome | undefined;
      let readAtBlock: bigint | null = null;
      for (let i = 0; i < 4; i++) {
        setRun({ state: "busy", step: `Re-reading the contract (${i + 1}/4)…` });
        if (i > 0) await sleep(1500);
        try {
          const after = await rpc.getAgreement(config.escrowId, a.agreement_id);
          if (after.value === null) continue;
          const j = spec.judge(after.value, report);
          verdict = j.verdict;
          funding = j.funding;
          readAtBlock = after.blockHeight;
          const settled = funding !== undefined ? funding.key !== "processing" : verdict.confirmed;
          if (settled || (error !== null && error.code !== "UNKNOWN")) break;
        } catch {
          /* try again */
        }
      }
      clearPending();
      setRun({ state: "done", result: { txHash, reported, verdict, error, ...(funding !== undefined ? { funding } : {}), readAtBlock } });
      onRefresh();
    } catch (e) {
      setRun({ state: "blocked", message: `Could not complete the pre-sign checks: ${(e as Error).message}. Nothing was signed.` });
    }
  }
  return { run, go, busy: run.state === "busy" };
}

function RunStatus({ run, decimals, symbol, principal, onRefresh }: { run: Run; decimals: number; symbol: string; principal: bigint; onRefresh: () => void }) {
  if (run.state === "busy") return <p className="small muted" aria-live="polite">{run.step}</p>;
  if (run.state === "blocked") return <Notice tone="negative"><p>{run.message}</p></Notice>;
  if (run.state === "done") return <ActionResult r={run.result} decimals={decimals} symbol={symbol} principal={principal} onReRead={onRefresh} />;
  return null;
}

// ------------------------------------------------------------- acceptance

interface AcceptanceProps {
  readonly a: AgreementView;
  readonly check: TermsCheck;
  readonly validationIssue: string | null;
  readonly nowNs: bigint | null;
  readonly onRefresh: () => void;
}

export function AcceptancePanel({ a, check, validationIssue, nowNs, onRefresh }: AcceptanceProps) {
  const { config, wallet } = useApp();
  const role = roleOf(a.terms, wallet.accountId);
  const avail = acceptAvail(a, role, wallet.accountId, nowNs, check, validationIssue);
  const { run, go, busy } = useRunner(a, onRefresh);
  const rows = acceptanceRows(a);
  const method = role === null ? null : methodFor(role);
  const deadline = u128(a.terms.acceptance_deadline_ns);

  function onAccept() {
    if (role === null || method === null || !check.ok) return;
    const hash = check.hash;
    void go({
      kind: method,
      lineId: null,
      precheck: (fresh, now) => {
        if (fresh.terms_hash !== hash) return "The stored terms hash changed since you reviewed it. Do not sign; reload and verify again.";
        const v = acceptAvail(fresh, role, wallet.accountId, now, check, validationIssue);
        return v.kind === "enabled" ? null : v.kind === "disabled" ? v.reason : v.kind === "other_role" ? v.note : "This agreement no longer needs acceptance.";
      },
      build: () => (method === "accept_terms" ? acceptTermsCall : acceptAppointmentCall)(config.escrowId, a.agreement_id, hash),
      judge: (fresh) => ({ verdict: acceptVerdict(fresh, role) }),
    });
  }

  const nAccepted = rows.filter((r) => r.accepted).length;
  return (
    <section className="panel" aria-labelledby="acceptance-h" data-panel="acceptance">
      <div className="panel-head">
        <h2 id="acceptance-h">Parties and acceptance</h2>
        <span className="small muted num">{nAccepted} of 4 accepted (contract record)</span>
      </div>
      <dl className="kv">
        {rows.map((r) => (
          <AcceptRow key={r.role} title={r.title} you={r.role === role}>
            <span className="mono">{r.accountId}</span> ·{" "}
            <span data-accepted={r.role}>{r.accepted ? "✓ accepted" : "– not yet"}</span>
            <span className="muted small"> ({r.method === "accept_terms" ? "accepts the terms" : "accepts the appointment"})</span>
          </AcceptRow>
        ))}
        <dt>Accept by</dt>
        <dd>
          <When ns={deadline} /> (exclusive)
        </dd>
        <dt>Terms hash</dt>
        <dd className="mono" style={{ wordBreak: "break-all" }}>
          {a.terms_hash}
          {check.ok ? " (re-encoded here and equal to compute_terms_hash)" : ""}
        </dd>
      </dl>
      {!check.ok && (
        <Notice tone="negative">
          <p>
            <strong>{check.reason}</strong>
          </p>
        </Notice>
      )}
      {avail.kind !== "hidden" && (
        <div className="settlement">
          {avail.kind !== "other_role" && method !== null && (
            <>
              <p className="small">
                {method === "accept_terms"
                  ? "By accepting you agree to these exact terms, identified by the hash above. Creating an agreement is not acceptance; the buyer accepts too."
                  : "By accepting you take the arbitrator appointment under these exact terms, identified by the hash above."}
              </p>
              <div className="actions">
                <button className="button" type="button" disabled={busy || avail.kind !== "enabled"} onClick={onAccept}>
                  {method === "accept_terms" ? "Accept terms" : "Accept appointment"}
                </button>
              </div>
            </>
          )}
          <AvailNote avail={avail} />
        </div>
      )}
      <RunStatus run={run} decimals={0} symbol="" principal={0n} onRefresh={onRefresh} />
    </section>
  );
}

function AcceptRow({ title, you, children }: { title: string; you: boolean; children: ReactNode }) {
  return (
    <>
      <dt>
        {title}
        {you ? " (you)" : ""}
      </dt>
      <dd>{children}</dd>
    </>
  );
}

// ------------------------------------------------------------- per line

interface LineProps {
  readonly a: AgreementView;
  readonly line: LineView;
  readonly principal: bigint;
  readonly decimals: number;
  readonly symbol: string;
  readonly check: TermsCheck;
  readonly nowNs: bigint | null;
  readonly onRefresh: () => void;
}

/** All lifecycle actions of one line (fund, deliver, review, advance). Renders nothing when none applies. */
export function LineLifecycle(p: LineProps) {
  const s = p.line.status;
  if (s !== "UNFUNDED" && s !== "FUNDED" && s !== "SUBMITTED") return null;
  return (
    <div data-panel="lifecycle">
      {s === "UNFUNDED" && <FundingBlock {...p} />}
      {s === "FUNDED" && <DeliveryBlock {...p} />}
      {s === "SUBMITTED" && <ReviewBlock {...p} />}
      {(s === "FUNDED" || s === "SUBMITTED") && <AdvanceBlock {...p} />}
    </div>
  );
}

// ---- funding

function FundingBlock({ a, line, principal, decimals, symbol, check, nowNs, onRefresh }: LineProps) {
  const { config, rpc, wallet } = useApp();
  const role = roleOf(a.terms, wallet.accountId);
  const [escrowRegistered, setReg] = useState<boolean | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [reads, setReads] = useState(0);
  const { run, go, busy } = useRunner(a, onRefresh);
  const ftId = a.terms.ft_contract_id;
  const isBuyer = role === "buyer";

  useEffect(() => {
    if (!isBuyer || wallet.accountId === null) return;
    let cancelled = false;
    const account = wallet.accountId;
    rpc.storageBalanceOf(ftId, config.escrowId).then(
      (r) => !cancelled && setReg(r.value !== null),
      () => !cancelled && setReg(null),
    );
    rpc.ftBalanceOf(ftId, account).then(
      (r) => !cancelled && setBalance(/^(0|[1-9][0-9]*)$/.test(r.value) ? BigInt(r.value) : null),
      () => !cancelled && setBalance(null),
    );
    return () => {
      cancelled = true;
    };
  }, [isBuyer, wallet.accountId, rpc, ftId, config.escrowId, reads]);

  const avail = fundAvail(a, line, role, wallet.accountId, nowNs, check, { escrowRegistered, buyerBalance: balance });
  if (avail.kind === "hidden") return null;
  const w = fundingWindow(a, line.line_id);
  const id = line.line_id;

  function onFund() {
    if (!check.ok) return;
    const hash = check.hash;
    void go({
      kind: "fund",
      lineId: id,
      precheck: (fresh, now) => {
        if (fresh.terms_hash !== hash) return "The stored terms hash changed since you reviewed it. Do not sign.";
        const fl = fresh.lines[id];
        if (fl === undefined) return "The line could not be re-read.";
        const v = fundAvail(fresh, fl, role, wallet.accountId, now, check, { escrowRegistered, buyerBalance: balance });
        return v.kind === "enabled" ? null : v.kind === "disabled" ? v.reason : v.kind === "other_role" ? v.note : `The line is ${fl.status} now, not unfunded.`;
      },
      build: () => fundLineCall(ftId, config.escrowId, a.agreement_id, id, principal, hash),
      judge: (fresh, report) => {
        const fl = fresh.lines[id];
        const o = fundingOutcome(fl, principal, report);
        return { verdict: { confirmed: o.key === "secured", text: o.title }, funding: o };
      },
    });
  }

  return (
    <div className="settlement" aria-labelledby={`fund-${id}`} data-action="fund">
      <h3 id={`fund-${id}`}>Funding</h3>
      <dl className="kv">
        <dt>Funding deadline</dt>
        <dd>
          <When ns={w.deadlineNs} /> (exclusive)
        </dd>
        {w.f3Binding && (
          <>
            <dt>Last moment to fund</dt>
            <dd data-f3="binding">
              {w.lastCreditableNs === null ? (
                <span>Never: the delivery deadline leaves less than the review window.</span>
              ) : (
                <>
                  <When ns={w.lastCreditableNs} /> (delivery deadline + grace − review window)
                </>
              )}
            </dd>
          </>
        )}
        <dt>Exact amount</dt>
        <dd>
          <Amount base={principal} decimals={decimals} symbol={symbol} /> in one transfer
        </dd>
      </dl>
      {w.f3Binding && (
        <p className="small muted">
          A deposit is credited only if the supplier keeps at least the review window to deliver (founder-approved rule F3; the contract version this app
          accepts does not enforce it yet, so this app stops offering funding at the earlier time).
        </p>
      )}
      {avail.kind !== "other_role" && (
        <>
          <p className="small">
            Sends exactly <Amount base={principal} decimals={decimals} symbol={symbol} /> from your account to the escrow through the token contract{" "}
            <span className="mono">{ftId}</span>, with 1 yoctoNEAR attached. A wrong amount, a late deposit or any mismatch is returned by the token and
            nothing is credited.
          </p>
          <dl className="kv">
            <dt>Escrow registered on the token</dt>
            <dd data-check="escrow-registered">{escrowRegistered === null ? "unknown" : escrowRegistered ? "yes" : "no"}</dd>
            <dt>Your token balance</dt>
            <dd data-check="buyer-balance">{balance === null ? "unknown" : <Amount base={balance} decimals={decimals} symbol={symbol} />}</dd>
          </dl>
          <div className="actions">
            <button className="button" type="button" disabled={busy || avail.kind !== "enabled"} onClick={onFund}>
              Fund line {id + 1}
            </button>
            <button className="button quiet" type="button" onClick={() => setReads((n) => n + 1)}>
              Re-check balance and registration
            </button>
          </div>
        </>
      )}
      <AvailNote avail={avail} />
      <RunStatus run={run} decimals={decimals} symbol={symbol} principal={principal} onRefresh={onRefresh} />
    </div>
  );
}

// ---- delivery

interface Prepared {
  readonly fileName: string;
  readonly input: EvidenceInput;
  readonly commitment: string;
}

function DeliveryBlock({ a, line, principal, decimals, symbol, nowNs, onRefresh }: LineProps) {
  const { config, wallet } = useApp();
  const role = roleOf(a.terms, wallet.accountId);
  const avail = deliverAvail(a, line, role, wallet.accountId, nowNs);
  const { run, go, busy } = useRunner(a, onRefresh);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (avail.kind === "hidden") return null;
  const id = line.line_id;
  const cutoff = submissionCutoff(a, id);

  async function onFile(f: File | undefined) {
    setPrep(null);
    setSaved(false);
    setPrepError(null);
    if (f === undefined) return;
    try {
      const digest = await contentDigest(new Uint8Array(await f.arrayBuffer()));
      const input: EvidenceInput = { network: config.network, escrowId: config.escrowId, agreementId: BigInt(a.agreement_id), lineId: id, version: EVIDENCE_VERSION_V1, contentDigest: digest, salt: newSalt() };
      setPrep({ fileName: f.name, input, commitment: await evidenceCommitmentHex(input) });
    } catch (e) {
      setPrepError(`The commitment could not be computed: ${(e as Error).message}`);
    }
  }

  function downloadReceipt() {
    if (prep === null) return;
    const blob = new Blob([evidenceReceiptJson(prep.input, prep.commitment, prep.fileName)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url;
    el.download = `linefair-evidence-${a.agreement_id}-line${id + 1}.json`;
    el.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function onSubmit() {
    if (prep === null || !saved) return;
    const c = prep.commitment;
    void go({
      kind: "submit_delivery",
      lineId: id,
      evidenceCommitment: c,
      precheck: (fresh, now) => {
        const fl = fresh.lines[id];
        if (fl === undefined) return "The line could not be re-read.";
        const v = deliverAvail(fresh, fl, role, wallet.accountId, now);
        return v.kind === "enabled" ? null : v.kind === "disabled" ? v.reason : v.kind === "other_role" ? v.note : `The line is ${fl.status} now, not funded.`;
      },
      build: () => submitDeliveryCall(config.escrowId, a.agreement_id, id, c),
      judge: (fresh) => ({ verdict: lineActionVerdict("submit_delivery", fresh.lines[id], { evidenceCommitment: c }) }),
    });
  }

  return (
    <div className="settlement" aria-labelledby={`deliver-${id}`} data-action="deliver">
      <h3 id={`deliver-${id}`}>Delivery</h3>
      <dl className="kv">
        <dt>Delivery cutoff</dt>
        <dd>
          <When ns={cutoff} /> (delivery deadline + grace, exclusive)
        </dd>
      </dl>
      {avail.kind !== "other_role" && (
        <>
          <p className="small">
            Choose the evidence file. It is read only in this browser: its SHA-256 and a new random 32-byte salt form the commitment. Only the commitment is
            sent to the contract; the file and the salt never leave this device.
          </p>
          <div className="actions">
            <label className="small" htmlFor={`evidence-${id}`}>
              Evidence file
            </label>
            <input id={`evidence-${id}`} type="file" disabled={avail.kind !== "enabled" || busy} onChange={(e) => void onFile(e.target.files?.[0])} />
          </div>
          {prepError !== null && <p className="small err">{prepError}</p>}
          {prep !== null && (
            <>
              <dl className="kv">
                <dt>Commitment</dt>
                <dd className="mono" style={{ wordBreak: "break-all" }} data-commitment>
                  {prep.commitment}
                </dd>
              </dl>
              <div className="actions">
                <button className="button secondary" type="button" onClick={downloadReceipt}>
                  Download private receipt (salt)
                </button>
                <label className="small">
                  <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved the private receipt with the file
                </label>
              </div>
            </>
          )}
          <div className="actions">
            <button className="button" type="button" disabled={busy || avail.kind !== "enabled" || prep === null || !saved} onClick={onSubmit}>
              Submit delivery for line {id + 1}
            </button>
          </div>
          {avail.kind === "enabled" && (prep === null || !saved) && (
            <p className="small muted" data-reason="needs-commitment">
              Choose the evidence file and save the private receipt first.
            </p>
          )}
        </>
      )}
      <AvailNote avail={avail} />
      <RunStatus run={run} decimals={decimals} symbol={symbol} principal={principal} onRefresh={onRefresh} />
    </div>
  );
}

// ---- review

function ReviewBlock({ a, line, principal, decimals, symbol, nowNs, onRefresh }: LineProps) {
  const { config, wallet } = useApp();
  const role = roleOf(a.terms, wallet.accountId);
  const avail = reviewAvail(a, line, role, wallet.accountId, nowNs);
  const { run, go, busy } = useRunner(a, onRefresh);
  if (avail.kind === "hidden") return null;
  const id = line.line_id;
  const end = reviewEnd(a, line);

  function act(action: Extract<LineAction, "accept_line" | "open_dispute">) {
    void go({
      kind: action,
      lineId: id,
      precheck: (fresh, now) => {
        const fl = fresh.lines[id];
        if (fl === undefined) return "The line could not be re-read.";
        const v = reviewAvail(fresh, fl, role, wallet.accountId, now);
        return v.kind === "enabled" ? null : v.kind === "disabled" ? v.reason : v.kind === "other_role" ? v.note : `The line is ${fl.status} now, not under review.`;
      },
      build: () => (action === "accept_line" ? acceptLineCall : openDisputeCall)(config.escrowId, a.agreement_id, id),
      judge: (fresh) => ({ verdict: lineActionVerdict(action, fresh.lines[id]) }),
    });
  }

  return (
    <div className="settlement" aria-labelledby={`review-${id}`} data-action="review">
      <h3 id={`review-${id}`}>Buyer review</h3>
      <dl className="kv">
        <dt>Submitted</dt>
        <dd>
          <When ns={u128(line.submitted_at_ns)} />
        </dd>
        <dt>Review window ends</dt>
        <dd>
          <When ns={end} /> (exclusive)
        </dd>
        <dt>Evidence commitment</dt>
        <dd className="mono" style={{ wordBreak: "break-all" }}>
          {line.evidence_commitment}
        </dd>
      </dl>
      {avail.kind !== "other_role" && (
        <>
          <p className="small">
            Accepting allocates the full amount to the supplier (claimable, not paid). Disputing keeps the funds secured and starts the agreed dispute process now.
          </p>
          <div className="actions">
            <button className="button" type="button" disabled={busy || avail.kind !== "enabled"} onClick={() => act("accept_line")}>
              Accept delivery
            </button>
            <button className="button secondary" type="button" disabled={busy || avail.kind !== "enabled"} onClick={() => act("open_dispute")}>
              Open dispute
            </button>
          </div>
        </>
      )}
      <AvailNote avail={avail} />
      <RunStatus run={run} decimals={decimals} symbol={symbol} principal={principal} onRefresh={onRefresh} />
    </div>
  );
}

// ---- advance_case

function AdvanceBlock({ a, line, principal, decimals, symbol, onRefresh }: LineProps) {
  const { config, wallet } = useApp();
  const info = advanceInfo(line, wallet.accountId);
  const { run, go, busy } = useRunner(a, onRefresh);
  if (info.avail.kind === "hidden" || info.t0Ns === null) return null;
  const id = line.line_id;

  function onAdvance() {
    void go({
      kind: "advance_case",
      lineId: id,
      precheck: (fresh) => {
        const fl = fresh.lines[id];
        if (fl === undefined) return "The line could not be re-read.";
        return advanceInfo(fl, wallet.accountId).avail.kind === "enabled" ? null : `The contract no longer reports this line as eligible (it is ${fl.status}).`;
      },
      build: () => advanceCaseCall(config.escrowId, a.agreement_id, id),
      judge: (fresh) => ({ verdict: lineActionVerdict("advance_case", fresh.lines[id]) }),
    });
  }

  return (
    <div className="settlement" aria-labelledby={`advance-${id}`} data-action="advance">
      <h3 id={`advance-${id}`}>{info.reason === "NO_RESPONSE" ? "No buyer response" : "No delivery"}</h3>
      <p className="small">
        {info.reason === "NO_RESPONSE"
          ? "The review window ended without the buyer accepting or disputing. The contract reports this line as eligible for the no-response dispute process. Funds are not paid automatically."
          : "The delivery cutoff passed without a submission. The contract reports this line as eligible for the non-delivery dispute process. Nothing is refunded automatically."}
      </p>
      <dl className="kv">
        <dt>Dispute T0 (fixed)</dt>
        <dd>
          <When ns={info.t0Ns} />
        </dd>
      </dl>
      <p className="small muted">{LIFECYCLE_COPY.fixedT0}</p>
      <div className="actions">
        <button className="button secondary" type="button" disabled={busy || info.avail.kind !== "enabled"} onClick={onAdvance}>
          Move line {id + 1} into the dispute process
        </button>
        <span className="small muted">Anyone may do this.</span>
      </div>
      <AvailNote avail={info.avail} />
      <RunStatus run={run} decimals={decimals} symbol={symbol} principal={principal} onRefresh={onRefresh} />
    </div>
  );
}
