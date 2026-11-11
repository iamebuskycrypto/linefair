// Fail-closed startup gate (lib/deployment.ts). With an escrow configured, the
// app renders nothing interactive (no wallet, no agreements, no signing) until
// the RPC chain id, the escrow's on-chain code hash, contract_version() and
// get_config() all match the expected release build. Any mismatch or read
// error shows a blocking screen. No escrow configured = local preview only.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppConfig } from "../lib/config.ts";
import { EXPECTED_CODE_HASH, EXPECTED_DEPLOYMENT, verifyDeployment, type VerifiedDeployment } from "../lib/deployment.ts";
import { NearRpc } from "../lib/near/rpc.ts";

type Gate = { state: "checking" } | { state: "blocked"; failures: string[] } | { state: "ok"; deployment: VerifiedDeployment | null };

export const STARTUP_COPY = {
  checking: "Checking the configured testnet contract…",
  blockedTitle: "LineFair will not start",
  blockedLede:
    "The configured escrow contract does not match the build this app was made for, or could not be checked. Nothing can be read, signed or sent until this is fixed.",
} as const;

export function StartupBlocked({ config, failures }: { config: AppConfig; failures: readonly string[] }) {
  return (
    <div className="panel" role="alert" data-startup="blocked">
      <h1>{STARTUP_COPY.blockedTitle}</h1>
      <p className="lede">{STARTUP_COPY.blockedLede}</p>
      <ul className="reasons">
        {failures.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <dl className="kv" style={{ marginTop: "var(--s2)" }}>
        <dt>Network</dt>
        <dd>{config.network}</dd>
        <dt>RPC</dt>
        <dd className="mono">{config.rpcUrl}</dd>
        <dt>Escrow</dt>
        <dd className="mono">{config.escrowId}</dd>
        <dt>Expected version</dt>
        <dd className="mono">{EXPECTED_DEPLOYMENT.contractVersion}</dd>
        <dt>Expected code hash</dt>
        <dd className="mono">{EXPECTED_CODE_HASH}</dd>
        <dt>Release WASM SHA-256</dt>
        <dd className="mono">{EXPECTED_DEPLOYMENT.wasmSha256}</dd>
      </dl>
      <p className="small muted" style={{ marginTop: "var(--s2)" }}>
        Reload the page to check again. If the contract was redeployed, this build must be updated to the new release values first.
      </p>
    </div>
  );
}

/** `rpc` is injectable only for the offline browser DOM check; production uses the configured RPC URL. */
export function StartupGate({ config, rpc: injected, children }: { config: AppConfig; rpc?: NearRpc; children: (deployment: VerifiedDeployment | null) => ReactNode }) {
  const rpc = useMemo(() => injected ?? new NearRpc(config.rpcUrl), [injected, config.rpcUrl]);
  const [gate, setGate] = useState<Gate>(() => (config.escrowId === "" ? { state: "ok", deployment: null } : { state: "checking" }));

  useEffect(() => {
    if (config.escrowId === "") return;
    let cancelled = false;
    verifyDeployment(rpc, config)
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) setGate({ state: "blocked", failures: r.failures });
        else
          setGate({
            state: "ok",
            deployment: { escrowId: config.escrowId, escrowConfig: r.escrowConfig, creatorAllowlist: [...r.escrowConfig.creator_allowlist] },
          });
      })
      .catch((e: unknown) => {
        if (!cancelled) setGate({ state: "blocked", failures: [`Startup check failed: ${(e as Error).message}`] });
      });
    return () => {
      cancelled = true;
    };
  }, [config, rpc]);

  if (gate.state === "checking") {
    return (
      <main>
        <div className="panel" aria-busy="true" data-startup="checking">
          <p className="muted">{STARTUP_COPY.checking}</p>
        </div>
      </main>
    );
  }
  if (gate.state === "blocked")
    return (
      <main>
        <StartupBlocked config={config} failures={gate.failures} />
      </main>
    );
  return <>{children(gate.deployment)}</>;
}
