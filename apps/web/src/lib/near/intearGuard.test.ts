// Intear connector hardening (branch wallet/intear-spike): message origin gate
// and fail-closed session validation. Pure logic + a real EventTarget; the
// browser ordering is checked separately in headless Chrome (evidence log).

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkIntearSession, installIntearMessageGuard, INTEAR_ORIGIN, shouldBlockMessage } from "./intearGuard.ts";

const GOOD = {
  accounts: [{ accountId: "pilot-buyer.testnet", active: true }],
  key: "ed25519:not-inspected-by-the-check",
  contractId: "",
  methodNames: [],
  logoutKey: "ed25519:11111111111111111111111111111111",
  walletUrl: INTEAR_ORIGIN,
  useBridge: false,
};
const raw = (over: Record<string, unknown>) => JSON.stringify({ ...GOOD, ...over });

test("message gate blocks every Intear message type unless it comes from the Intear wallet origin", () => {
  for (const type of ["ready", "connected", "error", "close", "sent", "signed"]) {
    assert.equal(shouldBlockMessage("https://evil.example", { type }), true, type);
    assert.equal(shouldBlockMessage("http://wallet.intear.tech", { type }), true, `${type} over http`);
    assert.equal(shouldBlockMessage("https://wallet.intear.tech.evil.example", { type }), true, `${type} lookalike`);
    assert.equal(shouldBlockMessage("null", { type }), true, `${type} opaque origin`);
    assert.equal(shouldBlockMessage(INTEAR_ORIGIN, { type }), false, `${type} from Intear`);
  }
});

test("message gate leaves unrelated messages alone", () => {
  assert.equal(shouldBlockMessage("https://evil.example", { type: "something-else" }), false);
  assert.equal(shouldBlockMessage("https://evil.example", "connected"), false);
  assert.equal(shouldBlockMessage("https://evil.example", null), false);
  assert.equal(shouldBlockMessage("https://evil.example", { source: "react-devtools" }), false);
});

test("installed gate stops forged messages before later listeners; genuine ones pass", () => {
  const target = new EventTarget();
  const remove = installIntearMessageGuard(target);
  const seen: string[] = [];
  target.addEventListener("message", (e) => seen.push(`${(e as MessageEvent).origin}:${JSON.stringify((e as MessageEvent).data)}`));
  target.dispatchEvent(new MessageEvent("message", { origin: "https://evil.example", data: { type: "connected", walletUrl: "https://evil.example" } }));
  target.dispatchEvent(new MessageEvent("message", { origin: "https://evil.example", data: { type: "sent", outcomes: [] } }));
  target.dispatchEvent(new MessageEvent("message", { origin: INTEAR_ORIGIN, data: { type: "ready" } }));
  target.dispatchEvent(new MessageEvent("message", { origin: "https://evil.example", data: { type: "unrelated" } }));
  assert.deepEqual(seen, [`${INTEAR_ORIGIN}:{"type":"ready"}`, 'https://evil.example:{"type":"unrelated"}']);
  remove();
  target.dispatchEvent(new MessageEvent("message", { origin: "https://evil.example", data: { type: "connected" } }));
  assert.equal(seen.length, 3, "after removal the gate no longer filters");
});

test("session check accepts only the expected Intear testnet session", () => {
  assert.deepEqual(checkIntearSession(raw({})), { ok: true, accountId: "pilot-buyer.testnet" });
  assert.deepEqual(checkIntearSession(raw({ walletUrl: undefined })), { ok: true, accountId: "pilot-buyer.testnet" }, "absent walletUrl falls back to the configured origin");
});

test("session check fails closed on every unexpected field", () => {
  const bad: [string, string | null, RegExp][] = [
    ["no session", null, /not connected/],
    ["malformed JSON", "{", /unreadable/],
    ["no accounts", raw({ accounts: [] }), /no account/],
    ["foreign wallet URL", raw({ walletUrl: "https://evil.example" }), /wallet URL/],
    ["http wallet URL", raw({ walletUrl: "http://wallet.intear.tech" }), /wallet URL/],
    ["lookalike wallet URL", raw({ walletUrl: "https://wallet.intear.tech.evil.example" }), /wallet URL/],
    ["wallet URL with path trick", raw({ walletUrl: "https://wallet.intear.tech@evil.example" }), /wallet URL/],
    ["non-string wallet URL", raw({ walletUrl: 7 }), /wallet URL/],
    ["function-call key for a contract", raw({ contractId: "escrow.ebusky-linefair.testnet" }), /function-call key/],
    ["method names", raw({ methodNames: ["accept_terms"] }), /function-call key/],
    ["bridge mode", raw({ useBridge: true }), /bridge/],
    ["mainnet account", raw({ accounts: [{ accountId: "pilot.near", active: true }] }), /testnet/],
    ["invalid account id", raw({ accounts: [{ accountId: "Bad ID.testnet", active: true }] }), /testnet/],
    ["non-string account id", raw({ accounts: [{ accountId: 5 }] }), /testnet/],
  ];
  for (const [name, input, why] of bad) {
    const r = checkIntearSession(input);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.match(r.reason, why, name);
  }
});
