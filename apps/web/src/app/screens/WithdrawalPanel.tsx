// LF-009 withdrawals for one line: the buyer's and the supplier's claim.
// Contract-confirmed state only (withdrawals.ts claimPanel):
// - every read is one snapshot at a single block (get_agreement +
//   get_withdrawal x2 + custody_summary, lib/near/snapshot.ts);
// - "Payment completed successfully." only after a second, later snapshot
//   confirms the same PAID record (exact copy: withdrawals.ts WITHDRAWAL_MESSAGES,
//   founder decision 2026-11-05);
// - the withdraw transaction's own result is shown as "reported by the
//   transaction", never as final;
// - after every withdraw: bounded re-reads (reads only, never a new transfer),
//   then the claim shows whatever the contract records. A PENDING record after
//   the transaction ended is the inconclusive case (permanent, no retry).
// - token balances are never read here and never decide anything.
// Wallet signing uses the testnet wallet-selector code, which has NOT been
// exercised against a deployed contract (wallet.ts STATUS).

import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../context.tsx";
import { explorerTxUrl } from "../../lib/config.ts";
import { Amount, Notice, Status } from "../ui.tsx";
import {
  beneficiaryArg,
  claimPanel,
  claimState,
  parseWithdrawResult,
  withdrawErrorText,
  type ClaimPanel,
  type Registration,
  type TxRecord,
  type Who,
} from "../../lib/contract/withdrawals.ts";
import type { AgreementView, LineView } from "../../lib/contract/types.ts";
import { u128 } from "../../lib/contract/states.ts";
import { claimSnapshot, readLineSnapshot, type LineSnapshot } from "../../lib/near/snapshot.ts";
import { withdrawCall } from "../../lib/near/tx.ts";
import { signForOutcome } from "../sign.ts";
import { formatNsUtc } from "../../lib/format.ts";

/** Bounded post-transaction re-reads (reads only). */
const REREAD_ATTEMPTS = 5;
const REREAD_DELAY_MS = 1500;
const CONFIRM_DELAY_MS = 1200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Props {
  readonly a: AgreementView;
  readonly line: LineView;
  readonly decimals: number;
  readonly symbol: string;
  readonly onRefresh: () => void;
}

const WHO: readonly Who[] = ["supplier", "buyer"];

