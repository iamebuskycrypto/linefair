//! Shared canonical-terms vectors (M1 S2): T059–T064, T055, T016 (hash part),
//! T078 (prerequisite).
//!
//! Rust is the reference (`docs/20`). This test builds every vector from the
//! public crate API and then either:
//! - compares it byte for byte with the committed file (default), or
//! - rewrites the file when `LINEFAIR_WRITE_VECTORS=1`.
//!
//! The file is `packages/shared-schemas/vectors/terms_v1.json`. The future
//! TypeScript encoder must reproduce every `preimage_hex` / `digest_hex` and
//! reject every `malformed` case.

use std::path::PathBuf;

use linefair_escrow::hash::{NetworkId, TERMS_DOMAIN_V1, terms_hash, terms_preimage};
use linefair_escrow::terms::{
    AgreementTermsV1, DEFAULT_BACKUP_WINDOW_NS, DEFAULT_NEGOTIATION_WINDOW_NS,
    DEFAULT_PRIMARY_WINDOW_NS, DEFAULT_REVIEW_WINDOW_NS, LineTermsV1, ValidationContext,
};
use linefair_escrow::terms_json::{
    AgreementTermsJsonV1, encode_hex_lower, parse_and_validate, parse_terms_json,
};
use near_sdk::AccountId;
use near_sdk::serde_json::{self, Value, json};

const NOW: u64 = 1_800_000_000_000_000_000;
const HOUR: u64 = 3_600_000_000_000;
const GOLDEN_DIGEST_HEX: &str = "9257a5bfea49918f0a1b1a3308ad553a384079e73da987df495f55002869a33c";
const ESCROW: &str = "escrow.lf-demo.testnet";
const FT: &str = "ft-test.lf-demo.testnet";
const TREASURY: &str = "treasury.lf-demo.testnet";

fn acc(s: &str) -> AccountId {
    s.parse().expect("account id")
}

fn vectors_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared-schemas/vectors/terms_v1.json")
}

fn commitment(line_id: u32) -> [u8; 32] {
    near_sdk::env::sha256_array(format!("linefair/fixture/criteria/{line_id}").as_bytes())
}

fn line(line_id: u32, principal: u128, hours: u64, b: u16, s: u16) -> LineTermsV1 {
    LineTermsV1 {
        line_id,
        principal,
        delivery_deadline_ns: NOW + hours * HOUR,
        acceptance_criteria_commitment: commitment(line_id),
        fallback_buyer_bps: b,
        fallback_supplier_bps: s,
    }
}

/// Demo agreement: 500 / 300 / 200 (6-decimal test token), default windows.
fn golden() -> AgreementTermsV1 {
    AgreementTermsV1 {
        schema_version: 1,
        deadline_rules_version: 1,
        buyer_id: acc("buyer.lf-demo.testnet"),
        supplier_id: acc("supplier.lf-demo.testnet"),
        primary_arbitrator_id: acc("primary.lf-demo.testnet"),
        backup_arbitrator_id: acc("backup.lf-demo.testnet"),
        ft_contract_id: acc(FT),
        agreement_nonce: 1,
        acceptance_deadline_ns: NOW + 24 * HOUR,
        funding_deadline_ns: NOW + 48 * HOUR,
        delivery_grace_period_ns: 0,
        review_window_ns: DEFAULT_REVIEW_WINDOW_NS,
        negotiation_window_ns: DEFAULT_NEGOTIATION_WINDOW_NS,
        primary_window_ns: DEFAULT_PRIMARY_WINDOW_NS,
        backup_window_ns: DEFAULT_BACKUP_WINDOW_NS,
        lines: vec![
            line(0, 500_000_000, 96, 5_000, 5_000),
            line(1, 300_000_000, 120, 6_000, 4_000),
            line(2, 200_000_000, 144, 3_000, 7_000),
        ],
    }
}

struct Ids {
    escrow: AccountId,
    ft: AccountId,
    treasury: AccountId,
}

impl Ids {
    fn new() -> Self {
        Ids {
            escrow: acc(ESCROW),
            ft: acc(FT),
            treasury: acc(TREASURY),
        }
    }
    fn ctx(&self) -> ValidationContext<'_> {
        ValidationContext {
            now_ns: NOW,
            escrow_id: &self.escrow,
            allowlisted_ft_id: &self.ft,
            operator_treasury_id: &self.treasury,
        }
    }
}

