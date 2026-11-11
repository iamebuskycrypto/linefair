// Creation-time validation, mirroring terms.rs `AgreementTermsV1::validate`
// rule by rule and in the same order (first failure wins).

import {
  BPS_DENOMINATOR,
  DEADLINE_RULES_VERSION_V1,
  DEFAULT_BACKUP_WINDOW_NS,
  DEFAULT_NEGOTIATION_WINDOW_NS,
  DEFAULT_PRIMARY_WINDOW_NS,
  DEFAULT_REVIEW_WINDOW_NS,
  MAX_DELIVERY_GRACE_NS,
  MAX_LINES,
  MAX_WINDOW_NS,
  MIN_LINES,
  MIN_WINDOW_NS,
  SCHEMA_VERSION_V1,
  U128_MAX,
  U64_MAX,
  type AgreementTermsV1,
  type LineTermsV1,
  type ValidationContext,
} from "./types.ts";

export type TermsErrorCode =
  | "UnsupportedSchemaVersion"
  | "UnsupportedDeadlineRulesVersion"
  | "FtNotAllowlisted"
  | "RolesNotDistinct"
  | "RoleIsReservedAccount"
  | "AcceptanceDeadlineNotInFuture"
  | "FundingDeadlineBeforeAcceptance"
  | "DeliveryGraceOutOfRange"
  | "WindowOutOfRange"
  | "LineCountOutOfRange"
  | "LineIdMismatch"
  | "ZeroPrincipal"
  | "BpsOutOfRange"
  | "BpsSumInvalid"
  | "DeliveryDeadlineBeforeFunding"
  | "SubmissionCutoffOverflow"
  | "PhaseScheduleOverflow"
  | "PrincipalSumOverflow";

export type Role = "buyer" | "supplier" | "primary_arbitrator" | "backup_arbitrator";
export type Window = "review" | "negotiation" | "primary" | "backup";

export interface TermsError {
  readonly code: TermsErrorCode;
  /** Optional context mirroring the Rust variant fields (line_id, role, window). */
  readonly line_id?: number;
  readonly role?: Role;
  readonly window?: Window;
}

function roles(t: AgreementTermsV1): [Role, string][] {
  return [
    ["buyer", t.buyer_id],
    ["supplier", t.supplier_id],
    ["primary_arbitrator", t.primary_arbitrator_id],
    ["backup_arbitrator", t.backup_arbitrator_id],
  ];
}

function windows(t: AgreementTermsV1): [Window, bigint, bigint][] {
  return [
    ["review", t.review_window_ns, DEFAULT_REVIEW_WINDOW_NS],
    ["negotiation", t.negotiation_window_ns, DEFAULT_NEGOTIATION_WINDOW_NS],
    ["primary", t.primary_window_ns, DEFAULT_PRIMARY_WINDOW_NS],
    ["backup", t.backup_window_ns, DEFAULT_BACKUP_WINDOW_NS],
  ];
}

/** Derived, not hashed: any window below its FD-06 default. */
export function acceleratedTestTiming(t: AgreementTermsV1): boolean {
  return windows(t).some(([, value, def]) => value < def);
}

/** Checked u64 add: null on overflow (Rust `checked_add`). */
function addU64(a: bigint, b: bigint): bigint | null {
  const s = a + b;
  return s > U64_MAX ? null : s;
}

function validateLine(t: AgreementTermsV1, position: number, line: LineTermsV1): TermsError | null {
  const line_id = line.line_id;
  if (line_id !== position) return { code: "LineIdMismatch", line_id };
  if (line.principal === 0n) return { code: "ZeroPrincipal", line_id };
  if (line.fallback_buyer_bps > BPS_DENOMINATOR || line.fallback_supplier_bps > BPS_DENOMINATOR) {
    return { code: "BpsOutOfRange", line_id };
  }
  if (line.fallback_buyer_bps + line.fallback_supplier_bps !== BPS_DENOMINATOR) {
    return { code: "BpsSumInvalid", line_id };
  }
  if (line.delivery_deadline_ns < t.funding_deadline_ns) {
    return { code: "DeliveryDeadlineBeforeFunding", line_id };
  }
  const cutoff = addU64(line.delivery_deadline_ns, t.delivery_grace_period_ns);
  if (cutoff === null) return { code: "SubmissionCutoffOverflow", line_id };
  let acc: bigint | null = cutoff;
  for (const w of [t.review_window_ns, t.negotiation_window_ns, t.primary_window_ns, t.backup_window_ns]) {
    acc = addU64(acc, w);
    if (acc === null) return { code: "PhaseScheduleOverflow", line_id };
  }
  return null;
}

/** `AgreementTermsV1::validate`. Returns null when valid. */
export function validateTerms(t: AgreementTermsV1, ctx: ValidationContext): TermsError | null {
  if (t.schema_version !== SCHEMA_VERSION_V1) return { code: "UnsupportedSchemaVersion" };
  if (t.deadline_rules_version !== DEADLINE_RULES_VERSION_V1) {
    return { code: "UnsupportedDeadlineRulesVersion" };
  }
  if (t.ft_contract_id !== ctx.allowlisted_ft_id) return { code: "FtNotAllowlisted" };

  const r = roles(t);
  for (let i = 0; i < r.length; i++) {
    for (let j = i + 1; j < r.length; j++) {
      if (r[i][1] === r[j][1]) return { code: "RolesNotDistinct", role: r[j][0] };
    }
  }
  const reserved = [ctx.escrow_id, ctx.allowlisted_ft_id, ctx.operator_treasury_id];
  for (const [role, id] of r) {
    if (reserved.includes(id)) return { code: "RoleIsReservedAccount", role };
  }

  if (ctx.now_ns >= t.acceptance_deadline_ns) return { code: "AcceptanceDeadlineNotInFuture" };
  if (t.funding_deadline_ns < t.acceptance_deadline_ns) {
    return { code: "FundingDeadlineBeforeAcceptance" };
  }

  if (t.delivery_grace_period_ns > MAX_DELIVERY_GRACE_NS) return { code: "DeliveryGraceOutOfRange" };
  for (const [window, value] of windows(t)) {
    if (value < MIN_WINDOW_NS || value > MAX_WINDOW_NS) return { code: "WindowOutOfRange", window };
  }

  const count = t.lines.length;
  if (count < MIN_LINES || count > MAX_LINES) return { code: "LineCountOutOfRange" };
  for (let position = 0; position < count; position++) {
    const e = validateLine(t, position, t.lines[position]);
    if (e !== null) return e;
  }

  // Rule A: checked sum of all principals fits u128 (after every per-line rule).
  let sum = 0n;
  for (const l of t.lines) {
    sum += l.principal;
    if (sum > U128_MAX) return { code: "PrincipalSumOverflow" };
  }
  return null;
}
