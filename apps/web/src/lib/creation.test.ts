import { test } from "node:test";
import assert from "node:assert/strict";

import { creationGate, CREATION_COPY } from "./creation.ts";

const LIST = ["buyer.lf-demo.testnet", "judge-buyer.testnet"] as const;

test("Create is allowed only for a connected allowlisted account that is the buyer", () => {
  assert.deepEqual(creationGate(LIST, "buyer.lf-demo.testnet", "buyer.lf-demo.testnet"), { kind: "allowed", accountId: "buyer.lf-demo.testnet" });
  assert.deepEqual(creationGate(LIST, "buyer.lf-demo.testnet", "  buyer.lf-demo.testnet "), { kind: "allowed", accountId: "buyer.lf-demo.testnet" });
  assert.equal(creationGate(LIST, "judge-buyer.testnet", "judge-buyer.testnet").kind, "allowed");
});

test("every other combination hides Create", () => {
  assert.equal(creationGate(null, "buyer.lf-demo.testnet", "buyer.lf-demo.testnet").kind, "preview");
  assert.equal(creationGate(LIST, null, "buyer.lf-demo.testnet").kind, "connect");
  // not listed, even when it names itself as buyer (the contract would answer ERR_CREATOR_NOT_ALLOWLISTED)
  assert.equal(creationGate(LIST, "supplier.lf-demo.testnet", "supplier.lf-demo.testnet").kind, "not_allowlisted");
  assert.equal(creationGate(LIST, "supplier.lf-demo.testnet", "buyer.lf-demo.testnet").kind, "not_allowlisted");
  // listed but naming another buyer (the contract would answer ERR_NOT_BUYER)
  assert.equal(creationGate(LIST, "buyer.lf-demo.testnet", "judge-buyer.testnet").kind, "not_buyer");
  assert.equal(creationGate(LIST, "buyer.lf-demo.testnet", "").kind, "not_buyer");
  // exact comparison, no case folding or suffix matching
  assert.equal(creationGate(LIST, "Buyer.lf-demo.testnet", "Buyer.lf-demo.testnet").kind, "not_allowlisted");
  assert.equal(creationGate(LIST, "x.buyer.lf-demo.testnet", "x.buyer.lf-demo.testnet").kind, "not_allowlisted");
  assert.equal(creationGate([], "buyer.lf-demo.testnet", "buyer.lf-demo.testnet").kind, "not_allowlisted");
});

test("copy says creation is limited and other roles remain available", () => {
  assert.match(CREATION_COPY.notAllowlisted, /limited to authorized testnet creators/);
  assert.match(CREATION_COPY.stillRoles, /supplier, primary arbitrator or backup arbitrator/);
  assert.doesNotMatch(Object.values(CREATION_COPY).join(" "), /\bpaid\b|guarantee/i);
});
