// Build-time guard for client environment variables (used by vite.config.ts,
// unit-tested in envGuard.test.ts and end-to-end in scripts/bundle-env.test.ts).
//
// Vite inlines `import.meta.env.X` into the public JavaScript. main.tsx reads
// only PUBLIC_ENV_KEYS by name; this guard makes the build FAIL if
// - any VITE_* variable has a secret-like name or a credential-like value, or
// - any other VITE_* variable name, or the value of one, appears in the output
//   (e.g. Vercel's "Automatically expose System Environment Variables", which
//   adds VITE_VERCEL_GIT_COMMIT_AUTHOR_NAME, …_MESSAGE, project/deployment ids).
// Messages name the variable only, never its value.

export const PUBLIC_ENV_KEYS = ["VITE_NEAR_NETWORK", "VITE_NEAR_RPC_URL", "VITE_NEAR_EXPLORER_URL", "VITE_ESCROW_ID", "VITE_FT_ID"] as const;

/**
 * Same words as config.ts FORBIDDEN, plus token/credential/bearer names. ("AUTH" alone is not used:
 * Vercel's VITE_VERCEL_GIT_COMMIT_AUTHOR_* would match and fail every Vercel build; those are caught
 * by the bundle-leak check instead.)
 */
export const FORBIDDEN_ENV_NAME = /(SECRET|PRIVATE|SEED|MNEMONIC|PASSWORD|KEY|TOKEN|CREDENTIAL|BEARER)/i;

const B58 = "[1-9A-HJ-NP-Za-km-z]";
const CREDENTIAL_VALUE: readonly [string, RegExp][] = [
  ["NEAR secret key", new RegExp(`(?:ed25519|secp256k1):${B58}{80,}`)],
  ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["word phrase", /^(?:[a-z]{3,8} ){11}[a-z]{3,8}(?: (?:[a-z]{3,8} ){11}[a-z]{3,8})?$/],
  ["JWT", /^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./],
  ["GitHub token", /^(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|^github_pat_/],
  ["API secret", /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|^sk-[A-Za-z0-9_-]{20,}/],
];

type Env = Readonly<Record<string, string | undefined>>;

function viteEntries(env: Env): [string, string][] {
  return Object.entries(env).filter((e): e is [string, string] => e[0].startsWith("VITE_") && typeof e[1] === "string");
}

/** Errors for the build environment (names only). */
export function checkBuildEnv(env: Env): string[] {
  const errors: string[] = [];
  for (const [k, v] of viteEntries(env)) {
    if (FORBIDDEN_ENV_NAME.test(k)) errors.push(`${k}: secret-like VITE_* variable names are not allowed (VITE_* values are public)`);
    for (const [what, re] of CREDENTIAL_VALUE) {
      if (re.test(v.trim())) errors.push(`${k}: value looks like a ${what}; VITE_* values are public`);
    }
  }
  return errors;
}

/**
 * Leaks of non-public VITE_* variables in emitted code: their names, or values of 12+ characters
 * (shorter values such as "main" or "production" occur naturally in code and are covered by the name check).
 */
export function findBundleLeaks(code: string, env: Env): string[] {
  const allowed = new Set<string>(PUBLIC_ENV_KEYS);
  const publicValues = new Set(PUBLIC_ENV_KEYS.map((k) => env[k]).filter((v): v is string => typeof v === "string" && v !== ""));
  const leaks: string[] = [];
  for (const [k, v] of viteEntries(env)) {
    if (allowed.has(k)) continue;
    if (code.includes(k)) leaks.push(`${k}: variable name present in the bundle`);
    else if (v.length >= 12 && !publicValues.has(v) && code.includes(v)) leaks.push(`${k}: variable value present in the bundle`);
  }
  // Any VITE_* identifier outside the allowlist, even if not in this build's env (e.g. inlined env object).
  // (Vite's internal `__VITE_PRELOAD__` placeholder is excluded by requiring a non-identifier character before.)
  for (const m of code.matchAll(/(?<![A-Za-z0-9_$])VITE_[A-Z0-9_]+/g)) {
    if (!allowed.has(m[0]) && !leaks.some((l) => l.startsWith(`${m[0]}:`))) leaks.push(`${m[0]}: variable name present in the bundle`);
  }
  return leaks;
}
