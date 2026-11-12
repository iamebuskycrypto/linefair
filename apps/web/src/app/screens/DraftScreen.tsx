// S02 Draft agreement + priced line editor. The canonical terms hash is
// computed locally by the shared encoder (packages/shared-schemas), the same
// code that reproduces every Rust vector. Creating on chain needs a deployed
// escrow that passed the startup check, a connected account that is in its
// creator_allowlist AND the buyer (lib/creation.ts), and an equal
// contract-side compute_terms_hash.

import { useEffect, useMemo, useState } from "react";
import { useApp } from "../context.tsx";
import { Amount, Field, Notice, Status } from "../ui.tsx";
import {
  emptyDraft,
  emptyLine,
  evaluateDraft,
  FIXTURE,
  goldenSampleDraft,
  MAX_DRAFT_LINES,
  percentToBps,
  type Draft,
  type DraftContext,
  type DraftEvaluation,
  type DraftLine,
} from "../../lib/draft.ts";
import { fallbackSplit } from "../../lib/contract/states.ts";
import { describeError } from "../../lib/contract/errors.ts";
import { formatBps, formatDurationNs, formatNsUtc, minutesToNs, parseUnits } from "../../lib/format.ts";
import { createAgreementCall } from "../../lib/near/tx.ts";
import { readWalletOutcome } from "../../lib/near/walletOutcome.ts";
import { creationGate } from "../../lib/creation.ts";
import { CreateAgreementControl, CreatorNotice } from "./CreateControl.tsx";
import { fundabilityWarnings } from "../../lib/contract/lifecycle.ts";

interface PreviewContext {
  readonly source: "fixture" | "chain";
  readonly ctx: DraftContext;
  readonly symbol: string;
  readonly clock: string;
}

type CtxLoad = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; value: PreviewContext };

function useDraftContext(): CtxLoad {
  const { rpc, deployment } = useApp();
  const [load, setLoad] = useState<CtxLoad>(() =>
    deployment === null
      ? {
          state: "ready",
          value: {
            source: "fixture",
            symbol: "TEST",
            clock: "browser clock (no chain contract configured)",
            ctx: {
              network: "testnet",
              escrowId: FIXTURE.escrowId,
              ftId: FIXTURE.ftId,
              treasuryId: FIXTURE.treasuryId,
              nowNs: BigInt(Date.now()) * 1_000_000n,
              decimals: FIXTURE.decimals,
            },
          },
        }
      : { state: "loading" },
  );
  useEffect(() => {
    if (deployment === null) return;
    let cancelled = false;
    (async () => {
      // network, token and version were verified at startup (StartupGate)
      const cfg = deployment.escrowConfig;
      const ftId = cfg.allowlisted_ft_id;
      const meta = await rpc.view<{ decimals: number; symbol: string }>(ftId, "ft_metadata");
      const block = await rpc.finalBlock();
      if (!cancelled) {
        setLoad({
          state: "ready",
          value: {
            source: "chain",
            symbol: meta.value.symbol,
            clock: `chain time at block ${block.height.toString()}`,
            ctx: {
              network: "testnet",
              escrowId: deployment.escrowId,
              ftId,
              treasuryId: cfg.operator_treasury_id,
              nowNs: block.timestampNs,
              decimals: meta.value.decimals,
            },
          },
        });
      }
    })().catch((e: unknown) => {
      if (!cancelled) setLoad({ state: "error", message: (e as Error).message });
    });
    return () => {
      cancelled = true;
    };
  }, [deployment, rpc]);
  return load;
}

type Submit = { state: "idle" } | { state: "busy"; step: string } | { state: "blocked"; message: string } | { state: "submitted"; txHash: string | null };

