// AgreementTermsV1 -> JSON wire form (`impl From<&AgreementTermsV1> for
// AgreementTermsJsonV1`). The JSON is never hashed; it is what a client sends
// as the `terms` argument of `create_agreement` / `compute_terms_hash`.

import { encodeHexLower } from "./fields.ts";
import type { AgreementTermsJsonV1, AgreementTermsV1 } from "./types.ts";

export function termsToJson(t: AgreementTermsV1): AgreementTermsJsonV1 {
  return {
    schema_version: t.schema_version,
    deadline_rules_version: t.deadline_rules_version,
    buyer_id: t.buyer_id,
    supplier_id: t.supplier_id,
    primary_arbitrator_id: t.primary_arbitrator_id,
    backup_arbitrator_id: t.backup_arbitrator_id,
    ft_contract_id: t.ft_contract_id,
    agreement_nonce: t.agreement_nonce.toString(),
    acceptance_deadline_ns: t.acceptance_deadline_ns.toString(),
    funding_deadline_ns: t.funding_deadline_ns.toString(),
    delivery_grace_period_ns: t.delivery_grace_period_ns.toString(),
    review_window_ns: t.review_window_ns.toString(),
    negotiation_window_ns: t.negotiation_window_ns.toString(),
    primary_window_ns: t.primary_window_ns.toString(),
    backup_window_ns: t.backup_window_ns.toString(),
    lines: t.lines.map((l) => ({
      line_id: l.line_id,
      principal: l.principal.toString(),
      delivery_deadline_ns: l.delivery_deadline_ns.toString(),
      acceptance_criteria_commitment: encodeHexLower(l.acceptance_criteria_commitment),
      fallback_buyer_bps: l.fallback_buyer_bps,
      fallback_supplier_bps: l.fallback_supplier_bps,
    })),
  };
}

/**
 * Minified JSON text in struct field order. Safe with `JSON.stringify`
 * because every u64/u128 is already a decimal string and every number is a
 * u16/u32 (exact in IEEE-754).
 */
export function termsToJsonText(t: AgreementTermsV1): string {
  return JSON.stringify(termsToJson(t));
}
