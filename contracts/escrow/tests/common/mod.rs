//! Shared sandbox helpers. Every sandbox test uses the sha256-verified binary
//! from `NEAR_SANDBOX_BIN_PATH` (docs/24) and this crate's cargo-near WASM.
#![allow(dead_code)]

use std::path::PathBuf;

use near_sdk::serde_json::{Value, json};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};

pub type TestResult = Result<(), Box<dyn std::error::Error>>;

pub const FT: &str = "ft.test.near";
pub const TREASURY: &str = "treasury.test.near";
pub const HOUR: u64 = 3_600_000_000_000;
/// LF-010A default creator allowlist for sandbox deploys (`docs/28`).
pub const CREATORS: [&str; 2] = ["buyer.test.near", "supplier.test.near"];

pub fn wasm() -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/near/linefair_escrow.wasm");
    std::fs::read(&path).map_err(|e| {
        format!(
            "missing {} ({e}); run `cargo near build non-reproducible-wasm --locked` first",
            path.display()
        )
        .into()
    })
}

pub async fn sandbox() -> Result<Worker<Sandbox>, Box<dyn std::error::Error>> {
    let bin = std::env::var("NEAR_SANDBOX_BIN_PATH")
        .map_err(|_| "NEAR_SANDBOX_BIN_PATH must point at the verified sandbox binary")?;
    assert!(
        std::path::Path::new(&bin).is_file(),
        "NEAR_SANDBOX_BIN_PATH is not a file: {bin}"
    );
    Ok(near_workspaces::sandbox().await?)
}

/// Deploy and initialise the escrow (`new` signed by the contract itself).
pub async fn deploy(
    worker: &Worker<Sandbox>,
    max_agreements: u32,
) -> Result<Contract, Box<dyn std::error::Error>> {
    deploy_with_ft(worker, max_agreements, FT).await
}

/// Deploy and initialise the escrow allowlisting the token account `ft`.
pub async fn deploy_with_ft(
    worker: &Worker<Sandbox>,
    max_agreements: u32,
    ft: &str,
) -> Result<Contract, Box<dyn std::error::Error>> {
    let contract = worker.dev_deploy(&wasm()?).await?;
    contract
        .call("new")
        .args_json(json!({
            "network_id": "sandbox",
            "allowlisted_ft_id": ft,
            "operator_treasury_id": TREASURY,
            "max_agreements": max_agreements,
            "creator_allowlist": CREATORS,
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(contract)
}

pub struct Roles {
    pub buyer: Account,
    pub supplier: Account,
    pub primary: Account,
    pub backup: Account,
    pub stranger: Account,
}

pub async fn roles(worker: &Worker<Sandbox>) -> Result<Roles, Box<dyn std::error::Error>> {
    let root = worker.root_account()?;
    let mut made = Vec::new();
    for name in ["buyer", "supplier", "primary", "backup", "stranger"] {
        let account = root
            .create_subaccount(name)
            .initial_balance(NearToken::from_near(10))
            .transact()
            .await?
            .into_result()?;
        made.push(account);
    }
    let [buyer, supplier, primary, backup, stranger]: [Account; 5] =
        made.try_into().map_err(|_| "five accounts")?;
    Ok(Roles {
        buyer,
        supplier,
        primary,
        backup,
        stranger,
    })
}

pub async fn now_ns(worker: &Worker<Sandbox>) -> Result<u64, Box<dyn std::error::Error>> {
    Ok(worker.view_block().await?.timestamp())
}

/// Valid terms JSON for the sandbox roles. `lines` = 1..=3 (more for negative tests).
pub fn terms(r: &Roles, nonce: u64, acceptance_deadline_ns: u64, lines: usize) -> Value {
    let principals = ["500000000", "300000000", "200000000", "100000000"];
    let bps = [
        (5_000, 5_000),
        (6_000, 4_000),
        (3_000, 7_000),
        (5_000, 5_000),
    ];
    let line = |i: usize| {
        json!({
            "line_id": i,
            "principal": principals[i],
            "delivery_deadline_ns": (acceptance_deadline_ns + 96 * HOUR).to_string(), // F3: >= funding + review (72 h)
            "acceptance_criteria_commitment": format!("{:02x}", i + 1).repeat(32),
            "fallback_buyer_bps": bps[i].0,
            "fallback_supplier_bps": bps[i].1,
        })
    };
    json!({
        "schema_version": 1,
        "deadline_rules_version": 1,
        "buyer_id": r.buyer.id(),
        "supplier_id": r.supplier.id(),
        "primary_arbitrator_id": r.primary.id(),
        "backup_arbitrator_id": r.backup.id(),
        "ft_contract_id": FT,
        "agreement_nonce": nonce.to_string(),
        "acceptance_deadline_ns": acceptance_deadline_ns.to_string(),
        "funding_deadline_ns": (acceptance_deadline_ns + HOUR).to_string(),
        "delivery_grace_period_ns": "0",
        "review_window_ns": "259200000000000",
        "negotiation_window_ns": "172800000000000",
        "primary_window_ns": "259200000000000",
        "backup_window_ns": "259200000000000",
        "lines": (0..lines).map(line).collect::<Vec<_>>(),
    })
}

/// The transaction must fail. For a contract code (`ERR_…`) the failure
/// must carry exactly that one code (token equality, no substring match);
/// for an SDK/runtime message the given text must appear verbatim.
pub fn assert_fails(res: ExecutionFinalResult, code: &str) {
    assert!(
        res.is_failure(),
        "expected failure with {code}, got success"
    );
    let msg = format!("{:?}", res.into_result().expect_err("failure"));
    if code.starts_with("ERR_") {
        assert_eq!(
            err_codes(&msg),
            vec![code.to_string()],
            "expected exactly {code}, got: {msg}"
        );
    } else {
        assert!(msg.contains(code), "expected {code}, got: {msg}");
    }
}

/// Every distinct `ERR_<AREA>[:<Code>]` token in `msg`, in order of first
/// appearance (exact-code assertions; no substring matching).
pub fn err_codes(msg: &str) -> Vec<String> {
    let b = msg.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i + 4 <= b.len() {
        if &b[i..i + 4] == b"ERR_"
            && (i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_'))
        {
            let mut j = i + 4;
            while j < b.len()
                && (b[j].is_ascii_uppercase() || b[j].is_ascii_digit() || b[j] == b'_')
            {
                j += 1;
            }
            if j < b.len() && b[j] == b':' {
                let k0 = j + 1;
                let mut k = k0;
                while k < b.len() && b[k].is_ascii_alphanumeric() {
                    k += 1;
                }
                if k > k0 {
                    j = k;
                }
            }
            let t = msg[i..j].to_string();
            if !out.contains(&t) {
                out.push(t);
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

pub async fn get_agreement(
    contract: &Contract,
    id: &str,
) -> Result<Value, Box<dyn std::error::Error>> {
    Ok(contract
        .view("get_agreement")
        .args_json(json!({ "agreement_id": id }))
        .await?
        .json::<Value>()?)
}

pub async fn storage_usage(contract: &Contract) -> Result<u64, Box<dyn std::error::Error>> {
    Ok(contract.view_account().await?.storage_usage)
}
