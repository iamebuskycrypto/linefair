// S08 mutual settlement (LF-007) for one DISPUTED / ALLOCATED line.
// The contract is the authority: buttons are offered by role and state as a
// convenience, every outcome is judged by re-reading get_agreement, and any
// rejection is mapped through errors.ts. Wallet signing uses the existing
// testnet wallet-selector code, which has NOT been exercised against a
// deployed contract (wallet.ts STATUS).

import { useState } from "react";
import { useApp } from "../context.tsx";
import { Amount, Field, Notice, Status } from "../ui.tsx";
import { describeError } from "../../lib/contract/errors.ts";
import {
  allocationState,
  parseSplitInput,
  proposalState,
  recheckBeforeAccept,
  roleOf,
  splitAvailability,
  type Proposal,
} from "../../lib/contract/settlement.ts";
import type { AgreementView, LineView } from "../../lib/contract/types.ts";
import { acceptSplitCall, proposeSplitCall } from "../../lib/near/tx.ts";
import { sign } from "../sign.ts";
import { formatNsUtc, formatUnits, parseUnits } from "../../lib/format.ts";

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
  /** Latest final block timestamp (chain time), or null if unknown. */
  readonly nowNs: bigint | null;
  /** Re-read the agreement from the contract. */
  readonly onRefresh: () => void;
}

