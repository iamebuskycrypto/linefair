// Real-browser wallet UI check: headless system Chrome over the DevTools
// Protocol (Node 24 global WebSocket; no npm dependency), loopback app only.
//
// It drives the REAL production build, the real Intear module and the real
// connector iframe from wallet.intear.tech. Steps marked SIMULATED inject
// storage records or remove the connector to imitate a wallet outcome. They
// test LineFair's handling of those outcomes; they are NOT a real-wallet
// connection, and no wallet credentials exist or are created. The simulated
// session uses an unparsable key on purpose, so the Intear module never
// contacts its logout service with it.
//
// Usage: node scripts/wallet-browser-check.ts <chrome> <http://127.0.0.1:PORT/> <out-dir> <profile-dir-that-must-not-exist> [widths=390,1440]
// Exit 0 only if every check passes.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [chrome, url, outDir, prof, widthsArg = "390,1440"] = process.argv.slice(2);
if (chrome === undefined || url === undefined || outDir === undefined || prof === undefined) {
  console.error("usage: wallet-browser-check.ts <chrome> <http://127.0.0.1:PORT/> <out-dir> <new-profile-dir> [widths]");
  process.exit(2);
}
if (!url.startsWith("http://127.0.0.1:")) {
  console.error("refusing: url must be http://127.0.0.1:<port>/");
  process.exit(2);
}
if (existsSync(prof)) {
  console.error("refusing: profile dir already exists");
  process.exit(2);
}
mkdirSync(prof, { recursive: true });
mkdirSync(outDir, { recursive: true });

const PORT = 9336;
const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-extensions", "--disable-component-update", "--disable-default-apps", "--no-pings", "--password-store=basic", "--use-mock-keychain", `--user-data-dir=${prof}`, "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore" });
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try {
    proc.kill();
  } catch {}
  try {
    rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("uncaughtException", (e) => {
  console.error(e);
  process.exit(3);
});
process.on("unhandledRejection", (e) => {
  console.error(e);
  process.exit(3);
});
setTimeout(() => {
  console.error("timeout: 10 minutes");
  process.exit(4);
}, 600_000).unref();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Target = { type: string; id: string; webSocketDebuggerUrl: string };
async function targets(): Promise<Target[]> {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as Target[];
}
let list: Target[] = [];
for (let i = 0; i < 80; i++) {
  try {
    list = await targets();
    if (list.some((t) => t.type === "page")) break;
  } catch {}
  await sleep(250);
}
if (!list.some((t) => t.type === "page")) {
  console.error("chrome did not start");
  process.exit(3);
}

class Page {
  private id = 0;
  private readonly pend = new Map<number, (v: unknown) => void>();
  readonly hosts = new Set<string>();
  exceptions: string[] = [];
  private readonly ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: unknown; method?: string; params?: Record<string, unknown> };
      if (m.id !== undefined && this.pend.has(m.id)) {
        this.pend.get(m.id)!(m.result ?? m.error);
        this.pend.delete(m.id);
      } else if (m.method === "Network.requestWillBeSent") {
        try {
          this.hosts.add(new URL((m.params as { request: { url: string } }).request.url).host);
        } catch {}
      } else if (m.method === "Runtime.exceptionThrown") {
        const d = (m.params as { exceptionDetails: { text?: string; exception?: { description?: string } } }).exceptionDetails;
        this.exceptions.push(String(d.exception?.description ?? d.text ?? "exception").split("\n")[0]!.slice(0, 160));
      }
    };
  }
  static async open(t: Target): Promise<Page> {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    const p = new Page(ws);
    await p.send("Page.enable");
    await p.send("Runtime.enable");
    await p.send("Network.enable");
    return p;
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((r) => {
      const i = ++this.id;
      this.pend.set(i, r);
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  async eval<T>(expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as { result?: { value?: T } };
    return r.result?.value as T;
  }
  async waitFor(expression: string, ms = 30_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.eval<boolean>(`!!(${expression})`)) return true;
      await sleep(200);
    }
    return false;
  }
  async goto(u: string) {
    await this.send("Page.navigate", { url: u });
    await sleep(500);
  }
  async reload() {
    await this.send("Page.reload", { ignoreCache: true });
    await sleep(500);
  }
  async click(selector: string): Promise<boolean> {
    const r = await this.eval<{ x: number; y: number } | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:"center"}); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    if (r === null || r === undefined) return false;
    for (const type of ["mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
    return true;
  }
  async shot(file: string) {
    const r = (await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })) as { data: string };
    writeFileSync(file, Buffer.from(r.data, "base64"));
  }
  close() {
    this.ws.close();
  }
}

const results: { width: number; check: string; pass: boolean; detail?: string }[] = [];
const ok = (width: number, check: string, pass: boolean, detail?: string) => {
  results.push({ width, check, pass, ...(detail !== undefined ? { detail } : {}) });
  console.log(`${pass ? "PASS" : "FAIL"} [${width}] ${check}${detail !== undefined ? ` — ${detail}` : ""}`);
};

