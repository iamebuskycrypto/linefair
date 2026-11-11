//! Canonical terms hash v1 (M1 S2 / LF-002b).
//!
//! `docs/20` §Canonical terms encoding v1 (FROZEN 2026-10-27):
//!
//! ```text
//! terms_hash = SHA-256( "linefair/agreement/v1" || 0x00
//!                       || bstr(network_id) || bstr(escrow_contract_id)
//!                       || Borsh(AgreementTermsV1) )
//! bstr(x) = u32 LE byte length || UTF-8 bytes
//! ```
//!
//! The hash is always recomputed by the contract and never taken from a
//! caller. `terms_hash`, `agreement_id`, acceptance flags and runtime state are
//! not part of the preimage.
//!
//! Hashing uses `env::sha256_array`: the NEAR host function in WASM and a
//! native SHA-256 in host tests. No caller, time or amount is read from `env`.

use near_sdk::AccountId;
use near_sdk::borsh::{self, BorshSerialize};
use near_sdk::{env, near};

use crate::terms::AgreementTermsV1;

/// Domain tag: 21 ASCII bytes, no length prefix, followed by `0x00`.
pub const TERMS_DOMAIN_V1: &[u8; 21] = b"linefair/agreement/v1";
/// Separator byte after the domain tag.
pub const DOMAIN_SEPARATOR: u8 = 0x00;

/// A 32-byte SHA-256 digest of the canonical terms preimage.
pub type TermsHash = [u8; 32];

/// The networks this contract may be initialised for (OQ-13). There is no
/// mainnet variant, so mainnet terms cannot even be encoded.
#[near(serializers = [borsh])]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkId {
    Sandbox,
    Testnet,
}

impl NetworkId {
    pub fn as_str(self) -> &'static str {
        match self {
            NetworkId::Sandbox => "sandbox",
            NetworkId::Testnet => "testnet",
        }
    }

    /// Exact, case-sensitive parse. Anything else, including `"mainnet"`, is `None`.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "sandbox" => Some(NetworkId::Sandbox),
            "testnet" => Some(NetworkId::Testnet),
            _ => None,
        }
    }
}

/// The exact bytes that are hashed.
pub fn terms_preimage(
    network: NetworkId,
    escrow_id: &AccountId,
    terms: &AgreementTermsV1,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(512);
    buf.extend_from_slice(TERMS_DOMAIN_V1);
    buf.push(DOMAIN_SEPARATOR);
    // Borsh `str` / `String` / `AccountId` is exactly bstr: u32 LE length + UTF-8.
    // Writing to a Vec<u8> fails only if a length exceeds u32::MAX, which no
    // account id (<= 64 bytes) or line list can reach.
    network
        .as_str()
        .serialize(&mut buf)
        .expect("bstr(network) into Vec");
    escrow_id
        .serialize(&mut buf)
        .expect("bstr(escrow_id) into Vec");
    borsh::to_writer(&mut buf, terms).expect("Borsh(AgreementTermsV1) into Vec");
    buf
}

