//! Release-artifact isolation guard (test-only; no contract change).
//!
//! The qualified release outputs in `target/near/` must describe the release
//! WASM only. Building the test-only `test-starve-callback` variant with the
//! shared cargo target directory rewrites `target/near/linefair_escrow_abi.json`
//! with the starve build's metadata (observed 2026-11-05), so a fixture or
//! deployment step that trusts that file could pin the starve build. Build the
//! starve variant with `scripts/build-artifacts.sh` (isolated CARGO_TARGET_DIR).

use near_sdk::serde_json::{self, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn base58(bytes: &[u8]) -> String {
    let mut digits: Vec<u8> = Vec::new(); // little-endian base-58 digits
    for &b in bytes {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let zeros = bytes.iter().take_while(|&&b| b == 0).count();
    let mut s = "1".repeat(zeros);
    s.extend(digits.iter().rev().map(|&d| B58[d as usize] as char));
    s
}

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target")
}

fn read(p: &PathBuf) -> Vec<u8> {
    std::fs::read(p).unwrap_or_else(|e| {
        panic!(
            "missing {} ({e}); run scripts/build-artifacts.sh",
            p.display()
        )
    })
}

fn sha(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn abi_wasm_hash(p: &PathBuf) -> String {
    let abi: Value = serde_json::from_slice(&read(p)).expect("ABI is JSON");
    abi["metadata"]["wasm_hash"]
        .as_str()
        .expect("metadata.wasm_hash")
        .to_owned()
}

#[test]
fn base58_matches_known_vectors() {
    assert_eq!(base58(&[0u8; 32]), "11111111111111111111111111111111");
    // Release and starve digests recorded in evidence/lf012 and docs/32.
    let rel = hex32("470db97b62cd04701e68f6a87d7589dd8af9b8d122b96e4f5e12788d4405f2e1");
    assert_eq!(base58(&rel), "5nN5ua65yntBYmNZC6JEtdWYBbbuBkVxuHC7GZxpBgcQ");
    let stv = hex32("76618fe6be7bf5fa6ae9290fef2355ae6a038ee0c550e9ec206c6318409fcecb");
    assert_eq!(base58(&stv), "8y7PnG5p9L2Na9rAfnnLfFNZRFx59mheWjD8tEXL829G");
}

fn hex32(h: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).expect("hex");
    }
    out
}

#[test]
fn release_abi_describes_the_release_wasm() {
    let d = dir();
    let release = read(&d.join("near/linefair_escrow.wasm"));
    let want = base58(&sha(&release));
    let got = abi_wasm_hash(&d.join("near/linefair_escrow_abi.json"));
    assert_eq!(
        got, want,
        "target/near/linefair_escrow_abi.json describes another WASM (starve build with a shared target dir?); rebuild with scripts/build-artifacts.sh"
    );
}

#[test]
fn starve_artifacts_are_separate_and_never_the_release() {
    let d = dir();
    let release = sha(&read(&d.join("near/linefair_escrow.wasm")));
    let starve_path = d.join("near-starve/linefair_escrow.wasm");
    let starve = sha(&read(&starve_path));
    assert_ne!(release, starve, "starve build must differ from the release");
    // The starve ABI, if present, describes the starve WASM, not the release.
    let starve_abi = d.join("near-starve/linefair_escrow_abi.json");
    if starve_abi.exists() {
        assert_eq!(abi_wasm_hash(&starve_abi), base58(&starve));
    }
}
