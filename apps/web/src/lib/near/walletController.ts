// Wallet connection state machine (frontend only; no contract or transaction
// logic). Owns session restore, connect, disconnect, account changes and the
// time limits around them, so that the UI can never sit on "Opening wallet…"
// indefinitely and never shows an account whose stored session LineFair would
// refuse to sign with (intearGuard.ts M2).
//
// Everything that touches the wallet library or the browser goes through a
// WalletPort, so the behaviour is unit-tested deterministically with a
// SIMULATED port (walletController.test.ts). Real Intear sessions are only
// exercised by the founder's manual acceptance protocol.
//
// Behaviour of @near-wallet-selector/intear-wallet 10.1.4 that this handles
// (read from the installed module):
// - signIn() shows a full-screen iframe from wallet.intear.tech and settles
//   only on its "connected" (resolve) or "close" with a message (reject)
//   messages. A "close" without a message removes the iframe but never settles
//   the promise, and nothing settles if the iframe fails to load. -> connect
//   watches the connector and has an overall time limit.
// - getAccounts() on restore reads `savedData.accounts[0]` without checking the
//   stored value; a malformed session makes setupWalletSelector reject, which
//   previously disabled the Connect button permanently. -> malformed sessions
//   are cleared before the library starts.
// - signOut() calls the Intear logout bridge over the network before clearing
//   local storage. -> disconnect has a time limit and always ends locally
//   signed out.

import { checkIntearSession } from "./intearGuard.ts";

export type WalletStatus = "initializing" | "disconnected" | "connecting" | "connected" | "disconnecting" | "unavailable";

export type NoticeKind = "info" | "warning" | "error";
export interface WalletNotice {
  readonly kind: NoticeKind;
  readonly text: string;
}

export interface WalletView {
  readonly status: WalletStatus;
  readonly accountId: string | null;
  readonly notice: WalletNotice | null;
}

/** Narrow interface over the wallet library and browser storage (real: wallet.ts; tests: simulated). */
export interface WalletPort {
  /** Raw Intear session value from localStorage (null if absent). */
  readSession(): string | null;
  /**
   * Remove LineFair's local wallet session records only (Intear session + selector selection) and,
   * once the library is running, reset its in-memory state without contacting the wallet.
   */
  clearLocalSession(): Promise<void>;
  /** Start the wallet library (restores a stored session). */
  init(): Promise<void>;
  /** Active account according to the wallet library store. */
  storeAccount(): string | null;
  /** Subscribe to wallet-library store changes. */
  subscribe(onChange: () => void): () => void;
  /** Ask the wallet to sign in; resolves with the account the wallet reported (if any). */
  signIn(): Promise<string | null>;
  /** Wallet-library sign-out (may contact the wallet's logout service). */
  signOut(): Promise<void>;
  /** Whether the wallet's connection window/overlay is currently present. */
  connectorOpen(): boolean;
  /** Whether the connector appeared at any point during the current sign-in (catches very quick closes). */
  connectorWasOpened(): boolean;
  /** Remove a leftover connection overlay (after a time-out or interruption). */
  closeConnector(): void;
}

export interface WalletTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WalletControllerOptions {
  /** Overall limit for a sign-in attempt (account creation in the wallet can take minutes). */
  readonly connectTimeoutMs?: number;
  /** Limit for starting the wallet library / restoring a session. */
  readonly initTimeoutMs?: number;
  /** Limit for the wallet's sign-out call; local records are cleared regardless. */
  readonly signOutTimeoutMs?: number;
  /** How often the connector overlay is checked while signing in. */
  readonly connectorPollMs?: number;
  /** If the connector never appears within this time, the attempt is treated as failed to open. */
  readonly connectorOpenGraceMs?: number;
  readonly timers?: WalletTimers;
}

export const DEFAULT_WALLET_OPTIONS = {
  connectTimeoutMs: 5 * 60_000,
  initTimeoutMs: 20_000,
  signOutTimeoutMs: 10_000,
  connectorPollMs: 500,
  connectorOpenGraceMs: 15_000,
} as const;

