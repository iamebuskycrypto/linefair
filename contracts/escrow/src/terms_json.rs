//! Strict JSON edge for `AgreementTermsV1` (`docs/20` §JSON edge,
//! `schemas/agreement-terms-v1.schema.json`).
//!
//! The JSON form is never hashed. It is parsed into [`AgreementTermsV1`],
//! which is then Borsh-encoded by `hash`. Rules:
//! - u64/u128 values are canonical decimal strings `^(0|[1-9][0-9]*)$`,
//!   range-checked (no sign, exponent, whitespace or leading zero);
//! - commitments are exactly 64 lowercase hex characters;
//! - account ids must parse as NEAR `AccountId`;
//! - unknown, missing or duplicate fields are rejected (serde derive).
//!
//! Semantic rules (versions, roles, bps, line ids, deadlines) stay in
//! `AgreementTermsV1::validate`.

use near_sdk::serde_json;
use near_sdk::{AccountId, near};

use crate::terms::{AgreementTermsV1, LineTermsV1, TermsError, ValidationContext};

/// JSON wire form. Field order equals Borsh order.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgreementTermsJsonV1 {
    pub schema_version: u16,
    pub deadline_rules_version: u16,
    pub buyer_id: String,
    pub supplier_id: String,
    pub primary_arbitrator_id: String,
    pub backup_arbitrator_id: String,
    pub ft_contract_id: String,
    pub agreement_nonce: String,
    pub acceptance_deadline_ns: String,
    pub funding_deadline_ns: String,
    pub delivery_grace_period_ns: String,
    pub review_window_ns: String,
    pub negotiation_window_ns: String,
    pub primary_window_ns: String,
    pub backup_window_ns: String,
    pub lines: Vec<LineTermsJsonV1>,
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineTermsJsonV1 {
    pub line_id: u32,
    pub principal: String,
    pub delivery_deadline_ns: String,
    pub acceptance_criteria_commitment: String,
    pub fallback_buyer_bps: u16,
    pub fallback_supplier_bps: u16,
}

/// Why JSON could not be turned into terms. `field` is the JSON key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// Not JSON, wrong type, integer out of range, unknown/missing/duplicate field.
    Json(String),
    InvalidAccountId {
        field: &'static str,
    },
    NonCanonicalDecimal {
        field: &'static str,
    },
    DecimalOverflow {
        field: &'static str,
    },
    InvalidCommitmentHex {
        field: &'static str,
    },
}

impl ParseError {
    /// Stable code shared with the TypeScript vectors.
    pub fn code(&self) -> &'static str {
        match self {
            ParseError::Json(_) => "Json",
            ParseError::InvalidAccountId { .. } => "InvalidAccountId",
            ParseError::NonCanonicalDecimal { .. } => "NonCanonicalDecimal",
            ParseError::DecimalOverflow { .. } => "DecimalOverflow",
            ParseError::InvalidCommitmentHex { .. } => "InvalidCommitmentHex",
        }
    }
}

/// Rejection at either stage of `parse_and_validate`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TermsRejection {
    Parse(ParseError),
    Invalid(TermsError),
}

impl TermsRejection {
    pub fn stage(&self) -> &'static str {
        match self {
            TermsRejection::Parse(_) => "parse",
            TermsRejection::Invalid(_) => "validate",
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            TermsRejection::Parse(e) => e.code(),
            TermsRejection::Invalid(e) => e.code(),
        }
    }
}

fn is_canonical_decimal(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.iter().all(u8::is_ascii_digit) && (b.len() == 1 || b[0] != b'0')
}

/// Canonical decimal u64.
pub fn parse_u64(field: &'static str, s: &str) -> Result<u64, ParseError> {
    if !is_canonical_decimal(s) {
        return Err(ParseError::NonCanonicalDecimal { field });
    }
    // Only digits remain, so the only possible failure is overflow.
    s.parse::<u64>()
        .map_err(|_| ParseError::DecimalOverflow { field })
}

/// Canonical decimal u128.
pub fn parse_u128(field: &'static str, s: &str) -> Result<u128, ParseError> {
    if !is_canonical_decimal(s) {
        return Err(ParseError::NonCanonicalDecimal { field });
    }
    s.parse::<u128>()
        .map_err(|_| ParseError::DecimalOverflow { field })
}

fn hex_nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    }
}

