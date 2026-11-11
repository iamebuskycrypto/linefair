// Strict JSON reader for the terms edge (TS_ENCODER_TEST_PLAN.md §3).
//
// `JSON.parse` is not used for terms: it keeps the last of duplicate keys,
// cannot tell `5000` from `5000.0`, and accepts lone surrogate escapes. This
// reader follows RFC 8259 the way serde_json 1.0.154 `from_str` does:
// - whitespace is only space, tab, LF, CR; no BOM;
// - exactly one value, trailing non-whitespace is an error;
// - strings reject raw control characters (< 0x20), invalid escapes and
//   unpaired surrogates (escaped or raw);
// - numbers keep their exact lexeme; the grammar is
//   `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`;
// - a key repeated inside one object is an error (serde derive reports a
//   duplicate field for every object that maps to a struct, and no other
//   objects are allowed in the terms);
// - nesting deeper than 128 is an error (serde_json default recursion limit).
// Every failure is a `JsonSyntaxError`; the terms parser maps it to code `Json`.

export type JsonValue =
  | { readonly kind: "object"; readonly entries: ReadonlyMap<string, JsonValue> }
  | { readonly kind: "array"; readonly items: readonly JsonValue[] }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly lexeme: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "null" };

export class JsonSyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "JsonSyntaxError";
    this.offset = offset;
  }
}

const MAX_DEPTH = 128;

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

class Reader {
  private readonly s: string;
  private i = 0;

  constructor(s: string) {
    this.s = s;
  }

  private fail(msg: string): never {
    throw new JsonSyntaxError(msg, this.i);
  }

  private peek(): number {
    return this.i < this.s.length ? this.s.charCodeAt(this.i) : -1;
  }

  private skipWs(): void {
    while (this.i < this.s.length && isWs(this.s.charCodeAt(this.i))) this.i++;
  }

  document(): JsonValue {
    this.skipWs();
    if (this.i >= this.s.length) this.fail("EOF while parsing a value");
    const v = this.value(0);
    this.skipWs();
    if (this.i !== this.s.length) this.fail("trailing characters");
    return v;
  }

  private value(depth: number): JsonValue {
    const c = this.peek();
    switch (c) {
      case 0x7b: // {
        return this.object(depth + 1);
      case 0x5b: // [
        return this.array(depth + 1);
      case 0x22: // "
        return { kind: "string", value: this.string() };
      case 0x74: // t
        this.literal("true");
        return { kind: "bool", value: true };
      case 0x66: // f
        this.literal("false");
        return { kind: "bool", value: false };
      case 0x6e: // n
        this.literal("null");
        return { kind: "null" };
      default:
        if (c === 0x2d || isDigit(c)) return { kind: "number", lexeme: this.number() };
        return this.fail(c === -1 ? "EOF while parsing a value" : "expected value");
    }
  }

  private literal(word: string): void {
    if (this.s.startsWith(word, this.i)) {
      this.i += word.length;
      return;
    }
    this.fail("expected ident");
  }

  private object(depth: number): JsonValue {
    if (depth > MAX_DEPTH) this.fail("recursion limit exceeded");
    this.i++; // {
    const entries = new Map<string, JsonValue>();
    this.skipWs();
    if (this.peek() === 0x7d) {
      this.i++;
      return { kind: "object", entries };
    }
    for (;;) {
      this.skipWs();
      if (this.peek() !== 0x22) this.fail("key must be a string");
      const keyStart = this.i;
      const key = this.string();
      if (entries.has(key)) {
        this.i = keyStart;
        this.fail(`duplicate field \`${key}\``);
      }
      this.skipWs();
      if (this.peek() !== 0x3a) this.fail("expected `:`");
      this.i++;
      this.skipWs();
      entries.set(key, this.value(depth));
      this.skipWs();
      const c = this.peek();
      if (c === 0x2c) {
        this.i++;
        continue;
      }
      if (c === 0x7d) {
        this.i++;
        return { kind: "object", entries };
      }
      this.fail("expected `,` or `}`");
    }
  }

