import { test } from "node:test";
import assert from "node:assert/strict";

import { acceptAppointmentCall, acceptTermsCall, createAgreementCall, fundLineCall, GAS, withdrawCall } from "./tx.ts";

const H = "9257a5bfea49918f0a1b1a3308ad553a384079e73da987df495f55002869a33c";

test("escrow calls are non-payable and target the escrow", () => {
  for (const c of [
    createAgreementCall("escrow.testnet", {} as never),
    acceptTermsCall("escrow.testnet", "0", H),
    acceptAppointmentCall("escrow.testnet", "0", H),
  ]) {
    assert.equal(c.receiverId, "escrow.testnet");
    assert.equal(c.deposit, 0n);
    assert.ok(c.gas >= 30_000_000_000_000n);
  }
  assert.deepEqual(acceptTermsCall("e.testnet", "4", H).args, { agreement_id: "4", terms_hash: H });
});

test("funding goes to the token with exactly 1 yocto and the v1 message", () => {
  const c = fundLineCall("ft.testnet", "escrow.testnet", "3", 1, 300_000_000n, H);
  assert.equal(c.receiverId, "ft.testnet");
  assert.equal(c.methodName, "ft_transfer_call");
  assert.equal(c.deposit, 1n);
  assert.equal(c.gas, GAS.fund);
  assert.deepEqual(c.args, {
    receiver_id: "escrow.testnet",
    amount: "300000000",
    msg: `{"version":1,"agreement_id":"3","line_id":1,"terms_hash":"${H}"}`,
  });
  assert.throws(() => fundLineCall("ft.testnet", "escrow.testnet", "3", 3, 1n, H));
});

test("withdraw goes to the escrow with exactly 1 yocto and 100 Tgas; beneficiary is exact uppercase", () => {
  const b = withdrawCall("escrow.testnet", "3", 0, "BUYER");
  const s = withdrawCall("escrow.testnet", "3", 2, "SUPPLIER");
  for (const c of [b, s]) {
    assert.equal(c.receiverId, "escrow.testnet");
    assert.equal(c.methodName, "withdraw");
    assert.equal(c.deposit, 1n);
    assert.equal(c.gas, 100_000_000_000_000n);
  }
  assert.deepEqual(b.args, { agreement_id: "3", line_id: 0, beneficiary: "BUYER" });
  assert.deepEqual(s.args, { agreement_id: "3", line_id: 2, beneficiary: "SUPPLIER" });
  assert.deepEqual(Object.keys(b.args), ["agreement_id", "line_id", "beneficiary"]);
  for (const bad of ["Buyer", "buyer", "SUPPLIER ", "OPERATOR"]) assert.throws(() => withdrawCall("escrow.testnet", "3", 0, bad as never));
});
