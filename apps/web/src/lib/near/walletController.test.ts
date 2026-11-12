// SIMULATED wallet acceptance tests for walletController.ts. A fake WalletPort
// stands in for @near-wallet-selector + Intear and a manual clock replaces
// timers, so every flow is deterministic. These results are NOT a real-wallet
// acceptance test: real Intear sessions are covered only by the founder's
// manual protocol (docs/qa/WALLET_UAT_FINAL_REPORT.md).

import { test } from "node:test";
import assert from "node:assert/strict";

import { WalletController, MESSAGES, classifyConnectError, isMalformedSession, type WalletPort, type WalletTimers } from "./walletController.ts";
import { INTEAR_ORIGIN, INTEAR_STORAGE_KEY } from "./intearGuard.ts";

const ACCOUNT = "uat-buyer.testnet";
const OTHER = "someone-else.testnet";
const session = (accountId: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ accounts: [{ accountId, active: true }], key: "ed25519:simulated-not-a-real-key", contractId: "", methodNames: [], logoutKey: "ed25519:11111111111111111111111111111111", walletUrl: INTEAR_ORIGIN, useBridge: false, ...over });

/** Manual clock: timers run only when the test advances time. */
class Clock implements WalletTimers {
  now = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  pending(): number {
    return this.timers.size;
  }
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      await flush();
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (next === undefined || e[1].at < next[1].at)) next = e;
      if (next === undefined) break;
      this.timers.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = end;
    await flush();
  }
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
};

/** Simulated wallet library + browser storage, shared across "page loads" like real localStorage. */
class SimDevice {
  storage = new Map<string, string>();
  remoteLogoutReachable = true;
  pages: SimPort[] = [];
  page(): SimPort {
    const p = new SimPort(this);
    this.pages.push(p);
    return p;
  }
}

type SignInScript = (port: SimPort) => Promise<string | null>;

class SimPort implements WalletPort {
  initialized = false;
  storeId: string | null = null;
  listeners = new Set<() => void>();
  connector = false;
  opened = false;
  signInCalls = 0;
  signOutCalls = 0;
  initBehaviour: "ok" | "fail" | "hang" = "ok";
  signOutBehaviour: "ok" | "hang" = "ok";
  signInScript: SignInScript = async () => null;
  readonly device: SimDevice;
  constructor(device: SimDevice) {
    this.device = device;
  }
  readSession() {
    return this.device.storage.get(INTEAR_STORAGE_KEY) ?? null;
  }
  async clearLocalSession() {
    this.device.storage.delete(INTEAR_STORAGE_KEY);
    this.device.storage.delete("near-wallet-selector:selectedWalletId");
    if (this.initialized) this.setStore(null);
  }
  async init() {
    if (this.initBehaviour === "fail") throw new Error("library failed to load (simulated)");
    if (this.initBehaviour === "hang") return new Promise<void>(() => undefined);
    // Like wallet-selector restore: selected wallet + Intear accounts from storage. A malformed record would throw here.
    const raw = this.readSession();
    if (this.device.storage.get("near-wallet-selector:selectedWalletId") === '"intear-wallet"' && raw !== null) {
      const s = JSON.parse(raw) as { accounts: { accountId: string }[] };
      this.storeId = s.accounts[0]!.accountId; // throws on malformed, as intear-wallet 10.1.4 does
    }
    this.initialized = true;
  }
  storeAccount() {
    return this.initialized ? this.storeId : null;
  }
  subscribe(on: () => void) {
    this.listeners.add(on);
    return () => this.listeners.delete(on);
  }
  setStore(id: string | null) {
    this.storeId = id;
    for (const l of this.listeners) l();
  }
  async signIn() {
    this.signInCalls++;
    this.connector = true;
    this.opened = true;
    return this.signInScript(this);
  }
  /** What a successful Intear sign-in does: store the session, update the selector store. */
  completeSignIn(accountId: string, sessionAccount = accountId) {
    this.device.storage.set(INTEAR_STORAGE_KEY, session(sessionAccount));
    this.device.storage.set("near-wallet-selector:selectedWalletId", '"intear-wallet"');
    this.storeId = accountId;
    this.connector = false;
    return accountId;
  }
  async signOut() {
    this.signOutCalls++;
    if (this.signOutBehaviour === "hang") return new Promise<void>(() => undefined);
    this.device.storage.delete(INTEAR_STORAGE_KEY);
    this.device.storage.delete("near-wallet-selector:selectedWalletId");
    this.setStore(null);
  }
  connectorOpen() {
    return this.connector;
  }
  connectorWasOpened() {
    return this.opened;
  }
  closeConnector() {
    this.connector = false;
  }
}