fn terms_value(t: &AgreementTermsV1) -> Value {
    serde_json::to_value(AgreementTermsJsonV1::from(t)).expect("to_value")
}

fn validation_code(t: &AgreementTermsV1, ids: &Ids) -> &'static str {
    match t.validate(&ids.ctx()) {
        Ok(()) => "ok",
        Err(e) => e.code(),
    }
}

/// One encoded vector; also asserts JSON round trip and hash agreement.
fn vector(
    id: &str,
    label: &str,
    net: NetworkId,
    escrow: &AccountId,
    t: &AgreementTermsV1,
    ids: &Ids,
) -> (Value, String) {
    let v = terms_value(t);
    let text = serde_json::to_string(&v).expect("to_string");
    let parsed = parse_terms_json(&text).expect("vector terms must parse");
    assert_eq!(&parsed, t, "{label}: JSON round trip");
    let pre = terms_preimage(net, escrow, t);
    let digest = encode_hex_lower(&terms_hash(net, escrow, t));
    assert_eq!(
        terms_hash(net, escrow, &parsed),
        terms_hash(net, escrow, t),
        "{label}"
    );
    (
        json!({
            "id": id,
            "label": label,
            "network": net.as_str(),
            "escrow_id": escrow.as_str(),
            "terms": v,
            "preimage_hex": encode_hex_lower(&pre),
            "digest_hex": digest,
            "validation": validation_code(t, ids),
            "accelerated_test_timing": t.accelerated_test_timing(),
        }),
        digest,
    )
}

type Mutation = (&'static str, &'static str, fn(&mut AgreementTermsV1));

/// (field, expected validation code, mutation) — one minimal change per field.
fn field_mutations() -> Vec<Mutation> {
    vec![
        ("schema_version", "UnsupportedSchemaVersion", |t| {
            t.schema_version = 2
        }),
        (
            "deadline_rules_version",
            "UnsupportedDeadlineRulesVersion",
            |t| t.deadline_rules_version = 2,
        ),
        ("buyer_id", "ok", |t| {
            t.buyer_id = acc("buyer2.lf-demo.testnet")
        }),
        ("supplier_id", "ok", |t| {
            t.supplier_id = acc("supplier2.lf-demo.testnet")
        }),
        ("primary_arbitrator_id", "ok", |t| {
            t.primary_arbitrator_id = acc("primary2.lf-demo.testnet")
        }),
        ("backup_arbitrator_id", "ok", |t| {
            t.backup_arbitrator_id = acc("backup2.lf-demo.testnet")
        }),
        ("ft_contract_id", "FtNotAllowlisted", |t| {
            t.ft_contract_id = acc("ft-other.lf-demo.testnet")
        }),
        ("agreement_nonce", "ok", |t| t.agreement_nonce += 1),
        ("acceptance_deadline_ns", "ok", |t| {
            t.acceptance_deadline_ns += 1
        }),
        ("funding_deadline_ns", "ok", |t| t.funding_deadline_ns += 1),
        ("delivery_grace_period_ns", "ok", |t| {
            t.delivery_grace_period_ns = 1
        }),
        ("review_window_ns", "ok", |t| t.review_window_ns += 1),
        ("negotiation_window_ns", "ok", |t| {
            t.negotiation_window_ns += 1
        }),
        ("primary_window_ns", "ok", |t| t.primary_window_ns += 1),
        ("backup_window_ns", "ok", |t| t.backup_window_ns += 1),
        ("lines", "ok", |t| {
            t.lines.pop();
        }),
        ("lines[1].line_id", "LineIdMismatch", |t| {
            t.lines[1].line_id = 2
        }),
        ("lines[1].principal", "ok", |t| t.lines[1].principal += 1),
        ("lines[1].delivery_deadline_ns", "ok", |t| {
            t.lines[1].delivery_deadline_ns += 1
        }),
        ("lines[1].acceptance_criteria_commitment", "ok", |t| {
            t.lines[1].acceptance_criteria_commitment[31] ^= 0x01
        }),
        ("lines[1].fallback_buyer_bps", "BpsSumInvalid", |t| {
            t.lines[1].fallback_buyer_bps += 1
        }),
        ("lines[1].fallback_supplier_bps", "BpsSumInvalid", |t| {
            t.lines[1].fallback_supplier_bps -= 1
        }),
    ]
}

