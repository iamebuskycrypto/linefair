// TS-20: no lossy Number conversions in the encoder sources (plan §4).
// A simple source scan, not a full lint: it fails on `Number(`, `parseInt`,
// `parseFloat`, `JSON.parse` and unary `+` applied to an identifier or call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const SRC = new URL("../src/", import.meta.url);

function files(dir: URL): URL[] {
  const out: URL[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...files(new URL(`${e.name}/`, dir)));
    else if (e.name.endsWith(".ts")) out.push(new URL(e.name, dir));
  }
  return out;
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

test("TS-20 no Number()/parseInt/parseFloat/JSON.parse/unary + in src", () => {
  const banned: [RegExp, string][] = [
    [/\bNumber\s*\(/, "Number("],
    [/\bparseInt\b/, "parseInt"],
    [/\bparseFloat\b/, "parseFloat"],
    [/\bJSON\.parse\b/, "JSON.parse"],
    [/(^|[=(,:?!&|]\s*|return\s+)\+\s*[A-Za-z_$(]/m, "unary +"],
  ];
  const hits: string[] = [];
  const list = files(SRC);
  assert.ok(list.length >= 7, "expected encoder sources");
  for (const f of list) {
    const src = stripComments(readFileSync(f, "utf8"));
    for (const [re, name] of banned) if (re.test(src)) hits.push(`${f.pathname.split("/src/")[1]}: ${name}`);
  }
  assert.deepEqual(hits, []);
});