function setup(device = new SimDevice()) {
  const clock = new Clock();
  const port = device.page();
  const c = new WalletController(port, { timers: clock });
  return { device, clock, port, c };
}

async function startedPage(device = new SimDevice()) {
  const s = setup(device);
  await s.c.start();
  return s;
}

const succeed: SignInScript = async (p) => p.completeSignIn(ACCOUNT);

test("initialisation without a stored session ends disconnected (no prompt, no wallet call)", async () => {
  const { c, port } = await startedPage();
  assert.deepEqual(c.getView(), { status: "disconnected", accountId: null, notice: null });
  assert.equal(port.signInCalls, 0);
});

test("connect: valid account connection shows the session's account", async () => {
  const { c, port } = await startedPage();
  port.signInScript = succeed;
  await c.connect();
  assert.equal(c.getView().status, "connected");
  assert.equal(c.getView().accountId, ACCOUNT);
  assert.equal(c.getView().notice?.text, MESSAGES.connected(ACCOUNT));
});

test("session restoration after refresh and after reopening (new controller over the same storage)", async () => {
  const device = new SimDevice();
  const first = await startedPage(device);
  first.port.signInScript = succeed;
  await first.c.connect();
  first.c.dispose();
  const refreshed = await startedPage(device); // refresh
  assert.equal(refreshed.c.getView().status, "connected");
  assert.equal(refreshed.c.getView().accountId, ACCOUNT);
  refreshed.c.dispose();
  const reopened = await startedPage(device); // tab closed and reopened: same persistent storage
  assert.equal(reopened.c.getView().accountId, ACCOUNT);
  assert.equal(reopened.port.signInCalls, 0, "restoration never prompts");
});

test("disconnect clears the session, and stays disconnected after refresh; reconnect works", async () => {
  const device = new SimDevice();
  const a = await startedPage(device);
  a.port.signInScript = succeed;
  await a.c.connect();
  await a.c.disconnect();
  assert.deepEqual([a.c.getView().status, a.c.getView().accountId], ["disconnected", null]);
  assert.equal(a.c.getView().notice?.text, MESSAGES.disconnected);
  assert.equal(device.storage.has(INTEAR_STORAGE_KEY), false);
  const b = await startedPage(device);
  assert.equal(b.c.getView().status, "disconnected", "no restoration after explicit disconnect");
  b.port.signInScript = succeed;
  await b.c.connect();
  assert.equal(b.c.getView().accountId, ACCOUNT, "reconnect");
});

test("disconnect still ends signed out locally when the wallet's logout service hangs", async () => {
  const { c, port, clock, device } = await startedPage();
  port.signInScript = succeed;
  await c.connect();
  port.signOutBehaviour = "hang";
  const p = c.disconnect();
  assert.equal(c.getView().status, "disconnecting");
  await clock.advance(10_000);
  await p;
  assert.equal(c.getView().status, "disconnected");
  assert.equal(c.getView().notice?.text, MESSAGES.disconnectedLocalOnly);
  assert.equal(device.storage.has(INTEAR_STORAGE_KEY), false);
});

test("account mismatch at connect: wallet-reported account differs from the stored session -> refused and cleared", async () => {
  const { c, port, device } = await startedPage();
  port.signInScript = async (p) => p.completeSignIn(OTHER, ACCOUNT);
  await c.connect();
  assert.deepEqual([c.getView().status, c.getView().accountId], ["disconnected", null]);
  assert.equal(c.getView().notice?.text, MESSAGES.mismatch);
  assert.equal(device.storage.has(INTEAR_STORAGE_KEY), false);
});

test("account mismatch on restore: selector account differs from stored session -> signed out, not displayed", async () => {
  const device = new SimDevice();
  device.storage.set(INTEAR_STORAGE_KEY, session(ACCOUNT));
  device.storage.set("near-wallet-selector:selectedWalletId", '"intear-wallet"');
  const s = setup(device);
  s.port.init = async () => {
    s.port.initialized = true;
    s.port.storeId = OTHER;
  };
  await s.c.start();
  assert.deepEqual([s.c.getView().status, s.c.getView().accountId], ["disconnected", null]);
  assert.equal(s.c.getView().notice?.text, MESSAGES.mismatch);
});

test("user cancellation (wallet reports a rejection) -> disconnected with a clear message; retry works", async () => {
  const { c, port, device } = await startedPage();
  port.signInScript = async () => {
    throw new Error("User cancelled the connection");
  };
  await c.connect();
  assert.equal(c.getView().status, "disconnected");
  assert.equal(c.getView().notice?.text, MESSAGES.cancelled);
  assert.equal(device.storage.has(INTEAR_STORAGE_KEY), false);
  port.signInScript = succeed;
  await c.connect();
  assert.equal(c.getView().status, "connected");
});

