// End-to-end bundle test (npm run test:bundle): runs real Vite production
// builds in memory (build.write = false; nothing is written to disk) with
// Vercel-style system variables and credential-like canaries in the
// environment, and checks what reaches the emitted JavaScript.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build, type Rolldown } from "vite";

import { envLeakGuard } from "../vite.config.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/env-leak/", import.meta.url));

const PUBLIC = {
  VITE_NEAR_NETWORK: "testnet",
  VITE_NEAR_RPC_URL: "https://rpc.testnet.fastnear.com",
  VITE_NEAR_EXPLORER_URL: "https://testnet.nearblocks.io",
  VITE_ESCROW_ID: "escrow2.ebusky-linefair.testnet",
  VITE_FT_ID: "demo-ft.ebusky-linefair.testnet",
};
const CANARIES = {
  VITE_VERCEL_GIT_COMMIT_AUTHOR_LOGIN: "canary-login-7f3a9c",
  VITE_VERCEL_GIT_COMMIT_AUTHOR_NAME: "Canary Author 7f3a9c",
  VITE_VERCEL_GIT_COMMIT_MESSAGE: "canary commit message 7f3a9c",
  VITE_VERCEL_PROJECT_ID: "prj_canary7f3a9cProject",
  VITE_VERCEL_DEPLOYMENT_ID: "dpl_canary7f3a9cDeploy",
  VITE_VERCEL_OBSERVABILITY_CLIENT_CONFIG: '{"analytics":"canary7f3a9c/script.js"}',
  VITE_UNRELATED_SETTING: "unrelated-canary-7f3a9c",
};
// Realistic Vercel preview values that coincide with text in the app (footer GitHub link).
const VERCEL_REAL = {
  VITE_VERCEL_ENV: "preview",
  VITE_VERCEL_GIT_PROVIDER: "github",
  VITE_VERCEL_GIT_REPO_OWNER: "iamebuskycrypto",
  VITE_VERCEL_GIT_REPO_SLUG: "linefair",
  VITE_VERCEL_GIT_COMMIT_REF: "qa/wallet-uat-final",
  VITE_VERCEL_PROJECT_PRODUCTION_URL: "linefair-ebuskys-projects.vercel.app",
};

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(process.env).filter((k) => k.startsWith("VITE_")).map((k) => [k, process.env[k]]));
  for (const k of saved.keys()) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith("VITE_")) delete process.env[k];
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
}

function jsOf(out: Awaited<ReturnType<typeof build>>): string {
  const outputs = (Array.isArray(out) ? out : [out]) as Rolldown.RolldownOutput[];
  return outputs.flatMap((o) => o.output).map((c) => (c.type === "chunk" ? c.code : typeof c.source === "string" ? c.source : "")).join("\n");
}

const buildApp = () => build({ root: APP, configFile: `${APP}vite.config.ts`, logLevel: "silent", build: { write: false } });

test("production build: Vercel metadata and unrelated VITE_* values never reach the bundle; public config does", async () => {
  const js = jsOf(await withEnv({ ...PUBLIC, ...CANARIES }, buildApp));
  assert.ok(!js.includes("7f3a9c"), "a canary value reached the bundle");
  assert.equal(/(?<![A-Za-z0-9_$])VITE_VERCEL_/.test(js), false, "a VITE_VERCEL_* name reached the bundle");
  assert.ok(js.includes(PUBLIC.VITE_ESCROW_ID), "escrow id missing: startup verification would not run");
  assert.ok(js.includes(PUBLIC.VITE_FT_ID), "token id missing");
  assert.ok(js.includes(PUBLIC.VITE_NEAR_RPC_URL), "RPC URL missing");
  assert.ok(js.includes("linefair-escrow 0.1.0 (lf-012 f3)"), "expected contract version missing: startup check absent");
});

test("regression (Vercel preview failure): realistic Vercel preview variables build successfully and add no VITE_* names", async () => {
  const js = jsOf(await withEnv({ ...PUBLIC, ...VERCEL_REAL, ...CANARIES }, buildApp));
  assert.equal(/(?<![A-Za-z0-9_$])VITE_VERCEL_/.test(js), false);
  assert.ok(!js.includes("7f3a9c"));
});

test("production build is refused when a secret-like VITE_* variable is present, without printing its value", async () => {
  await assert.rejects(
    withEnv({ ...PUBLIC, VITE_ESCROW_PRIVATE_KEY: "do-not-print-7f3a9c" }, buildApp),
    (e: Error) => /VITE_ESCROW_PRIVATE_KEY/.test(e.message) && !e.message.includes("do-not-print-7f3a9c"),
  );
});

test("production build is refused when a VITE_* value looks like a NEAR secret key", async () => {
  await assert.rejects(withEnv({ ...PUBLIC, VITE_EXTRA: `ed25519:${"4".repeat(88)}` }, buildApp), /VITE_EXTRA: value looks like a NEAR secret key/);
});

test("regression: a build that inlines the whole env object (old main.tsx pattern) is refused by the guard", async () => {
  await assert.rejects(
    withEnv({ ...PUBLIC, ...CANARIES }, () => build({ root: FIXTURE, configFile: false, logLevel: "silent", plugins: [envLeakGuard()], build: { write: false } })),
    (e: Error) => /import\.meta\.env is used as a whole object/.test(e.message) && !e.message.includes("Canary Author"),
  );
});