/// Exactly 64 lowercase hex characters → 32 bytes.
pub fn parse_hex32(field: &'static str, s: &str) -> Result<[u8; 32], ParseError> {
    let b = s.as_bytes();
    if b.len() != 64 {
        return Err(ParseError::InvalidCommitmentHex { field });
    }
    let mut out = [0u8; 32];
    for (o, pair) in out.iter_mut().zip(b.chunks_exact(2)) {
        let hi = hex_nibble(pair[0]).ok_or(ParseError::InvalidCommitmentHex { field })?;
        let lo = hex_nibble(pair[1]).ok_or(ParseError::InvalidCommitmentHex { field })?;
        *o = (hi << 4) | lo;
    }
    Ok(out)
}

/// Lowercase hex.
pub fn encode_hex_lower(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(char::from(DIGITS[usize::from(b >> 4)]));
        s.push(char::from(DIGITS[usize::from(b & 0x0f)]));
    }
    s
}

fn parse_account(field: &'static str, s: &str) -> Result<AccountId, ParseError> {
    s.parse::<AccountId>()
        .map_err(|_| ParseError::InvalidAccountId { field })
}

impl TryFrom<&AgreementTermsJsonV1> for AgreementTermsV1 {
    type Error = ParseError;

    fn try_from(j: &AgreementTermsJsonV1) -> Result<Self, ParseError> {
        let mut lines = Vec::with_capacity(j.lines.len());
        // Parse terms fields first, in field order, so the first error is deterministic.
        let buyer_id = parse_account("buyer_id", &j.buyer_id)?;
        let supplier_id = parse_account("supplier_id", &j.supplier_id)?;
        let primary_arbitrator_id =
            parse_account("primary_arbitrator_id", &j.primary_arbitrator_id)?;
        let backup_arbitrator_id = parse_account("backup_arbitrator_id", &j.backup_arbitrator_id)?;
        let ft_contract_id = parse_account("ft_contract_id", &j.ft_contract_id)?;
        let agreement_nonce = parse_u64("agreement_nonce", &j.agreement_nonce)?;
        let acceptance_deadline_ns =
            parse_u64("acceptance_deadline_ns", &j.acceptance_deadline_ns)?;
        let funding_deadline_ns = parse_u64("funding_deadline_ns", &j.funding_deadline_ns)?;
        let delivery_grace_period_ns =
            parse_u64("delivery_grace_period_ns", &j.delivery_grace_period_ns)?;
        let review_window_ns = parse_u64("review_window_ns", &j.review_window_ns)?;
        let negotiation_window_ns = parse_u64("negotiation_window_ns", &j.negotiation_window_ns)?;
        let primary_window_ns = parse_u64("primary_window_ns", &j.primary_window_ns)?;
        let backup_window_ns = parse_u64("backup_window_ns", &j.backup_window_ns)?;
        for l in &j.lines {
            lines.push(LineTermsV1 {
                line_id: l.line_id,
                principal: parse_u128("principal", &l.principal)?,
                delivery_deadline_ns: parse_u64("delivery_deadline_ns", &l.delivery_deadline_ns)?,
                acceptance_criteria_commitment: parse_hex32(
                    "acceptance_criteria_commitment",
                    &l.acceptance_criteria_commitment,
                )?,
                fallback_buyer_bps: l.fallback_buyer_bps,
                fallback_supplier_bps: l.fallback_supplier_bps,
            });
        }
        Ok(AgreementTermsV1 {
            schema_version: j.schema_version,
            deadline_rules_version: j.deadline_rules_version,
            buyer_id,
            supplier_id,
            primary_arbitrator_id,
            backup_arbitrator_id,
            ft_contract_id,
            agreement_nonce,
            acceptance_deadline_ns,
            funding_deadline_ns,
            delivery_grace_period_ns,
            review_window_ns,
            negotiation_window_ns,
            primary_window_ns,
            backup_window_ns,
            lines,
        })
    }
}

