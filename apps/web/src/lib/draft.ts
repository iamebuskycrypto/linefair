// Agreement draft (screen S02) -> canonical terms. Pure.
// The form is converted to the JSON wire form, then checked by the SAME
// strict parser + validator + encoder that passes the Rust vectors, so the
// local hash shown in the editor is computed exactly as the contract would.

import {
  acceleratedTestTiming,
  parseAndValidate,
  termsHashHex,
  type AgreementTermsJsonV1,
  type AgreementTermsV1,
  type NetworkId,
  type TermsError,
} from "./terms.ts";
import { minutesToNs, parseUnits, utcInputToNs } from "./format.ts";
import { termsInvalidTitle } from "./contract/errors.ts";

export interface DraftLine {
  /** Token amount in display units, e.g. "500" or "1250.50". */
  amount: string;
  /** `<input type="datetime-local">` value, interpreted as UTC. */
  deliveryDeadline: string;
  /** 64 lowercase hex salted acceptance-criteria commitment (computed off chain). */
  commitment: string;
  /** Supplier share of the fallback split in percent, up to 2 decimals. Buyer gets the rest. */
  supplierPercent: string;
}

export interface Draft {
  buyer: string;
  supplier: string;
  primary: string;
  backup: string;
  nonce: string;
  acceptanceDeadline: string;
  fundingDeadline: string;
  graceMinutes: string;
  reviewMinutes: string;
  negotiationMinutes: string;
  primaryMinutes: string;
  backupMinutes: string;
  lines: DraftLine[];
}

export interface DraftContext {
  readonly network: NetworkId;
  readonly escrowId: string;
  readonly ftId: string;
  readonly treasuryId: string;
  /** Chain time if known, else browser time (the UI says which). */
  readonly nowNs: bigint;
  readonly decimals: number;
}

export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

export type DraftEvaluation =
  | { readonly kind: "incomplete"; readonly issues: readonly FieldIssue[] }
  | {
      readonly kind: "invalid";
      readonly stage: "parse" | "validate";
      readonly code: string;
      readonly issues: readonly FieldIssue[];
      readonly termsJson: AgreementTermsJsonV1;
    }
  | {
      readonly kind: "valid";
      readonly terms: AgreementTermsV1;
      readonly termsJson: AgreementTermsJsonV1;
      readonly termsText: string;
      readonly hash: string;
      readonly accelerated: boolean;
    };

export const MAX_DRAFT_LINES = 3;

/** "40" / "33.5" / "100" -> bps. null if not 0..100 with at most 2 decimals. */
export function percentToBps(p: string): number | null {
  const m = /^(100|[1-9]?[0-9])(?:\.([0-9]{1,2}))?$/.exec(p.trim());
  if (m === null) return null;
  const frac = (m[2] ?? "").padEnd(2, "0");
  const bps = Number.parseInt(m[1], 10) * 100 + Number.parseInt(frac, 10);
  return bps > 10_000 ? null : bps;
}

function issue(field: string, message: string): FieldIssue {
  return { field, message };
}

