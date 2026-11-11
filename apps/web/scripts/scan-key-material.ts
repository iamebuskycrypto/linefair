// Scan built bundle and sources for key material (CLAUDE.md: never commit or
// bundle private keys). Pattern-based, so it can only show the ABSENCE of
// these known shapes, not prove that no secret exists. Prints file + pattern
// + a redacted excerpt for each hit (never the full match). Exit 1 on any
// hit, 2 on usage error.
//
// Usage: node scripts/scan-key-material.ts <dir> [<dir> ...]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const B58 = "[1-9A-HJ-NP-Za-km-z]";
const PATTERNS: [name: string, re: RegExp][] = [
  // NEAR secret keys: ed25519 secret = 64 bytes -> ~87-88 base58 chars (public keys are ~43-44).
  ["near-ed25519-secret", new RegExp(`ed25519:${B58}{80,}`, "g")],
  ["near-secp256k1-secret", new RegExp(`secp256k1:${B58}{80,}`, "g")],
  ["pem-private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["keyfile-json", /"(?:secret_key|private_key)"\s*:\s*"[^"]{16,}"/g],
  ["assigned-secret-literal", /\b(?:secretKey|privateKey|secret_key|private_key|seedPhrase|seed_phrase|mnemonic)\s*[:=]\s*["'`][^"'`\s]{16,}["'`]/g],
  ["env-secret", /\b(?:[A-Z_]*PRIVATE_KEY|[A-Z_]*SECRET_KEY|[A-Z_]*SEED_PHRASE)\s*=\s*\S{8,}/g],
  ["sandbox-or-credentials-path", /validator_key\.json|\.near-credentials|near-sandbox[^"'\s]*\/sbx/g],
  // 12/24-word lowercase phrase in a single string literal (bip39-like), conservative.
  ["word-phrase-literal", /["'`](?:[a-z]{3,8} ){11}[a-z]{3,8}(?: (?:[a-z]{3,8} ){11}[a-z]{3,8})?["'`]/g],
];

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: scan-key-material.ts <dir> [<dir> ...]");
  process.exit(2);
}

function* walk(p: string): Generator<string> {
  const st = statSync(p);
  if (st.isFile()) {
    yield p;
    return;
  }
  for (const e of readdirSync(p)) {
    if (e === "node_modules" || e === ".git") continue;
    yield* walk(join(p, e));
  }
}

let files = 0;
let bytes = 0;
let hits = 0;
for (const d of dirs) {
  for (const f of walk(d)) {
    const text = readFileSync(f, "utf8");
    files++;
    bytes += Buffer.byteLength(text);
    for (const [name, re] of PATTERNS) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        hits++;
        const s = m[0];
        console.log(`HIT ${name} ${f}@${m.index}: ${s.slice(0, 8)}…(${s.length} chars, redacted)`);
      }
    }
  }
}
console.log(`scanned ${files} files, ${bytes} bytes, ${PATTERNS.length} patterns: ${hits} hit(s)`);
process.exitCode = hits === 0 ? 0 : 1;
