// S01 Agreement list. Reads contract views only; no list view exists, so ids
// 0..agreements_created are read one by one (<= 25, MAX_AGREEMENTS_LIMIT).

import { useEffect, useState } from "react";
import { useApp } from "../context.tsx";
import { Notice, Status } from "../ui.tsx";
import { agreementSummaryLabel, u128 } from "../../lib/contract/states.ts";
import type { AgreementView } from "../../lib/contract/types.ts";
import { formatNsUtc } from "../../lib/format.ts";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; items: AgreementView[]; blockHeight: bigint };

const MAX_LIST = 25;

export function AgreementsScreen() {
  const { config, rpc, wallet } = useApp();
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    if (config.escrowId === "") return;
    let cancelled = false;
    (async () => {
      const cfg = await rpc.getConfig(config.escrowId);
      if (cfg.value.network_id !== "testnet") throw new Error(`Escrow reports network "${cfg.value.network_id}", expected testnet.`);
      const n = u128(cfg.value.agreements_created);
      const count = Number(n < BigInt(MAX_LIST) ? n : BigInt(MAX_LIST));
      const items: AgreementView[] = [];
      for (let i = 0; i < count; i++) {
        const a = await rpc.getAgreement(config.escrowId, String(i));
        if (a.value !== null) items.push(a.value);
      }
      if (!cancelled) setLoad({ state: "ready", items, blockHeight: cfg.blockHeight });
    })().catch((e: unknown) => {
      if (!cancelled) setLoad({ state: "error", message: (e as Error).message });
    });
    return () => {
      cancelled = true;
    };
  }, [config.escrowId, rpc]);

  const me = wallet.accountId;
  const roleOf = (a: AgreementView): string | null => {
    if (me === null) return null;
    const t = a.terms;
    if (t.buyer_id === me) return "Buyer";
    if (t.supplier_id === me) return "Supplier";
    if (t.primary_arbitrator_id === me) return "Primary arbitrator";
    if (t.backup_arbitrator_id === me) return "Backup arbitrator";
    return null;
  };

  return (
    <>
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero-copy">
          <span className="home-kicker"><span className="home-kicker-dot" aria-hidden="true" /> A fairer way to work together</span>
          <h1 id="home-title">One disagreement shouldn't <em>freeze every payment.</em></h1>
          <p className="home-hero-lede">
            One project can have different outcomes. LineFair lets clients and service providers agree on
            individually priced deliverables—so accepted work can be paid while disputed work follows its own resolution path.
          </p>
          <div className="home-hero-actions">
            <a className="button home-primary-cta" href="#/agreements/0">See a real settled agreement <span aria-hidden="true">↗</span></a>
            <a className="home-text-link" href="#how-linefair-works">How it works <span aria-hidden="true">↓</span></a>
          </div>
          <p className="home-hero-disclaimer">Live NEAR Testnet demo · valueless test tokens · experimental, not independently audited. Creating new agreements is currently restricted.</p>
        </div>
        <div className="home-proof" aria-label="Three real outcomes from testnet agreement zero">
          <div className="home-proof-head">
            <span className="home-proof-mark">LF<span aria-hidden="true">/</span>00</span>
            <span className="home-proof-badge"><span aria-hidden="true">●</span> NEAR TESTNET</span>
          </div>
          <div className="home-proof-intro">
            <span className="home-proof-caption">AGREEMENT #0 · VERIFIED ON-CHAIN</span>
            <p>One agreement.<br /><strong>Three outcomes.</strong></p>
          </div>
          <ol className="home-proof-lines">
            <li>
              <span className="home-proof-number">01</span>
              <span className="home-proof-line-main"><strong>Accepted &amp; paid</strong><small>Supplier paid in full</small></span>
              <span className="home-proof-line-amount">400 <small>tLFT</small></span>
              <span className="home-proof-icon success" aria-label="Completed">✓</span>
            </li>
            <li>
              <span className="home-proof-number">02</span>
              <span className="home-proof-line-main"><strong>Mutual settlement</strong><small>700 supplier · 300 buyer</small></span>
              <span className="home-proof-line-amount">1,000 <small>tLFT</small></span>
              <span className="home-proof-icon agreed" aria-label="Settled">↔</span>
            </li>
            <li>
              <span className="home-proof-number">03</span>
              <span className="home-proof-line-main"><strong>Arbitrator ruling</strong><small>800 supplier · 200 buyer</small></span>
              <span className="home-proof-line-amount">1,000 <small>tLFT</small></span>
              <span className="home-proof-icon ruled" aria-label="Resolved">✓</span>
            </li>
          </ol>
          <div className="home-proof-summary">
            <div><span>Total settled</span><strong>2,400 <small>tLFT</small></strong></div>
            <div><span>Outstanding</span><strong>0 <small>tLFT</small></strong></div>
          </div>
          <a className="home-proof-source" href="#/agreements/0">View the on-chain agreement <span aria-hidden="true">↗</span></a>
        </div>
      </section>

      <section className="home-how" id="how-linefair-works" aria-labelledby="home-how-title">
        <div className="home-how-intro">
          <span className="eyebrow">Built for the moments work gets complicated</span>
          <h2 id="home-how-title">Keep the finished work moving.</h2>
          <p>Each deliverable has its own amount and settlement path. A disagreement over one doesn't have to decide the fate of the others.</p>
        </div>
        <ol className="home-how-steps">
          <li><span className="home-how-index">01 / AGREE</span><strong>Define each deliverable.</strong><p>Set the work, price, deadlines and dispute rules together before funding.</p></li>
          <li><span className="home-how-index">02 / DELIVER</span><strong>Review line by line.</strong><p>Accept and pay completed work while keeping contested amounts separate.</p></li>
          <li><span className="home-how-index">03 / RESOLVE</span><strong>Follow agreed rules.</strong><p>Disputes can move through negotiation, arbitrators and an available fallback after defined windows.</p></li>
        </ol>
      </section>

      <div className="home-records-head" id="agreement-records">
        <span className="eyebrow">Live contract records</span>
        <div className="home-records-title">
          <div>
            <h2>Agreements</h2>
            <p>Actual state from the NEAR Testnet escrow. Browse records and verify each outcome.</p>
          </div>
          <a className="home-records-link" href="#/agreements/0">Explore agreement #0 <span aria-hidden="true">↗</span></a>
        </div>
      </div>

      {config.escrowId === "" ? (
        <div className="panel empty">
          <h2>No escrow contract is configured</h2>
          <p className="muted">
            The LineFair escrow has not been deployed to testnet yet, so there are no agreements to show. Nothing on this page is read
            from a chain until a contract account is configured.
          </p>
          <p>
            You can still draft an agreement and see its canonical terms hash computed locally.
          </p>
          <div className="actions">
            <a className="button" href="#/agreements/new">
              Draft an agreement
            </a>
          </div>
        </div>
      ) : load.state === "loading" ? (
        <div className="panel" aria-busy="true">
          <p className="muted">Reading agreements from {config.escrowId}…</p>
        </div>
      ) : load.state === "error" ? (
        <Notice tone="negative">
          <p>
            <strong>Could not read the escrow contract.</strong> {load.message}
          </p>
          <p>Check the network connection and the configured contract account, then reload.</p>
        </Notice>
      ) : (
        <div className="panel">
          <div className="panel-head">
            <h2>{load.items.length === 0 ? "No agreements yet" : `${load.items.length} agreement${load.items.length === 1 ? "" : "s"}`}</h2>
            <span className="small muted num">Read at block {load.blockHeight.toString()}</span>
          </div>
          {load.items.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Agreement</th>
                  <th scope="col">Status</th>
                  <th scope="col">Lines</th>
                  <th scope="col">Your role</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {load.items.map((a) => (
                  <tr key={a.agreement_id}>
                    <td>
                      <a href={`#/agreements/${a.agreement_id}`}>Agreement #{a.agreement_id}</a>
                    </td>
                    <td>
                      <Status state={agreementSummaryLabel(a)} />
                    </td>
                    <td className="num">{a.lines.length}</td>
                    <td>{roleOf(a) ?? <span className="muted">—</span>}</td>
                    <td className="small num">{formatNsUtc(u128(a.created_at_ns))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