/// The canonical terms hash v1.
pub fn terms_hash(
    network: NetworkId,
    escrow_id: &AccountId,
    terms: &AgreementTermsV1,
) -> TermsHash {
    env::sha256_array(terms_preimage(network, escrow_id, terms))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terms::{
        DEFAULT_BACKUP_WINDOW_NS, DEFAULT_NEGOTIATION_WINDOW_NS, DEFAULT_PRIMARY_WINDOW_NS,
        DEFAULT_REVIEW_WINDOW_NS, LineTermsV1, TermsError, ValidationContext,
    };
    use proptest::prelude::*;
    use sha2::{Digest, Sha256};

    const NOW: u64 = 1_800_000_000_000_000_000;
    const HOUR: u64 = 3_600_000_000_000;

    fn acc(s: &str) -> AccountId {
        s.parse().expect("test account id")
    }

    fn escrow() -> AccountId {
        acc("escrow.lf-demo.testnet")
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn line(line_id: u32, principal: u128, hours: u64, b: u16, s: u16) -> LineTermsV1 {
        LineTermsV1 {
            line_id,
            principal,
            delivery_deadline_ns: NOW + hours * HOUR,
            acceptance_criteria_commitment: Sha256::digest(
                format!("linefair/fixture/criteria/{line_id}").as_bytes(),
            )
            .into(),
            fallback_buyer_bps: b,
            fallback_supplier_bps: s,
        }
    }

    /// Same terms as the golden vector in `tests/terms_vectors.rs`.
    fn golden() -> AgreementTermsV1 {
        AgreementTermsV1 {
            schema_version: 1,
            deadline_rules_version: 1,
            buyer_id: acc("buyer.lf-demo.testnet"),
            supplier_id: acc("supplier.lf-demo.testnet"),
            primary_arbitrator_id: acc("primary.lf-demo.testnet"),
            backup_arbitrator_id: acc("backup.lf-demo.testnet"),
            ft_contract_id: acc("ft-test.lf-demo.testnet"),
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

    fn h(t: &AgreementTermsV1) -> TermsHash {
        terms_hash(NetworkId::Testnet, &escrow(), t)
    }

    // ---- independent spec encoder (written from the docs/20 tables, not Borsh) ----

    fn spec_bstr(out: &mut Vec<u8>, s: &str) {
        out.extend_from_slice(&u32::try_from(s.len()).expect("short").to_le_bytes());
        out.extend_from_slice(s.as_bytes());
    }

    fn spec_preimage(network: &str, escrow_id: &str, t: &AgreementTermsV1) -> Vec<u8> {
        let mut o = Vec::new();
        o.extend_from_slice(b"linefair/agreement/v1");
        o.push(0x00);
        spec_bstr(&mut o, network);
        spec_bstr(&mut o, escrow_id);
        o.extend_from_slice(&t.schema_version.to_le_bytes()); // 1
        o.extend_from_slice(&t.deadline_rules_version.to_le_bytes()); // 2
        spec_bstr(&mut o, t.buyer_id.as_str()); // 3
        spec_bstr(&mut o, t.supplier_id.as_str()); // 4
        spec_bstr(&mut o, t.primary_arbitrator_id.as_str()); // 5
        spec_bstr(&mut o, t.backup_arbitrator_id.as_str()); // 6
        spec_bstr(&mut o, t.ft_contract_id.as_str()); // 7
        o.extend_from_slice(&t.agreement_nonce.to_le_bytes()); // 8
        o.extend_from_slice(&t.acceptance_deadline_ns.to_le_bytes()); // 9
        o.extend_from_slice(&t.funding_deadline_ns.to_le_bytes()); // 10
        o.extend_from_slice(&t.delivery_grace_period_ns.to_le_bytes()); // 11
        o.extend_from_slice(&t.review_window_ns.to_le_bytes()); // 12
        o.extend_from_slice(&t.negotiation_window_ns.to_le_bytes()); // 13
        o.extend_from_slice(&t.primary_window_ns.to_le_bytes()); // 14
        o.extend_from_slice(&t.backup_window_ns.to_le_bytes()); // 15
        o.extend_from_slice(&u32::try_from(t.lines.len()).expect("few").to_le_bytes()); // 16
        for l in &t.lines {
            o.extend_from_slice(&l.line_id.to_le_bytes());
            o.extend_from_slice(&l.principal.to_le_bytes()); // u128 LE, 16 bytes
            o.extend_from_slice(&l.delivery_deadline_ns.to_le_bytes());
            o.extend_from_slice(&l.acceptance_criteria_commitment); // raw 32, no prefix
            o.extend_from_slice(&l.fallback_buyer_bps.to_le_bytes());
            o.extend_from_slice(&l.fallback_supplier_bps.to_le_bytes());
        }
        o
    }

    // ---- SHA-256 primitive -------------------------------------------------

    #[test]
    fn sha256_known_answer_nist_abc() {
        // FIPS 180-2 Appendix B.1.
        assert_eq!(
            hex(&env::sha256_array(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex(&env::sha256_array(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    // ---- T059 golden ---------------------------------------------------------

    /// Pinned golden digest. If this changes, encoding v1 changed: that needs
    /// schema v2 and founder approval (docs/20, docs/24 §Stop / ask).
    const GOLDEN_DIGEST_HEX: &str =
        "9257a5bfea49918f0a1b1a3308ad553a384079e73da987df495f55002869a33c";

    #[test]
    fn t059_golden_digest_pinned_and_cross_checked() {
        let t = golden();
        assert_eq!(t.validate(&golden_ctx()), Ok(()), "golden terms are valid");
        let pre = terms_preimage(NetworkId::Testnet, &escrow(), &t);
        let via_env = h(&t);
        let via_sha2: [u8; 32] = Sha256::digest(&pre).into();
        assert_eq!(via_env, via_sha2, "env::sha256_array == sha2");
        assert_eq!(hex(&via_env), GOLDEN_DIGEST_HEX, "pinned golden digest");
    }

    fn golden_ctx_ids() -> (AccountId, AccountId, AccountId) {
        (
            escrow(),
            acc("ft-test.lf-demo.testnet"),
            acc("treasury.lf-demo.testnet"),
        )
    }

    fn golden_ctx() -> ValidationContext<'static> {
        use std::sync::OnceLock;
        static IDS: OnceLock<(AccountId, AccountId, AccountId)> = OnceLock::new();
        let ids = IDS.get_or_init(golden_ctx_ids);
        ValidationContext {
            now_ns: NOW,
            escrow_id: &ids.0,
            allowlisted_ft_id: &ids.1,
            operator_treasury_id: &ids.2,
        }
    }

    // ---- layout = spec ---------------------------------------------------------

    #[test]
    fn preimage_matches_independent_spec_encoder() {
        let t = golden();
        for net in [NetworkId::Sandbox, NetworkId::Testnet] {
            assert_eq!(
                terms_preimage(net, &escrow(), &t),
                spec_preimage(net.as_str(), escrow().as_str(), &t)
            );
        }
    }

    #[test]
    fn preimage_prefix_bytes_are_literal() {
        let pre = terms_preimage(NetworkId::Sandbox, &escrow(), &golden());
        let mut expected = b"linefair/agreement/v1".to_vec();
        assert_eq!(expected.len(), 21);
        expected.push(0);
        expected.extend_from_slice(&[7, 0, 0, 0]);
        expected.extend_from_slice(b"sandbox");
        expected.extend_from_slice(&[22, 0, 0, 0]);
        expected.extend_from_slice(b"escrow.lf-demo.testnet");
        expected.extend_from_slice(&[1, 0, 1, 0]); // schema_version, deadline_rules_version
        assert_eq!(&pre[..expected.len()], &expected[..]);
        // Total length: 21+1 + (4+7) + (4+22) + terms. Terms = 2+2 + 5 bstr
        // + 8*8 u64 fields + 4 + 3 * (4+16+8+32+2+2).
        let ids = ["buyer", "supplier", "primary", "backup", "ft-test"]
            .iter()
            .map(|p| 4 + p.len() + ".lf-demo.testnet".len())
            .sum::<usize>();
        let terms_len = 4 + ids + 8 * 8 + 4 + 3 * 64;
        assert_eq!(pre.len(), 22 + 11 + 26 + terms_len);
    }

    // ---- determinism -------------------------------------------------------------

    #[test]
    fn encoding_is_deterministic() {
        let a = golden();
        let b = golden(); // independently constructed
        assert_eq!(h(&a), h(&a));
        assert_eq!(h(&a), h(&b));
        assert_eq!(h(&a), h(&a.clone()));
        // Borsh round trip yields identical terms and identical bytes.
        let bytes = borsh::to_vec(&a).expect("encode");
        let back: AgreementTermsV1 = borsh::from_slice(&bytes).expect("decode");
        assert_eq!(back, a);
        assert_eq!(borsh::to_vec(&back).expect("encode"), bytes);
    }

    #[test]
    fn borsh_decode_rejects_trailing_and_truncated_bytes() {
        let mut bytes = borsh::to_vec(&golden()).expect("encode");
        bytes.push(0);
        assert!(borsh::from_slice::<AgreementTermsV1>(&bytes).is_err());
        bytes.truncate(bytes.len() - 2);
        assert!(borsh::from_slice::<AgreementTermsV1>(&bytes).is_err());
    }

    // ---- T060 / T055 / T016: every field is committed --------------------------

    /// One minimal change per committed field: 16 terms fields + 6 line fields.
    fn single_field_mutations() -> Vec<(&'static str, AgreementTermsV1)> {
        let g = golden();
        let m = |name: &'static str, f: &dyn Fn(&mut AgreementTermsV1)| {
            let mut t = g.clone();
            f(&mut t);
            (name, t)
        };
        vec![
            m("schema_version", &|t| t.schema_version = 2),
            m("deadline_rules_version", &|t| t.deadline_rules_version = 2),
            m("buyer_id", &|t| t.buyer_id = acc("buyer2.lf-demo.testnet")),
            m("supplier_id", &|t| {
                t.supplier_id = acc("supplier2.lf-demo.testnet")
            }),
            m("primary_arbitrator_id", &|t| {
                t.primary_arbitrator_id = acc("primary2.lf-demo.testnet")
            }),
            m("backup_arbitrator_id", &|t| {
                t.backup_arbitrator_id = acc("backup2.lf-demo.testnet")
            }),
            m("ft_contract_id", &|t| {
                t.ft_contract_id = acc("ft-other.lf-demo.testnet")
            }),
            m("agreement_nonce", &|t| t.agreement_nonce += 1),
            m("acceptance_deadline_ns", &|t| t.acceptance_deadline_ns += 1),
            m("funding_deadline_ns", &|t| t.funding_deadline_ns += 1),
            m("delivery_grace_period_ns", &|t| {
                t.delivery_grace_period_ns = 1
            }),
            m("review_window_ns", &|t| t.review_window_ns += 1),
            m("negotiation_window_ns", &|t| t.negotiation_window_ns += 1),
            m("primary_window_ns", &|t| t.primary_window_ns += 1),
            m("backup_window_ns", &|t| t.backup_window_ns += 1),
            m("lines", &|t| {
                t.lines.pop();
            }),
            m("lines[1].line_id", &|t| t.lines[1].line_id = 2),
            m("lines[1].principal", &|t| t.lines[1].principal += 1),
            m("lines[1].delivery_deadline_ns", &|t| {
                t.lines[1].delivery_deadline_ns += 1
            }),
            m("lines[1].acceptance_criteria_commitment", &|t| {
                t.lines[1].acceptance_criteria_commitment[31] ^= 0x01
            }),
            m("lines[1].fallback_buyer_bps", &|t| {
                t.lines[1].fallback_buyer_bps += 1
            }),
            m("lines[1].fallback_supplier_bps", &|t| {
                t.lines[1].fallback_supplier_bps -= 1
            }),
        ]
    }

    #[test]
    fn t060_each_of_22_fields_changes_digest() {
        let muts = single_field_mutations();
        assert_eq!(muts.len(), 22, "16 terms fields + 6 line fields");
        let mut digests = vec![("golden", h(&golden()))];
        for (name, t) in &muts {
            assert_ne!(t, &golden(), "{name} actually mutated");
            digests.push((name, h(t)));
        }
        for i in 0..digests.len() {
            for j in (i + 1)..digests.len() {
                assert_ne!(
                    digests[i].1, digests[j].1,
                    "{} vs {}",
                    digests[i].0, digests[j].0
                );
            }
        }
    }

    #[test]
    fn t055_grace_zero_vs_nonzero_digests_differ() {
        let g0 = golden();
        let mut g1 = golden();
        g1.delivery_grace_period_ns = 1;
        let mut g_hour = golden();
        g_hour.delivery_grace_period_ns = HOUR;
        assert_ne!(h(&g0), h(&g1));
        assert_ne!(h(&g0), h(&g_hour));
        assert_ne!(h(&g1), h(&g_hour));
        // deadline_rules_version is committed too.
        let mut v2 = golden();
        v2.deadline_rules_version = 2;
        assert_ne!(h(&g0), h(&v2));
    }

    #[test]
    fn t016_mutated_amount_changes_digest() {
        // Hash-level part of T016. Rejecting the old hash on accept/fund is
        // tested with acceptance (S3) and funding (LF-005).
        let g = golden();
        for idx in 0..3 {
            for delta in [1u128, 1_000_000] {
                let mut t = golden();
                t.lines[idx].principal += delta;
                assert_ne!(h(&g), h(&t), "line {idx} +{delta}");
            }
        }
        // Moving value between lines keeps the total but changes the digest.
        let mut t = golden();
        t.lines[0].principal -= 1;
        t.lines[1].principal += 1;
        assert_ne!(h(&g), h(&t));
        // Swapping fallback bps keeps the sum but changes the digest.
        let mut t = golden();
        t.lines[1].fallback_buyer_bps = 4_000;
        t.lines[1].fallback_supplier_bps = 6_000;
        assert_ne!(h(&g), h(&t));
    }

    // ---- T061 reordered lines ----------------------------------------------------

    #[test]
    fn t061_reordered_lines_rejected_and_digest_differs() {
        let g = golden();
        let mut swapped = golden();
        swapped.lines.swap(0, 1);
        assert_eq!(
            swapped.validate(&golden_ctx()),
            Err(TermsError::LineIdMismatch {
                position: 0,
                line_id: 1
            })
        );
        assert_ne!(h(&g), h(&swapped));
        // Even with ids renumbered to positions (valid terms), order is committed.
        let mut renumbered = swapped.clone();
        renumbered.lines[0].line_id = 0;
        renumbered.lines[1].line_id = 1;
        assert_eq!(renumbered.validate(&golden_ctx()), Ok(()));
        assert_ne!(h(&g), h(&renumbered));
        assert_ne!(h(&swapped), h(&renumbered));
    }

    // ---- T063 / T064 network and contract binding ----------------------------------

    #[test]
    fn t063_network_sandbox_vs_testnet_differ() {
        let t = golden();
        assert_ne!(
            terms_hash(NetworkId::Sandbox, &escrow(), &t),
            terms_hash(NetworkId::Testnet, &escrow(), &t)
        );
    }

    #[test]
    fn t064_escrow_id_changes_digest() {
        let t = golden();
        let base = h(&t);
        for other in [
            "escrow2.lf-demo.testnet",
            "escrow.lf-demo.testnet.x",
            "x.escrow.lf-demo.testnet",
            "escrow.lf-demo.testneu",
        ] {
            assert_ne!(
                base,
                terms_hash(NetworkId::Testnet, &acc(other), &t),
                "{other}"
            );
        }
    }

    #[test]
    fn network_parse_is_exact_and_has_no_mainnet() {
        assert_eq!(NetworkId::parse("sandbox"), Some(NetworkId::Sandbox));
        assert_eq!(NetworkId::parse("testnet"), Some(NetworkId::Testnet));
        for bad in ["mainnet", "Testnet", "TESTNET", "testnet ", "", "localnet"] {
            assert_eq!(NetworkId::parse(bad), None, "{bad:?}");
        }
        for n in [NetworkId::Sandbox, NetworkId::Testnet] {
            assert_eq!(NetworkId::parse(n.as_str()), Some(n));
        }
    }

    // ---- domain separation --------------------------------------------------------

    #[test]
    fn domain_separation() {
        let t = golden();
        let borsh_only = borsh::to_vec(&t).expect("encode");
        let canonical = h(&t);
        let sha = |b: &[u8]| -> [u8; 32] { Sha256::digest(b).into() };

        // Plain hash of the Borsh bytes (no domain, network or contract).
        assert_ne!(canonical, sha(&borsh_only));

        let tail = |domain: &[u8], sep: Option<u8>| {
            let mut o = domain.to_vec();
            if let Some(s) = sep {
                o.push(s);
            }
            spec_bstr(&mut o, "testnet");
            spec_bstr(&mut o, escrow().as_str());
            o.extend_from_slice(&borsh_only);
            sha(&o)
        };
        assert_eq!(canonical, tail(b"linefair/agreement/v1", Some(0)));
        assert_ne!(canonical, tail(b"linefair/agreement/v1", None), "separator");
        assert_ne!(
            canonical,
            tail(b"linefair/agreement/v1", Some(1)),
            "separator value"
        );
        assert_ne!(
            canonical,
            tail(b"linefair/agreement/v2", Some(0)),
            "version"
        );
        assert_ne!(
            canonical,
            tail(b"linefair/criteria/v1", Some(0)),
            "other LineFair domain"
        );
        assert_ne!(
            canonical,
            tail(b"linefair/evidence/v1", Some(0)),
            "other LineFair domain"
        );
    }

    #[test]
    fn length_prefixes_prevent_field_boundary_shifts() {
        // Moving a character across the buyer/supplier boundary must not
        // produce the same bytes (bstr length prefixes).
        let mut a = golden();
        a.buyer_id = acc("ab.lf-demo.testnet");
        a.supplier_id = acc("c.lf-demo.testnet");
        let mut b = golden();
        b.buyer_id = acc("a.lf-demo.testnet");
        b.supplier_id = acc("bc.lf-demo.testnet");
        assert_ne!(h(&a), h(&b));
    }

    // ---- T078 prerequisite ----------------------------------------------------------

    #[test]
    fn t078_prerequisite_identical_preimage_identical_digest() {
        // Registration-time rejection of an already-registered preimage is S3.
        // Here: identical terms always give the same key; a new nonce does not.
        assert_eq!(h(&golden()), h(&golden()));
        let mut n2 = golden();
        n2.agreement_nonce = 2;
        assert_ne!(h(&golden()), h(&n2));
    }

    // ---- property tests -------------------------------------------------------------

    fn arb_account() -> impl Strategy<Value = AccountId> {
        "[a-z0-9]{2,12}(\\.[a-z0-9]{1,10}){0,2}".prop_map(|s| acc(&s))
    }

    fn arb_terms() -> impl Strategy<Value = AgreementTermsV1> {
        let line = (
            any::<u32>(),
            any::<u128>(),
            any::<u64>(),
            any::<[u8; 32]>(),
            any::<u16>(),
            any::<u16>(),
        )
            .prop_map(|(line_id, principal, d, c, b, s)| LineTermsV1 {
                line_id,
                principal,
                delivery_deadline_ns: d,
                acceptance_criteria_commitment: c,
                fallback_buyer_bps: b,
                fallback_supplier_bps: s,
            });
        (
            (any::<u16>(), any::<u16>()),
            proptest::array::uniform5(arb_account()),
            proptest::array::uniform8(any::<u64>()),
            proptest::collection::vec(line, 0..4),
        )
            .prop_map(|((sv, dv), ids, n, lines)| {
                let [buyer, supplier, primary, backup, ft] = ids;
                AgreementTermsV1 {
                    schema_version: sv,
                    deadline_rules_version: dv,
                    buyer_id: buyer,
                    supplier_id: supplier,
                    primary_arbitrator_id: primary,
                    backup_arbitrator_id: backup,
                    ft_contract_id: ft,
                    agreement_nonce: n[0],
                    acceptance_deadline_ns: n[1],
                    funding_deadline_ns: n[2],
                    delivery_grace_period_ns: n[3],
                    review_window_ns: n[4],
                    negotiation_window_ns: n[5],
                    primary_window_ns: n[6],
                    backup_window_ns: n[7],
                    lines,
                }
            })
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 2_048, ..ProptestConfig::default() })]

        /// For arbitrary terms: Borsh preimage == independent spec encoder,
        /// env hash == sha2, encoding is deterministic and round-trips.
        #[test]
        fn preimage_equals_spec_encoder_prop(t in arb_terms(), sandbox in any::<bool>(), esc in arb_account()) {
            let net = if sandbox { NetworkId::Sandbox } else { NetworkId::Testnet };
            let pre = terms_preimage(net, &esc, &t);
            prop_assert_eq!(&pre, &spec_preimage(net.as_str(), esc.as_str(), &t));
            prop_assert_eq!(&pre, &terms_preimage(net, &esc, &t.clone()));
            let via_sha2: [u8; 32] = Sha256::digest(&pre).into();
            prop_assert_eq!(terms_hash(net, &esc, &t), via_sha2);
            let bytes = borsh::to_vec(&t).expect("encode");
            let back: AgreementTermsV1 = borsh::from_slice(&bytes).expect("decode");
            prop_assert_eq!(back, t);
        }

        /// Any two distinct terms give distinct preimages (injective encoding),
        /// hence distinct digests barring a SHA-256 collision.
        #[test]
        fn distinct_terms_have_distinct_preimages_prop(a in arb_terms(), b in arb_terms()) {
            let esc = escrow();
            let pa = terms_preimage(NetworkId::Testnet, &esc, &a);
            let pb = terms_preimage(NetworkId::Testnet, &esc, &b);
            prop_assert_eq!(a == b, pa == pb);
            if a != b {
                prop_assert_ne!(terms_hash(NetworkId::Testnet, &esc, &a), terms_hash(NetworkId::Testnet, &esc, &b));
            }
        }

        /// A single random field change on random terms always changes the digest.
        #[test]
        fn single_field_change_changes_digest_prop(t in arb_terms(), field in 0usize..16, v in any::<u64>()) {
            let mut m = t.clone();
            match field {
                0 => m.schema_version = m.schema_version.wrapping_add(1 + (v % 100) as u16),
                1 => m.deadline_rules_version = m.deadline_rules_version.wrapping_add(1),
                2 => m.buyer_id = acc(&format!("z{}", m.buyer_id)),
                3 => m.supplier_id = acc(&format!("z{}", m.supplier_id)),
                4 => m.primary_arbitrator_id = acc(&format!("z{}", m.primary_arbitrator_id)),
                5 => m.backup_arbitrator_id = acc(&format!("z{}", m.backup_arbitrator_id)),
                6 => m.ft_contract_id = acc(&format!("z{}", m.ft_contract_id)),
                7 => m.agreement_nonce ^= v | 1,
                8 => m.acceptance_deadline_ns ^= v | 1,
                9 => m.funding_deadline_ns ^= v | 1,
                10 => m.delivery_grace_period_ns ^= v | 1,
                11 => m.review_window_ns ^= v | 1,
                12 => m.negotiation_window_ns ^= v | 1,
                13 => m.primary_window_ns ^= v | 1,
                14 => m.backup_window_ns ^= v | 1,
                _ => {
                    if let Some(l) = m.lines.first_mut() {
                        l.principal ^= u128::from(v | 1);
                    } else {
                        m.lines.push(line(0, 1, 1, 5_000, 5_000));
                    }
                }
            }
            prop_assert_ne!(&m, &t);
            prop_assert_ne!(h(&m), h(&t));
        }
    }
}