const KEY = "_intear_wallet_connected_account";
const SEL = "near-wallet-selector:selectedWalletId";
const SIM_ACCOUNT = "simulated-uat-account.testnet";
const simSession = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ accounts: [{ accountId: SIM_ACCOUNT, active: true }], key: "SIMULATED-not-a-key", contractId: "", methodNames: [], logoutKey: "ed25519:11111111111111111111111111111111", walletUrl: "https://wallet.intear.tech", useBridge: false, ...over });
const setStorage = (entries: Record<string, string | null>) =>
  `(() => { ${Object.entries(entries).map(([k, v]) => (v === null ? `localStorage.removeItem(${JSON.stringify(k)});` : `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`)).join(" ")} return true; })()`;
const STATUS = (s: string) => `document.querySelector('[data-wallet-status="${s}"]')`;
const NOTICE_TEXT = `(document.querySelector('[data-wallet-notice]')?.innerText ?? '')`;
const CONNECTOR = `[...document.querySelectorAll('iframe')].some(f => f.src.startsWith('https://wallet.intear.tech/wallet-connector-iframe.html'))`;
const OVERFLOW = `document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`;
const READY = `${STATUS("disconnected")} || document.querySelector('[data-wallet-account]')`;
const APP_OK = `document.querySelector('.topbar') && !document.body.innerText.includes('Configuration refused')`;