type JsonEdit = Box<dyn Fn(&mut Value)>;

/// (name, edit of the golden JSON value, expected stage, expected code).
fn malformed_edits() -> Vec<(&'static str, JsonEdit, &'static str, &'static str)> {
    fn set(path: &'static [&'static str], v: Value) -> JsonEdit {
        Box::new(move |root: &mut Value| {
            let mut cur = root;
            for (i, key) in path.iter().enumerate() {
                let next = if let Ok(idx) = key.parse::<usize>() {
                    &mut cur[idx]
                } else {
                    &mut cur[*key]
                };
                if i == path.len() - 1 {
                    *next = v.clone();
                    return;
                }
                cur = next;
            }
        })
    }
    fn edit(f: impl Fn(&mut Value) + 'static) -> JsonEdit {
        Box::new(f)
    }
    let long_id = format!("{}.testnet", "a".repeat(57)); // 65 chars
    let upper_hex = encode_hex_lower(&commitment(0)).to_uppercase();
    let short_hex = encode_hex_lower(&commitment(0))[..62].to_string();
    let prefixed_hex = format!("0x{}", &encode_hex_lower(&commitment(0))[..62]);
    vec![
        // account ids
        (
            "account id uppercase",
            set(&["buyer_id"], json!("Buyer.lf-demo.testnet")),
            "parse",
            "InvalidAccountId",
        ),
        (
            "account id 65 chars",
            set(&["supplier_id"], json!(long_id)),
            "parse",
            "InvalidAccountId",
        ),
        (
            "account id empty part",
            set(&["primary_arbitrator_id"], json!("a..testnet")),
            "parse",
            "InvalidAccountId",
        ),
        (
            "account id 1 char",
            set(&["backup_arbitrator_id"], json!("a")),
            "parse",
            "InvalidAccountId",
        ),
        // hex
        (
            "commitment uppercase hex",
            set(
                &["lines", "0", "acceptance_criteria_commitment"],
                json!(upper_hex),
            ),
            "parse",
            "InvalidCommitmentHex",
        ),
        (
            "commitment 62 hex chars",
            set(
                &["lines", "0", "acceptance_criteria_commitment"],
                json!(short_hex),
            ),
            "parse",
            "InvalidCommitmentHex",
        ),
        (
            "commitment 0x prefix",
            set(
                &["lines", "0", "acceptance_criteria_commitment"],
                json!(prefixed_hex),
            ),
            "parse",
            "InvalidCommitmentHex",
        ),
        // decimals
        (
            "nonce leading zero",
            set(&["agreement_nonce"], json!("007")),
            "parse",
            "NonCanonicalDecimal",
        ),
        (
            "nonce plus sign",
            set(&["agreement_nonce"], json!("+1")),
            "parse",
            "NonCanonicalDecimal",
        ),
        (
            "nonce exponent",
            set(&["agreement_nonce"], json!("1e3")),
            "parse",
            "NonCanonicalDecimal",
        ),
        (
            "window empty string",
            set(&["review_window_ns"], json!("")),
            "parse",
            "NonCanonicalDecimal",
        ),
        (
            "u64 as JSON number",
            set(&["agreement_nonce"], json!(1)),
            "parse",
            "Json",
        ),
        (
            "u64 overflow",
            set(&["acceptance_deadline_ns"], json!("18446744073709551616")),
            "parse",
            "DecimalOverflow",
        ),
        (
            "u128 overflow",
            set(
                &["lines", "1", "principal"],
                json!("340282366920938463463374607431768211456"),
            ),
            "parse",
            "DecimalOverflow",
        ),
        (
            // Rule A (founder 2026-11-01): each line valid, the sum overflows.
            "principal sum overflow",
            set(
                &["lines", "0", "principal"],
                json!("340282366920938463463374607431768211455"),
            ),
            "validate",
            "PrincipalSumOverflow",
        ),
        (
            "principal zero",
            set(&["lines", "1", "principal"], json!("0")),
            "validate",
            "ZeroPrincipal",
        ),
        // line count / ids
        (
            "zero lines",
            set(&["lines"], json!([])),
            "validate",
            "LineCountOutOfRange",
        ),
        (
            "four lines",
            edit(|v| {
                let mut extra = v["lines"][2].clone();
                extra["line_id"] = json!(3);
                v["lines"].as_array_mut().expect("lines").push(extra);
            }),
            "validate",
            "LineCountOutOfRange",
        ),
        (
            "line id gap",
            edit(|v| {
                v["lines"][1]["line_id"] = json!(2);
                v["lines"][2]["line_id"] = json!(3);
            }),
            "validate",
            "LineIdMismatch",
        ),
        (
            "negative line id",
            set(&["lines", "0", "line_id"], json!(-1)),
            "parse",
            "Json",
        ),
        // bps
        (
            "bps sum 9999",
            set(&["lines", "2", "fallback_supplier_bps"], json!(6_999)),
            "validate",
            "BpsSumInvalid",
        ),
        (
            "bps 10001",
            set(&["lines", "2", "fallback_buyer_bps"], json!(10_001)),
            "validate",
            "BpsOutOfRange",
        ),
        (
            "bps above u16",
            set(&["lines", "2", "fallback_buyer_bps"], json!(70_000)),
            "parse",
            "Json",
        ),
        (
            "bps float",
            set(&["lines", "2", "fallback_buyer_bps"], json!(3000.0)),
            "parse",
            "Json",
        ),
        // structure
        (
            "unknown top-level field",
            set(&["memo"], json!("x")),
            "parse",
            "Json",
        ),
        (
            "unknown line field",
            set(&["lines", "0", "memo"], json!("x")),
            "parse",
            "Json",
        ),
        (
            "missing field",
            edit(|v| {
                v.as_object_mut()
                    .expect("object")
                    .remove("funding_deadline_ns");
            }),
            "parse",
            "Json",
        ),
        (
            "null field",
            set(&["funding_deadline_ns"], Value::Null),
            "parse",
            "Json",
        ),
        (
            "schema_version as string",
            set(&["schema_version"], json!("1")),
            "parse",
            "Json",
        ),
        (
            "schema_version 2",
            set(&["schema_version"], json!(2)),
            "validate",
            "UnsupportedSchemaVersion",
        ),
        // semantic
        (
            "buyer equals supplier",
            set(&["supplier_id"], json!("buyer.lf-demo.testnet")),
            "validate",
            "RolesNotDistinct",
        ),
        (
            "role equals escrow",
            set(&["backup_arbitrator_id"], json!(ESCROW)),
            "validate",
            "RoleIsReservedAccount",
        ),
        (
            "non-allowlisted FT",
            set(&["ft_contract_id"], json!("ft-other.lf-demo.testnet")),
            "validate",
            "FtNotAllowlisted",
        ),
        (
            "window below 60 s",
            set(&["primary_window_ns"], json!("59999999999")),
            "validate",
            "WindowOutOfRange",
        ),
        (
            "grace above 30 d",
            set(&["delivery_grace_period_ns"], json!("2592000000000001")),
            "validate",
            "DeliveryGraceOutOfRange",
        ),
    ]
}

