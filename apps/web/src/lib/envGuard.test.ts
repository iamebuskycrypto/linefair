// Build-environment guard (envGuard.ts): pure checks. The end-to-end build
// test is scripts/bundle-env.test.ts (npm run test:bundle).

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkBuildEnv, findBundleLeaks, findEnvAccess, PUBLIC_ENV_KEYS } from "./envGuard.ts";
import { parseConfig } from "./config.ts";

const PUBLIC = {
  VITE_NEAR_NETWORK: "testnet",
  VITE_NEAR_RPC_URL: "https://rpc.testnet.fastnear.com",
  VITE_NEAR_EXPLORER_URL: "https://testnet.nearblocks.io",
  VITE_ESCROW_ID: "escrow2.ebusky-linefair.testnet",
  VITE_FT_ID: "demo-ft.ebusky-linefair.testnet",
};
// Shapes of the variables Vercel adds with "Automatically expose System Environment Variables" (canary values).
const VERCEL = {
  VITE_VERCEL_ENV: "production",
  VITE_VERCEL_GIT_COMMIT_AUTHOR_LOGIN: "canary-login-0001",
  VITE_VERCEL_GIT_COMMIT_AUTHOR_NAME: "Canary Author Name",
  VITE_VERCEL_GIT_COMMIT_MESSAGE: "canary commit message text",
  VITE_VERCEL_PROJECT_ID: "prj_canaryProjectId0001",
  VITE_VERCEL_DEPLOYMENT_ID: "dpl_canaryDeploymentId01",
};

test("the five public keys are exactly the ones main.tsx passes to parseConfig", () => {
  assert.deepEqual([...PUBLIC_ENV_KEYS], Object.keys(PUBLIC));
});

test("a normal public environment, including Vercel system variables, is accepted at build time", () => {
  assert.deepEqual(checkBuildEnv({ ...PUBLIC, ...VERCEL }), []);
});

test("secret-like VITE_* names are refused, naming the variable but never echoing its value", () => {
  for (const k of ["VITE_ESCROW_PRIVATE_KEY", "VITE_SEED_PHRASE", "VITE_API_KEY", "VITE_DEPLOY_TOKEN", "VITE_DB_PASSWORD", "VITE_CLIENT_SECRET", "VITE_MNEMONIC", "VITE_NEAR_CREDENTIALS"]) {
    const errors = checkBuildEnv({ ...PUBLIC, [k]: "value-that-must-not-be-printed" });
    assert.equal(errors.length >= 1, true, k);
    assert.ok(errors[0]?.startsWith(`${k}:`), k);
    assert.ok(!errors.join("\n").includes("value-that-must-not-be-printed"), `${k} value echoed`);
  }
});

test("credential-like VALUES are refused even under an innocuous name", () => {
  const nearSecret = `ed25519:${"3".repeat(88)}`;
  const cases: Record<string, string> = {
    VITE_A: nearSecret,
    VITE_B: "-----BEGIN PRIVATE KEY-----\nabc",
    VITE_C: "abandon ability able about above absent absorb abstract absurd abuse access accident",
    VITE_D: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig",
    VITE_E: `ghp_${"a".repeat(36)}`,
    VITE_F: `sk_live_${"b".repeat(24)}`,
  };
  for (const [k, v] of Object.entries(cases)) {
    const errors = checkBuildEnv({ ...PUBLIC, [k]: v });
    assert.equal(errors.length, 1, k);
    assert.ok(!errors[0]?.includes(v.slice(0, 12)), `${k} value echoed`);
  }
  // A public key (43-44 base58 chars) and URLs are not credentials.
  assert.deepEqual(checkBuildEnv({ ...PUBLIC, VITE_X: `ed25519:${"3".repeat(44)}` }), []);
});

test("bundle leak check: an inlined env object (the old main.tsx pattern) is detected", () => {
  const inlined = `const e={${Object.entries({ ...PUBLIC, ...VERCEL }).map(([k, v]) => `${k}:\`${v}\``).join(",")}};parse(e)`;
  const leaks = findBundleLeaks(inlined, { ...PUBLIC, ...VERCEL });
  for (const k of Object.keys(VERCEL)) assert.ok(leaks.some((l) => l.startsWith(`${k}:`)), `${k} not detected`);
  for (const k of PUBLIC_ENV_KEYS) assert.ok(!leaks.some((l) => l.startsWith(`${k}:`)), `${k} wrongly flagged`);
});

test("source check: whole-object env use and non-public VITE_* reads are refused; the five public reads pass", () => {
  assert.deepEqual(findEnvAccess("parseConfig(import.meta.env)"), ["import.meta.env is used as a whole object (would inline every VITE_* variable)"]);
  assert.deepEqual(findEnvAccess("x = import.meta.env.VITE_VERCEL_PROJECT_ID"), ["import.meta.env.VITE_VERCEL_PROJECT_ID is not an allowed public setting"]);
  assert.deepEqual(findEnvAccess(PUBLIC_ENV_KEYS.map((k) => `import.meta.env.${k}`).join(";") + ";import.meta.env.DEV"), []);
});

test("regression (Vercel preview failure 2026-11-12): a Vercel value equal to text already in the app is not a leak", () => {
  const code = `a="https://github.com/iamebuskycrypto/linefair#security"`;
  assert.deepEqual(findBundleLeaks(code, { ...PUBLIC, VITE_VERCEL_GIT_REPO_OWNER: "iamebuskycrypto", VITE_VERCEL_GIT_REPO_SLUG: "linefair" }), []);
});

test("bundle leak check: public values, short values and Vite's own placeholder are not leaks", () => {
  const code = `a="escrow2.ebusky-linefair.testnet";b="https://rpc.testnet.fastnear.com";c="production";d="__VITE_PRELOAD__";e="VITE_NEAR_RPC_URL must use https"`;
  assert.deepEqual(findBundleLeaks(code, { ...PUBLIC, ...VERCEL }), []);
});

test("runtime config check still refuses secret-like keys passed to parseConfig (not weakened)", () => {
  const r = parseConfig({ ...PUBLIC, VITE_SECRET_KEY: "x" });
  assert.equal(r.ok, false);
});
