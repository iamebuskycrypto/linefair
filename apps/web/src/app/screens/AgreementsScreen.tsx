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
      <div className="page-head">
        <h1>Agreements</h1>
        <p className="lede">
          Each agreement has up to three independently priced lines. Every line is funded, delivered, reviewed and settled on its own.
        </p>
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