test("popup closure without a result (Intear 'close' with no message never settles) -> interrupted, not stuck", async () => {
  const { c, port, clock } = await startedPage();
  port.signInScript = () => new Promise(() => undefined);
  const p = c.connect();
  await clock.advance(2_000);
  assert.equal(c.getView().status, "connecting");
  port.connector = false; // user closed the wallet window
  await clock.advance(600);
  await p;
  assert.equal(c.getView().status, "disconnected");
  assert.equal(c.getView().notice?.text, MESSAGES.interrupted);
  assert.equal(clock.pending(), 0, "no timers left running");
});

test("connector closed within milliseconds (before the first poll) -> interrupted at the first poll, not 'did not open'", async () => {
  const { c, port, clock } = await startedPage();
  port.signInScript = () => {
    port.connector = false; // opened (opened = true) and closed again immediately
    return new Promise(() => undefined);
  };
  const p = c.connect();
  await clock.advance(500);
  await p;
  assert.equal(c.getView().notice?.text, MESSAGES.interrupted);
});

test("connector that never appears -> 'did not open' after the grace period", async () => {
  const { c, port, clock } = await startedPage();
  port.signInScript = () => {
    port.connector = false;
    port.opened = false;
    return new Promise(() => undefined);
  };
  const p = c.connect();
  await clock.advance(15_000);
  await p;
  assert.equal(c.getView().notice?.text, MESSAGES.failedToOpen);
});

test("authentication left open too long -> time-out after 5 minutes, overlay removed, button usable again", async () => {
  const { c, port, clock } = await startedPage();
  port.signInScript = () => new Promise(() => undefined); // connector stays open
  const p = c.connect();
  await clock.advance(4 * 60_000);
  assert.equal(c.getView().status, "connecting", "users get reasonable time to authenticate");
  await clock.advance(60_000);
  await p;
  assert.equal(c.getView().status, "disconnected");
  assert.equal(c.getView().notice?.text, MESSAGES.timeout);
  assert.equal(port.connector, false, "leftover full-screen overlay removed");
});

test("a sign-in reported after the time-out is adopted only through the validated store path", async () => {
  // In the real module the overlay is removed on time-out, so a late "connected" message cannot arrive;
  // if a store update still happens, it must pass the same session checks as any account change.
  const { c, port, clock, device } = await startedPage();
  port.signInScript = () => new Promise(() => undefined);
  const pr = c.connect();
  await clock.advance(5 * 60_000);
  await pr;
  assert.equal(c.getView().status, "disconnected");
  device.storage.set(INTEAR_STORAGE_KEY, session(ACCOUNT, { walletUrl: "https://evil.example" }));
  port.setStore(ACCOUNT);
  await flush();
  assert.deepEqual([c.getView().status, c.getView().accountId], ["disconnected", null], "invalid late session refused");
  device.storage.set(INTEAR_STORAGE_KEY, session(ACCOUNT));
  port.setStore(ACCOUNT);
  assert.deepEqual([c.getView().status, c.getView().accountId], ["connected", ACCOUNT], "valid late session accepted");
});

test("popup blocked -> actionable message", async () => {
  const { c, port } = await startedPage();
  port.signInScript = async () => {
    throw new Error("Popup was blocked");
  };
  await c.connect();
  assert.equal(c.getView().notice?.text, MESSAGES.popupBlocked);
});

test("connection failure with arbitrary wallet text -> generic failure, excerpt only, single line", async () => {
  const { c, port } = await startedPage();
  port.signInScript = async () => {
    throw new Error(`network\nunreachable ${"x".repeat(400)}`);
  };
  await c.connect();
  const t = c.getView().notice?.text ?? "";
  assert.match(t, /^The wallet connection failed \(network unreachable x+\)\. Please try again\.$/);
  assert.ok(t.length < 200);
});

test("malformed stored sessions are removed before the wallet library starts (previously: library crash, button disabled)", async () => {
  for (const bad of ["{not json", "null", "42", '{"accounts":[]}', '{"accounts":[null]}', '{"accounts":[{"accountId":7}],"key":"k"}', '{"accounts":[{"accountId":"a.testnet"}]}']) {
    const device = new SimDevice();
    device.storage.set(INTEAR_STORAGE_KEY, bad);
    device.storage.set("near-wallet-selector:selectedWalletId", '"intear-wallet"');
    const { c } = await startedPage(device);
    assert.equal(c.getView().status, "disconnected", bad);
    assert.equal(c.getView().notice?.text, MESSAGES.malformedSession, bad);
    assert.equal(device.storage.has(INTEAR_STORAGE_KEY), false, bad);
  }
});