/** Convert the form; collect every conversion issue (UI-level, before canonical checks). */
function toJson(d: Draft, decimals: number): { json: AgreementTermsJsonV1 | null; issues: FieldIssue[] } {
  const issues: FieldIssue[] = [];
  const ns = (field: string, v: string): string => {
    const r = utcInputToNs(v);
    if (r === null) issues.push(issue(field, "Enter a date and time (UTC)."));
    return r === null ? "0" : r.toString();
  };
  const dur = (field: string, v: string): string => {
    const r = minutesToNs(v);
    if (r === null) issues.push(issue(field, "Enter whole minutes."));
    return r === null ? "0" : r.toString();
  };
  if (!/^(0|[1-9][0-9]*)$/.test(d.nonce.trim())) issues.push(issue("nonce", "Enter a whole number."));
  if (d.lines.length < 1 || d.lines.length > MAX_DRAFT_LINES) issues.push(issue("lines", "Add 1 to 3 lines."));
  const json: AgreementTermsJsonV1 = {
    schema_version: 1,
    deadline_rules_version: 1,
    buyer_id: d.buyer.trim(),
    supplier_id: d.supplier.trim(),
    primary_arbitrator_id: d.primary.trim(),
    backup_arbitrator_id: d.backup.trim(),
    ft_contract_id: "",
    agreement_nonce: d.nonce.trim(),
    acceptance_deadline_ns: ns("acceptanceDeadline", d.acceptanceDeadline),
    funding_deadline_ns: ns("fundingDeadline", d.fundingDeadline),
    delivery_grace_period_ns: dur("graceMinutes", d.graceMinutes),
    review_window_ns: dur("reviewMinutes", d.reviewMinutes),
    negotiation_window_ns: dur("negotiationMinutes", d.negotiationMinutes),
    primary_window_ns: dur("primaryMinutes", d.primaryMinutes),
    backup_window_ns: dur("backupMinutes", d.backupMinutes),
    lines: d.lines.map((l, i) => {
      const amt = parseUnits(l.amount, decimals);
      if (!amt.ok) issues.push(issue(`lines.${i}.amount`, amt.error));
      const sbps = percentToBps(l.supplierPercent);
      if (sbps === null) issues.push(issue(`lines.${i}.supplierPercent`, "Enter a percentage from 0 to 100 (up to 2 decimals)."));
      if (!/^[0-9a-f]{64}$/.test(l.commitment.trim())) {
        issues.push(issue(`lines.${i}.commitment`, "Enter the 64-character lowercase hex commitment."));
      }
      return {
        line_id: i,
        principal: amt.ok ? amt.value.toString() : "0",
        delivery_deadline_ns: ns(`lines.${i}.deliveryDeadline`, l.deliveryDeadline),
        acceptance_criteria_commitment: l.commitment.trim(),
        fallback_buyer_bps: sbps === null ? 0 : 10_000 - sbps,
        fallback_supplier_bps: sbps ?? 0,
      };
    }),
  };
  return { json: issues.length === 0 ? json : null, issues };
}

const ROLE_FIELD: Record<string, string> = {
  buyer: "buyer",
  supplier: "supplier",
  primary_arbitrator: "primary",
  backup_arbitrator: "backup",
};

const PARSE_FIELD: Record<string, string> = {
  buyer_id: "buyer",
  supplier_id: "supplier",
  primary_arbitrator_id: "primary",
  backup_arbitrator_id: "backup",
  ft_contract_id: "token",
  agreement_nonce: "nonce",
};

/** Field to highlight for a validation error. */
export function fieldForTermsError(e: TermsError): string {
  switch (e.code) {
    case "UnsupportedSchemaVersion":
    case "UnsupportedDeadlineRulesVersion":
    case "FtNotAllowlisted":
      return "token";
    case "RolesNotDistinct":
    case "RoleIsReservedAccount":
      return e.role !== undefined ? (ROLE_FIELD[e.role] ?? "roles") : "roles";
    case "AcceptanceDeadlineNotInFuture":
      return "acceptanceDeadline";
    case "FundingDeadlineBeforeAcceptance":
      return "fundingDeadline";
    case "DeliveryGraceOutOfRange":
      return "graceMinutes";
    case "WindowOutOfRange":
      return `${e.window ?? "review"}Minutes`;
    case "LineCountOutOfRange":
    case "PrincipalSumOverflow":
      return "lines";
    case "ZeroPrincipal":
      return `lines.${e.line_id}.amount`;
    case "BpsOutOfRange":
    case "BpsSumInvalid":
      return `lines.${e.line_id}.supplierPercent`;
    case "DeliveryDeadlineBeforeFunding":
    case "SubmissionCutoffOverflow":
    case "PhaseScheduleOverflow":
      return `lines.${e.line_id}.deliveryDeadline`;
    case "LineIdMismatch":
      return "lines";
  }
}