export function DraftScreen() {
  const load = useDraftContext();
  const { rpc, wallet, deployment } = useApp();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [evaluation, setEvaluation] = useState<DraftEvaluation | null>(null);
  const [submit, setSubmit] = useState<Submit>({ state: "idle" });
  const [touched, setTouched] = useState(false);

  const pc = load.state === "ready" ? load.value : null;

  useEffect(() => {
    if (pc === null) return;
    let cancelled = false;
    evaluateDraft(draft, pc.ctx).then((r) => {
      if (!cancelled) setEvaluation(r);
    });
    return () => {
      cancelled = true;
    };
  }, [draft, pc]);

  const issues = useMemo(() => {
    const m = new Map<string, string>();
    if (evaluation !== null && evaluation.kind !== "valid") for (const i of evaluation.issues) if (!m.has(i.field)) m.set(i.field, i.message);
    return m;
  }, [evaluation]);
  const err = (field: string) => (touched ? issues.get(field) : undefined);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setTouched(true);
    setSubmit({ state: "idle" });
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const setLine = (i: number, patch: Partial<DraftLine>) =>
    set(
      "lines",
      draft.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    );

  const gate = creationGate(deployment?.creatorAllowlist ?? null, wallet.accountId, draft.buyer);
  const blockers: string[] = [];
  if (evaluation?.kind !== "valid") blockers.push("Complete the terms and fix the highlighted fields.");

  async function onCreate() {
    if (gate.kind !== "allowed" || evaluation?.kind !== "valid" || pc === null || pc.source !== "chain" || wallet.accountId === null) return;
    try {
      setSubmit({ state: "busy", step: "Checking the contract computes the same hash…" });
      const remote = await rpc.computeTermsHash(pc.ctx.escrowId, evaluation.termsJson);
      if (remote.value !== evaluation.hash) {
        setSubmit({ state: "blocked", message: "Terms could not be verified: the contract computes a different hash. Do not sign." });
        return;
      }
      setSubmit({ state: "busy", step: "Waiting for confirmation in your wallet…" });
      const { signAndSend } = await import("../../lib/near/wallet.ts");
      const outcome = await signAndSend(wallet.accountId, createAgreementCall(pc.ctx.escrowId, evaluation.termsJson));
      const txHash = readWalletOutcome(outcome).txHash;
      setSubmit({ state: "submitted", txHash });
    } catch (e) {
      const d = describeError((e as Error).message);
      setSubmit({ state: "blocked", message: `${d.title} ${d.action}` });
    }
  }

  const durationHint = (v: string) => {
    const ns = minutesToNs(v);
    return ns === null ? "Whole minutes" : `= ${formatDurationNs(ns)}`;
  };

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Advanced testnet creation</span>
        <h1>Plan the work, line by line.</h1>
        <p className="lede">
          Set who is involved, when work is due, and what each deliverable is worth. Agreement creation is currently limited to approved testnet accounts.
        </p>
      </div>

      <div className="draft-orientation" role="note">
        <strong>Just exploring?</strong> View the real settled agreement without filling out this advanced form or connecting a wallet.
        <a href="#/agreements/0">See the live demo ↗</a>
      </div>

      {load.state === "loading" && (
        <div className="panel" aria-busy="true">
          <p className="muted">Reading the escrow configuration and token details…</p>
        </div>
      )}
      {load.state === "error" && (
        <Notice tone="negative">
          <p>
            <strong>Could not read the escrow configuration.</strong> {load.message}
          </p>
          <p>Creating is disabled until the contract and token can be read.</p>
        </Notice>
      )}

      {pc !== null && (
        <div className="draft-layout">
          <div>
            <CreatorNotice gate={gate} />
            {pc.source === "fixture" && (
              <Notice tone="warning">
                <p>
                  <strong>Preview only.</strong> No escrow contract is deployed. The hash is computed for the fixture escrow{" "}
                  <code>{FIXTURE.escrowId}</code> and token <code>{FIXTURE.ftId}</code> from the shared test vectors, assuming 6 token
                  decimals. It is not a real agreement.
                </p>
              </Notice>
            )}

            <section className="panel" aria-labelledby="parties-h" style={{ marginTop: "var(--s2)" }}>
              <div className="panel-head">
                <h2 id="parties-h">1. Who is involved?</h2>
                <button className="button quiet" type="button" onClick={() => { setDraft(goldenSampleDraft()); setTouched(true); setSubmit({ state: "idle" }); }}>
                  Load developer sample
                </button>
              </div>
              <div className="grid-2">
                {(
                  [
                    ["buyer", "Client (buyer)", "Commissions the work, funds each deliverable and reviews delivery."],
                    ["supplier", "Service provider", "Delivers the work and receives accepted payments."],
                    ["primary", "Primary dispute resolver", "An appointed NEAR account that can rule on disputes within its window."],
                    ["backup", "Backup dispute resolver", "A different appointed account if the primary cannot act."],
                  ] as const
                ).map(([k, label, hint]) => (
                  <Field key={k} id={`f-${k}`} label={label} hint={hint} error={err(k)}>
                    {(a) => (
                      <input
                        {...a}
                        className="mono"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="name.testnet"
                        value={draft[k]}
                        onChange={(e) => set(k, e.target.value)}
                      />
                    )}
                  </Field>
                ))}
              </div>
              {err("roles") !== undefined && <p className="err small">{err("roles")}</p>}
            </section>

            <section className="panel" aria-labelledby="timeline-h">
              <div className="panel-head">
                <h2 id="timeline-h">2. When should it happen?</h2>
                <span className="small muted">All dates and times UTC</span>
              </div>
              <div className="grid-2">
                <Field id="f-acc" label="Agree to the terms by" hint="All four people must accept the same terms by this date." error={err("acceptanceDeadline")}>
                  {(a) => <input {...a} type="datetime-local" value={draft.acceptanceDeadline} onChange={(e) => set("acceptanceDeadline", e.target.value)} />}
                </Field>
                <Field id="f-fund" label="Fund the deliverables by" hint="The client sends each test payment before this date." error={err("fundingDeadline")}>
                  {(a) => <input {...a} type="datetime-local" value={draft.fundingDeadline} onChange={(e) => set("fundingDeadline", e.target.value)} />}
                </Field>
                <details className="draft-advanced" open={touched && ["graceMinutes", "reviewMinutes", "negotiationMinutes", "primaryMinutes", "backupMinutes", "nonce"].some((key) => issues.has(key)) ? true : undefined}>
                  <summary>Advanced dispute windows and timing <span className="small muted">Defaults are prefilled</span></summary>
                  <p className="small muted draft-advanced-help">These settings control how long each review, negotiation and dispute-resolution stage lasts. They become part of the agreed terms.</p>
                  <div className="grid-2">
                {(
                  [
                    ["graceMinutes", "Delivery grace period", "Extra time after each delivery deadline (0 to 30 days)."],
                    ["reviewMinutes", "Buyer review window", "Default 72 h."],
                    ["negotiationMinutes", "Negotiation window", "Default 48 h."],
                    ["primaryMinutes", "Primary arbitrator window", "Default 72 h."],
                    ["backupMinutes", "Backup arbitrator window", "Default 72 h."],
                  ] as const
                ).map(([k, label, hint]) => (
                  <Field key={k} id={`f-${k}`} label={`${label} (minutes)`} hint={`${hint} ${durationHint(draft[k])}`} error={err(k)}>
                    {(a) => <input {...a} inputMode="numeric" value={draft[k]} onChange={(e) => set(k, e.target.value)} />}
                  </Field>
                ))}
                <Field id="f-nonce" label="Agreement nonce" hint="Change it to register otherwise identical terms." error={err("nonce")}>
                  {(a) => <input {...a} inputMode="numeric" value={draft.nonce} onChange={(e) => set("nonce", e.target.value)} />}
                </Field>
                  </div>
                </details>
              </div>
            </section>

            <section className="panel" aria-labelledby="lines-h">
              <div className="panel-head">
                <h2 id="lines-h">3. What will be delivered?</h2>
                <span className="small muted">{draft.lines.length} of {MAX_DRAFT_LINES}</span>
              </div>
              {draft.lines.map((l, i) => (
                <LineEditor
                  key={i}
                  index={i}
                  line={l}
                  decimals={pc.ctx.decimals}
                  symbol={pc.symbol}
                  err={err}
                  onChange={(p) => setLine(i, p)}
                  {...(draft.lines.length > 1 ? { onRemove: () => set("lines", draft.lines.filter((_, j) => j !== i)) } : {})}
                />
              ))}
              {err("lines") !== undefined && <p className="err small">{err("lines")}</p>}
              <div className="actions" style={{ marginTop: "var(--s2)" }}>
                <button
                  className="button secondary"
                  type="button"
                  disabled={draft.lines.length >= MAX_DRAFT_LINES}
                  onClick={() => set("lines", [...draft.lines, emptyLine()])}
                >
                  Add deliverable
                </button>
              </div>
            </section>
          </div>

          <aside className="sticky" aria-labelledby="terms-h">
            <div className="panel">
              <div className="panel-head">
                <h2 id="terms-h">Review agreement</h2>
              </div>
              <TermsSummary evaluation={evaluation} pc={pc} />
              <div style={{ marginTop: "var(--s3)" }}>
                <CreateAgreementControl gate={gate} blockers={blockers} busy={submit.state === "busy"} onCreate={onCreate} />
                {submit.state === "busy" && <p className="small muted" style={{ marginTop: "var(--s1)" }}>{submit.step}</p>}
                {submit.state === "blocked" && (
                  <div style={{ marginTop: "var(--s1)" }}>
                    <Notice tone="negative">
                      <p>{submit.message}</p>
                    </Notice>
                  </div>
                )}
                {submit.state === "submitted" && (
                  <div style={{ marginTop: "var(--s1)" }}>
                    <Notice>
                      <p>
                        Transaction submitted{submit.txHash !== null ? <> (<code>{submit.txHash}</code>)</> : null}. The agreement exists only
                        once the contract shows it in the agreement list.
                      </p>
                    </Notice>
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

function LineEditor(props: {
  index: number;
  line: DraftLine;
  decimals: number;
  symbol: string;
  err: (f: string) => string | undefined;
  onChange: (p: Partial<DraftLine>) => void;
  onRemove?: () => void;
}) {
  const { index: i, line, decimals, symbol, err } = props;
  const amount = parseUnits(line.amount, decimals);
  const sbps = percentToBps(line.supplierPercent);
  const split = amount.ok && sbps !== null ? fallbackSplit(amount.value, sbps) : null;
  return (
    <div className="line-card">
      <header>
        <h3>Deliverable {i + 1}</h3>
        {props.onRemove !== undefined && (
          <button className="button quiet" type="button" onClick={props.onRemove}>
            Remove
          </button>
        )}
      </header>
      <div className="grid-2">
        <Field id={`l${i}-amt`} label={`Amount (${symbol})`} hint={`Exact amount; ${decimals} decimal places, never rounded.`} error={err(`lines.${i}.amount`)}>
          {(a) => <input {...a} inputMode="decimal" value={line.amount} onChange={(e) => props.onChange({ amount: e.target.value })} />}
        </Field>
        <Field id={`l${i}-del`} label="Delivery deadline" hint="UTC. On or after the funding deadline." error={err(`lines.${i}.deliveryDeadline`)}>
          {(a) => <input {...a} type="datetime-local" value={line.deliveryDeadline} onChange={(e) => props.onChange({ deliveryDeadline: e.target.value })} />}
        </Field>
      </div>
      <Field
        id={`l${i}-com`}
        label="Proof of the agreed acceptance criteria"
        hint="Advanced: 64 lowercase hexadecimal characters. Prepare a salted SHA-256 digest of written acceptance criteria externally, and save the criteria and salt privately. This form cannot generate that proof yet."
        error={err(`lines.${i}.commitment`)}
      >
        {(a) => (
          <input {...a} className="mono" autoComplete="off" spellCheck={false} value={line.commitment} onChange={(e) => props.onChange({ commitment: e.target.value })} />
        )}
      </Field>
      <div className="grid-2">
        <Field
          id={`l${i}-bps`}
          label="Service provider's fallback share (%)"
          hint={sbps === null ? "0 to 100" : `Buyer receives ${formatBps(10_000 - sbps)}.`}
          error={err(`lines.${i}.supplierPercent`)}
        >
          {(a) => <input {...a} inputMode="decimal" value={line.supplierPercent} onChange={(e) => props.onChange({ supplierPercent: e.target.value })} />}
        </Field>
        <div>
          <p className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Fallback split</p>
          {split === null ? (
            <p className="small muted">Enter an amount and a share to see the exact split.</p>
          ) : (
            <dl className="split">
              <dt>Supplier</dt>
              <dd><Amount base={split.supplier} decimals={decimals} symbol={symbol} /></dd>
              <dt>Buyer</dt>
              <dd><Amount base={split.buyer} decimals={decimals} symbol={symbol} /></dd>
            </dl>
          )}
          <p className="small muted" style={{ marginTop: 4 }}>
            Scheduled to become eligible only after both arbitrator windows pass; someone must then call the contract.
          </p>
        </div>
      </div>
    </div>
  );
}

function TermsSummary({ evaluation, pc }: { evaluation: DraftEvaluation | null; pc: PreviewContext }) {
  const context = (
    <dl className="kv" style={{ marginTop: "var(--s2)" }}>
      <dt>Network</dt>
      <dd>{pc.ctx.network}</dd>
      <dt>Escrow</dt>
      <dd className="mono">{pc.ctx.escrowId}{pc.source === "fixture" ? " (fixture)" : ""}</dd>
      <dt>Token</dt>
      <dd className="mono">{pc.ctx.ftId}{pc.source === "fixture" ? " (fixture)" : ""}</dd>
      <dt>Checked against</dt>
      <dd>{pc.clock}</dd>
    </dl>
  );
  if (evaluation === null) return <p className="muted small">Computing…</p>;
  if (evaluation.kind !== "valid") {
    return (
      <>
        <Status state={{ label: evaluation.kind === "incomplete" ? "Incomplete" : "Not valid", tone: evaluation.kind === "incomplete" ? "neutral" : "warning" }} />
        <p className="small muted" style={{ marginTop: "var(--s1)" }}>
          No hash is shown until the terms pass the same checks the contract applies.
          {evaluation.kind === "invalid" ? ` First problem: ${evaluation.issues[0]?.message ?? evaluation.code}` : ""}
        </p>
        {context}
      </>
    );
  }
  const t = evaluation.terms;
  const total = t.lines.reduce((a, l) => a + l.principal, 0n);
  const isGolden = pc.source === "fixture" && evaluation.hash === FIXTURE.goldenDigest;
  return (
    <>
      <div className="actions">
        <Status state={{ label: "Valid terms", tone: "positive" }} />
        {evaluation.accelerated && <Status state={{ label: "Accelerated timing — test only", tone: "warning" }} />}
      </div>
      <p className="small muted" style={{ marginTop: "var(--s2)" }}>Terms hash (SHA-256, encoding v1)</p>
      <p className="hash" aria-label="Terms hash">{evaluation.hash}</p>
      {isGolden && <p className="small" style={{ marginTop: 4 }}>Matches shared test vector T059 (golden).</p>}
      <dl className="kv" style={{ marginTop: "var(--s2)" }}>
        <dt>Lines</dt>
        <dd className="num">{t.lines.length}</dd>
        <dt>Total</dt>
        <dd><Amount base={total} decimals={pc.ctx.decimals} symbol={pc.symbol} /></dd>
        <dt>Accept by</dt>
        <dd className="num">{formatNsUtc(t.acceptance_deadline_ns)}</dd>
        <dt>Fund by</dt>
        <dd className="num">{formatNsUtc(t.funding_deadline_ns)}</dd>
      </dl>
      {fundabilityWarnings(t).length > 0 && (
        <div data-fundability="warning">
          <Notice tone="warning">
            <p>
              <strong>Fundability warning (the contract accepts these terms).</strong> Under the approved funding rule F3 a deposit is credited only while
              the supplier keeps at least the review window before delivery deadline + grace.
            </p>
            {fundabilityWarnings(t).map((w) => (
              <p key={w.lineId}>{w.message}</p>
            ))}
          </Notice>
        </div>
      )}
      {context}
    </>
  );
}
