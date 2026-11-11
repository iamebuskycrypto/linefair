// LF-008 timed arbitration and fallback: pure derivations over `LineView`
// (main b28d33b, lf-008). The contract is the authority. These functions
// only decide what the UI shows and offers; every action is re-checked by
// the contract against its own block time and the result is judged by a
// fresh get_agreement read.
//
// Contract rules mirrored (deadlines.rs dispute_phase / phase_starts,
// line.rs submit_ruling / trigger_fallback, agreement.rs submit_ruling):
// - Phases are half-open, measured from the fixed T0 of the dispute:
//   NEGOTIATION [T0, T0+N), PRIMARY [T0+N, T0+N+A), BACKUP [T0+N+A, T0+N+A+B),
//   FALLBACK [T0+N+A+B, ∞). At each exact boundary the earlier authority ends.
// - Primary arbitrator rules only in PRIMARY, backup only in BACKUP
//   (else ERR_LINE:NotRulingWindow); anyone else ERR_LINE:NotAuthorized.
// - buyer + supplier == principal exactly (AllocationSumMismatch).
// - Anyone may trigger the fallback in FALLBACK (else FallbackNotEligible):
//   supplier = floor(P·bps/10 000), buyer = P − supplier. No amount input.
// - Mutual settlement (LF-007) stays available in every phase.
// - The first finalization wins; later ones get AlreadyFinalized.

import { fallbackSplit, u128, type StateLabel, type Tone } from "./states.ts";
import type { LineView } from "./types.ts";
import type { Role } from "./settlement.ts";

export type PhaseKey = "NEGOTIATION" | "PRIMARY" | "BACKUP" | "FALLBACK";

export interface PhaseStep {
  readonly key: PhaseKey;
  readonly title: string;
  /** Who can decide in this phase, in plain words. */
  readonly who: string;
  readonly startNs: bigint;
  /** Exclusive end; null for the open-ended fallback phase. */
  readonly endNs: bigint | null;
  readonly position: "past" | "current" | "upcoming";
}

export type Timeline =
  | { readonly ok: true; readonly current: PhaseKey; readonly label: StateLabel; readonly steps: readonly PhaseStep[] }
  | { readonly ok: false; readonly label: StateLabel };

/** Agreement-level hashed windows (terms JSON strings, ns). */
export interface Windows {
  readonly negotiation_window_ns: string;
  readonly primary_window_ns: string;
  readonly backup_window_ns: string;
}

const ORDER: readonly PhaseKey[] = ["NEGOTIATION", "PRIMARY", "BACKUP", "FALLBACK"];

const TITLE: Record<PhaseKey, [title: string, who: string, current: string, tone: Tone]> = {
  NEGOTIATION: ["Negotiation", "Buyer and supplier may settle by mutual agreement. No arbitrator can rule yet.", "Dispute: negotiation", "warning"],
  PRIMARY: ["Primary arbitrator", "The primary arbitrator may rule. Buyer and supplier may still settle mutually.", "Dispute: primary arbitrator window", "warning"],
  BACKUP: ["Backup arbitrator", "The backup arbitrator may rule. The primary arbitrator can no longer rule. Mutual settlement remains possible.", "Dispute: backup arbitrator window", "warning"],
  FALLBACK: ["Contractual fallback", "Anyone may apply the pre-agreed fallback split. Mutual settlement remains possible until a decision is recorded.", "Dispute: fallback available", "warning"],
};

function bad(why: string): Timeline {
  return {
    ok: false,
    label: {
      key: "incident",
      label: "Dispute timeline inconsistent — incident",
      detail: `The contract reported a dispute phase this app does not recognise or that is inconsistent. Do not act on it; report it. (${why})`,
      tone: "negative",
    },
  };
}

/**
 * Phase timeline of a DISPUTED line. The current phase is the contract's
 * `dispute_phase` (computed by the contract at the queried block), never a
 * local clock. Phase starts come from the view and are cross-checked against
 * T0 and the hashed windows; any mismatch is an incident.
 */