impl From<&AgreementTermsV1> for AgreementTermsJsonV1 {
    fn from(t: &AgreementTermsV1) -> Self {
        AgreementTermsJsonV1 {
            schema_version: t.schema_version,
            deadline_rules_version: t.deadline_rules_version,
            buyer_id: t.buyer_id.to_string(),
            supplier_id: t.supplier_id.to_string(),
            primary_arbitrator_id: t.primary_arbitrator_id.to_string(),
            backup_arbitrator_id: t.backup_arbitrator_id.to_string(),
            ft_contract_id: t.ft_contract_id.to_string(),
            agreement_nonce: t.agreement_nonce.to_string(),
            acceptance_deadline_ns: t.acceptance_deadline_ns.to_string(),
            funding_deadline_ns: t.funding_deadline_ns.to_string(),
            delivery_grace_period_ns: t.delivery_grace_period_ns.to_string(),
            review_window_ns: t.review_window_ns.to_string(),
            negotiation_window_ns: t.negotiation_window_ns.to_string(),
            primary_window_ns: t.primary_window_ns.to_string(),
            backup_window_ns: t.backup_window_ns.to_string(),
            lines: t
                .lines
                .iter()
                .map(|l| LineTermsJsonV1 {
                    line_id: l.line_id,
                    principal: l.principal.to_string(),
                    delivery_deadline_ns: l.delivery_deadline_ns.to_string(),
                    acceptance_criteria_commitment: encode_hex_lower(
                        &l.acceptance_criteria_commitment,
                    ),
                    fallback_buyer_bps: l.fallback_buyer_bps,
                    fallback_supplier_bps: l.fallback_supplier_bps,
                })
                .collect(),
        }
    }
}

/// Parse JSON text into terms (no semantic validation).
pub fn parse_terms_json(json: &str) -> Result<AgreementTermsV1, ParseError> {
    let j: AgreementTermsJsonV1 =
        serde_json::from_str(json).map_err(|e| ParseError::Json(e.to_string()))?;
    AgreementTermsV1::try_from(&j)
}

/// Parse, then validate. This is what agreement creation will call.
pub fn parse_and_validate(
    json: &str,
    ctx: &ValidationContext<'_>,
) -> Result<AgreementTermsV1, TermsRejection> {
    let t = parse_terms_json(json).map_err(TermsRejection::Parse)?;
    t.validate(ctx).map_err(TermsRejection::Invalid)?;
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_u64_canonical_and_range() {
        assert_eq!(parse_u64("f", "0"), Ok(0));
        assert_eq!(parse_u64("f", "7"), Ok(7));
        assert_eq!(parse_u64("f", "18446744073709551615"), Ok(u64::MAX));
        assert_eq!(
            parse_u64("f", "18446744073709551616"),
            Err(ParseError::DecimalOverflow { field: "f" })
        );
        assert_eq!(
            parse_u64("f", "99999999999999999999999"),
            Err(ParseError::DecimalOverflow { field: "f" })
        );
        for bad in [
            "", "00", "007", "+5", "-5", "1e3", " 5", "5 ", "5.0", "0x10", "١", "1_000",
        ] {
            assert_eq!(
                parse_u64("f", bad),
                Err(ParseError::NonCanonicalDecimal { field: "f" }),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn decimal_u128_canonical_and_range() {
        assert_eq!(
            parse_u128("p", "340282366920938463463374607431768211455"),
            Ok(u128::MAX)
        );
        assert_eq!(
            parse_u128("p", "340282366920938463463374607431768211456"),
            Err(ParseError::DecimalOverflow { field: "p" })
        );
        assert_eq!(
            parse_u128("p", "01"),
            Err(ParseError::NonCanonicalDecimal { field: "p" })
        );
    }

    #[test]
    fn hex32_lowercase_exact_length() {
        let ok = "00".repeat(31) + "ff";
        let mut expected = [0u8; 32];
        expected[31] = 0xff;
        assert_eq!(parse_hex32("c", &ok), Ok(expected));
        assert_eq!(encode_hex_lower(&expected), ok);
        let upper = "00".repeat(31) + "FF";
        for bad in [
            upper.as_str(),
            &"0".repeat(63),
            &"0".repeat(65),
            &"0".repeat(62),
            "",
            &("g".to_string() + &"0".repeat(63)),
            &("0x".to_string() + &"0".repeat(62)),
        ] {
            assert_eq!(
                parse_hex32("c", bad),
                Err(ParseError::InvalidCommitmentHex { field: "c" }),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn hex_round_trip_all_bytes() {
        let mut bytes = [0u8; 32];
        for start in (0u16..256).step_by(32) {
            for (i, b) in bytes.iter_mut().enumerate() {
                *b = u8::try_from(start + u16::try_from(i).expect("i < 32")).expect("byte");
            }
            let s = encode_hex_lower(&bytes);
            assert_eq!(parse_hex32("c", &s), Ok(bytes));
        }
    }
}