/// Raw-text malformed cases that cannot be expressed as a JSON value edit.
fn malformed_texts(golden_text: &str) -> Vec<(&'static str, String, &'static str, &'static str)> {
    vec![
        (
            "duplicate key",
            format!("{{\"agreement_nonce\":\"8\",{}", &golden_text[1..]),
            "parse",
            "Json",
        ),
        (
            "trailing garbage",
            format!("{golden_text}x"),
            "parse",
            "Json",
        ),
        ("empty input", String::new(), "parse", "Json"),
        (
            "top-level array",
            format!("[{golden_text}]"),
            "parse",
            "Json",
        ),
    ]
}

fn build_vectors() -> Value {
    let ids = Ids::new();
    let g = golden();
    assert_eq!(g.validate(&ids.ctx()), Ok(()));

    // T059 golden
    let (golden_v, golden_digest) =
        vector("T059", "golden", NetworkId::Testnet, &ids.escrow, &g, &ids);
    assert_eq!(golden_digest, GOLDEN_DIGEST_HEX, "pinned golden digest");

    // T060 field mutations (+ T055 grace, T016 principal)
    let mut all_digests = vec![("golden".to_string(), golden_digest.clone())];
    let mut mutations = Vec::new();
    let muts = field_mutations();
    assert_eq!(muts.len(), 22, "16 terms fields + 6 line fields");
    for (field, expected, f) in muts {
        let mut t = g.clone();
        f(&mut t);
        assert_ne!(t, g, "{field} mutated");
        let (v, d) = vector("T060", field, NetworkId::Testnet, &ids.escrow, &t, &ids);
        assert_eq!(v["validation"], json!(expected), "{field}: validation code");
        all_digests.push((field.to_string(), d));
        mutations.push(v);
    }

    // T061 reordered lines
    let mut swapped = g.clone();
    swapped.lines.swap(0, 1);
    let (swapped_v, swapped_d) = vector(
        "T061",
        "lines[0] and lines[1] swapped, ids kept",
        NetworkId::Testnet,
        &ids.escrow,
        &swapped,
        &ids,
    );
    assert_eq!(swapped_v["validation"], json!("LineIdMismatch"));
    let mut renumbered = swapped.clone();
    renumbered.lines[0].line_id = 0;
    renumbered.lines[1].line_id = 1;
    let (renumbered_v, renumbered_d) = vector(
        "T061",
        "lines swapped, ids renumbered to positions",
        NetworkId::Testnet,
        &ids.escrow,
        &renumbered,
        &ids,
    );
    assert_eq!(renumbered_v["validation"], json!("ok"));
    all_digests.push(("T061 swapped".into(), swapped_d));
    all_digests.push(("T061 renumbered".into(), renumbered_d));

    // T063 network, T064 escrow id
    let (sandbox_v, sandbox_d) = vector(
        "T063",
        "network sandbox",
        NetworkId::Sandbox,
        &ids.escrow,
        &g,
        &ids,
    );
    all_digests.push(("T063 sandbox".into(), sandbox_d));
    let mut binding = vec![sandbox_v];
    for other in ["escrow2.lf-demo.testnet", "escrow.lf-demo.testnet.x"] {
        let (v, d) = vector(
            "T064",
            "escrow contract id changed",
            NetworkId::Testnet,
            &acc(other),
            &g,
            &ids,
        );
        all_digests.push((format!("T064 {other}"), d));
        binding.push(v);
    }

    // T078 prerequisite: identical preimage → identical digest
    let (rebuilt_v, rebuilt_d) = vector(
        "T078",
        "independently rebuilt golden terms",
        NetworkId::Testnet,
        &ids.escrow,
        &golden(),
        &ids,
    );
    assert_eq!(
        rebuilt_d, golden_digest,
        "identical preimage, identical digest"
    );

    for i in 0..all_digests.len() {
        for j in (i + 1)..all_digests.len() {
            assert_ne!(
                all_digests[i].1, all_digests[j].1,
                "{} vs {}",
                all_digests[i].0, all_digests[j].0
            );
        }
    }

    // JSON form is not hashed: key order and whitespace do not matter.
    let struct_order_text = serde_json::to_string(&AgreementTermsJsonV1::from(&g)).expect("text");
    let pretty_text = serde_json::to_string_pretty(&terms_value(&g)).expect("text");
    let mut equivalence = Vec::new();
    for (name, text) in [
        ("struct field order", struct_order_text),
        ("pretty-printed", pretty_text),
    ] {
        let t = parse_and_validate(&text, &ids.ctx()).expect("equivalent JSON is valid");
        let d = encode_hex_lower(&terms_hash(NetworkId::Testnet, &ids.escrow, &t));
        assert_eq!(d, golden_digest, "{name}");
        equivalence.push(json!({ "label": name, "json_text": text, "digest_hex": d }));
    }

    // T062 malformed
    let golden_text = serde_json::to_string(&terms_value(&g)).expect("text");
    let mut cases: Vec<(&str, String, &str, &str)> = Vec::new();
    for (name, edit, stage, code) in malformed_edits() {
        let mut v = terms_value(&g);
        edit(&mut v);
        cases.push((name, serde_json::to_string(&v).expect("text"), stage, code));
    }
    cases.extend(malformed_texts(&golden_text));
    let mut malformed = Vec::new();
    for (name, text, stage, code) in cases {
        let err = parse_and_validate(&text, &ids.ctx()).expect_err(name);
        assert_eq!((err.stage(), err.code()), (stage, code), "{name}: {err:?}");
        malformed.push(json!({
            "id": "T062",
            "label": name,
            "json_text": text,
            "expect": { "accept": false, "stage": stage, "code": code },
        }));
    }

    json!({
        "_generated_by": "contracts/escrow/tests/terms_vectors.rs (Rust reference). Do not edit by hand.",
        "_regenerate": "cd contracts/escrow && LINEFAIR_WRITE_VECTORS=1 cargo test --locked --test terms_vectors",
        "_ts_contract": "A TypeScript encoder must reproduce preimage_hex and digest_hex for every vector, including vectors whose `validation` is not \"ok\" (encoding is independent of validation), and must reject every `malformed` case. `stage`/`code` are the Rust reference outcome.",
        "encoding": {
            "domain_ascii": String::from_utf8(TERMS_DOMAIN_V1.to_vec()).expect("ascii"),
            "separator_hex": "00",
            "preimage": "domain || 0x00 || bstr(network_id) || bstr(escrow_contract_id) || Borsh(AgreementTermsV1)",
            "bstr": "u32 little-endian byte length || UTF-8 bytes",
            "hash": "SHA-256",
            "spec": "docs/20_DATA_MODELS_AND_EVENTS.md §Canonical terms encoding v1",
        },
        "context": {
            "network": "testnet",
            "escrow_id": ESCROW,
            "allowlisted_ft_id": FT,
            "operator_treasury_id": TREASURY,
            "now_ns": NOW.to_string(),
            "note": "Fixture accounts only; nothing is deployed. Commitments are sha256(\"linefair/fixture/criteria/<line_id>\"), not real salted commitments.",
        },
        "golden": golden_v,
        "field_mutations": mutations,
        "reordered_lines": [swapped_v, renumbered_v],
        "binding": binding,
        "identical_preimage": rebuilt_v,
        "json_equivalence": equivalence,
        "malformed": malformed,
    })
}

