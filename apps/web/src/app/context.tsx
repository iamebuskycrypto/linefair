import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AppConfig } from "../lib/config.ts";
import type { VerifiedDeployment } from "../lib/deployment.ts";
import { NearRpc } from "../lib/near/rpc.ts";
import { WalletController, type WalletNotice, type WalletPort, type WalletStatus, type WalletView } from "../lib/near/walletController.ts";

export interface WalletState {
  readonly accountId: string | null;
  readonly status: WalletStatus;
  /** Latest user-facing wallet message (cancellation, failure, account change…); null when none. */
  readonly notice: WalletNotice | null;
  connect(): void;
  disconnect(): void;
  dismissNotice(): void;
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
  const wallet = useWalletController();
  return <Ctx.Provider value={{ config, rpc, wallet, deployment }}>{children}</Ctx.Provider>;
}

const INITIAL_VIEW: WalletView = { status: "initializing", accountId: null, notice: null };

/** The wallet module (and its libraries) loads lazily; the controller is created once per page. */
function useWalletController(): WalletState {
  const [controller, setController] = useState<WalletController | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let created: WalletController | null = null;
    import("../lib/near/wallet.ts")
      .then((w) => {
        if (cancelled) return;
        const port: WalletPort = w.createWalletPort();
        created = new WalletController(port);
        setController(created);
        setLoadFailed(false);
        void created.start();
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
      created?.dispose();
    };
  }, [attempt]);
  const view = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getView ?? (() => INITIAL_VIEW),
  );
  if (controller === null) {
    return {
      accountId: null,
      status: loadFailed ? "unavailable" : "initializing",
      notice: loadFailed ? { kind: "error", text: "The wallet could not be loaded. Check your connection and try again." } : null,
      connect: () => setAttempt((a) => a + 1),
      disconnect: () => undefined,
      dismissNotice: () => undefined,
    };
  }
  return {
    accountId: view.accountId,
    status: view.status,
    notice: view.notice,
    connect: () => void controller.connect(),
    disconnect: () => void controller.disconnect(),
    dismissNotice: controller.dismissNotice,
  };
}

const noopSubscribe = () => () => undefined;
