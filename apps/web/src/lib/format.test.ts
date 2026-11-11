import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatBps,
  formatDurationNs,
  formatNsUtc,
  formatUnits,
  minutesToNs,
  nsToUtcInput,
  parseUnits,
  shortHash,
  utcInputToNs,
} from "./format.ts";

const U128_MAX = (1n << 128n) - 1n;

test("formatUnits is exact", () => {
  assert.equal(formatUnits(500_000_000n, 6), "500");
  assert.equal(formatUnits(1_234_567_890n, 6), "1,234.56789");
  assert.equal(formatUnits(1n, 24), "0.000000000000000000000001");
  assert.equal(formatUnits(0n, 6), "0");
  assert.equal(formatUnits(U128_MAX, 0), "340,282,366,920,938,463,463,374,607,431,768,211,455");
  assert.throws(() => formatUnits(-1n, 6));
  assert.throws(() => formatUnits(1n, 1.5));
});

test("parseUnits never rounds and rejects ambiguous input", () => {
  assert.deepEqual(parseUnits("500", 6), { ok: true, value: 500_000_000n });
  assert.deepEqual(parseUnits("1,250.50", 6), { ok: true, value: 1_250_500_000n });
  assert.deepEqual(parseUnits("0.000001", 6), { ok: true, value: 1n });
  assert.deepEqual(parseUnits(" 7 ", 0), { ok: true, value: 7n });
  for (const bad of ["", "-1", "+1", "1e3", "1.", ".5", "01", "1,25", "1 000", "0x10", "1.0000001", "NaN", "١"]) {
    assert.equal(parseUnits(bad, 6).ok, false, bad);
  }
  assert.equal(parseUnits(U128_MAX.toString(), 0).ok, true);
  assert.equal(parseUnits((U128_MAX + 1n).toString(), 0).ok, false);
  // round trip
  for (const v of [1n, 999_999n, 1_000_000n, 123_456_789_012n]) {
    const r = parseUnits(formatUnits(v, 6), 6);
    assert.deepEqual(r, { ok: true, value: v });
  }
});

test("UTC time conversion", () => {
  assert.equal(formatNsUtc(1_800_086_400_000_000_000n), "2027-01-16 08:00 UTC");
  assert.equal(utcInputToNs("2027-01-16T08:00"), 1_800_086_400_000_000_000n);
  assert.equal(nsToUtcInput(1_800_086_400_000_000_000n), "2027-01-16T08:00");
  assert.equal(utcInputToNs("2026-02-30T10:00"), null);
  assert.equal(utcInputToNs("2026-11-03 10:00"), null);
  assert.equal(utcInputToNs(""), null);
});

test("durations and bps", () => {
  assert.equal(minutesToNs("4320"), 259_200_000_000_000n);
  assert.equal(minutesToNs("1"), 60_000_000_000n);
  assert.equal(minutesToNs("0"), 0n);
  for (const bad of ["", "-1", "1.5", "01", "1e3"]) assert.equal(minutesToNs(bad), null, bad);
  assert.equal(formatDurationNs(259_200_000_000_000n), "72 h");
  assert.equal(formatDurationNs(60_000_000_000n), "1 min");
  assert.equal(formatDurationNs(59_999_999_999n), "59 s");
  assert.equal(formatBps(5000), "50 %");
  assert.equal(formatBps(3333), "33.33 %");
  assert.equal(formatBps(10), "0.1 %");
  assert.equal(formatBps(0), "0 %");
  assert.equal(shortHash("9257a5bfea49918f0a1b1a3308ad553a384079e73da987df495f55002869a33c"), "9257a5bf…a33c");
});
