//! FT funding message v1 (LF-005). `schemas/ft-funding-message-v1.schema.json`
//! (FROZEN 2026-10-27):
//!
//! ```json
//! {"version":1,"agreement_id":"<u64>","line_id":<0..2>,"terms_hash":"<hex64>"}
//! ```
//!
//! Parsed strictly: unknown, missing or duplicate fields are rejected;
//! `agreement_id` is a canonical decimal u64 string; `line_id` is an integer
//! 0..=2; `terms_hash` is 64 lowercase hex characters. Pure: no `env`.

use near_sdk::serde::Deserialize;
use near_sdk::serde_json;

use crate::hash::TermsHash;
use crate::terms_json::{ParseError, parse_hex32, parse_u64};

/// Highest `line_id` the schema allows (agreements have at most 3 lines).
pub const MAX_LINE_ID: u32 = 2;

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct FundingMsgJsonV1 {
    version: u8,
    agreement_id: String,
    line_id: u32,
    terms_hash: String,
}

/// A validated funding message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FundingMsgV1 {
    pub agreement_id: u64,
    pub line_id: u32,
    pub terms_hash: TermsHash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FundingMsgError {
    /// Not a JSON object of the right shape (type, missing/unknown/duplicate field).
    Json,
    UnsupportedVersion,
    AgreementIdNonCanonical,
    AgreementIdOverflow,
    LineIdOutOfRange,
    InvalidTermsHash,
}

impl FundingMsgError {
    pub fn code(self) -> &'static str {
        match self {
            FundingMsgError::Json => "MsgJson",
            FundingMsgError::UnsupportedVersion => "MsgVersion",
            FundingMsgError::AgreementIdNonCanonical => "MsgAgreementIdNonCanonical",
            FundingMsgError::AgreementIdOverflow => "MsgAgreementIdOverflow",
            FundingMsgError::LineIdOutOfRange => "MsgLineIdOutOfRange",
            FundingMsgError::InvalidTermsHash => "MsgTermsHash",
        }
    }
}

/// Parse a funding message. Never panics.
pub fn parse_funding_msg(msg: &str) -> Result<FundingMsgV1, FundingMsgError> {
    let j: FundingMsgJsonV1 = serde_json::from_str(msg).map_err(|_| FundingMsgError::Json)?;
    if j.version != 1 {
        return Err(FundingMsgError::UnsupportedVersion);
    }
    let agreement_id = parse_u64("agreement_id", &j.agreement_id).map_err(|e| match e {
        ParseError::DecimalOverflow { .. } => FundingMsgError::AgreementIdOverflow,
        _ => FundingMsgError::AgreementIdNonCanonical,
    })?;
    if j.line_id > MAX_LINE_ID {
        return Err(FundingMsgError::LineIdOutOfRange);
    }
    let terms_hash =
        parse_hex32("terms_hash", &j.terms_hash).map_err(|_| FundingMsgError::InvalidTermsHash)?;
    Ok(FundingMsgV1 {
        agreement_id,
        line_id: j.line_id,
        terms_hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: &str = "ab01ab01ab01ab01ab01ab01ab01ab01ab01ab01ab01ab01ab01ab01ab01ab01";

    fn hash_bytes() -> TermsHash {
        parse_hex32("h", H).expect("hex")
    }

    #[test]
    fn msg_v1_canonical_parses() {
        let ok = |m: &str, id: u64, line: u32| {
            assert_eq!(
                parse_funding_msg(m),
                Ok(FundingMsgV1 {
                    agreement_id: id,
                    line_id: line,
                    terms_hash: hash_bytes()
                }),
                "{m}"
            );
        };
        ok(
            &format!(r#"{{"version":1,"agreement_id":"0","line_id":0,"terms_hash":"{H}"}}"#),
            0,
            0,
        );
        ok(
            &format!(r#"{{"version":1,"agreement_id":"7","line_id":2,"terms_hash":"{H}"}}"#),
            7,
            2,
        );
        ok(
            &format!(
                r#"{{"version":1,"agreement_id":"18446744073709551615","line_id":1,"terms_hash":"{H}"}}"#
            ),
            u64::MAX,
            1,
        );
        // Key order and whitespace are irrelevant to JSON meaning.
        ok(
            &format!(
                "{{ \"terms_hash\" : \"{H}\",\n \"line_id\": 1, \"agreement_id\":\"3\", \"version\":1 }}"
            ),
            3,
            1,
        );
    }

    #[test]
    fn msg_rejects_malformed() {
        use FundingMsgError::*;
        let up = H.to_uppercase();
        let h63 = &H[..63];
        let h65 = format!("{H}0");
        let ox = format!("0x{}", &H[..62]);
        let nonhex = format!("g{}", &H[1..]);
        let base = |v: &str, id: &str, line: &str, h: &str| {
            format!(r#"{{"version":{v},"agreement_id":{id},"line_id":{line},"terms_hash":{h}}}"#)
        };
        let q = |s: &str| format!("\"{s}\"");
        let good_h = q(H);
        let cases: Vec<(String, FundingMsgError)> = vec![
            (String::new(), Json),
            ("not json".into(), Json),
            (format!("{}x", base("1", "\"1\"", "0", &good_h)), Json),
            (format!("[{}]", base("1", "\"1\"", "0", &good_h)), Json),
            (
                format!(
                    r#"{{"version":1,"agreement_id":"1","line_id":0,"terms_hash":"{H}","memo":"x"}}"#
                ),
                Json,
            ),
            (
                format!(r#"{{"version":1,"agreement_id":"1","terms_hash":"{H}"}}"#),
                Json,
            ),
            (
                format!(
                    r#"{{"version":1,"agreement_id":"1","agreement_id":"2","line_id":0,"terms_hash":"{H}"}}"#
                ),
                Json,
            ),
            (base("0", "\"1\"", "0", &good_h), UnsupportedVersion),
            (base("2", "\"1\"", "0", &good_h), UnsupportedVersion),
            (base("\"1\"", "\"1\"", "0", &good_h), Json),
            (base("1.0", "\"1\"", "0", &good_h), Json),
            (base("1", "1", "0", &good_h), Json),
            (base("1", "\"01\"", "0", &good_h), AgreementIdNonCanonical),
            (base("1", "\"+1\"", "0", &good_h), AgreementIdNonCanonical),
            (base("1", "\"\"", "0", &good_h), AgreementIdNonCanonical),
            (
                base("1", "\"18446744073709551616\"", "0", &good_h),
                AgreementIdOverflow,
            ),
            (base("1", "\"1\"", "3", &good_h), LineIdOutOfRange),
            (base("1", "\"1\"", "-1", &good_h), Json),
            (base("1", "\"1\"", "\"0\"", &good_h), Json),
            (base("1", "\"1\"", "1.5", &good_h), Json),
            (base("1", "\"1\"", "0", &q(&up)), InvalidTermsHash),
            (base("1", "\"1\"", "0", &q(h63)), InvalidTermsHash),
            (base("1", "\"1\"", "0", &q(&h65)), InvalidTermsHash),
            (base("1", "\"1\"", "0", &q(&ox)), InvalidTermsHash),
            (base("1", "\"1\"", "0", &q(&nonhex)), InvalidTermsHash),
            (base("1", "\"1\"", "0", "null"), Json),
        ];
        for (m, e) in cases {
            assert_eq!(parse_funding_msg(&m), Err(e), "{m:?}");
        }
    }
}
