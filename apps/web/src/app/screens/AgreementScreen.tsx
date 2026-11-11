// S04 Agreement detail. Shows contract state only. Line actions offered so
// far: LF-007 mutual settlement (SettlementPanel) on DISPUTED / ALLOCATED
// lines and LF-008 dispute timeline, arbitrator ruling and fallback
// (ArbitrationPanel) on DISPUTED lines, and LF-009 withdrawals
// (WithdrawalPanel) on ALLOCATED lines; acceptance (AcceptancePanel) and the
// line lifecycle actions fund / deliver / review / advance (LineLifecycle),
// founder authorization 2026-11-05.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useApp } from "../context.tsx";
import { Amount, Notice, Status } from "../ui.tsx";
import { SettlementPanel } from "./SettlementPanel.tsx";
import { ArbitrationPanel } from "./ArbitrationPanel.tsx";
import { moneyRows } from "../../lib/contract/settlement.ts";
import { agreementSummaryLabel, lineStateLabel, u128 } from "../../lib/contract/states.ts";
import { WithdrawalPanel } from "./WithdrawalPanel.tsx";
import type { AgreementView } from "../../lib/contract/types.ts";
import { parseTermsJson, termsHashHex, validateTerms } from "../../lib/terms.ts";
import { termsInvalidTitle } from "../../lib/contract/errors.ts";
import { checkTerms, type TermsCheck } from "../../lib/contract/lifecycle.ts";
import { AcceptancePanel, LineLifecycle } from "./LifecycleActions.tsx";
import { formatBps, formatNsUtc } from "../../lib/format.ts";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "missing" }
  | {
      state: "ready";
      a: AgreementView;
      blockHeight: bigint;
      nowNs: bigint | null;
      /** Local re-encode == stored hash (existing panels: settlement, arbitration, withdrawals). */
      verified: boolean;
      /** Local == stored == compute_terms_hash (required before any new signature: acceptance, funding). */
      check: TermsCheck;
      /** Local validator verdict at chain time (only meaningful while PROPOSED). */
      validationIssue: string | null;
      decimals: number;
      symbol: string;
    };

