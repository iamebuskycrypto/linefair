// Wallet return banner (lib/near/walletReturn.ts). Reads `transactionHashes`
// or `errorCode` / `errorMessage` from the address once, removes them from
// the address bar (history.replaceState, #route kept), shows the transaction
// hash with an explorer link as "reported by the wallet", and then re-reads
// the contract: only that read is shown as the outcome.

import { useEffect, useState } from "react";
import { useApp } from "./context.tsx";
import { Notice } from "./ui.tsx";
import { explorerTxUrl } from "../lib/config.ts";
import { clearPending, loadPending, parseWalletReturn, stripWalletParams, walletErrorText, type PendingAction, type WalletReturn as Ret } from "../lib/near/walletReturn.ts";
import { acceptVerdict, fundingOutcome, lineActionVerdict, parseFundingOutcome, type FundingOutcome, type ReReadVerdict } from "../lib/contract/lifecycle.ts";
import { lineStateLabel, u128 } from "../lib/contract/states.ts";
import type { Role } from "../lib/contract/settlement.ts";
import { FundingOutcomeCard } from "./screens/LifecycleActions.tsx";

type Reread =
  | { state: "none" }
  | { state: "reading" }
  | { state: "failed"; message: string }
  | { state: "done"; blockHeight: bigint; verdict: ReReadVerdict | null; funding: FundingOutcome | null; lineLabel: string | null; principal: bigint };

const ROLE_OF_KIND: Record<string, (p: PendingAction, terms: { buyer_id: string; supplier_id: string; primary_arbitrator_id: string; backup_arbitrator_id: string }) => Role | null> = {
  accept_terms: (p, t) => (p.signerId === t.buyer_id ? "buyer" : p.signerId === t.supplier_id ? "supplier" : null),
  accept_appointment: (p, t) => (p.signerId === t.primary_arbitrator_id ? "primary_arbitrator" : p.signerId === t.backup_arbitrator_id ? "backup_arbitrator" : null),
};

export function WalletReturnBanner() {
  const { config, rpc, wallet } = useApp();
  const [ret] = useState<Ret>(() => parseWalletReturn(window.location.search));
  const [pending] = useState<PendingAction | null>(() => (ret.kind === "none" ? null : loadPending()));
  const [reread, setReread] = useState<Reread>({ state: "none" });
  const [urlAfter, setUrlAfter] = useState<string | null>(null);

  useEffect(() => {
    if (ret.kind === "none") return;
    const clean = stripWalletParams(window.location.href);
    window.history.replaceState(window.history.state, "", clean);
    setUrlAfter(clean);
  }, [ret.kind]);

  useEffect(() => {
    if (ret.kind === "none" || pending === null || config.escrowId === "") return;
    let cancelled = false;
    setReread({ state: "reading" });
    (async () => {
      let report = null;
      const hash = ret.kind === "success" ? ret.txHashes[0] : undefined;
      if (pending.kind === "fund" && hash !== undefined) {
        try {
          report = parseFundingOutcome(await rpc.txStatus(hash, pending.signerId));
        } catch {
          report = null;
        }
      }
      const r = await rpc.getAgreement(config.escrowId, pending.agreementId);
      if (r.value === null) throw new Error(`agreement ${pending.agreementId} not found`);
      const a = r.value;
      let verdict: ReReadVerdict | null = null;
      let funding: FundingOutcome | null = null;
      let lineLabel: string | null = null;
      let principal = 0n;
      if (pending.lineId !== null) {
        const l = a.lines[pending.lineId];
        const t = a.terms.lines[pending.lineId];
        if (l === undefined || t === undefined) throw new Error(`line ${pending.lineId} not found`);
        principal = u128(t.principal);
        lineLabel = lineStateLabel(l, { principal }).label;
        if (pending.kind === "fund") funding = fundingOutcome(l, principal, report);
        else if (pending.kind !== "accept_terms" && pending.kind !== "accept_appointment") {
          verdict = lineActionVerdict(pending.kind, l, pending.evidenceCommitment !== undefined ? { evidenceCommitment: pending.evidenceCommitment } : undefined);
        }
      } else {
        const role = ROLE_OF_KIND[pending.kind]?.(pending, a.terms) ?? null;
        if (role !== null) verdict = acceptVerdict(a, role);
      }
      if (!cancelled) setReread({ state: "done", blockHeight: r.blockHeight, verdict, funding, lineLabel, principal });
      clearPending();
    })().catch((e: unknown) => {
      if (!cancelled) setReread({ state: "failed", message: (e as Error).message });
    });
    return () => {
      cancelled = true;
    };
  }, [ret, pending, rpc, config.escrowId]);

  if (ret.kind === "none") return null;
  const what = pending === null ? null : `${pending.kind.replace(/_/g, " ")} on agreement #${pending.agreementId}${pending.lineId !== null ? `, line ${pending.lineId + 1}` : ""}`;
  return (
    <div data-wallet-return={ret.kind} data-url-after={urlAfter ?? ""}>
      <Notice tone={ret.kind === "error" ? "warning" : "info"}>
        {ret.kind === "success" ? (
          <p>
            <strong>The wallet returned a transaction.</strong> Reported by the wallet, not a result:{" "}
            {ret.txHashes.map((h) => (
              <a key={h} className="mono" href={explorerTxUrl(config, h)} target="_blank" rel="noreferrer" data-tx={h}>
                {h}
              </a>
            ))}{" "}
            (testnet explorer).
          </p>
        ) : (
          <p data-wallet-error={ret.errorCode}>
            <strong>{walletErrorText(ret.errorCode)}</strong>
            {ret.errorMessage !== null ? <span className="small muted"> Wallet message: “{ret.errorMessage}”.</span> : null} The contract record below decides what happened.
          </p>
        )}
        {what !== null && <p className="small">Action started from this browser: {what}{wallet.accountId !== null && wallet.accountId !== pending?.signerId ? ` (signed as ${pending?.signerId})` : ""}.</p>}
        {pending === null && <p className="small">This browser has no record of which action was signed. Open the agreement to read its current state from the contract.</p>}
        {reread.state === "reading" && <p className="small muted" aria-live="polite">Re-reading the contract…</p>}
        {reread.state === "failed" && <p className="small err">The contract could not be re-read ({reread.message}). Nothing is shown as done.</p>}
        {reread.state === "done" && (
          <div data-reread="done">
            <p className="small muted">Contract read at block {reread.blockHeight.toString()}:</p>
            {reread.lineLabel !== null && <p data-line-state>Line state (contract): {reread.lineLabel}</p>}
            {reread.funding !== null && <FundingOutcomeCard outcome={reread.funding} decimals={0} symbol="base units" principal={reread.principal} />}
            {reread.verdict !== null && <p data-verdict={reread.verdict.confirmed ? "confirmed" : "unconfirmed"}>{reread.verdict.text}</p>}
            {pending !== null && (
              <p className="small">
                <a href={`#/agreements/${pending.agreementId}`}>Open agreement #{pending.agreementId}</a>
              </p>
            )}
          </div>
        )}
      </Notice>
    </div>
  );
}