export const MESSAGES = {
  cancelled: "Wallet connection cancelled. Nothing was connected. You can try again at any time.",
  interrupted: "The wallet window closed before the connection finished. Nothing was connected. You can try again.",
  timeout: "The wallet did not finish connecting in time. Nothing was connected. Please try again.",
  popupBlocked: "Your browser blocked the wallet window. Allow pop-ups for this site, then try again.",
  failedToOpen: "The wallet window did not open. Check your connection and that pop-ups are allowed, then try again.",
  libraryFailed: "The wallet could not be loaded. Check your connection and try again.",
  restoreTimeout: "Restoring your wallet session is taking too long. You can connect again.",
  malformedSession: "A saved wallet session on this device was unreadable and has been removed. Connect again to continue.",
  connected: (id: string) => `Connected as ${id}.`,
  disconnected: "Wallet disconnected on this device.",
  disconnectedLocalOnly: "Disconnected on this device. The wallet could not be notified; you can also remove the LineFair session in your wallet.",
  accountChanged: (id: string) => `The wallet switched to ${id}. Check the account before signing anything.`,
  mismatch: "The wallet reported a different account from the saved session, so the connection was refused. Please connect again.",
  externalSignOut: "The wallet session ended. Connect again to continue.",
} as const;

export type ConnectFailure = "cancelled" | "popup-blocked" | "failed";

/** Classify an error raised by the wallet library during sign-in (messages are wallet-supplied, so matching is loose). */
export function classifyConnectError(e: unknown): { readonly kind: ConnectFailure; readonly text: string } {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const m = raw.toLowerCase();
  if (/popup.*block|blocked.*popup|pop-up.*block/.test(m)) return { kind: "popup-blocked", text: MESSAGES.popupBlocked };
  if (/cancel|reject|denied|declin|closed|close|abort|user/.test(m)) return { kind: "cancelled", text: MESSAGES.cancelled };
  // Never echo arbitrary wallet text verbatim beyond a short, single-line excerpt.
  const excerpt = raw.replace(/\s+/g, " ").trim().slice(0, 140);
  return { kind: "failed", text: excerpt === "" ? "The wallet connection failed. Please try again." : `The wallet connection failed (${excerpt}). Please try again.` };
}

/** Is the stored value structurally broken (would crash the wallet library on restore)? Policy rejections are not "malformed". */
export function isMalformedSession(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    const s: unknown = JSON.parse(raw);
    if (s === null || typeof s !== "object") return true;
    const accounts = (s as { accounts?: unknown }).accounts;
    if (!Array.isArray(accounts) || accounts.length === 0) return true;
    const first = accounts[0] as { accountId?: unknown } | null;
    if (first === null || typeof first !== "object" || typeof first.accountId !== "string") return true;
    return typeof (s as { key?: unknown }).key !== "string";
  } catch {
    return true;
  }
}

class TimeoutError extends Error {}

export class WalletController {
  private view: WalletView = { status: "initializing", accountId: null, notice: null };
  private readonly listeners = new Set<() => void>();
  private unsubscribeStore: (() => void) | null = null;
  private started = false;
  private disposed = false;
  /** Increments per connect/disconnect; stale async results are ignored. */
  private epoch = 0;
  private readonly o: Required<Omit<WalletControllerOptions, "timers">>;
  private readonly t: WalletTimers;

  private readonly port: WalletPort;

