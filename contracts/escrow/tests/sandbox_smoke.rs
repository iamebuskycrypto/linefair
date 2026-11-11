//! Sandbox smoke test: deploys THIS crate's cargo-near WASM into a local NEAR
//! sandbox, initialises it and calls the `contract_version` view.
//!
//! Preconditions (see docs/24 §First implementation session):
//! - `cargo near build non-reproducible-wasm --locked` has produced
//!   `target/near/linefair_escrow.wasm`;
//! - `NEAR_SANDBOX_BIN_PATH` points at the sha256-verified sandbox binary.
//!   The test refuses to run without it, so near-sandbox never silently
//!   downloads an unverified binary.

mod common;

const EXPECTED_VERSION: &str = "linefair-escrow 0.1.0 (lf-012 f3)";

#[tokio::test]
async fn sandbox_deploy_and_contract_version() -> common::TestResult {
    let worker = common::sandbox().await?;
    let contract = common::deploy(&worker, 1).await?;
    let version: String = contract.view("contract_version").await?.json()?;
    assert_eq!(version, EXPECTED_VERSION);
    println!(
        "deployed {} bytes to {}; contract_version = {version:?}",
        common::wasm()?.len(),
        contract.id()
    );
    Ok(())
}
