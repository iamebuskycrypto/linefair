// LF-008 dispute timeline, arbitrator ruling and permissionless fallback for
// one DISPUTED line. The contract is the authority: the current phase is the
// contract's `dispute_phase` from the last read, the ruling form appears only
// for the arbitrator whose window that read reports open, every action
// re-reads the line right before signing, and every outcome is judged by a
// fresh read after signing. Wallet signing uses the existing testnet
// wallet-selector code, which has NOT been exercised against a deployed
// contract (wallet.ts STATUS).

import { useState } from "react";
import { useApp } from "../context.tsx";
import { Amount, Field, Notice, Status } from "../ui.tsx";
import { sign } from "../sign.ts";
import { describeError } from "../../lib/contract/errors.ts";
import {
  disputeTimeline,
  fallbackAvailability,
  fallbackPreview,
  recheckBeforeDecision,
  rulingAvailability,
} from "../../lib/contract/arbitration.ts";
import { parseSplitInput, roleOf } from "../../lib/contract/settlement.ts";
import type { AgreementView, LineView } from "../../lib/contract/types.ts";
import { submitRulingCall, triggerFallbackCall, type FunctionCallSpec } from "../../lib/near/tx.ts";
import { formatBps, formatNsLocal, formatNsUtc, formatUnits, parseUnits } from "../../lib/format.ts";

type Submit =
  | { state: "idle" }
  | { state: "busy"; step: string }
  | { state: "blocked"; message: string }
  | { state: "sent"; what: string; txHash: string | null };

interface Props {
  readonly a: AgreementView;
  readonly line: LineView;
  readonly principal: bigint;
  readonly decimals: number;
  readonly symbol: string;
  readonly onRefresh: () => void;
}

function When({ ns }: { ns: bigint }) {
  return (
    <span className="num" title={`${ns.toString()} ns since epoch (chain time)`}>
      {formatNsUtc(ns)}
      <span className="muted"> · {formatNsLocal(ns)} local</span>
    </span>
  );
}

