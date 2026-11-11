import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppConfig } from "../lib/config.ts";
import type { VerifiedDeployment } from "../lib/deployment.ts";
import { NearRpc } from "../lib/near/rpc.ts";

export interface WalletState {
  readonly accountId: string | null;
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly error?: string;
  connect(): void;
  disconnect(): void;
}

interface AppContextValue {
  readonly config: AppConfig;
  readonly rpc: NearRpc;
  readonly wallet: WalletState;
  /** The escrow that passed the startup check (StartupGate); null = no contract configured (local preview). */
  readonly deployment: VerifiedDeployment | null;
}

const Ctx = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useApp outside AppProvider");
  return v;
}

/**
 * Provider with a fixed value and no wallet library: used only by the
 * offline browser DOM check (browser-check/), which renders panels from
 * fixture views. Production uses AppProvider.
 */
export function StaticAppProvider({ value, children }: { value: AppContextValue; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export type { AppContextValue };

export function AppProvider({ config, deployment, children }: { config: AppConfig; deployment: VerifiedDeployment | null; children: ReactNode }) {
  const rpc = useMemo(() => new NearRpc(config.rpcUrl), [config.rpcUrl]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [status, setStatus] = useState<WalletState["status"]>("idle");
  const [error, setError] = useState<string | undefined>(undefined);

  // Restore an existing wallet session without prompting.
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;
    import("../lib/near/wallet.ts")
      .then(async (w) => {
        const selector = await w.getSelector();
        if (cancelled) return;
        setAccountId(w.activeAccountId(selector));
        unsub = w.subscribeAccount(selector, setAccountId);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setError(`Wallet library failed to load: ${(e as Error).message}`);
      });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  const wallet: WalletState = {
    accountId,
    status,
    ...(error !== undefined ? { error } : {}),
    connect() {
      setStatus("loading");
      setError(undefined);
      import("../lib/near/wallet.ts")
        .then((w) => w.connect())
        .then((id) => {
          setAccountId(id);
          setStatus("ready");
        })
        .catch((e: unknown) => {
          setStatus("ready");
          setError((e as Error).message);
        });
    },
    disconnect() {
      import("../lib/near/wallet.ts")
        .then((w) => w.disconnect())
        .then(() => setAccountId(null))
        .catch((e: unknown) => setError((e as Error).message));
    },
  };

  return <Ctx.Provider value={{ config, rpc, wallet, deployment }}>{children}</Ctx.Provider>;
}