const page = await Page.open(list.find((t) => t.type === "page")!);
const appUrl = url.replace(/#.*$/, "") + "#/agreements/0";

for (const width of widthsArg.split(",").map(Number)) {
  page.exceptions = [];
  await page.send("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 600 });
  await page.goto(appUrl);
  await page.eval(setStorage({ [KEY]: null, [SEL]: null }));
  await page.reload();

  // 1. Initialisation (startup contract checks must pass first).
  ok(width, "startup gate passed (contract verified) and app rendered", await page.waitFor(APP_OK, 45_000));
  ok(width, "wallet initialises to disconnected; Connect button enabled", await page.waitFor(`${STATUS("disconnected")} && !document.querySelector('[data-wallet-status] button').disabled`, 30_000));
  ok(width, "no horizontal overflow (disconnected)", !(await page.eval<boolean>(OVERFLOW)));
  await page.shot(join(outDir, `wallet-${width}-1-disconnected.png`));

  // 2. Real connect: real Intear connector iframe opens.
  await page.click('[data-wallet-status="disconnected"] button');
  ok(width, "connect shows 'Waiting for wallet…' with guidance and disables the button", await page.waitFor(`${STATUS("connecting")} && document.querySelector('[data-wallet-status] button').disabled && ${NOTICE_TEXT}.includes('Complete the connection')`, 15_000));
  ok(width, "real Intear connector iframe (wallet.intear.tech) present", await page.waitFor(CONNECTOR, 15_000));
  await sleep(2_500); // let the real connector load and post "ready"
  await page.shot(join(outDir, `wallet-${width}-2-connecting.png`));

  // 3. Unexpected message origin: a forged Intear "connected" from this page's origin must be dropped.
  await page.eval(`window.postMessage({ type: "connected", accounts: [{ accountId: "forged.testnet" }], logoutKey: "ed25519:11111111111111111111111111111111", walletUrl: "https://evil.example", functionCallKeyAdded: false, useBridge: false }, "*")`);
  await sleep(1_500);
  ok(width, "forged 'connected' message from a non-Intear origin ignored (no session stored, still connecting)", (await page.eval<string | null>(`localStorage.getItem(${JSON.stringify(KEY)})`)) === null && (await page.eval<boolean>(`!!${STATUS("connecting")}`)));

  // 4. SIMULATED popup closure: the connector disappears without a result (Intear 'close' without message).
  await page.eval(`document.querySelectorAll('iframe').forEach(f => { if (f.src.startsWith('https://wallet.intear.tech/')) f.remove(); })`);
  ok(width, "SIMULATED closure -> back to disconnected with 'closed before the connection finished' message", await page.waitFor(`${STATUS("disconnected")} && ${NOTICE_TEXT}.includes('closed before the connection finished')`, 5_000));
  ok(width, "notice is announced politely (role=status)", await page.eval<boolean>(`document.querySelector('[data-wallet-notice]')?.getAttribute('role') === 'status'`));
  ok(width, "no horizontal overflow (notice shown)", !(await page.eval<boolean>(OVERFLOW)));
  await page.shot(join(outDir, `wallet-${width}-3-interrupted.png`));

  // 5. Retry works (repeat attempt), then dismiss.
  const clicked = await page.click('[data-wallet-status="disconnected"] button');
  const retried = (await page.waitFor(`${STATUS("connecting")}`, 10_000)) && (await page.waitFor(CONNECTOR, 10_000));
  const diag = await page.eval<string>(`JSON.stringify({ clicked: ${clicked}, status: document.querySelector('[data-wallet-status]')?.getAttribute('data-wallet-status') ?? 'none', notice: ${NOTICE_TEXT}.slice(0, 80), connector: ${CONNECTOR} })`);
  await page.eval(`document.querySelectorAll('iframe').forEach(f => { if (f.src.startsWith('https://wallet.intear.tech/')) f.remove(); })`);
  ok(width, "retry opens the connector again and recovers to disconnected", retried && (await page.waitFor(`${STATUS("disconnected")}`, 5_000)), retried ? undefined : diag);
  await page.click('[aria-label="Dismiss wallet message"]');
  ok(width, "notice can be dismissed", await page.waitFor(`!document.querySelector('[data-wallet-notice]')`, 3_000));

  // 6. SIMULATED malformed session -> removed, warning, wallet still usable.
  await page.eval(setStorage({ [KEY]: "{broken", [SEL]: '"intear-wallet"' }));
  await page.reload();
  ok(width, "malformed stored session removed on load with a warning; Connect still enabled", await page.waitFor(`${STATUS("disconnected")} && ${NOTICE_TEXT}.includes('unreadable and has been removed') && !document.querySelector('[data-wallet-status] button').disabled`, 30_000));
  ok(width, "malformed record no longer in storage", (await page.eval<string | null>(`localStorage.getItem(${JSON.stringify(KEY)})`)) === null);

  // 7. SIMULATED session with a foreign wallet URL -> signed out, not displayed.
  await page.eval(setStorage({ [KEY]: simSession({ walletUrl: "https://evil.example" }), [SEL]: '"intear-wallet"' }));
  await page.reload();
  ok(width, "policy-invalid session (foreign wallet URL) signed out on restore and never displayed", (await page.waitFor(`${STATUS("disconnected")} && document.querySelector('[data-wallet-notice="warning"]')`, 30_000)) && !(await page.eval<boolean>(`document.body.innerText.includes(${JSON.stringify(SIM_ACCOUNT)})`)));

  // 8. SIMULATED valid session: display, refresh, reopen, disconnect, persistent disconnect.
  await page.eval(setStorage({ [KEY]: simSession(), [SEL]: '"intear-wallet"' }));
  await page.reload();
  ok(width, "SIMULATED session restored: account shown", await page.waitFor(`document.querySelector('[data-wallet-account]')?.textContent === ${JSON.stringify(SIM_ACCOUNT)}`, 30_000));
  ok(width, "no horizontal overflow (account shown)", !(await page.eval<boolean>(OVERFLOW)));
  await page.shot(join(outDir, `wallet-${width}-4-simulated-connected.png`));
  await page.reload();
  ok(width, "SIMULATED session persists after refresh", await page.waitFor(`document.querySelector('[data-wallet-account]')?.textContent === ${JSON.stringify(SIM_ACCOUNT)}`, 30_000));
  // Reopen: new tab in the same profile.
  const created = (await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" })).json()) as Target;
  const tab2 = await Page.open(created);
  await tab2.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  ok(width, "SIMULATED session restored in a newly opened tab", await tab2.waitFor(`document.querySelector('[data-wallet-account]')?.textContent === ${JSON.stringify(SIM_ACCOUNT)}`, 45_000));
  tab2.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${created.id}`);
  await page.click(".wallet button");
  ok(width, "Disconnect returns to disconnected with confirmation", await page.waitFor(`${STATUS("disconnected")} && ${NOTICE_TEXT}.includes('isconnected')`, 15_000));
  ok(width, "Disconnect cleared the Intear and selector records", (await page.eval<boolean>(`localStorage.getItem(${JSON.stringify(KEY)}) === null && localStorage.getItem(${JSON.stringify(SEL)}) === null`)));
  await page.reload();
  ok(width, "no restoration after explicit disconnect (refresh)", (await page.waitFor(READY, 30_000)) && (await page.eval<boolean>(`!!${STATUS("disconnected")} && !document.querySelector('[data-wallet-account]')`)));
  await page.shot(join(outDir, `wallet-${width}-5-after-disconnect.png`));

  ok(width, "no uncaught page exceptions", page.exceptions.length === 0, page.exceptions.slice(0, 3).join(" | ") || undefined);
}

const hosts = [...page.hosts].sort();
const allowed = (h: string) => h.startsWith("127.0.0.1:") || h === "rpc.testnet.fastnear.com" || h === "wallet.intear.tech" || h.endsWith(".intear.tech");
ok(0, "network hosts limited to the app, FastNear testnet RPC and Intear", hosts.every(allowed), hosts.join(", "));
writeFileSync(join(outDir, "wallet-browser-check.json"), JSON.stringify({ url, widths: widthsArg, results, hosts }, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
page.close();
process.exit(failed === 0 ? 0 : 1);