export function ArbitrationPanel({ a, line, principal, decimals, symbol, onRefresh }: Props) {
  const { config, rpc, wallet } = useApp();
  const role = roleOf(a.terms, wallet.accountId);
  const terms = a.terms.lines[line.line_id];
  const timeline = disputeTimeline(line, a.terms);
  const ruling = rulingAvailability(line, role);
  const fb = fallbackAvailability(line, wallet.accountId !== null);
  const preview = fallbackPreview(principal, terms.fallback_supplier_bps, terms.fallback_buyer_bps);
  const [buyerText, setBuyerText] = useState("");
  const [supplierText, setSupplierText] = useState("");
  const [touched, setTouched] = useState(false);
  const [submit, setSubmit] = useState<Submit>({ state: "idle" });
  const busy = submit.state === "busy";
  const input = parseSplitInput(buyerText, supplierText, principal, decimals);
  const errs = touched && !input.ok ? input : null;
  const id = line.line_id;

  function fillRemainder(from: "buyer" | "supplier") {
    const other = from === "buyer" ? supplierText : buyerText;
    if (other.trim() !== "") return;
    const leg = parseUnits(from === "buyer" ? buyerText : supplierText, decimals);
    if (!leg.ok || leg.value > principal) return;
    const rest = formatUnits(principal - leg.value, decimals).replace(/,/g, "");
    if (from === "buyer") setSupplierText(rest);
    else setBuyerText(rest);
  }

  /** Re-read, re-check the phase, sign, then re-read again. */
  async function act(action: "primary" | "backup" | "fallback", build: () => FunctionCallSpec, what: string) {
    if (wallet.accountId === null) return;
    try {
      setSubmit({ state: "busy", step: "Re-reading the line from the contract…" });
      const fresh = await rpc.getAgreement(config.escrowId, a.agreement_id);
      const freshLine = fresh.value?.lines[id];
      if (freshLine === undefined) {
        setSubmit({ state: "blocked", message: "The line could not be re-read. Nothing was signed." });
        return;
      }
      const check = recheckBeforeDecision(freshLine, action);
      if (!check.ok) {
        setSubmit({ state: "blocked", message: check.message });
        onRefresh();
        return;
      }
      const call = build();
      setSubmit({ state: "busy", step: `Waiting for confirmation in your wallet (phase checked at block ${fresh.blockHeight.toString()})…` });
      const txHash = await sign(wallet.accountId, call);
      setSubmit({ state: "sent", what, txHash });
      onRefresh();
    } catch (e) {
      const d = describeError((e as Error).message);
      setSubmit({ state: "blocked", message: `${d.title} ${d.action}` });
    }
  }

  function onRule() {
    setTouched(true);
    if (!input.ok || !ruling.canRule || ruling.as === undefined) return;
    const { buyer, supplier } = input;
    void act(ruling.as, () => submitRulingCall(config.escrowId, a.agreement_id, id, buyer, supplier, principal), "Ruling sent");
  }

  function onFallback() {
    if (!fb.canTrigger) return;
    void act("fallback", () => triggerFallbackCall(config.escrowId, a.agreement_id, id), "Fallback request sent");
  }

  return (
    <div className="settlement" aria-labelledby={`arb-${id}`}>
      <h3 id={`arb-${id}`}>Dispute timeline</h3>
      {!timeline.ok ? (
        <p className="small">
          <Status state={timeline.label} /> {timeline.label.detail}
        </p>
      ) : (
        <>
          <p className="small">
            <Status state={timeline.label} /> {timeline.label.detail}
          </p>
          <ol className="timeline">
            {timeline.steps.map((s) => (
              <li key={s.key} className={`phase ${s.position}`} aria-current={s.position === "current" ? "step" : undefined}>
                <div className="phase-head">
                  <strong>{s.title}</strong>
                  <span className="small muted">{s.position === "current" ? "now (at last read)" : s.position === "past" ? "ended" : "upcoming"}</span>
                </div>
                <div className="small">
                  From <When ns={s.startNs} />
                  {s.endNs !== null ? <> until <When ns={s.endNs} /> (exclusive)</> : <> onward</>}
                </div>
                <div className="small muted">{s.who}</div>
              </li>
            ))}
          </ol>
          <p className="small muted">
            Times are chain time. The phase shown is what the contract reported at the last read; the contract re-checks the phase with its own
            clock when an action is signed. At each boundary the earlier authority ends.
          </p>
        </>
      )}

      <dl className="kv" style={{ marginTop: "var(--s2)" }}>
        <dt>Fallback split (agreed)</dt>
        <dd>
          Supplier {formatBps(preview.supplierBps)}: <Amount base={preview.supplier} decimals={decimals} symbol={symbol} />; buyer{" "}
          {formatBps(preview.buyerBps)}: <Amount base={preview.buyer} decimals={decimals} symbol={symbol} />
          <span className="small muted"> (supplier share rounded down to the base unit; the buyer receives the remainder)</span>
        </dd>
      </dl>

      {ruling.canRule && (
        <form
          className="split-form"
          onSubmit={(e) => {
            e.preventDefault();
            onRule();
          }}
          noValidate
        >
          <h3>Your ruling as {ruling.as} arbitrator</h3>
          <p className="small muted">
            Allocate the line amount of <Amount base={principal} decimals={decimals} symbol={symbol} /> between the original buyer and supplier.
            The two amounts must add up exactly; nothing is rounded. A ruling is final and cannot be changed.
          </p>
          <div className="grid-2">
            <Field id={`rb-${id}`} label="Buyer receives" error={errs !== null && !errs.ok ? errs.buyerError : undefined} hint={symbol}>
              {(aria) => <input {...aria} inputMode="decimal" autoComplete="off" value={buyerText} onChange={(e) => setBuyerText(e.target.value)} onBlur={() => fillRemainder("buyer")} />}
            </Field>
            <Field id={`rs-${id}`} label="Supplier receives" error={errs !== null && !errs.ok ? errs.supplierError : undefined} hint={symbol}>
              {(aria) => <input {...aria} inputMode="decimal" autoComplete="off" value={supplierText} onChange={(e) => setSupplierText(e.target.value)} onBlur={() => fillRemainder("supplier")} />}
            </Field>
          </div>
          {errs !== null && !errs.ok && errs.sumError !== undefined && <p className="small err">{errs.sumError}</p>}
          {input.ok && (
            <p className="small muted num">
              Exact base units sent: buyer {input.buyer.toString()}, supplier {input.supplier.toString()} (sum {principal.toString()}).
            </p>
          )}
          <div className="actions">
            <button className="button" type="submit" disabled={busy}>
              Submit final ruling for line {id + 1}
            </button>
          </div>
        </form>
      )}
      {!ruling.canRule && ruling.reason !== null && <p className="small muted">{ruling.reason}</p>}

      {line.status === "DISPUTED" && line.dispute_phase === "FALLBACK" && (
        <div className="actions" style={{ marginTop: "var(--s2)" }}>
          <button className="button secondary" type="button" disabled={busy || !fb.canTrigger} onClick={onFallback}>
            Apply the agreed fallback split
          </button>
          <span className="small muted">Anyone may do this. The contract computes the amounts from the agreed terms; no amount is entered.</span>
        </div>
      )}
      {fb.reason !== null && line.dispute_phase === "FALLBACK" && <p className="small muted">{fb.reason}</p>}

      {submit.state === "busy" && <p className="small muted" aria-live="polite">{submit.step}</p>}
      {submit.state === "blocked" && (
        <Notice tone="negative">
          <p>{submit.message}</p>
        </Notice>
      )}
      {submit.state === "sent" && (
        <Notice>
          <p>
            <strong>{submit.what} to the wallet.</strong> This is not a result: the line shows only what the contract reports after a fresh read.
            Another decision may have been recorded first. {submit.txHash !== null ? <>Transaction <span className="mono">{submit.txHash}</span>.</> : null}
          </p>
          <p>
            <button className="button quiet" type="button" onClick={onRefresh}>
              Re-read the line
            </button>
          </p>
        </Notice>
      )}
    </div>
  );
}