export function AgreementScreen({ id }: { id: string }) {
  const { config, rpc, deployment } = useApp();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [reads, setReads] = useState(0);
  const refresh = useCallback(() => setReads((n) => n + 1), []);

  useEffect(() => {
    if (config.escrowId === "") return;
    let cancelled = false;
    (async () => {
      const r = await rpc.getAgreement(config.escrowId, id);
      if (r.value === null) {
        if (!cancelled) setLoad({ state: "missing" });
        return;
      }
      const a = r.value;
      // Re-encode the stored terms locally; the digest must equal the stored hash.
      const parsed = parseTermsJson(JSON.stringify(a.terms));
      const local = parsed.ok ? await termsHashHex("testnet", config.escrowId, parsed.terms) : null;
      const meta = await rpc.view<{ decimals: number; symbol: string }>(a.terms.ft_contract_id, "ft_metadata");
      // Chain time for advisory window checks (the contract re-checks with its own clock).
      const nowNs = await rpc.finalBlock().then((b) => b.timestampNs, () => null);
      // The contract's own digest of the stored terms (parse only; no validation).
      const contractHash = await rpc.computeTermsHash(config.escrowId, a.terms).then((h) => h.value, () => null);
      const check = checkTerms(local, a.terms_hash, contractHash);
      let validationIssue: string | null = null;
      if (a.status === "PROPOSED") {
        if (!parsed.ok) validationIssue = "the stored terms could not be parsed";
        else if (deployment === null || nowNs === null) validationIssue = "the validation context (escrow configuration, chain time) is not available";
        else {
          const e = validateTerms(parsed.terms, {
            now_ns: nowNs,
            escrow_id: config.escrowId,
            allowlisted_ft_id: deployment.escrowConfig.allowlisted_ft_id,
            operator_treasury_id: deployment.escrowConfig.operator_treasury_id,
          });
          validationIssue = e === null ? null : termsInvalidTitle(e.code);
        }
      }
      if (!cancelled) {
        setLoad({
          state: "ready",
          a,
          blockHeight: r.blockHeight,
          nowNs,
          verified: local !== null && local === a.terms_hash,
          check,
          validationIssue,
          decimals: meta.value.decimals,
          symbol: meta.value.symbol,
        });
      }
    })().catch((e: unknown) => {
      if (!cancelled) setLoad({ state: "error", message: (e as Error).message });
    });
    return () => {
      cancelled = true;
    };
  }, [config.escrowId, id, rpc, reads, deployment]);

  if (config.escrowId === "") {
    return (
      <div className="panel empty">
        <h1>Agreement #{id}</h1>
        <p className="muted">No escrow contract is configured, so there is nothing to read.</p>
        <p>
          <a href="#/">Back to agreements</a>
        </p>
      </div>
    );
  }
  if (load.state === "loading") return <div className="panel" aria-busy="true"><p className="muted">Reading agreement #{id}…</p></div>;
  if (load.state === "missing") return <div className="panel empty"><h1>Agreement #{id} not found</h1><p><a href="#/">Back to agreements</a></p></div>;
  if (load.state === "error") {
    return (
      <Notice tone="negative">
        <p><strong>Could not read agreement #{id}.</strong> {load.message}</p>
      </Notice>
    );
  }

  const { a, decimals, symbol } = load;
  const st = agreementSummaryLabel(a);
  return (
    <>
      <div className="page-head">
        <div className="actions">
          <h1>Agreement #{a.agreement_id}</h1>
          <Status state={st} />
          {a.accelerated_test_timing && <Status state={{ label: "Accelerated timing — test only", tone: "warning" }} />}
        </div>
        {st.detail !== undefined && <p className="lede">{st.detail}</p>}
        <div className="actions">
          <p className="small muted num">Read at block {load.blockHeight.toString()}</p>
          <button className="button quiet" type="button" onClick={refresh}>Re-read</button>
        </div>
      </div>

      {!load.verified && (
        <Notice tone="negative">
          <p><strong>Terms could not be verified. Do not sign.</strong> The terms re-encoded in this browser do not match the stored hash.</p>
        </Notice>
      )}

      <AcceptancePanel a={a} check={load.check} validationIssue={load.validationIssue} nowNs={load.nowNs} onRefresh={refresh} />

      {a.lines.map((l) => {
        const t = a.terms.lines[l.line_id];
        const principal = u128(t.principal);
        const s = lineStateLabel(l, { principal });
        const showSlots = l.status === "ALLOCATED";
        const rows = moneyRows(l);
        const settle = l.status === "DISPUTED" || l.status === "ALLOCATED";
        return (
          <section className="panel" key={l.line_id} aria-labelledby={`line-${l.line_id}`}>
            <div className="panel-head">
              <h2 id={`line-${l.line_id}`}>Line {l.line_id + 1}</h2>
              <Status state={s} />
            </div>
            {s.detail !== undefined && <p className="small" style={{ marginBottom: "var(--s2)" }}>{s.detail}</p>}
            <dl className="kv">
              <dt>Amount</dt><dd><Amount base={principal} decimals={decimals} symbol={symbol} /></dd>
              {rows.length === 0 && (<><dt>Held</dt><dd className="muted">Nothing held for this line</dd></>)}
              {rows.map((r) => (
                <MoneyRowItem key={`${r.key}-${r.party ?? ""}`} label={r.label} incident={r.key === "incident"}>
                  <Amount base={r.amount} decimals={decimals} symbol={symbol} />
                </MoneyRowItem>
              ))}
              <dt>Delivery deadline</dt><dd className="num">{formatNsUtc(u128(t.delivery_deadline_ns))}</dd>
              <dt>Fallback split</dt><dd>Supplier {formatBps(t.fallback_supplier_bps)}, buyer {formatBps(t.fallback_buyer_bps)}</dd>
              {l.status === "DISPUTED" && (<><dt>Dispute T0</dt><dd className="num">{formatNsUtc(u128(l.dispute_t0_ns))}</dd></>)}
              {l.no_response_t0_ns !== null && (<><dt>Dispute T0</dt><dd className="num">{formatNsUtc(u128(l.no_response_t0_ns))} (review deadline)</dd></>)}
              {l.non_delivery_t0_ns !== null && (<><dt>Dispute T0</dt><dd className="num">{formatNsUtc(u128(l.non_delivery_t0_ns))} (delivery cutoff)</dd></>)}
            </dl>
            <LineLifecycle a={a} line={l} principal={principal} decimals={decimals} symbol={symbol} check={load.check} nowNs={load.nowNs} onRefresh={refresh} />
            {showSlots && load.verified && (
              <WithdrawalPanel a={a} line={l} decimals={decimals} symbol={symbol} onRefresh={refresh} />
            )}
            {showSlots && !load.verified && (
              <p className="small muted">Withdrawals are hidden because the terms could not be verified.</p>
            )}
            {l.status === "DISPUTED" && load.verified && (
              <ArbitrationPanel a={a} line={l} principal={principal} decimals={decimals} symbol={symbol} onRefresh={refresh} />
            )}
            {settle && load.verified && (
              <SettlementPanel a={a} line={l} principal={principal} decimals={decimals} symbol={symbol} nowNs={load.nowNs} onRefresh={refresh} />
            )}
          </section>
        );
      })}
    </>
  );
}

function MoneyRowItem({ label, incident, children }: { label: string; incident: boolean; children: ReactNode }) {
  return (
    <>
      <dt className={incident ? "err" : undefined}>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