export function WithdrawalPanel({ a, line, decimals, symbol, onRefresh }: Props) {
  const { config, rpc, wallet } = useApp();
  const [snap, setSnap] = useState<LineSnapshot | undefined>(undefined);
  const [confirm, setConfirm] = useState<LineSnapshot | undefined>(undefined);
  const [readError, setReadError] = useState<string | null>(null);
  const [reg, setReg] = useState<Record<Who, Registration>>({ buyer: "checking", supplier: "checking" });
  const [tx, setTx] = useState<Record<Who, TxRecord | null>>({ buyer: null, supplier: null });
  const [txError, setTxError] = useState<Record<Who, string | null>>({ buyer: null, supplier: null });
  const alive = useRef(true);
  // Set on every mount: React StrictMode (development) mounts, unmounts and
  // re-mounts each component; a cleanup-only flag stayed false after the
  // simulated unmount and every read result was discarded ("Reading the
  // contract record…" forever, found live 2026-11-11).
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const { buyer_id, supplier_id } = a.terms;
  const recipient = useCallback((who: Who) => (who === "buyer" ? buyer_id : supplier_id), [buyer_id, supplier_id]);
  const ftId = a.terms.ft_contract_id;

  /** One snapshot, plus a confirming later snapshot when any slot reads PAID. */
  const readAll = useCallback(async (): Promise<LineSnapshot> => {
    const s = await readLineSnapshot(rpc, config.escrowId, a.agreement_id, line.line_id);
    if (!alive.current) return s;
    setSnap(s);
    setConfirm(undefined);
    setReadError(null);
    if (s.line.buyer_withdrawal === "PAID" || s.line.supplier_withdrawal === "PAID") {
      await sleep(CONFIRM_DELAY_MS);
      const c = await readLineSnapshot(rpc, config.escrowId, a.agreement_id, line.line_id);
      if (alive.current) setConfirm(c);
    }
    return s;
  }, [rpc, config.escrowId, a.agreement_id, line.line_id]);

  const checkRegistration = useCallback(
    async (who: Who): Promise<Registration> => {
      try {
        const r = await rpc.storageBalanceOf(ftId, recipient(who));
        return r.value === null ? "not_registered" : "registered";
      } catch {
        return "unknown";
      }
    },
    [rpc, ftId, recipient],
  );

  useEffect(() => {
    let cancelled = false;
    readAll()
      .then(async (s) => {
        const next: Record<Who, Registration> = { buyer: "unknown", supplier: "unknown" };
        for (const who of WHO) next[who] = claimState(s.line, who).withdrawable ? await checkRegistration(who) : "unknown";
        if (!cancelled && alive.current) setReg(next);
      })
      .catch((e: unknown) => {
        if (!cancelled && alive.current) setReadError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [readAll, checkRegistration, line]);

  async function onWithdraw(who: Who) {
    const signer = wallet.accountId;
    if (signer === null) return;
    setTxError((t) => ({ ...t, [who]: null }));
    try {
      // Fresh read and registration check right before signing.
      const fresh = await readAll();
      const r = await checkRegistration(who);
      setReg((x) => ({ ...x, [who]: r }));
      const p = claimPanel({ who, recipient: recipient(who), ftId, snap: claimSnapshot(fresh, who), confirm: undefined, connected: signer, registration: r, tx: null });
      if (!p.action.enabled) {
        setTxError((t) => ({ ...t, [who]: `Not signed: ${p.action.reason ?? p.label}` }));
        return;
      }
      setTx((t) => ({ ...t, [who]: { phase: "signing" } }));
      let txHash: string | null = null;
      let reported = null;
      let error: string | null = null;
      try {
        const out = await signForOutcome(signer, withdrawCall(config.escrowId, a.agreement_id, line.line_id, beneficiaryArg(who)));
        txHash = out.txHash;
        error = out.failure;
        reported = out.successValue === null ? null : parseWithdrawResult(out.successValue);
      } catch (e) {
        error = (e as Error).message;
      }
      if (error !== null) {
        const text = withdrawErrorText(error);
        setTxError((t) => ({ ...t, [who]: text }));
      }
      setTx((t) => ({ ...t, [who]: { phase: "ended", txHash, reported, error, rereadDone: false } }));
      // Bounded re-reads (final-finality views lag the transaction by a block
      // or two): stop once the record shows a NEW withdrawal id that is no
      // longer PENDING. If the id never changes the call was rejected before
      // any state change and the claim simply stays as it was.
      const beforeId = (who === "buyer" ? fresh.buyer : fresh.supplier)?.withdrawal_id ?? "0";
      for (let n = 0; n < REREAD_ATTEMPTS; n++) {
        const s = await readAll();
        const rec = who === "buyer" ? s.buyer : s.supplier;
        if (rec !== null && rec.withdrawal_id !== beforeId && rec.state !== "PENDING") break;
        if (n + 1 < REREAD_ATTEMPTS) await sleep(REREAD_DELAY_MS);
      }
      if (alive.current) {
        setTx((t) => ({ ...t, [who]: { phase: "ended", txHash, reported, error, rereadDone: true } }));
        const r2 = await checkRegistration(who);
        setReg((x) => ({ ...x, [who]: r2 }));
      }
      onRefresh();
    } catch (e) {
      if (alive.current) setReadError((e as Error).message);
    }
  }

  return (
    <div className="settlement withdrawals" aria-labelledby={`withdraw-${line.line_id}`}>
      <h3 id={`withdraw-${line.line_id}`}>Withdrawals</h3>
      {readError !== null && (
        <Notice tone="negative">
          <p><strong>Could not read the withdrawal record.</strong> {readError} Nothing is shown as paid or ready until it can be read.</p>
        </Notice>
      )}
      {WHO.map((who) => {
        const panel = claimPanel({
          who,
          recipient: recipient(who),
          ftId,
          snap: snap === undefined ? undefined : claimSnapshot(snap, who),
          confirm: confirm === undefined ? undefined : claimSnapshot(confirm, who),
          connected: wallet.accountId,
          registration: reg[who],
          tx: tx[who],
        });
        return (
          <ClaimCard
            key={who}
            who={who}
            panel={panel}
            decimals={decimals}
            symbol={symbol}
            txHash={endedHash(tx[who])}
            txUrl={endedHash(tx[who]) === null ? null : explorerTxUrl(config, endedHash(tx[who]) as string)}
            error={txError[who]}
            onWithdraw={() => void onWithdraw(who)}
          />
        );
      })}
      {snap !== undefined && (
        <p className="small muted num">
          Contract custody (observation only, never used to decide a payout): outstanding liabilities{" "}
          <Amount base={u128(snap.custody.outstanding_liabilities)} decimals={decimals} symbol={symbol} />, open withdrawals{" "}
          {snap.custody.open_withdrawals}. Read at block {snap.blockHeight.toString()}
          {confirm !== undefined ? `, confirmed at block ${confirm.blockHeight.toString()}` : ""}.
        </p>
      )}
    </div>
  );
}

function endedHash(t: TxRecord | null): string | null {
  return t !== null && t.phase === "ended" ? t.txHash : null;
}

/** Presentational card for one claim (also rendered by the offline DOM check). */
export function ClaimCard(props: {
  who: Who;
  panel: ClaimPanel;
  decimals: number;
  symbol: string;
  txHash: string | null;
  txUrl: string | null;
  error: string | null;
  onWithdraw: () => void;
}) {
  const { who, panel: p, decimals, symbol } = props;
  const party = who === "buyer" ? "Buyer" : "Supplier";
  const amt = (v: bigint) => <Amount base={v} decimals={decimals} symbol={symbol} />;
  return (
    <div className="claim" data-claim={who} data-claim-key={p.key}>
      <div className="actions">
        <strong>{party}</strong>
        <Status state={p} />
      </div>
      {p.detail !== undefined && p.detail !== "" && <p className="small muted">{p.detail}</p>}
      <dl className="kv facts claim-facts">
        {p.share > 0n && (<div><dt>Allocated share</dt><dd>{amt(p.share)}</dd></div>)}
        {p.withdrawalId !== null && (<div><dt>Withdrawal</dt><dd className="num">#{p.withdrawalId}</dd></div>)}
        {!(p.key === "paid" && p.amount !== null) && (<div className="wide"><dt>Recipient</dt><dd className="mono">{p.recipient}</dd></div>)}
        {p.startedAtNs !== null && (<div><dt>Started</dt><dd className="num">{formatNsUtc(p.startedAtNs)}</dd></div>)}
        {p.resolvedAtNs !== null && (p.key === "paid" || p.key === "failed_restored") && (
          <div><dt>{p.key === "paid" ? "Confirmed" : "Failed"}</dt><dd className="num">{formatNsUtc(p.resolvedAtNs)}</dd></div>
        )}
        {p.key === "paid" && p.amount !== null && (<div className="wide"><dt>Paid to {p.recipient}</dt><dd>{amt(p.amount)}</dd></div>)}
      </dl>
      {p.notices.map((n, i) => (
        <Notice key={i} tone={n.tone}><p>{n.text}</p></Notice>
      ))}
      {p.reported !== null && (
        <p className={`small ${p.reported.agrees ? "muted" : ""}`} data-reported={p.reported.agrees ? "agrees" : "unconfirmed"}>
          {p.reported.text}
          {props.txHash !== null && (
            <>
              {" "}Transaction{" "}
              <a className="mono" href={props.txUrl ?? undefined} target="_blank" rel="noreferrer">{props.txHash}</a>
            </>
          )}
        </p>
      )}
      {props.error !== null && (
        <Notice tone="negative"><p>{props.error}</p></Notice>
      )}
      {p.action.kind !== "none" && (
        <div className="actions">
          <button className="button" type="button" disabled={!p.action.enabled} onClick={props.onWithdraw}>
            {p.action.kind === "retry" ? "Withdraw again" : "Withdraw"} {amt(p.share)}
          </button>
          {p.action.reason !== null && <span className="small muted">{p.action.reason}</span>}
          {p.action.enabled && <span className="small muted">Sends the whole share to {p.recipient}. Attaches exactly 1 yoctoNEAR; nothing else.</span>}
        </div>
      )}
    </div>
  );
}
