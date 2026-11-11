// Exact money and time formatting. BigInt only for token amounts and
// nanosecond timestamps; never floats (docs/07 header, ARCHITECTURE.md §5.4).

const MAX_DECIMALS = 38; // u128 max has 39 digits

function checkDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(`token decimals must be an integer 0..${MAX_DECIMALS}`);
  }
}

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Base units -> "1,234.5" (trailing fractional zeros trimmed, exact). */
export function formatUnits(base: bigint, decimals: number): string {
  checkDecimals(decimals);
  if (base < 0n) throw new RangeError("negative amount");
  const unit = 10n ** BigInt(decimals);
  const whole = base / unit;
  const frac = base % unit;
  const fracStr = decimals === 0 ? "" : frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr === "" ? group(whole.toString()) : `${group(whole.toString())}.${fracStr}`;
}

export type ParseUnitsResult = { ok: true; value: bigint } | { ok: false; error: string };

/**
 * Exact decimal text -> base units. Accepts `123`, `123.45`, optional
 * thousands commas in the integer part; rejects signs, exponents, spaces
 * inside, and more fractional digits than the token has (never rounds).
 */
export function parseUnits(input: string, decimals: number): ParseUnitsResult {
  checkDecimals(decimals);
  const s = input.trim();
  const m = /^((?:0|[1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*))(?:\.([0-9]+))?$/.exec(s);
  if (m === null) return { ok: false, error: "Enter a plain amount such as 1250 or 1250.50." };
  const whole = m[1].replace(/,/g, "");
  const frac = m[2] ?? "";
  if (frac.length > decimals) {
    return { ok: false, error: `This token has ${decimals} decimal places; amounts are never rounded.` };
  }
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (value > (1n << 128n) - 1n) return { ok: false, error: "Amount is too large." };
  return { ok: true, value };
}

const NS_PER_MS = 1_000_000n;

/** Nanoseconds since epoch -> "2027-01-16 08:00 UTC". */
export function formatNsUtc(ns: bigint): string {
  const ms = ns / NS_PER_MS;
  const d = new Date(Number(ms)); // ms < 2^53 for any date before year 287 000
  if (Number.isNaN(d.getTime())) return `${ns.toString()} ns`;
  const iso = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * Nanoseconds since epoch -> the same instant in a local time zone, e.g.
 * "2027-01-16 09:00 GMT+1". `timeZone` defaults to the browser's zone; tests
 * pass one explicitly. Seconds are dropped like formatNsUtc, so a window
 * that opens at 08:00:30 UTC shows 08:00 in both forms (the exact ns stays
 * available as the raw value).
 */
export function formatNsLocal(ns: bigint, timeZone?: string): string {
  const d = new Date(Number(ns / NS_PER_MS));
  if (Number.isNaN(d.getTime())) return `${ns.toString()} ns`;
  const parts = new Intl.DateTimeFormat("en-GB", {
    ...(timeZone !== undefined ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

/** `<input type="datetime-local">` value interpreted as UTC -> ns. null if invalid. */
export function utcInputToNs(value: string): bigint | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (m === null) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (Number.isNaN(ms)) return null;
  const check = new Date(ms).toISOString().slice(0, 16);
  if (check !== value) return null; // rejects 2026-02-30 etc.
  return BigInt(ms) * NS_PER_MS;
}

/** ns -> `<input type="datetime-local">` value in UTC. */
export function nsToUtcInput(ns: bigint): string {
  return new Date(Number(ns / NS_PER_MS)).toISOString().slice(0, 16);
}

const NS_PER_MINUTE = 60_000_000_000n;

/** Whole minutes (digits only) -> ns. null if not a canonical non-negative integer. */
export function minutesToNs(minutes: string): bigint | null {
  if (!/^(0|[1-9][0-9]{0,9})$/.test(minutes.trim())) return null;
  return BigInt(minutes.trim()) * NS_PER_MINUTE;
}

/** ns duration -> "72 h", "48 h 30 min", "1 min", "0". */
export function formatDurationNs(ns: bigint): string {
  if (ns === 0n) return "0";
  const totalMin = ns / NS_PER_MINUTE;
  const rem = ns % NS_PER_MINUTE;
  const h = totalMin / 60n;
  const m = totalMin % 60n;
  const parts: string[] = [];
  if (h > 0n) parts.push(`${h} h`);
  if (m > 0n) parts.push(`${m} min`);
  if (rem > 0n) parts.push(`${rem / 1_000_000_000n} s`);
  return parts.join(" ");
}

/** "5000" bps -> "50 %", "3333" -> "33.33 %". */
export function formatBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? `${whole} %` : `${whole}.${frac.toString().padStart(2, "0").replace(/0$/, "")} %`;
}

/** Shorten a 64-hex digest for display: "9257a5bf…a33c". The full value stays available. */
export function shortHash(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex;
}
