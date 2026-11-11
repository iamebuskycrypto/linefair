// AgreementTermsV1 / LineTermsV1 mirrored from contracts/escrow/src/terms.rs.
// Field order = Borsh order (docs/20 §Canonical terms encoding v1, FROZEN).
// u64 / u128 are bigint only; u16 / u32 are number (every value <= 2^32-1 is exact).

export interface LineTermsV1 {
  readonly line_id: number; // u32
  readonly principal: bigint; // u128, NEP-141 base units
  readonly delivery_deadline_ns: bigint; // u64
  readonly acceptance_criteria_commitment: Uint8Array; // [u8; 32]
  readonly fallback_buyer_bps: number; // u16
  readonly fallback_supplier_bps: number; // u16
}

export interface AgreementTermsV1 {
  readonly schema_version: number; // u16
  readonly deadline_rules_version: number; // u16
  readonly buyer_id: string;
  readonly supplier_id: string;
  readonly primary_arbitrator_id: string;
  readonly backup_arbitrator_id: string;
  readonly ft_contract_id: string;
  readonly agreement_nonce: bigint; // u64
  readonly acceptance_deadline_ns: bigint;
  readonly funding_deadline_ns: bigint;
  readonly delivery_grace_period_ns: bigint;
  readonly review_window_ns: bigint;
  readonly negotiation_window_ns: bigint;
  readonly primary_window_ns: bigint;
  readonly backup_window_ns: bigint;
  readonly lines: readonly LineTermsV1[];
}

/** JSON wire form (`AgreementTermsJsonV1` in terms_json.rs). */
export interface LineTermsJsonV1 {
  line_id: number;
  principal: string;
  delivery_deadline_ns: string;
  acceptance_criteria_commitment: string;
  fallback_buyer_bps: number;
  fallback_supplier_bps: number;
}

export interface AgreementTermsJsonV1 {
  schema_version: number;
  deadline_rules_version: number;
  buyer_id: string;
  supplier_id: string;
  primary_arbitrator_id: string;
  backup_arbitrator_id: string;
  ft_contract_id: string;
  agreement_nonce: string;
  acceptance_deadline_ns: string;
  funding_deadline_ns: string;
  delivery_grace_period_ns: string;
  review_window_ns: string;
  negotiation_window_ns: string;
  primary_window_ns: string;
  backup_window_ns: string;
  lines: LineTermsJsonV1[];
}

/** `hash.rs::NetworkId`. There is no mainnet variant. */
export type NetworkId = "sandbox" | "testnet";

/** `terms.rs::ValidationContext`. */
export interface ValidationContext {
  readonly now_ns: bigint;
  readonly escrow_id: string;
  readonly allowlisted_ft_id: string;
  readonly operator_treasury_id: string;
}

export const U16_MAX = 0xffff;
export const U32_MAX = 0xffff_ffff;
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;

export const SCHEMA_VERSION_V1 = 1;
export const DEADLINE_RULES_VERSION_V1 = 1;
export const BPS_DENOMINATOR = 10_000;
export const MIN_LINES = 1;
export const MAX_LINES = 3;

const NS_PER_SEC = 1_000_000_000n;
const NS_PER_HOUR = 3_600n * NS_PER_SEC;
const NS_PER_DAY = 24n * NS_PER_HOUR;

export const MIN_WINDOW_NS = 60n * NS_PER_SEC;
export const MAX_WINDOW_NS = 30n * NS_PER_DAY;
export const MAX_DELIVERY_GRACE_NS = 30n * NS_PER_DAY;

export const DEFAULT_REVIEW_WINDOW_NS = 72n * NS_PER_HOUR;
export const DEFAULT_NEGOTIATION_WINDOW_NS = 48n * NS_PER_HOUR;
export const DEFAULT_PRIMARY_WINDOW_NS = 72n * NS_PER_HOUR;
export const DEFAULT_BACKUP_WINDOW_NS = 72n * NS_PER_HOUR;
export const DEFAULT_DELIVERY_GRACE_NS = 0n;
