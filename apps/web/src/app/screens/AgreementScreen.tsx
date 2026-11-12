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
import { allocationState, moneyRows } from "../../lib/contract/settlement.ts";
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
  // Overview figures come only from contract fields (terms principals and line ledgers via moneyRows).
  // A paid amount counts as confirmed only when its withdrawal slot is PAID (moneyRows key "paid");
  // a paid amount without a PAID slot is an incident and is never counted as paid out.
  const items = a.lines.map((l) => {
    const t = a.terms.lines[l.line_id];
    const principal = u128(t.principal);
    return { l, t, principal, s: lineStateLabel(l, { principal }), rows: moneyRows(l) };
  });
  let total = 0n, paid = 0n, held = 0n, incident = 0n, paidBuyer = 0n, paidSupplier = 0n;
  for (const it of items) {
    total += it.principal;
    for (const r of it.rows) {
      if (r.key === "paid") {
        paid += r.amount;
        if (r.party === "buyer") paidBuyer += r.amount;
        else paidSupplier += r.amount;
      } else if (r.key === "incident") incident += r.amount;
      else held += r.amount; // locked, claimable or withdrawal processing: still held by the contract
    }
  }
  const settledCount = items.filter((it) => it.l.status === "ALLOCATED" && it.rows.length > 0 && it.rows.every((r) => r.key === "paid")).length;
  const acceptanceFirst = a.status === "PROPOSED";
  const acceptance = <AcceptancePanel a={a} check={load.check} validationIssue={load.validationIssue} nowNs={load.nowNs} onRefresh={refresh} />;
  return (
    <>
      <a className="back-link" href="#/">← Back to home</a>
      <section className="overview" aria-labelledby="agreement-title">
        <div className="overview-top">
          <span className="eyebrow">On-chain record · {items.length} {items.length === 1 ? "deliverable" : "deliverables"}</span>
          <div className="overview-title">
            <h1 id="agreement-title">Agreement #{a.agreement_id}</h1>
            <Status state={st} />
            {a.accelerated_test_timing && <Status state={{ label: "Accelerated timing — test only", tone: "warning" }} />}
          </div>
          {st.detail !== undefined && <p className="lede">{st.detail}</p>}
          <div className="overview-meta">
            <span className="small muted">Live NEAR Testnet data</span>
            <button className="button quiet" type="button" onClick={refresh}>Refresh status</button>
            <details className="overview-block-info">
              <summary>Block details</summary>
              <span className="num">Read at block {load.blockHeight.toString()}</span>
            </details>
          </div>
        </div>
        <dl className="metrics">
          <div className="metric">
            <dt>Total agreed</dt>
            <dd><Amount base={total} decimals={decimals} symbol={symbol} /></dd>
            <span className="sub">across {items.length} independent {items.length === 1 ? "line" : "lines"}</span>
          </div>
          <div className="metric">
            <dt>Payments completed</dt>
            <dd><Amount base={paid} decimals={decimals} symbol={symbol} /></dd>
            <span className="sub">confirmed by the contract</span>
          </div>
          <div className="metric">
            <dt>Not yet paid</dt>
            <dd><Amount base={held} decimals={decimals} symbol={symbol} /></dd>
            <span className="sub">locked, claimable or processing</span>
          </div>
          <div className="metric">
            <dt>Deliverables completed</dt>
            <dd className="num">{settledCount}<span className="unit">of {items.length}</span></dd>
            <span className="sub">fully settled and paid</span>
          </div>
        </dl>
        <div className="progress-block">
          <div className="progress-head">
            <h2>Progress by deliverable</h2>
            {paid > 0n && (
              <p className="parties-paid">
                <span>Supplier received <strong><Amount base={paidSupplier} decimals={decimals} symbol={symbol} /></strong></span>
                <span>Buyer received <strong><Amount base={paidBuyer} decimals={decimals} symbol={symbol} /></strong></span>
              </p>
            )}
          </div>
          <div className="segments" role="img" aria-label={items.map((it) => `Line ${it.l.line_id + 1}: ${it.s.label}`).join("; ")}>
            {items.map((it) => (
              <span key={it.l.line_id} className={`segment tone-${it.s.tone}`} style={{ flexGrow: Number(it.principal > 0n ? it.principal : 1n) }} />
            ))}
          </div>
          <ul className="legend">
            {items.map((it) => (
              <li key={it.l.line_id}>
                <span className={`swatch segment tone-${it.s.tone}`} aria-hidden="true" />
                <strong>Line {it.l.line_id + 1}</strong> {it.s.label}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {!load.verified && (
        <Notice tone="negative">
          <p><strong>Terms could not be verified. Do not sign.</strong> The terms re-encoded in this browser do not match the stored hash.</p>
        </Notice>
      )}
      {incident > 0n && (
        <Notice tone="negative">
          <p><strong>Incident:</strong> a paid amount of <Amount base={incident} decimals={decimals} symbol={symbol} /> has no confirmed PAID withdrawal record. It is not counted as paid out.</p>
        </Notice>
      )}

      {acceptanceFirst && acceptance}

      <div className="agreement-guide" role="note">
        <div>
          <strong>How to read this agreement</strong>
          <p>Each deliverable can have a different outcome. Payment is only marked complete after the contract confirms the transfer.</p>
        </div>
        <button className="button secondary" type="button" onClick={() => document.getElementById("agreement-deliverables")?.scrollIntoView({ behavior: "smooth", block: "start" })}>View deliverables ↓</button>
      </div>

      <div className="section-head" id="agreement-deliverables">
        <h2>Deliverables, one by one</h2>
        <span className="small muted">Choose a line to understand its status and the available next steps.</span>
      </div>

      {items.map(({ l, t, principal, s, rows }) => {
        const showSlots = l.status === "ALLOCATED";
        const settle = l.status === "DISPUTED" || l.status === "ALLOCATED";
        return (
          <section className="panel deliverable" key={l.line_id} aria-labelledby={`line-${l.line_id}`}>
            <div className="deliverable-head">
              <div className="titles">
                <div className="actions">
                  <h2 id={`line-${l.line_id}`}>Deliverable {l.line_id + 1}</h2>
                  <Status state={s} />
                </div>
                {s.detail !== undefined && <p className="small muted">{s.detail}</p>}
              </div>
              <div className="deliverable-amount">
                <span className="label">Agreed amount</span>
                <span className="value"><Amount base={principal} decimals={decimals} symbol={symbol} /></span>
              </div>
            </div>
            <div className="line-status-explanation">
              <span className="eyebrow">What this means</span>
              <p>{s.tone === "negative"
                ? s.detail ?? "This record needs attention. Do not initiate payments."
                : l.status === "UNFUNDED"
                  ? "No test tokens are secured for this deliverable yet. The client must fund it before payment is protected."
                  : l.status === "FUNDED"
                    ? "Test tokens are held in escrow. The service provider can submit the work before the agreed deadline."
                    : l.status === "SUBMITTED"
                      ? "The work was submitted. The client can accept it or begin a dispute during the review period."
                      : l.status === "DISPUTED"
                        ? "This deliverable is disputed. Only its funds are subject to the agreed resolution process."
                        : l.status === "ALLOCATED" && s.key === "paid_out"
                          ? "Completed: the contract has confirmed payment of every allocated share."
                          : l.status === "ALLOCATED"
                            ? "A decision was recorded. Allocated funds are not considered paid until each withdrawal is confirmed."
                            : "See the contract-reported status before taking any action."}</p>
            </div>
            <div className="deliverable-body">
              {l.status === "ALLOCATED" && <OutcomeBand line={l} principal={principal} decimals={decimals} symbol={symbol} />}
              <dl className="kv facts">
                {rows.length === 0 && (<div><dt>Held</dt><dd className="muted">Nothing held for this line</dd></div>)}
                {rows
                  .filter((r) => !(r.key === "paid" && showSlots && load.verified))
                  .map((r) => (
                    <MoneyRowItem key={`${r.key}-${r.party ?? ""}`} label={r.label} incident={r.key === "incident"}>
                      <Amount base={r.amount} decimals={decimals} symbol={symbol} />
                    </MoneyRowItem>
                  ))}
                <div><dt>Delivery deadline</dt><dd className="num">{formatNsUtc(u128(t.delivery_deadline_ns))}</dd></div>
                <div><dt>Fallback split</dt><dd>Supplier {formatBps(t.fallback_supplier_bps)}, buyer {formatBps(t.fallback_buyer_bps)}</dd></div>
                {l.status === "DISPUTED" && (<div><dt>Dispute T0</dt><dd className="num">{formatNsUtc(u128(l.dispute_t0_ns))}</dd></div>)}
                {l.no_response_t0_ns !== null && (<div><dt>Dispute T0</dt><dd className="num">{formatNsUtc(u128(l.no_response_t0_ns))} (review deadline)</dd></div>)}
                {l.non_delivery_t0_ns !== null && (<div><dt>Dispute T0</dt><dd className="num">{formatNsUtc(u128(l.non_delivery_t0_ns))} (delivery cutoff)</dd></div>)}
              </dl>
              <LineLifecycle a={a} line={l} principal={principal} decimals={decimals} symbol={symbol} check={load.check} nowNs={load.nowNs} onRefresh={refresh} />
              {showSlots && load.verified && s.key === "paid_out" ? (
                <details className="tech line-payment-history">
                  <summary>View confirmed payment records</summary>
                  <div className="tech-body">
                    <WithdrawalPanel a={a} line={l} decimals={decimals} symbol={symbol} onRefresh={refresh} />
                  </div>
                </details>
              ) : showSlots && load.verified ? (
                <WithdrawalPanel a={a} line={l} decimals={decimals} symbol={symbol} onRefresh={refresh} />
              ) : null}
              {showSlots && !load.verified && (
                <p className="small muted">Withdrawals are hidden because the terms could not be verified.</p>
              )}
              {l.status === "DISPUTED" && load.verified && (
                <ArbitrationPanel a={a} line={l} principal={principal} decimals={decimals} symbol={symbol} onRefresh={refresh} />
              )}
              {settle && load.verified && l.status === "ALLOCATED" && (
                <details className="tech">
                  <summary>Settlement record</summary>
                  <div className="tech-body">
                    <SettlementPanel a={a} line={l} principal={principal} decimals={decimals} symbol={symbol} nowNs={load.nowNs} onRefresh={refresh} />
                  </div>
                </details>
              )}
              {settle && load.verified && l.status !== "ALLOCATED" && (
                <SettlementPanel a={a} line={l} principal={principal} decimals={decimals} symbol={symbol} nowNs={load.nowNs} onRefresh={refresh} />
              )}
            </div>
          </section>
        );
      })}

      {!acceptanceFirst && (
        <>
          <div className="section-head">
            <h2>Parties</h2>
            <span className="small muted">Four distinct accounts accepted the identical terms.</span>
          </div>
          {acceptance}
        </>
      )}

      <details className="tech page-tech">
        <summary>Technical details and verification</summary>
        <div className="tech-body">
          <dl className="kv">
            <dt>Escrow contract</dt><dd className="mono">{config.escrowId}</dd>
            <dt>Token contract</dt><dd className="mono">{a.terms.ft_contract_id}</dd>
            <dt>Token</dt><dd>{symbol} · {decimals} decimals</dd>
            <dt>Terms hash</dt><dd className="mono">{a.terms_hash}</dd>
            <dt>Read at block</dt><dd className="num">{load.blockHeight.toString()}</dd>
          </dl>
        </div>
      </details>
    </>
  );
}

/** Who received what on an ALLOCATED line, from the contract's own allocation (allocationState checks conservation). */
function OutcomeBand({ line, principal, decimals, symbol }: { line: AgreementView["lines"][number]; principal: bigint; decimals: number; symbol: string }) {
  const alloc = allocationState(line, principal);
  const buyer = u128(line.allocation_buyer_amount);
  const supplier = u128(line.allocation_supplier_amount);
  const consistent = alloc.tone !== "negative" && principal > 0n && buyer + supplier === principal;
  const pct = (x: bigint) => (principal > 0n ? Number((x * 10000n) / principal) / 100 : 0);
  return (
    <div className="outcome" data-outcome={line.allocation_mode}>
      <div className="outcome-head">
        <p className="route">Outcome <span>· how this line was decided</span></p>
        <Status state={alloc} />
      </div>
      {consistent && (
        <>
          <div className="splitbar" role="img" aria-label={`Supplier ${pct(supplier)}%, buyer ${pct(buyer)}%`}>
            {supplier > 0n && <span className="s" style={{ flexGrow: pct(supplier) }} />}
            {buyer > 0n && <span className="b" style={{ flexGrow: pct(buyer) }} />}
          </div>
          <div className="split-legend">
            <span><i style={{ background: "var(--forest-2)" }} aria-hidden="true" />Supplier <strong><Amount base={supplier} decimals={decimals} symbol={symbol} /></strong></span>
            <span><i style={{ background: "var(--accent)" }} aria-hidden="true" />Buyer <strong><Amount base={buyer} decimals={decimals} symbol={symbol} /></strong></span>
          </div>
        </>
      )}
    </div>
  );
}

function MoneyRowItem({ label, incident, children }: { label: string; incident: boolean; children: ReactNode }) {
  return (
    <div>
      <dt className={incident ? "err" : undefined}>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