export function disputeTimeline(line: LineView, w: Windows): Timeline {
  if (line.status !== "DISPUTED") {
    if (line.dispute_phase !== "NONE" || line.primary_start_ns !== null || line.backup_start_ns !== null || line.fallback_start_ns !== null) {
      return bad(`phase ${line.dispute_phase} on a ${line.status} line`);
    }
    return { ok: false, label: { key: "none", label: "Not in dispute", tone: "neutral" } };
  }
  const current = line.dispute_phase;
  if (!(ORDER as readonly string[]).includes(current)) return bad(`unknown phase ${current}`);
  if (line.primary_start_ns === null || line.backup_start_ns === null || line.fallback_start_ns === null) {
    return bad("DISPUTED line without phase start times");
  }
  const t0 = u128(line.dispute_t0_ns);
  const ps = u128(line.primary_start_ns);
  const bs = u128(line.backup_start_ns);
  const fs = u128(line.fallback_start_ns);
  if (ps !== t0 + u128(w.negotiation_window_ns) || bs !== ps + u128(w.primary_window_ns) || fs !== bs + u128(w.backup_window_ns)) {
    return bad("phase start times do not equal T0 plus the agreed windows");
  }
  const starts: Record<PhaseKey, [bigint, bigint | null]> = {
    NEGOTIATION: [t0, ps],
    PRIMARY: [ps, bs],
    BACKUP: [bs, fs],
    FALLBACK: [fs, null],
  };
  const ci = ORDER.indexOf(current as PhaseKey);
  const steps = ORDER.map((key, i): PhaseStep => ({
    key,
    title: TITLE[key][0],
    who: TITLE[key][1],
    startNs: starts[key][0],
    endNs: starts[key][1],
    position: i < ci ? "past" : i === ci ? "current" : "upcoming",
  }));
  const [, who, label, tone] = TITLE[current as PhaseKey];
  return { ok: true, current: current as PhaseKey, label: { key: current.toLowerCase(), label, detail: who, tone }, steps };
}

export interface RulingAvailability {
  readonly canRule: boolean;
  /** Which arbitrator this account is, when it is one. */
  readonly as?: "primary" | "backup";
  /** Shown to an arbitrator whose window is not open (null: show nothing). */
  readonly reason: string | null;
}

/**
 * The ruling form is shown only to the arbitrator whose window the contract
 * reports as open. Everyone else sees no form (reason null) — the timeline
 * already explains who can decide.
 */
export function rulingAvailability(line: LineView, role: Role | null): RulingAvailability {
  if (role !== "primary_arbitrator" && role !== "backup_arbitrator") return { canRule: false, reason: null };
  const as = role === "primary_arbitrator" ? "primary" : "backup";
  if (line.status === "ALLOCATED") return { canRule: false, as, reason: "This line already has a final allocation. No ruling is possible." };
  if (line.status !== "DISPUTED") return { canRule: false, as, reason: null };
  const want = as === "primary" ? "PRIMARY" : "BACKUP";
  if (line.dispute_phase === want) return { canRule: true, as, reason: null };
  const before = ORDER.indexOf(line.dispute_phase as PhaseKey) < ORDER.indexOf(want);
  return {
    canRule: false,
    as,
    reason: before
      ? `Your ${as} arbitrator window is not open yet. It opens at the time shown in the timeline.`
      : `Your ${as} arbitrator window has ended. You can no longer rule on this line.`,
  };
}

export interface FallbackPreview {
  readonly buyer: bigint;
  readonly supplier: bigint;
  readonly supplierBps: number;
  readonly buyerBps: number;
}

/**
 * Exact fallback split, computed exactly like ledger.rs split_bps:
 * supplier = floor(P·S/10 000), buyer = P − supplier. Requires the two
 * agreed shares to sum to 10 000 bps (terms validation).
 */
export function fallbackPreview(principal: bigint, supplierBps: number, buyerBps: number): FallbackPreview {
  if (!Number.isInteger(buyerBps) || supplierBps + buyerBps !== 10_000) throw new RangeError("fallback bps must sum to 10 000");
  const { buyer, supplier } = fallbackSplit(principal, supplierBps);
  return { buyer, supplier, supplierBps, buyerBps };
}

export interface FallbackAvailability {
  readonly canTrigger: boolean;
  readonly reason: string | null;
}

/** Anyone (any connected account) once the contract reports FALLBACK on a DISPUTED line. */
export function fallbackAvailability(line: LineView, connected: boolean): FallbackAvailability {
  if (line.status !== "DISPUTED") return { canTrigger: false, reason: null };
  if (line.dispute_phase !== "FALLBACK") return { canTrigger: false, reason: "The fallback becomes available at the fallback time shown in the timeline." };
  if (!connected) return { canTrigger: false, reason: "Connect any account to apply the fallback split. Anyone may do this." };
  return { canTrigger: true, reason: null };
}

export type PreSignCheck = { ok: true } | { ok: false; message: string };

/**
 * Re-check on a fresh read right before signing a ruling or the fallback:
 * the line must still be DISPUTED and the contract must still report the
 * phase the action needs. The contract re-checks again with its own time.
 */
export function recheckBeforeDecision(fresh: LineView, action: "primary" | "backup" | "fallback"): PreSignCheck {
  if (fresh.status === "ALLOCATED") return { ok: false, message: "This line was decided in the meantime. Nothing was signed. Review the recorded decision." };
  if (fresh.status !== "DISPUTED") return { ok: false, message: "The line is no longer disputed. Nothing was signed." };
  const want = action === "primary" ? "PRIMARY" : action === "backup" ? "BACKUP" : "FALLBACK";
  if (fresh.dispute_phase !== want) {
    return { ok: false, message: `The contract now reports the ${fresh.dispute_phase.toLowerCase()} phase, not ${want.toLowerCase()}. Nothing was signed.` };
  }
  return { ok: true };
}
