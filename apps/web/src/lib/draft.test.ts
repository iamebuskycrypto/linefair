import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyDraft, evaluateDraft, FIXTURE, goldenSampleDraft, percentToBps, type DraftContext } from "./draft.ts";

const ctx: DraftContext = {
  network: FIXTURE.network,
  escrowId: FIXTURE.escrowId,
  ftId: FIXTURE.ftId,
  treasuryId: FIXTURE.treasuryId,
  nowNs: 1_800_000_000_000_000_000n, // vector context now_ns
  decimals: FIXTURE.decimals,
};

test("golden sample draft hashes to the shared T059 digest", async () => {
  const r = await evaluateDraft(goldenSampleDraft(), ctx);
  assert.equal(r.kind, "valid");
  if (r.kind !== "valid") return;
  assert.equal(r.hash, FIXTURE.goldenDigest);
  assert.equal(r.accelerated, false);
  assert.equal(r.termsJson.lines[1].fallback_buyer_bps, 6000);
  assert.equal(r.termsJson.lines[1].principal, "300000000");
});

test("changing one field changes the hash; escrow id is bound", async () => {
  const d = goldenSampleDraft();
  d.lines[2].amount = "200.000001";
  const r = await evaluateDraft(d, ctx);
  assert.ok(r.kind === "valid" && r.hash !== FIXTURE.goldenDigest);
  const other = await evaluateDraft(goldenSampleDraft(), { ...ctx, escrowId: "escrow2.lf-demo.testnet" });
  assert.ok(other.kind === "valid" && other.hash !== FIXTURE.goldenDigest);
});

test("conversion issues are reported per field before canonical checks", async () => {
  const r = await evaluateDraft(emptyDraft(), ctx);
  assert.equal(r.kind, "incomplete");
  if (r.kind !== "incomplete") return;
  const fields = r.issues.map((i) => i.field);
  for (const f of ["acceptanceDeadline", "fundingDeadline", "lines.0.amount", "lines.0.commitment", "lines.0.deliveryDeadline"]) {
    assert.ok(fields.includes(f), f);
  }
  const d = goldenSampleDraft();
  d.lines[0].amount = "1.0000001"; // 7 decimals for a 6-decimal token: never rounded
  const r2 = await evaluateDraft(d, ctx);
  assert.ok(r2.kind === "incomplete" && r2.issues[0].field === "lines.0.amount");
});

test("validator errors map to the right field with plain copy", async () => {
  const cases: [string, (d: ReturnType<typeof goldenSampleDraft>) => void, string][] = [
    ["RolesNotDistinct", (d) => (d.supplier = d.buyer), "supplier"],
    ["RoleIsReservedAccount", (d) => (d.primary = FIXTURE.escrowId), "primary"],
    ["AcceptanceDeadlineNotInFuture", (d) => (d.acceptanceDeadline = "2027-01-15T08:00"), "acceptanceDeadline"],
    ["FundingDeadlineBeforeAcceptance", (d) => (d.fundingDeadline = "2027-01-16T07:59"), "fundingDeadline"],
    ["WindowOutOfRange", (d) => (d.negotiationMinutes = "0"), "negotiationMinutes"],
    ["DeliveryGraceOutOfRange", (d) => (d.graceMinutes = "43201"), "graceMinutes"],
    ["ZeroPrincipal", (d) => (d.lines[1].amount = "0"), "lines.1.amount"],
    ["DeliveryDeadlineBeforeFunding", (d) => (d.lines[2].deliveryDeadline = "2027-01-17T07:59"), "lines.2.deliveryDeadline"],
  ];
  for (const [code, mutate, field] of cases) {
    const d = goldenSampleDraft();
    mutate(d);
    const r = await evaluateDraft(d, ctx);
    assert.equal(r.kind, "invalid", code);
    if (r.kind !== "invalid") continue;
    assert.equal(r.code, code);
    assert.equal(r.issues[0].field, field, code);
  }
  const d = goldenSampleDraft();
  d.buyer = "Buyer.testnet";
  const r = await evaluateDraft(d, ctx);
  assert.ok(r.kind === "invalid" && r.stage === "parse" && r.code === "InvalidAccountId" && r.issues[0].field === "buyer");
  const w = await evaluateDraft(goldenSampleDraft(), { ...ctx, ftId: "other-ft.testnet" });
  // ft id comes from the escrow config, so a mismatch can only mean misconfiguration
  assert.ok(w.kind === "valid");
});

test("accelerated timing is derived, and a 4th line is refused", async () => {
  const d = goldenSampleDraft();
  d.reviewMinutes = "5";
  const r = await evaluateDraft(d, ctx);
  assert.ok(r.kind === "valid" && r.accelerated);
  d.lines.push({ ...d.lines[0] });
  const r4 = await evaluateDraft(d, ctx);
  assert.ok(r4.kind === "incomplete" && r4.issues.some((i) => i.field === "lines"));
});

test("percentToBps", () => {
  assert.equal(percentToBps("40"), 4000);
  assert.equal(percentToBps("33.33"), 3333);
  assert.equal(percentToBps("0.5"), 50);
  assert.equal(percentToBps("100"), 10_000);
  assert.equal(percentToBps("0"), 0);
  for (const bad of ["", "100.01", "101", "-1", "1e1", "40.123", "040"]) assert.equal(percentToBps(bad), null, bad);
});

test("F3 fundability: the golden sample (shared vector, unchanged) warns for line 1 only; moving its delivery to funding + review clears it", async () => {
  const { fundabilityWarnings } = await import("./contract/lifecycle.ts");
  const r = await evaluateDraft(goldenSampleDraft(), ctx);
  assert.equal(r.kind, "valid");
  if (r.kind !== "valid") return;
  // funding 2027-01-17 08:00 + review 72 h = 2027-01-20 08:00; line 1 delivers 2027-01-19 08:00, lines 2/3 at or after 01-20.
  assert.deepEqual(fundabilityWarnings(r.terms).map((w) => w.lineId), [0]);
  const d = goldenSampleDraft();
  d.lines[0].deliveryDeadline = "2027-01-20T08:00";
  const r2 = await evaluateDraft(d, ctx);
  assert.ok(r2.kind === "valid");
  if (r2.kind === "valid") assert.deepEqual(fundabilityWarnings(r2.terms), []);
});