  private array(depth: number): JsonValue {
    if (depth > MAX_DEPTH) this.fail("recursion limit exceeded");
    this.i++; // [
    const items: JsonValue[] = [];
    this.skipWs();
    if (this.peek() === 0x5d) {
      this.i++;
      return { kind: "array", items };
    }
    for (;;) {
      this.skipWs();
      items.push(this.value(depth));
      this.skipWs();
      const c = this.peek();
      if (c === 0x2c) {
        this.i++;
        continue;
      }
      if (c === 0x5d) {
        this.i++;
        return { kind: "array", items };
      }
      this.fail("expected `,` or `]`");
    }
  }

  private hex4(): number {
    if (this.i + 4 > this.s.length) this.fail("EOF while parsing a string");
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const h = hexVal(this.s.charCodeAt(this.i + k));
      if (h < 0) this.fail("invalid escape");
      v = (v << 4) | h;
    }
    this.i += 4;
    return v;
  }

  private string(): string {
    this.i++; // opening quote
    let out = "";
    for (;;) {
      if (this.i >= this.s.length) this.fail("EOF while parsing a string");
      const c = this.s.charCodeAt(this.i);
      if (c === 0x22) {
        this.i++;
        return out;
      }
      if (c < 0x20) this.fail("control character in string");
      if (c === 0x5c) {
        this.i++;
        const e = this.peek();
        this.i++;
        switch (e) {
          case 0x22: out += '"'; break;
          case 0x5c: out += "\\"; break;
          case 0x2f: out += "/"; break;
          case 0x62: out += "\b"; break;
          case 0x66: out += "\f"; break;
          case 0x6e: out += "\n"; break;
          case 0x72: out += "\r"; break;
          case 0x74: out += "\t"; break;
          case 0x75: {
            const u = this.hex4();
            if (u >= 0xdc00 && u <= 0xdfff) this.fail("lone trailing surrogate in hex escape");
            if (u >= 0xd800 && u <= 0xdbff) {
              if (this.s.charCodeAt(this.i) !== 0x5c || this.s.charCodeAt(this.i + 1) !== 0x75) {
                this.fail("lone leading surrogate in hex escape");
              }
              this.i += 2;
              const lo = this.hex4();
              if (lo < 0xdc00 || lo > 0xdfff) this.fail("lone leading surrogate in hex escape");
              out += String.fromCharCode(u, lo);
            } else {
              out += String.fromCharCode(u);
            }
            break;
          }
          default:
            this.i--;
            this.fail("invalid escape");
        }
        continue;
      }
      // Raw UTF-16 code units: a surrogate must be a well-formed pair, otherwise
      // the text has no UTF-8 encoding (serde_json only ever sees valid UTF-8).
      if (c >= 0xd800 && c <= 0xdbff) {
        const lo = this.s.charCodeAt(this.i + 1);
        if (!(lo >= 0xdc00 && lo <= 0xdfff)) this.fail("unpaired surrogate");
        out += this.s.slice(this.i, this.i + 2);
        this.i += 2;
        continue;
      }
      if (c >= 0xdc00 && c <= 0xdfff) this.fail("unpaired surrogate");
      out += this.s[this.i];
      this.i++;
    }
  }

  private number(): string {
    const start = this.i;
    if (this.peek() === 0x2d) this.i++;
    const first = this.peek();
    if (first === 0x30) {
      this.i++;
      if (isDigit(this.peek())) this.fail("invalid number");
    } else if (isDigit(first)) {
      while (isDigit(this.peek())) this.i++;
    } else {
      this.fail("invalid number");
    }
    if (this.peek() === 0x2e) {
      this.i++;
      if (!isDigit(this.peek())) this.fail("invalid number");
      while (isDigit(this.peek())) this.i++;
    }
    const e = this.peek();
    if (e === 0x65 || e === 0x45) {
      this.i++;
      const sign = this.peek();
      if (sign === 0x2b || sign === 0x2d) this.i++;
      if (!isDigit(this.peek())) this.fail("invalid number");
      while (isDigit(this.peek())) this.i++;
    }
    return this.s.slice(start, this.i);
  }
}

/** Parse one JSON document strictly. Throws `JsonSyntaxError`. */
export function parseStrictJson(text: string): JsonValue {
  return new Reader(text).document();
}