export function SettlementPanel({ a, line, principal, decimals, symbol, nowNs, onRefresh }: Props) {
  const { config, rpc, wallet } = useApp();
  const role = roleOf(a.terms, wallet.accountId);
  const proposal = proposalState(line, principal);
  const allocation = allocationState(line, principal);
  const avail = splitAvailability(line, principal, role, nowNs);
  const [buyerText, setBuyerText] = useState("");
  const [supplierText, setSupplierText] = useState("");
  const [touched, setTouched] = useState(false);
  const [submit, setSubmit] = useState<Submit>({ state: "idle" });
  const busy = submit.state === "busy";

  const input = parseSplitInput(buyerText, supplierText, principal, decimals);
  const errs = touched && !input.ok ? input : null;
  const lineNo = line.line_id + 1;

  /** Convenience: when one leg is valid and the other is empty, fill the other with the exact remainder. */
  function fillRemainder(from: "buyer" | "supplier") {
    const other = from === "buyer" ? supplierText : buyerText;
    if (other.trim() !== "") return;
    const leg = parseUnits(from === "buyer" ? buyerText : supplierText, decimals);
    if (!leg.ok || leg.value > principal) return;
    const rest = formatUnits(principal - leg.value, decimals).replace(/,/g, "");
    if (from === "buyer") setSupplierText(rest);
    else setBuyerText(rest);
  }

  async function onPropose() {
    setTouched(true);
    if (!input.ok || wallet.accountId === null || !avail.canPropose) return;
    try {
      const call = proposeSplitCall(config.escrowId, a.agreement_id, line.line_id, input.buyer, input.supplier, principal);
      setSubmit({ state: "busy", step: "Waiting for confirmation in your wallet…" });
      const txHash = await sign(wallet.accountId, call);
      setSubmit({ state: "sent", what: "Proposal sent", txHash });
      onRefresh();
    } catch (e) {
      const d = describeError((e as Error).message);
      setSubmit({ state: "blocked", message: `${d.title} ${d.action}` });
    }
  }

  async function onAccept(reviewed: Proposal) {
    if (wallet.accountId === null) return;
    try {
      // Re-read the line right before signing: sign only the exact id and
      // amounts the contract holds now, and only if the user reviewed them.
      setSubmit({ state: "busy", step: "Re-reading the open proposal from the contract…" });
      const fresh = await rpc.getAgreement(config.escrowId, a.agreement_id);
      const freshLine = fresh.value?.lines[line.line_id];
      if (freshLine === undefined) {
        setSubmit({ state: "blocked", message: "The line could not be re-read. Nothing was signed." });
        return;
      }
      const check = recheckBeforeAccept(freshLine, principal, reviewed, role);
      if (!check.ok) {
        setSubmit({ state: "blocked", message: check.message });
        onRefresh();
        return;
      }
      const p = check.proposal;
      const call = acceptSplitCall(config.escrowId, a.agreement_id, line.line_id, p.id, p.buyerAmount, p.supplierAmount);
      setSubmit({ state: "busy", step: `Waiting for confirmation in your wallet (proposal #${p.id}, read at block ${fresh.blockHeight.toString()})…` });
      const txHash = await sign(wallet.accountId, call);
      setSubmit({ state: "sent", what: `Acceptance of proposal #${p.id} sent`, txHash });
      onRefresh();
    } catch (e) {
      const d = describeError((e as Error).message);
      setSubmit({ state: "blocked", message: `${d.title} ${d.action}` });
    }
  }

  const amt = (s: string) => <Amount base={BigInt(s)} decimals={decimals} symbol={symbol} />;
  const p = proposal.proposal;

  return (
    <div className="settlement" aria-labelledby={`settle-${line.line_id}`}>
      <h3 id={`settle-${line.line_id}`}>Settlement</h3>

      {line.status === "ALLOCATED" && (
        <p className="small">
          <Status state={allocation} /> {allocation.detail}
        </p>
      )}

      <div className="small">
        <Status state={proposal} /> {proposal.detail}
      </div>
      {p !== undefined && (
        <dl className="kv" style={{ marginTop: "var(--s1)" }}>
          <dt>{proposal.key === "accepted" ? "Buyer receives" : "Buyer would receive"}</dt>
          <dd>{amt(p.buyerAmount)}</dd>
          <dt>{proposal.key === "accepted" ? "Supplier receives" : "Supplier would receive"}</dt>
          <dd>{amt(p.supplierAmount)}</dd>
          <dt>Proposed by</dt>
          <dd>{p.proposer === "buyer" ? "Buyer" : "Supplier"}</dd>
          <dt>Proposed at</dt>
          <dd className="num">{formatNsUtc(p.createdAtNs)}</dd>
        </dl>
      )}

      {avail.canAccept && p !== undefined && (
        <div className="actions" style={{ marginTop: "var(--s2)" }}>
          <button className="button" type="button" disabled={busy} onClick={() => void onAccept(p)}>
            Accept proposal #{p.id}
          </button>
          <span className="small muted">
            Final: the line is allocated exactly as shown and cannot be changed. Nothing is paid until each party withdraws.
          </span>
        </div>
      )}

      {avail.canPropose && (
        <form
          className="split-form"
          onSubmit={(e) => {
            e.preventDefault();
            void onPropose();
          }}
          noValidate
        >
          <p className="small muted">
            {p !== undefined && proposal.key === "open" ? "A new proposal replaces the open one. " : ""}
            Split the line amount of <Amount base={principal} decimals={decimals} symbol={symbol} /> between buyer and supplier.
            The two amounts must add up exactly; nothing is rounded.
          </p>
          <div className="grid-2">
            <Field id={`b-${line.line_id}`} label="Buyer receives" error={errs !== null && !errs.ok ? errs.buyerError : undefined} hint={symbol}>
              {(aria) => (
                <input {...aria} inputMode="decimal" autoComplete="off" value={buyerText} onChange={(e) => setBuyerText(e.target.value)} onBlur={() => fillRemainder("buyer")} />
              )}
            </Field>
            <Field id={`s-${line.line_id}`} label="Supplier receives" error={errs !== null && !errs.ok ? errs.supplierError : undefined} hint={symbol}>
              {(aria) => (
                <input {...aria} inputMode="decimal" autoComplete="off" value={supplierText} onChange={(e) => setSupplierText(e.target.value)} onBlur={() => fillRemainder("supplier")} />
              )}
            </Field>
          </div>
          {errs !== null && !errs.ok && errs.sumError !== undefined && <p className="small err">{errs.sumError}</p>}
          {input.ok && (
            <p className="small muted num">
              Exact base units sent: buyer {input.buyer.toString()}, supplier {input.supplier.toString()} (sum {principal.toString()}).
            </p>
          )}
          <div className="actions" style={{ marginTop: "var(--s1)" }}>
            <button className="button secondary" type="submit" disabled={busy}>
              Propose split for line {lineNo}
            </button>
          </div>
        </form>
      )}

      {!avail.canPropose && !avail.canAccept && avail.reason !== undefined && line.status === "DISPUTED" && <p className="small muted">{avail.reason}</p>}
      {avail.canPropose && !avail.canAccept && avail.reason !== undefined && <p className="small muted">{avail.reason}</p>}

      {submit.state === "busy" && <p className="small muted" aria-live="polite">{submit.step}</p>}
      {submit.state === "blocked" && (
        <Notice tone="negative">
          <p>{submit.message}</p>
        </Notice>
      )}
      {submit.state === "sent" && (
        <Notice>
          <p>
            <strong>{submit.what} to the wallet.</strong> This is not a result: the line above shows only what the contract reports after
            a fresh read. {submit.txHash !== null ? <>Transaction <span className="mono">{submit.txHash}</span>.</> : null}
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