test("well-formed but policy-invalid sessions (foreign wallet URL, contract key, bridge, non-testnet) are signed out on restore", async () => {
  for (const over of [{ walletUrl: "https://evil.example" }, { contractId: "escrow2.ebusky-linefair.testnet", methodNames: ["x"] }, { useBridge: true }]) {
    const device = new SimDevice();
    device.storage.set(INTEAR_STORAGE_KEY, session(ACCOUNT, over));
    device.storage.set("near-wallet-selector:selectedWalletId", '"intear-wallet"');
    const { c, port } = await startedPage(device);
    assert.deepEqual([c.getView().status, c.getView().accountId], ["disconnected", null], JSON.stringify(over));
    assert.equal(port.signOutCalls, 1);
    assert.equal(c.getView().notice?.kind, "warning");
  }
  const device = new SimDevice();
  device.storage.set(INTEAR_STORAGE_KEY, session("mainnet-user.near"));
  device.storage.set("near-wallet-selector:selectedWalletId", '"intear-wallet"');
  const { c } = await startedPage(device);
  assert.equal(c.getView().accountId, null, "a non-testnet account is never displayed");
});

test("library load failure -> 'unavailable' with retry; retry recovers and connects", async () => {
  const { c, port } = setup();
  port.initBehaviour = "fail";
  await c.start();
  assert.equal(c.getView().status, "unavailable");
  assert.equal(c.getView().notice?.text, MESSAGES.libraryFailed);
  port.initBehaviour = "ok";
  port.signInScript = succeed;
  await c.connect(); // first restarts the library, then signs in
  await c.connect();
  assert.equal(c.getView().status, "connected");
});

test("restoration that hangs (e.g. wallet logout check unreachable) -> unavailable after 20 s, not stuck", async () => {
  const { c, port, clock } = setup();
  port.initBehaviour = "hang";
  const p = c.start();
  await clock.advance(20_000);
  await p;
  assert.equal(c.getView().status, "unavailable");
  assert.equal(c.getView().notice?.text, MESSAGES.restoreTimeout);
});

test("repeated clicks while connecting start exactly one wallet sign-in", async () => {
  const { c, port, clock } = await startedPage();
  let finish: (() => void) | undefined;
  port.signInScript = (p) => new Promise((r) => (finish = () => r(p.completeSignIn(ACCOUNT))));
  const p1 = c.connect();
  void c.connect();
  void c.connect();
  await clock.advance(100);
  finish?.();
  await p1;
  assert.equal(port.signInCalls, 1);
  assert.equal(c.getView().status, "connected");
});

test("account changes reported by the wallet: switch is shown with a warning; remote logout disconnects", async () => {
  const { c, port, device } = await startedPage();
  port.signInScript = succeed;
  await c.connect();
  device.storage.set(INTEAR_STORAGE_KEY, session(OTHER));
  port.setStore(OTHER);
  assert.equal(c.getView().accountId, OTHER);
  assert.equal(c.getView().notice?.text, MESSAGES.accountChanged(OTHER));
  port.setStore(null);
  assert.deepEqual([c.getView().status, c.getView().accountId], ["disconnected", null]);
  assert.equal(c.getView().notice?.text, MESSAGES.externalSignOut);
});

test("an account change whose stored session does not match is refused and signed out", async () => {
  const { c, port } = await startedPage();
  port.signInScript = succeed;
  await c.connect();
  port.setStore(OTHER); // stored session still says ACCOUNT
  await flush();
  assert.deepEqual([c.getView().status, c.getView().accountId], ["disconnected", null]);
  assert.equal(c.getView().notice?.text, MESSAGES.mismatch);
});

test("error classification", () => {
  assert.equal(classifyConnectError(new Error("Popup was blocked")).kind, "popup-blocked");
  for (const m of ["User rejected", "User closed the window", "Request cancelled", "Access denied", "Popup closed"]) assert.equal(classifyConnectError(new Error(m)).kind, "cancelled", m);
  assert.equal(classifyConnectError(new Error("RPC 503")).kind, "failed");
  assert.equal(classifyConnectError(undefined).text, "The wallet connection failed. Please try again.");
});

test("isMalformedSession distinguishes broken records from absent and policy-invalid ones", () => {
  assert.equal(isMalformedSession(null), false);
  assert.equal(isMalformedSession(session(ACCOUNT)), false);
  assert.equal(isMalformedSession(session(ACCOUNT, { walletUrl: "https://evil.example" })), false);
  assert.equal(isMalformedSession("{"), true);
  assert.equal(isMalformedSession('{"accounts":[{"accountId":"a.testnet"}]}'), true);
});