  constructor(port: WalletPort, options: WalletControllerOptions = {}) {
    this.port = port;
    this.o = {
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_WALLET_OPTIONS.connectTimeoutMs,
      initTimeoutMs: options.initTimeoutMs ?? DEFAULT_WALLET_OPTIONS.initTimeoutMs,
      signOutTimeoutMs: options.signOutTimeoutMs ?? DEFAULT_WALLET_OPTIONS.signOutTimeoutMs,
      connectorPollMs: options.connectorPollMs ?? DEFAULT_WALLET_OPTIONS.connectorPollMs,
      connectorOpenGraceMs: options.connectorOpenGraceMs ?? DEFAULT_WALLET_OPTIONS.connectorOpenGraceMs,
    };
    this.t = options.timers ?? { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  getView = (): WalletView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: Partial<WalletView>): void {
    if (this.disposed) return;
    this.view = { ...this.view, ...next };
    for (const l of this.listeners) l();
  }

  dismissNotice = (): void => this.set({ notice: null });

  /** Validated account for the current stored session, or null (with the reason). */
  private sessionAccount(): { ok: true; accountId: string } | { ok: false; reason: string } {
    const r = checkIntearSession(this.port.readSession());
    return r.ok ? { ok: true, accountId: r.accountId } : { ok: false, reason: r.reason };
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const h = this.t.setTimeout(() => reject(new TimeoutError("timeout")), ms);
      p.then(
        (v) => {
          this.t.clearTimeout(h);
          resolve(v);
        },
        (e: unknown) => {
          this.t.clearTimeout(h);
          reject(e);
        },
      );
    });
  }

  /** Start the library and restore a stored session (no prompt). Safe to call again after "unavailable". */
  start = async (): Promise<void> => {
    if (this.disposed) return;
    const epoch = ++this.epoch;
    this.set({ status: "initializing" });
    let notice: WalletNotice | null = null;
    if (isMalformedSession(this.port.readSession())) {
      await this.port.clearLocalSession();
      notice = { kind: "warning", text: MESSAGES.malformedSession };
    }
    try {
      await this.withTimeout(this.port.init(), this.o.initTimeoutMs);
    } catch (e) {
      if (epoch !== this.epoch) return;
      this.set({ status: "unavailable", accountId: null, notice: { kind: "error", text: e instanceof TimeoutError ? MESSAGES.restoreTimeout : MESSAGES.libraryFailed } });
      return;
    }
    if (epoch !== this.epoch || this.disposed) return;
    if (!this.started) {
      this.started = true;
      this.unsubscribeStore = this.port.subscribe(() => this.onStoreChange());
    }
    const storeId = this.port.storeAccount();
    if (storeId === null) {
      this.set({ status: "disconnected", accountId: null, notice });
      return;
    }
    const s = this.sessionAccount();
    if (!s.ok || s.accountId !== storeId) {
      await this.forceLocalSignOut();
      if (epoch !== this.epoch) return;
      this.set({ status: "disconnected", accountId: null, notice: { kind: "warning", text: s.ok ? MESSAGES.mismatch : `${s.reason} The saved session was signed out; connect again.` } });
      return;
    }
    this.set({ status: "connected", accountId: storeId, notice });
  };

  /** Store changed outside connect/disconnect (wallet switched account, remote logout, late sign-in). */
  private onStoreChange(): void {
    const st = this.view.status;
    if (st === "connecting" || st === "disconnecting" || st === "initializing") return;
    const storeId = this.port.storeAccount();
    if (storeId === null) {
      if (st === "connected") this.set({ status: "disconnected", accountId: null, notice: { kind: "info", text: MESSAGES.externalSignOut } });
      return;
    }
    if (storeId === this.view.accountId && st === "connected") return;
    const s = this.sessionAccount();
    if (!s.ok || s.accountId !== storeId) {
      void this.forceLocalSignOut().then(() => this.set({ status: "disconnected", accountId: null, notice: { kind: "warning", text: MESSAGES.mismatch } }));
      return;
    }
    const changed = st === "connected" && this.view.accountId !== null;
    this.set({ status: "connected", accountId: storeId, notice: changed ? { kind: "warning", text: MESSAGES.accountChanged(storeId) } : null });
  }

  connect = async (): Promise<void> => {
    const st = this.view.status;
    if (st === "connecting" || st === "disconnecting" || st === "connected" || this.disposed) return;
    if (st === "unavailable" || st === "initializing") {
      await this.start();
      if (this.view.status !== "disconnected") return; // restored, or still unavailable (notice shown)
    }
    const epoch = ++this.epoch;
    this.set({ status: "connecting", notice: null });

    const outcome = await new Promise<{ ok: true; reported: string | null } | { ok: false; notice: WalletNotice; closeConnector: boolean }>((resolve) => {
      let settled = false;
      let seenOpen = false;
      let pollHandle: unknown = null;
      const finish = (v: Parameters<typeof resolve>[0]) => {
        if (settled) return;
        settled = true;
        this.t.clearTimeout(overall);
        if (pollHandle !== null) this.t.clearTimeout(pollHandle);
        resolve(v);
      };
      const overall = this.t.setTimeout(() => finish({ ok: false, notice: { kind: "error", text: MESSAGES.timeout }, closeConnector: true }), this.o.connectTimeoutMs);
      let elapsedPolls = 0;
      const poll = () => {
        if (settled) return;
        elapsedPolls += this.o.connectorPollMs;
        const open = this.port.connectorOpen();
        if (open || this.port.connectorWasOpened()) seenOpen = true;
        // The connector closed without a result: cancelled or interrupted (Intear "close" without a message).
        if (seenOpen && !open && !this.sessionAccount().ok) {
          finish({ ok: false, notice: { kind: "info", text: MESSAGES.interrupted }, closeConnector: false });
          return;
        }
        if (!seenOpen && elapsedPolls >= this.o.connectorOpenGraceMs && !this.sessionAccount().ok) {
          finish({ ok: false, notice: { kind: "error", text: MESSAGES.failedToOpen }, closeConnector: true });
          return;
        }
        pollHandle = this.t.setTimeout(poll, this.o.connectorPollMs);
      };
      pollHandle = this.t.setTimeout(poll, this.o.connectorPollMs);
      this.port.signIn().then(
        (reported) => finish({ ok: true, reported }),
        (e: unknown) => {
          const c = classifyConnectError(e);
          finish({ ok: false, notice: { kind: c.kind === "cancelled" ? "info" : "error", text: c.text }, closeConnector: true });
        },
      );
    });

    if (epoch !== this.epoch) return;
    if (!outcome.ok) {
      if (outcome.closeConnector) this.port.closeConnector();
      // A sign-in that completed late (after a time-out) must not leave a half-connected session behind.
      if (this.port.storeAccount() !== null || this.port.readSession() !== null) await this.forceLocalSignOut();
      if (epoch !== this.epoch) return;
      this.set({ status: "disconnected", accountId: null, notice: outcome.notice });
      return;
    }
    const s = this.sessionAccount();
    if (!s.ok) {
      await this.forceLocalSignOut();
      if (epoch !== this.epoch) return;
      this.set({ status: "disconnected", accountId: null, notice: { kind: "error", text: `Wallet connection refused: ${s.reason}` } });
      return;
    }
    const storeId = this.port.storeAccount();
    if ((outcome.reported !== null && outcome.reported !== s.accountId) || (storeId !== null && storeId !== s.accountId)) {
      await this.forceLocalSignOut();
      if (epoch !== this.epoch) return;
      this.set({ status: "disconnected", accountId: null, notice: { kind: "error", text: MESSAGES.mismatch } });
      return;
    }
    this.set({ status: "connected", accountId: s.accountId, notice: { kind: "info", text: MESSAGES.connected(s.accountId) } });
  };

  /** Wallet sign-out with a time limit; local records are always cleared afterwards. Returns whether the wallet call completed. */
  private async forceLocalSignOut(): Promise<boolean> {
    let walletNotified = true;
    try {
      await this.withTimeout(this.port.signOut(), this.o.signOutTimeoutMs);
    } catch {
      walletNotified = false;
    }
    if (this.port.readSession() !== null || this.port.storeAccount() !== null) await this.port.clearLocalSession().catch(() => undefined);
    return walletNotified;
  }

  disconnect = async (): Promise<void> => {
    const st = this.view.status;
    if (st === "disconnecting" || this.disposed) return;
    const epoch = ++this.epoch;
    this.set({ status: "disconnecting", notice: null });
    const notified = await this.forceLocalSignOut();
    if (epoch !== this.epoch) return;
    this.set({ status: "disconnected", accountId: null, notice: { kind: "info", text: notified ? MESSAGES.disconnected : MESSAGES.disconnectedLocalOnly } });
  };

  dispose = (): void => {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.listeners.clear();
    this.disposed = true;
  };
}