export async function evaluateDraft(d: Draft, ctx: DraftContext): Promise<DraftEvaluation> {
  const { json, issues } = toJson(d, ctx.decimals);
  if (json === null) return { kind: "incomplete", issues };
  const termsJson: AgreementTermsJsonV1 = { ...json, ft_contract_id: ctx.ftId };
  const termsText = JSON.stringify(termsJson);
  const r = parseAndValidate(termsText, {
    now_ns: ctx.nowNs,
    escrow_id: ctx.escrowId,
    allowlisted_ft_id: ctx.ftId,
    operator_treasury_id: ctx.treasuryId,
  });
  if (!r.ok) {
    if (r.stage === "parse") {
      const field = PARSE_FIELD[r.detail] ?? "terms";
      const msg = r.code === "InvalidAccountId" ? "Not a valid NEAR account id (lowercase a-z, 0-9, - _ . ; 2 to 64 characters)." : `Rejected (${r.code}).`;
      return { kind: "invalid", stage: "parse", code: r.code, issues: [issue(field, msg)], termsJson };
    }
    return {
      kind: "invalid",
      stage: "validate",
      code: r.code,
      issues: [issue(fieldForTermsError(r.error), termsInvalidTitle(r.code))],
      termsJson,
    };
  }
  const hash = await termsHashHex(ctx.network, ctx.escrowId, r.terms);
  return { kind: "valid", terms: r.terms, termsJson, termsText, hash, accelerated: acceleratedTestTiming(r.terms) };
}

export function emptyLine(): DraftLine {
  return { amount: "", deliveryDeadline: "", commitment: "", supplierPercent: "50" };
}

export function emptyDraft(): Draft {
  return {
    buyer: "",
    supplier: "",
    primary: "",
    backup: "",
    nonce: "1",
    acceptanceDeadline: "",
    fundingDeadline: "",
    graceMinutes: "0",
    reviewMinutes: "4320",
    negotiationMinutes: "2880",
    primaryMinutes: "4320",
    backupMinutes: "4320",
    lines: [emptyLine()],
  };
}

/**
 * The shared golden vector (T059, packages/shared-schemas/vectors/terms_v1.json)
 * as a draft, with 6 token decimals. Fixture accounts only; the commitments
 * are fixture digests, not real salted commitments.
 */
export const FIXTURE = {
  network: "testnet",
  escrowId: "escrow.lf-demo.testnet",
  ftId: "ft-test.lf-demo.testnet",
  treasuryId: "treasury.lf-demo.testnet",
  decimals: 6,
  goldenDigest: "9257a5bfea49918f0a1b1a3308ad553a384079e73da987df495f55002869a33c",
} as const;

export function goldenSampleDraft(): Draft {
  return {
    buyer: "buyer.lf-demo.testnet",
    supplier: "supplier.lf-demo.testnet",
    primary: "primary.lf-demo.testnet",
    backup: "backup.lf-demo.testnet",
    nonce: "1",
    acceptanceDeadline: "2027-01-16T08:00",
    fundingDeadline: "2027-01-17T08:00",
    graceMinutes: "0",
    reviewMinutes: "4320",
    negotiationMinutes: "2880",
    primaryMinutes: "4320",
    backupMinutes: "4320",
    lines: [
      { amount: "500", deliveryDeadline: "2027-01-19T08:00", commitment: "d194b132a54e35a0d6ffb12e6dfa160828b6739b2d38d6799f669d182291838e", supplierPercent: "50" },
      { amount: "300", deliveryDeadline: "2027-01-20T08:00", commitment: "7947120d66ac3426e3d7d90b6221072a7ae8f35704db8886f45ba8dfb811bd67", supplierPercent: "40" },
      { amount: "200", deliveryDeadline: "2027-01-21T08:00", commitment: "aad0264441779512e811da08acfe8988dec9ee0d2624d5158d2bbe61028ab550", supplierPercent: "70" },
    ],
  };
}