#[test]
fn shared_terms_vectors_are_reproducible() {
    let generated = serde_json::to_string_pretty(&build_vectors()).expect("pretty") + "\n";
    // Generating twice yields identical bytes.
    let again = serde_json::to_string_pretty(&build_vectors()).expect("pretty") + "\n";
    assert_eq!(generated, again, "vector generation is deterministic");

    let path = vectors_path();
    if std::env::var("LINEFAIR_WRITE_VECTORS").as_deref() == Ok("1") {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, &generated).expect("write vectors");
        println!("wrote {}", path.display());
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "missing {} ({e}); regenerate with LINEFAIR_WRITE_VECTORS=1",
            path.display()
        )
    });
    assert!(
        committed == generated,
        "committed vectors differ from the Rust reference; encoding drift needs schema v2 + founder approval"
    );
}

#[test]
fn committed_vectors_verify_against_public_api() {
    // Independent of generation: parse the committed file and re-verify each
    // vector the way a consumer would.
    let text = std::fs::read_to_string(vectors_path()).expect("committed vectors");
    let doc: Value = serde_json::from_str(&text).expect("vectors JSON");
    let ids = Ids::new();
    let mut checked = 0;
    let mut check = |v: &Value| {
        let net = NetworkId::parse(v["network"].as_str().expect("network")).expect("known network");
        let escrow = acc(v["escrow_id"].as_str().expect("escrow"));
        let terms_text = serde_json::to_string(&v["terms"]).expect("terms");
        let t = parse_terms_json(&terms_text).expect("terms parse");
        assert_eq!(
            encode_hex_lower(&terms_preimage(net, &escrow, &t)),
            v["preimage_hex"].as_str().expect("pre")
        );
        assert_eq!(
            encode_hex_lower(&terms_hash(net, &escrow, &t)),
            v["digest_hex"].as_str().expect("digest")
        );
        assert_eq!(
            validation_code(&t, &ids),
            v["validation"].as_str().expect("validation")
        );
        checked += 1;
    };
    check(&doc["golden"]);
    check(&doc["identical_preimage"]);
    for key in ["field_mutations", "reordered_lines", "binding"] {
        for v in doc[key].as_array().expect(key) {
            check(v);
        }
    }
    assert_eq!(checked, 2 + 22 + 2 + 3);
    let mut rejected = 0;
    for m in doc["malformed"].as_array().expect("malformed") {
        let err = parse_and_validate(m["json_text"].as_str().expect("text"), &ids.ctx())
            .expect_err("must reject");
        assert_eq!(err.stage(), m["expect"]["stage"].as_str().expect("stage"));
        assert_eq!(err.code(), m["expect"]["code"].as_str().expect("code"));
        rejected += 1;
    }
    assert!(rejected >= 30, "malformed coverage: {rejected}");
}
