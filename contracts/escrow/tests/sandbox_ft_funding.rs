//! LF-005 sandbox tests with a GENUINE NEP-141 token: the official
//! near-sdk-rs fungible-token example pinned at 421ffb4 (`contracts/test-ft`).
//! Plan: `evidence/lf005/lf005-test-plan.md`.
//!
//! Build both contracts first:
//!   (cd contracts/test-ft && cargo near build non-reproducible-wasm --locked)
//!   (cd contracts/escrow  && cargo near build non-reproducible-wasm --locked)

mod common;

use common::*;
use near_sdk::serde_json::{Value, json};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use sha2::{Digest, Sha256};

/// Pinned test-token WASM (docs/21): official example at 421ffb4, built with
/// cargo-near 0.22.0 / rustc 1.95.0 against near-* =5.29.1.
const TOKEN_WASM_SHA256: &str = "c26d0ac1e4592fd7c099219ed4e1ca1400d1e7bcf6824afde42e02a63874b78d";
const SUPPLY: u128 = 1_000_000_000_000_000; // 10^15 base units

fn token_wasm() -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../test-ft/target/near/linefair_test_ft.wasm");
    let w = std::fs::read(&path).map_err(|e| {
        format!(
            "missing {} ({e}); build contracts/test-ft with cargo near build first",
            path.display()
        )
    })?;
    let h: [u8; 32] = Sha256::digest(&w).into();
    let hex: String = h.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(
        hex, TOKEN_WASM_SHA256,
        "test token WASM differs from the pin"
    );
    Ok(w)
}

struct Env {
    worker: Worker<Sandbox>,
    token: Contract,
    escrow: Contract,
    r: Roles,
    operator: Account,
    supply: u128,
}

async fn deploy_token(
    worker: &Worker<Sandbox>,
    owner: &Account,
) -> Result<Contract, Box<dyn std::error::Error>> {
    deploy_token_with_supply(worker, owner, SUPPLY).await
}

async fn deploy_token_with_supply(
    worker: &Worker<Sandbox>,
    owner: &Account,
    supply: u128,
) -> Result<Contract, Box<dyn std::error::Error>> {
    let token = worker.dev_deploy(&token_wasm()?).await?;
    token
        .call("new_default_meta")
        .args_json(json!({ "owner_id": owner.id(), "total_supply": supply.to_string() }))
        .transact()
        .await?
        .into_result()?;
    Ok(token)
}

/// docs/25: the operator registers storage on the token; the amount is read
/// from `storage_balance_bounds().min`, never hardcoded.
async fn register(
    operator: &Account,
    token: &Contract,
    who: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let bounds: Value = token.view("storage_balance_bounds").await?.json()?;
    let min: u128 = bounds["min"].as_str().expect("min").parse()?;
    operator
        .call(token.id(), "storage_deposit")
        .args_json(json!({ "account_id": who, "registration_only": true }))
        .deposit(NearToken::from_yoctonear(min))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn setup(max_agreements: u32) -> Result<Env, Box<dyn std::error::Error>> {
    setup_with_supply(max_agreements, SUPPLY).await
}

async fn setup_with_supply(
    max_agreements: u32,
    supply: u128,
) -> Result<Env, Box<dyn std::error::Error>> {
    let worker = sandbox().await?;
    let r = roles(&worker).await?;
    let operator = worker
        .root_account()?
        .create_subaccount("operator")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    let token = deploy_token_with_supply(&worker, &r.buyer, supply).await?;
    let escrow = deploy_with_ft(&worker, max_agreements, token.id().as_str()).await?;
    for who in [
        escrow.id().as_str(),
        r.supplier.id().as_str(),
        r.stranger.id().as_str(),
    ] {
        register(&operator, &token, who).await?;
    }
    // Sandbox accounts are ephemeral (fresh local chain per test).
    println!(
        "EVIDENCE sandbox escrow_id={} token_id={} buyer={} operator={}",
        escrow.id(),
        token.id(),
        r.buyer.id(),
        operator.id()
    );
    Ok(Env {
        worker,
        token,
        escrow,
        r,
        operator,
        supply,
    })
}

async fn balance(token: &Contract, who: &str) -> Result<u128, Box<dyn std::error::Error>> {
    let v: String = token
        .view("ft_balance_of")
        .args_json(json!({ "account_id": who }))
        .await?
        .json()?;
    Ok(v.parse()?)
}

/// Creates a fully accepted agreement allowlisting `env.token`; returns (id, hash).
async fn agreed(
    env: &Env,
    nonce: u64,
    lines: usize,
    mutate: impl Fn(&mut Value),
) -> Result<(String, String), Box<dyn std::error::Error>> {
    let deadline = now_ns(&env.worker).await? + HOUR;
    let mut t = terms(&env.r, nonce, deadline, lines);
    t["ft_contract_id"] = json!(env.token.id());
    mutate(&mut t);
    let id: String = env
        .r
        .buyer
        .call(env.escrow.id(), "create_agreement")
        .args_json(json!({ "terms": t }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let h = get_agreement(&env.escrow, &id).await?["terms_hash"]
        .as_str()
        .expect("hash")
        .to_string();
    for (who, m) in [
        (&env.r.buyer, "accept_terms"),
        (&env.r.supplier, "accept_terms"),
        (&env.r.primary, "accept_appointment"),
        (&env.r.backup, "accept_appointment"),
    ] {
        who.call(env.escrow.id(), m)
            .args_json(json!({ "agreement_id": id, "terms_hash": h }))
            .transact()
            .await?
            .into_result()?;
    }
    Ok((id, h))
}

fn msg(id: &str, line: u32, h: &str) -> String {
    format!(r#"{{"version":1,"agreement_id":"{id}","line_id":{line},"terms_hash":"{h}"}}"#)
}

async fn transfer_call(
    from: &Account,
    token: &Contract,
    to: &str,
    amount: u128,
    m: &str,
    gas: Option<Gas>,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error>> {
    let mut c = from
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": to, "amount": amount.to_string(), "msg": m }))
        .deposit(NearToken::from_yoctonear(1));
    c = match gas {
        Some(g) => c.gas(g),
        None => c.max_gas(),
    };
    Ok(c.transact().await?)
}

/// Used amount returned by ft_transfer_call (= amount credited by the escrow).
fn used(res: &ExecutionFinalResult) -> u128 {
    let v: String = res.clone().json().expect("ft_transfer_call returns U128");
    v.parse().expect("u128")
}

fn has_log(res: &ExecutionFinalResult, code: &str) -> bool {
    let want = format!("LF_FT_REFUND:{code}");
    res.logs().iter().any(|l| *l == want)
}

/// Reconciliation with actual token balances (no uncredited inflows).
async fn reconcile(
    env: &Env,
    agreements: u64,
    holders: &[&str],
) -> Result<(), Box<dyn std::error::Error>> {
    reconcile_with_surplus(env, agreements, holders, 0).await
}

/// Rule B reconciliation: outstanding_liabilities (E) == Σ unpaid buckets
/// (locked + claimable + pending) over agreements 0..n; escrow FT balance ==
/// E + `surplus` (inflows not credited as funding); Σ balances == total supply.
/// The aggregate balance is only observed, never used to infer an outcome.
async fn reconcile_with_surplus(
    env: &Env,
    agreements: u64,
    holders: &[&str],
    surplus: u128,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut unpaid: u128 = 0;
    for id in 0..agreements {
        let v = get_agreement(&env.escrow, &id.to_string()).await?;
        for l in v["lines"].as_array().expect("lines") {
            for b in [
                "locked",
                "buyer_claimable",
                "supplier_claimable",
                "buyer_pending",
                "supplier_pending",
            ] {
                unpaid += l[b].as_str().expect("bucket").parse::<u128>()?;
            }
        }
    }
    let e: String = env.escrow.view("outstanding_liabilities").await?.json()?;
    let e: u128 = e.parse()?;
    assert_eq!(e, unpaid, "Rule B: E != Σ unpaid buckets across agreements");
    let esc = balance(&env.token, env.escrow.id().as_str()).await?;
    assert_eq!(
        esc,
        e + surplus,
        "escrow FT balance != E + uncredited surplus"
    );
    let mut total = esc;
    for h in holders {
        total += balance(&env.token, h).await?;
    }
    let supply: String = env.token.view("ft_total_supply").await?.json()?;
    assert_eq!(total, supply.parse::<u128>()?, "Σ balances != total supply");
    assert_eq!(total, env.supply, "supply changed");
    Ok(())
}

async fn outstanding(env: &Env) -> Result<u128, Box<dyn std::error::Error>> {
    let e: String = env.escrow.view("outstanding_liabilities").await?.json()?;
    Ok(e.parse()?)
}

fn line_status(v: &Value, i: usize) -> &str {
    v["lines"][i]["status"].as_str().expect("status")
}

#[tokio::test]
async fn lf005_three_lines_funded_and_reconciled() -> TestResult {
    let env = setup(25).await?;
    let (id, h) = agreed(&env, 1, 3, |_| {}).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let mut credited = 0u128;
    for (line, p) in [(0u32, 500_000_000u128), (1, 300_000_000), (2, 200_000_000)] {
        let su = storage_usage(&env.escrow).await?;
        let res = transfer_call(
            &env.r.buyer,
            &env.token,
            env.escrow.id().as_str(),
            p,
            &msg(&id, line, &h),
            None,
        )
        .await?;
        println!(
            "EVIDENCE method=ft_transfer_call line={line} amount={p} total_gas_burnt_units={} receipt_failures={}",
            res.total_gas_burnt.as_gas(),
            res.receipt_failures().len()
        );
        assert!(res.receipt_failures().is_empty(), "no failed receipt");
        assert_eq!(used(&res), p, "escrow kept exactly P (returned 0 unused)");
        credited += p;
        assert_eq!(
            storage_usage(&env.escrow).await?,
            su,
            "funding writes only pre-allocated fields (storage delta 0)"
        );
        let v = get_agreement(&env.escrow, &id).await?;
        assert_eq!(line_status(&v, line as usize), "FUNDED");
        assert_eq!(v["lines"][line as usize]["locked"], json!(p.to_string()));
        assert_eq!(v["status"], "ACTIVE");
        assert_eq!(
            balance(&env.token, env.r.buyer.id().as_str()).await?,
            SUPPLY - credited
        );
        reconcile(&env, 1, &holders).await?;
    }
    assert_eq!(
        balance(&env.token, env.escrow.id().as_str()).await?,
        1_000_000_000,
        "500 + 300 + 200 units held"
    );
    Ok(())
}

#[tokio::test]
async fn lf005_invalid_deposits_refunded_by_resolver() -> TestResult {
    let env = setup(25).await?;
    let (id, h) = agreed(&env, 1, 3, |_| {}).await?;
    let (id2, h2) = agreed(&env, 2, 1, |_| {}).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    // Give the supplier tokens so it can attempt a deposit (T019).
    env.r
        .buyer
        .call(env.token.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": env.r.supplier.id(), "amount": "1000000000" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    // Line 0 funded once (prerequisite for T033).
    let res = transfer_call(
        &env.r.buyer,
        &env.token,
        env.escrow.id().as_str(),
        500_000_000,
        &msg(&id, 0, &h),
        None,
    )
    .await?;
    assert_eq!(used(&res), 500_000_000);

    let mut flipped = h.clone().into_bytes();
    flipped[0] = if flipped[0] == b'a' { b'b' } else { b'a' };
    let flipped = String::from_utf8(flipped)?;
    let cases: Vec<(&str, &Account, u128, String, &str)> = vec![
        (
            "T019 supplier deposits",
            &env.r.supplier,
            300_000_000,
            msg(&id, 1, &h),
            "NotAuthorized",
        ),
        (
            "T031 underpay by 1",
            &env.r.buyer,
            300_000_000 - 1,
            msg(&id, 1, &h),
            "AmountMismatch",
        ),
        (
            "T032 overpay by 1",
            &env.r.buyer,
            300_000_000 + 1,
            msg(&id, 1, &h),
            "AmountMismatch",
        ),
        (
            "T033 second deposit on line 0",
            &env.r.buyer,
            500_000_000,
            msg(&id, 0, &h),
            "WrongState",
        ),
        (
            "T034 unknown agreement id",
            &env.r.buyer,
            300_000_000,
            msg("99", 1, &h),
            "AgreementNotFound",
        ),
        (
            "T034 other agreement's hash",
            &env.r.buyer,
            300_000_000,
            msg(&id, 1, &h2),
            "TermsHashMismatch",
        ),
        (
            "T034 hash of this agreement on the other agreement",
            &env.r.buyer,
            500_000_000,
            msg(&id2, 0, &h),
            "TermsHashMismatch",
        ),
        (
            "T066 mismatched terms_hash",
            &env.r.buyer,
            300_000_000,
            msg(&id, 1, &flipped),
            "TermsHashMismatch",
        ),
    ];
    for (name, from, amount, m, code) in cases {
        let before = (
            get_agreement(&env.escrow, &id).await?,
            get_agreement(&env.escrow, &id2).await?,
        );
        let from_before = balance(&env.token, from.id().as_str()).await?;
        let esc_before = balance(&env.token, env.escrow.id().as_str()).await?;
        let res =
            transfer_call(from, &env.token, env.escrow.id().as_str(), amount, &m, None).await?;
        assert!(
            res.receipt_failures().is_empty(),
            "{name}: refund path must not fail a receipt"
        );
        assert!(
            has_log(&res, code),
            "{name}: expected LF_FT_REFUND:{code}, logs {:?}",
            res.logs()
        );
        assert_eq!(used(&res), 0, "{name}: nothing kept");
        assert_eq!(
            balance(&env.token, from.id().as_str()).await?,
            from_before,
            "{name}: sender fully refunded"
        );
        assert_eq!(
            balance(&env.token, env.escrow.id().as_str()).await?,
            esc_before,
            "{name}: escrow balance unchanged"
        );
        let after = (
            get_agreement(&env.escrow, &id).await?,
            get_agreement(&env.escrow, &id2).await?,
        );
        assert_eq!(after, before, "{name}: no credited state changed");
        reconcile(&env, 2, &holders).await?;
        println!("EVIDENCE refund case={name:?} code={code} ok");
    }
    let v = get_agreement(&env.escrow, &id).await?;
    assert_eq!(
        (line_status(&v, 0), line_status(&v, 1), line_status(&v, 2)),
        ("FUNDED", "UNFUNDED", "UNFUNDED")
    );
    Ok(())
}

#[tokio::test]
async fn lf005_fake_and_unlisted_tokens_never_credit() -> TestResult {
    let env = setup(25).await?;
    let (id, h) = agreed(&env, 1, 1, |_| {}).await?;
    let before = get_agreement(&env.escrow, &id).await?;

    // T020: a stranger calls ft_on_transfer directly (no tokens moved).
    let res = env
        .r
        .stranger
        .call(env.escrow.id(), "ft_on_transfer")
        .args_json(
            json!({ "sender_id": env.r.buyer.id(), "amount": "500000000", "msg": msg(&id, 0, &h) }),
        )
        .max_gas()
        .transact()
        .await?;
    let unused: String = res.clone().json()?;
    assert_eq!(
        unused, "500000000",
        "fake predecessor: full amount reported unused"
    );
    assert!(has_log(&res, "UnexpectedToken"));
    assert_eq!(
        get_agreement(&env.escrow, &id).await?,
        before,
        "T020: no credit"
    );

    // T035: a second GENUINE token instance that is not allowlisted.
    let other = deploy_token(&env.worker, &env.r.buyer).await?;
    register(&env.operator, &other, env.escrow.id().as_str()).await?;
    let res = transfer_call(
        &env.r.buyer,
        &other,
        env.escrow.id().as_str(),
        500_000_000,
        &msg(&id, 0, &h),
        None,
    )
    .await?;
    assert!(has_log(&res, "UnexpectedToken"));
    assert_eq!(used(&res), 0);
    assert_eq!(
        balance(&other, env.r.buyer.id().as_str()).await?,
        SUPPLY,
        "unlisted token fully refunded"
    );
    assert_eq!(balance(&other, env.escrow.id().as_str()).await?, 0);
    let v = get_agreement(&env.escrow, &id).await?;
    assert_eq!(v, before, "T035: line never marked funded");
    assert_eq!(line_status(&v, 0), "UNFUNDED");
    reconcile(
        &env,
        1,
        &[
            env.r.buyer.id().as_str(),
            env.r.supplier.id().as_str(),
            env.r.stranger.id().as_str(),
        ],
    )
    .await?;
    Ok(())
}

#[tokio::test]
async fn lf005_malformed_messages_refunded() -> TestResult {
    let env = setup(25).await?;
    let (id, h) = agreed(&env, 1, 1, |_| {}).await?;
    let good = msg(&id, 0, &h);
    let cases: Vec<(String, &str)> = vec![
        (String::new(), "MsgJson"),
        ("not json".into(), "MsgJson"),
        (format!("{good}x"), "MsgJson"),
        (good.replace('}', ",\"memo\":\"x\"}"), "MsgJson"),
        (good.replace("\"version\":1", "\"version\":2"), "MsgVersion"),
        (
            good.replace(
                &format!("\"agreement_id\":\"{id}\""),
                "\"agreement_id\":\"00\"",
            ),
            "MsgAgreementIdNonCanonical",
        ),
        (msg(&id, 3, &h), "MsgLineIdOutOfRange"),
        (msg(&id, 0, &h.to_uppercase()), "MsgTermsHash"),
        (msg(&id, 1, &h), "LineNotFound"),
    ];
    let before = get_agreement(&env.escrow, &id).await?;
    for (m, code) in cases {
        let res = transfer_call(
            &env.r.buyer,
            &env.token,
            env.escrow.id().as_str(),
            500_000_000,
            &m,
            None,
        )
        .await?;
        assert!(
            has_log(&res, code),
            "{m:?}: expected {code}, logs {:?}",
            res.logs()
        );
        assert_eq!(used(&res), 0, "{m:?}");
        assert_eq!(
            balance(&env.token, env.r.buyer.id().as_str()).await?,
            SUPPLY,
            "{m:?}: refunded"
        );
    }
    assert_eq!(get_agreement(&env.escrow, &id).await?, before);
    reconcile(
        &env,
        1,
        &[
            env.r.buyer.id().as_str(),
            env.r.supplier.id().as_str(),
            env.r.stranger.id().as_str(),
        ],
    )
    .await?;
    Ok(())
}

#[tokio::test]
async fn lf005_state_and_deadline_prerequisites() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    // Before AGREED: proposal with no acceptances.
    let deadline = now_ns(&env.worker).await? + HOUR;
    let mut t = terms(&env.r, 1, deadline, 1);
    t["ft_contract_id"] = json!(env.token.id());
    let id: String = env
        .r
        .buyer
        .call(env.escrow.id(), "create_agreement")
        .args_json(json!({ "terms": t }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let h = get_agreement(&env.escrow, &id).await?["terms_hash"]
        .as_str()
        .expect("h")
        .to_string();
    let res = transfer_call(
        &env.r.buyer,
        &env.token,
        env.escrow.id().as_str(),
        500_000_000,
        &msg(&id, 0, &h),
        None,
    )
    .await?;
    assert!(has_log(&res, "AgreementNotAgreed"), "{:?}", res.logs());
    assert_eq!(used(&res), 0);

    // Funding deadline in chain time: short acceptance/funding deadlines.
    let now = now_ns(&env.worker).await?;
    let (id2, h2) = agreed(&env, 2, 1, |t| {
        t["acceptance_deadline_ns"] = json!((now + 30_000_000_000).to_string());
        t["funding_deadline_ns"] = json!((now + 40_000_000_000).to_string());
    })
    .await?;
    let funding_deadline = now + 40_000_000_000;
    let mut rounds = 0;
    while now_ns(&env.worker).await? < funding_deadline {
        env.worker.fast_forward(100).await?;
        rounds += 1;
        assert!(rounds < 60, "chain time did not advance");
    }
    let res = transfer_call(
        &env.r.buyer,
        &env.token,
        env.escrow.id().as_str(),
        500_000_000,
        &msg(&id2, 0, &h2),
        None,
    )
    .await?;
    assert!(has_log(&res, "FundingDeadlinePassed"), "{:?}", res.logs());
    assert_eq!(used(&res), 0);
    assert_eq!(
        line_status(&get_agreement(&env.escrow, &id2).await?, 0),
        "UNFUNDED"
    );
    reconcile(&env, 2, &holders).await?;
    Ok(())
}

#[tokio::test]
async fn lf005_t057_receipt_failure_refunded_by_resolver() -> TestResult {
    // Starve ft_on_transfer of gas so its receipt fails; the token's resolver
    // must then treat the full amount as unused and refund it.
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let mut nonce = 10;
    let (mut id, mut h) = agreed(&env, nonce, 1, |_| {}).await?;
    let mut agreements = 1u64;
    let mut observed_t057 = Vec::new();
    let mut funded_runs = 0;
    let mut ggas = 6_000u64;
    while ggas <= 30_000 {
        let buyer_before = balance(&env.token, env.r.buyer.id().as_str()).await?;
        let res = transfer_call(
            &env.r.buyer,
            &env.token,
            env.escrow.id().as_str(),
            500_000_000,
            &msg(&id, 0, &h),
            Some(Gas::from_ggas(ggas)),
        )
        .await?;
        let escrow_failed = res
            .receipt_failures()
            .iter()
            .any(|o| o.executor_id.as_str() == env.escrow.id().as_str());
        let status = line_status(&get_agreement(&env.escrow, &id).await?, 0).to_string();
        let buyer_after = balance(&env.token, env.r.buyer.id().as_str()).await?;
        let outcome = if res.is_failure() && !escrow_failed {
            "tx_failed_before_transfer"
        } else if escrow_failed {
            "ft_on_transfer_receipt_failed"
        } else if status == "FUNDED" {
            "funded"
        } else {
            "refunded_by_value"
        };
        println!(
            "EVIDENCE t057_sweep gas_ggas={ggas} outcome={outcome} line={status} buyer_delta={}",
            buyer_before as i128 - buyer_after as i128
        );
        match outcome {
            "ft_on_transfer_receipt_failed" => {
                assert_eq!(status, "UNFUNDED", "failed receipt credited nothing");
                assert_eq!(
                    buyer_after, buyer_before,
                    "resolver refunded the full amount"
                );
                observed_t057.push(ggas);
            }
            "tx_failed_before_transfer" => assert_eq!(buyer_after, buyer_before),
            "funded" => {
                assert_eq!(buyer_before - buyer_after, 500_000_000);
                funded_runs += 1;
                if funded_runs >= 2 {
                    // Gas needs are monotonic: higher values also fund.
                    reconcile(&env, agreements, &holders).await?;
                    break;
                }
                // Fresh 1-line agreement for the next attempt.
                nonce += 1;
                let next = agreed(&env, nonce, 1, |_| {}).await?;
                id = next.0;
                h = next.1;
                agreements += 1;
            }
            _ => assert_eq!(buyer_after, buyer_before),
        }
        reconcile(&env, agreements, &holders).await?;
        ggas += 500;
    }
    println!("EVIDENCE t057_observed_at_ggas={observed_t057:?}");
    assert!(
        !observed_t057.is_empty(),
        "no gas value produced a failed ft_on_transfer receipt; T057 not executed"
    );
    Ok(())
}

// ---- Aggregate-bounds hardening (Rules A + B), founder 2026-11-01 ----------

#[tokio::test]
async fn hardening_rule_a_sum_overflow_rejected_in_sandbox() -> TestResult {
    let env = setup(25).await?;
    let deadline = now_ns(&env.worker).await? + HOUR;
    let su = storage_usage(&env.escrow).await?;
    let mut t = terms(&env.r, 1, deadline, 2);
    t["ft_contract_id"] = json!(env.token.id());
    t["lines"][0]["principal"] = json!(u128::MAX.to_string());
    t["lines"][1]["principal"] = json!("1");
    let res = env
        .r
        .buyer
        .call(env.escrow.id(), "create_agreement")
        .args_json(json!({ "terms": t }))
        .max_gas()
        .transact()
        .await?;
    assert_fails(res, "ERR_TERMS_INVALID:PrincipalSumOverflow");
    assert_eq!(
        storage_usage(&env.escrow).await?,
        su,
        "rejected create writes nothing"
    );
    // Σ exactly u128::MAX is accepted.
    t["lines"][0]["principal"] = json!((u128::MAX - 1).to_string());
    let id: String = env
        .r
        .buyer
        .call(env.escrow.id(), "create_agreement")
        .args_json(json!({ "terms": t }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(id, "0");
    println!("EVIDENCE rule_a sandbox: (MAX,1) rejected PrincipalSumOverflow; (MAX-1,1) accepted");
    Ok(())
}

#[tokio::test]
async fn hardening_outstanding_tracks_genuine_token_funding() -> TestResult {
    // A genuine token whose total supply is u128::MAX: E can reach exactly
    // u128::MAX and always equals the escrow's real balance.
    let env = setup_with_supply(25, u128::MAX).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let (id, h) = agreed(&env, 1, 2, |t| {
        t["lines"][0]["principal"] = json!((u128::MAX - 1).to_string());
        t["lines"][1]["principal"] = json!("1");
    })
    .await?;
    assert_eq!(outstanding(&env).await?, 0);
    reconcile(&env, 1, &holders).await?;
    let res = transfer_call(
        &env.r.buyer,
        &env.token,
        env.escrow.id().as_str(),
        u128::MAX - 1,
        &msg(&id, 0, &h),
        None,
    )
    .await?;
    assert_eq!(used(&res), u128::MAX - 1);
    assert_eq!(
        outstanding(&env).await?,
        u128::MAX - 1,
        "E += P on credited funding"
    );
    reconcile(&env, 1, &holders).await?;
    // Refunded deposits (wrong hash, wrong line state) leave E unchanged.
    let mut flipped = h.clone().into_bytes();
    flipped[0] = if flipped[0] == b'a' { b'b' } else { b'a' };
    let flipped = String::from_utf8(flipped)?;
    for (m, code) in [
        (msg(&id, 1, &flipped), "TermsHashMismatch"),
        (msg(&id, 0, &h), "WrongState"),
    ] {
        let res = transfer_call(
            &env.r.buyer,
            &env.token,
            env.escrow.id().as_str(),
            1,
            &m,
            None,
        )
        .await?;
        assert!(has_log(&res, code), "{code}: {:?}", res.logs());
        assert_eq!(used(&res), 0);
        assert_eq!(
            outstanding(&env).await?,
            u128::MAX - 1,
            "{code}: refund leaves E unchanged"
        );
        reconcile(&env, 1, &holders).await?;
    }
    // The last unit: E reaches exactly u128::MAX = escrow balance = supply.
    let res = transfer_call(
        &env.r.buyer,
        &env.token,
        env.escrow.id().as_str(),
        1,
        &msg(&id, 1, &h),
        None,
    )
    .await?;
    assert_eq!(used(&res), 1);
    assert_eq!(outstanding(&env).await?, u128::MAX);
    assert_eq!(
        balance(&env.token, env.escrow.id().as_str()).await?,
        u128::MAX
    );
    reconcile(&env, 1, &holders).await?;
    println!(
        "EVIDENCE rule_b sandbox: E reached u128::MAX with a genuine token; further credit impossible (no tokens left); overflow refusal unit-tested (rule_b_overflow_refunds_and_writes_nothing)"
    );
    Ok(())
}

#[tokio::test]
async fn hardening_uncredited_transfer_is_surplus_not_liability() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let (id, h) = agreed(&env, 1, 1, |_| {}).await?;
    let before = get_agreement(&env.escrow, &id).await?;
    // Plain ft_transfer (no ft_on_transfer call): an inflow not credited as funding.
    env.r
        .buyer
        .call(env.token.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": env.escrow.id(), "amount": "12345" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        outstanding(&env).await?,
        0,
        "uncredited inflow is not a liability"
    );
    assert_eq!(
        get_agreement(&env.escrow, &id).await?,
        before,
        "no line changed"
    );
    reconcile_with_surplus(&env, 1, &holders, 12_345).await?;
    // A later credited deposit adds exactly P; the surplus stays observable.
    let res = transfer_call(
        &env.r.buyer,
        &env.token,
        env.escrow.id().as_str(),
        500_000_000,
        &msg(&id, 0, &h),
        None,
    )
    .await?;
    assert_eq!(used(&res), 500_000_000);
    assert_eq!(outstanding(&env).await?, 500_000_000);
    reconcile_with_surplus(&env, 1, &holders, 12_345).await?;
    println!(
        "EVIDENCE rule_b surplus: balance = E + 12345 after a plain ft_transfer; E unchanged by it"
    );
    Ok(())
}

#[tokio::test]
async fn hardening_root_state_size_matches_layout() -> TestResult {
    let env = setup(25).await?;
    let state = env.escrow.view_state().await?;
    let root = state.get(b"STATE".as_slice()).expect("STATE key");
    let ft = env.token.id().as_str().len();
    let tr = TREASURY.len();
    // network 1 + bstr(ft) + bstr(treasury) + max_agreements 4 + next_id 8
    // + 2 LookupMap prefixes (4 + 1) + custody_total 16 (Rule B)
    // + last_withdrawal_id 8 + open_withdrawals 8 (LF-009)
    // + creator allowlist Vec<AccountId> (LF-010A).
    let list = 4 + CREATORS.iter().map(|a| 4 + a.len()).sum::<usize>();
    let expected = 1 + (4 + ft) + (4 + tr) + 4 + 8 + 2 * (4 + 1) + 16 + 16 + list;
    assert_eq!(root.len(), expected, "root state layout");
    println!(
        "EVIDENCE root_state_bytes={} (incl. 16 B custody_total + 16 B LF-009 counters) storage_usage_after_init={}",
        root.len(),
        storage_usage(&env.escrow).await?
    );
    // Optional one-off comparison with a previous build (LF-005, 63fa991).
    if let Ok(prev) = std::env::var("LINEFAIR_PREV_ESCROW_WASM") {
        let prev_wasm = std::fs::read(&prev)?;
        let old = env.worker.dev_deploy(&prev_wasm).await?;
        old.call("new")
            .args_json(json!({ "network_id": "sandbox", "allowlisted_ft_id": env.token.id(), "operator_treasury_id": TREASURY, "max_agreements": 25 }))
            .transact().await?.into_result()?;
        let old_state = old.view_state().await?;
        let old_root = old_state.get(b"STATE".as_slice()).expect("STATE");
        let new_usage = storage_usage(&env.escrow).await?;
        let old_usage = storage_usage(&old).await?;
        let code_new = wasm()?.len() as i64;
        let code_old = prev_wasm.len() as i64;
        println!(
            "EVIDENCE layout_compare prev_root_state_bytes={} new_root_state_bytes={} delta={} storage_usage prev={} new={} delta={} code_delta={} non_code_delta={}",
            old_root.len(),
            root.len(),
            root.len() as i64 - old_root.len() as i64,
            old_usage,
            new_usage,
            new_usage as i64 - old_usage as i64,
            code_new - code_old,
            (new_usage as i64 - old_usage as i64) - (code_new - code_old)
        );
        assert_eq!(
            root.len(),
            old_root.len() + 32 + list,
            "vs LF-005: Rule B adds 16 bytes, LF-009 16 bytes, LF-010A the allowlist"
        );
    }
    Ok(())
}

// ---- LF-006: submit_delivery / accept_line / open_dispute entry points -------
// Plan: evidence/lf006/lf006-test-plan.md. All agreements genuinely funded.

const EV: &str = "a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5";

async fn line_call(
    who: &Account,
    env: &Env,
    method: &str,
    args: Value,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error>> {
    Ok(who
        .call(env.escrow.id(), method)
        .args_json(args)
        .max_gas()
        .transact()
        .await?)
}

fn receipt(res: &ExecutionFinalResult) -> String {
    let o = res.outcome();
    format!(
        "tx_hash={} block_hash={} receipts={} gas_burnt_units={}",
        o.transaction_hash,
        o.block_hash,
        o.receipt_ids.len(),
        res.total_gas_burnt.as_gas()
    )
}

/// Agreement with `lines` lines, every line funded with the genuine token.
async fn funded_agreement(
    env: &Env,
    nonce: u64,
    lines: usize,
    mutate: impl Fn(&mut Value),
) -> Result<(String, String), Box<dyn std::error::Error>> {
    let (id, h) = agreed(env, nonce, lines, mutate).await?;
    let principals = [500_000_000u128, 300_000_000, 200_000_000];
    for (line, &p) in principals.iter().enumerate().take(lines) {
        let res = transfer_call(
            &env.r.buyer,
            &env.token,
            env.escrow.id().as_str(),
            p,
            &msg(&id, line as u32, &h),
            None,
        )
        .await?;
        assert_eq!(used(&res), p, "line {line} funded");
    }
    Ok((id, h))
}

#[tokio::test]
async fn lf006_submit_accept_dispute_on_funded_three_line_agreement() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let (id, _h) = funded_agreement(&env, 1, 3, |_| {}).await?;
    reconcile(&env, 1, &holders).await?;
    let steps: Vec<(&Account, &str, Value)> = vec![
        (
            &env.r.supplier,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": 0, "evidence_commitment": EV }),
        ),
        (
            &env.r.supplier,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": 1, "evidence_commitment": EV }),
        ),
        (
            &env.r.supplier,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": 2, "evidence_commitment": EV }),
        ),
        (
            &env.r.buyer,
            "accept_line",
            json!({ "agreement_id": id, "line_id": 0 }),
        ),
        (
            &env.r.buyer,
            "open_dispute",
            json!({ "agreement_id": id, "line_id": 1 }),
        ),
    ];
    for (who, method, args) in steps {
        let line = args["line_id"].as_u64().expect("line") as usize;
        let before = get_agreement(&env.escrow, &id).await?;
        let su = storage_usage(&env.escrow).await?;
        let res = line_call(who, &env, method, args).await?;
        let r = receipt(&res);
        res.into_result()?;
        let after = get_agreement(&env.escrow, &id).await?;
        assert_eq!(
            storage_usage(&env.escrow).await?,
            su,
            "{method}: storage delta 0"
        );
        for j in 0..3 {
            if j != line {
                assert_eq!(
                    after["lines"][j], before["lines"][j],
                    "{method} on line {line} changed line {j}"
                );
            }
        }
        reconcile(&env, 1, &holders).await?;
        println!("EVIDENCE lf006 method={method} line={line} storage_delta=0 {r}");
    }
    let v = get_agreement(&env.escrow, &id).await?;
    assert_eq!(
        (line_status(&v, 0), line_status(&v, 1), line_status(&v, 2)),
        ("ALLOCATED", "DISPUTED", "SUBMITTED")
    );
    let l0 = &v["lines"][0];
    assert_eq!(
        (
            l0["locked"].as_str(),
            l0["supplier_claimable"].as_str(),
            l0["supplier_paid"].as_str()
        ),
        (Some("0"), Some("500000000"), Some("0")),
        "T009: locked -> supplier claimable only, nothing paid"
    );
    let l1 = &v["lines"][1];
    assert_eq!(
        (l1["locked"].as_str(), l1["dispute_reason"].as_str()),
        (Some("300000000"), Some("BUYER_DISPUTE")),
        "dispute keeps funds locked"
    );
    assert_ne!(l1["dispute_t0_ns"], json!("0"));
    assert_eq!(v["lines"][2]["evidence_commitment"], json!(EV));
    assert_eq!(
        outstanding(&env).await?,
        1_000_000_000,
        "E unchanged by LF-006 transitions"
    );
    assert_eq!(
        balance(&env.token, env.r.supplier.id().as_str()).await?,
        0,
        "no payout to the supplier"
    );
    Ok(())
}

#[tokio::test]
async fn lf006_unauthorized_and_wrong_targets_rejected() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let (id, _h) = funded_agreement(&env, 1, 2, |_| {}).await?;
    line_call(
        &env.r.supplier,
        &env,
        "submit_delivery",
        json!({ "agreement_id": id, "line_id": 0, "evidence_commitment": EV }),
    )
    .await?
    .into_result()?;
    let upper = EV.to_uppercase();
    let zero = "0".repeat(64);
    let cases: Vec<(&str, &Account, &str, Value, &str)> = vec![
        (
            "buyer submits",
            &env.r.buyer,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": 1, "evidence_commitment": EV }),
            "ERR_LINE:NotAuthorized",
        ),
        (
            "stranger submits",
            &env.r.stranger,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": 1, "evidence_commitment": EV }),
            "ERR_LINE:NotAuthorized",
        ),
        (
            "primary submits",
            &env.r.primary,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": 1, "evidence_commitment": EV }),
            "ERR_LINE:NotAuthorized",
        ),
        (
            "supplier accepts",
            &env.r.supplier,
            "accept_line",
            json!({ "agreement_id": id, "line_id": 0 }),
            "ERR_LINE:NotAuthorized",
        ),
        (
            "supplier disputes",
            &env.r.supplier,
            "open_dispute",
            json!({ "agreement_id": id, "line_id": 0 }),
            "ERR_LINE:NotAuthorized",
        ),
        (
            "primary accepts",
            &env.r.primary,
            "accept_line",
            json!({ "agreement_id": id, "line_id": 0 }),
            "ERR_LINE:NotAuthorized",
        ),
        (
            "backup disputes",
            &env.r.backup,
            "open_dispute",
            json!({ "agreement_id": id, "line_id": 0 }),
            "ERR_LINE:NotAuthorized",
        ),
        (
            "stranger accepts",
            &env.r.stranger,
            "accept_line",
            json!({ "agreement_id": id, "line_id": 0 }),
            "ERR_LINE:NotAuthorized",
        ),
        (
            "unknown agreement",
            &env.r.buyer,
            "accept_line",
            json!({ "agreement_id": "9", "line_id": 0 }),
            "ERR_AGREEMENT_NOT_FOUND",
        ),
        (
            "unknown line",
            &env.r.buyer,
            "open_dispute",
            json!({ "agreement_id": id, "line_id": 2 }),
            "ERR_LINE:LineNotFound",
        ),
        (
            "uppercase commitment",
            &env.r.supplier,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": 1, "evidence_commitment": upper }),
            "ERR_EVIDENCE_COMMITMENT_FORMAT",
        ),
        (
            "zero commitment",
            &env.r.supplier,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": 1, "evidence_commitment": zero }),
            "ERR_LINE:ZeroCommitment",
        ),
        (
            "accept unsubmitted line",
            &env.r.buyer,
            "accept_line",
            json!({ "agreement_id": id, "line_id": 1 }),
            "ERR_LINE:WrongState",
        ),
    ];
    for (name, who, method, args, code) in cases {
        let before = get_agreement(&env.escrow, &id).await?;
        let su = storage_usage(&env.escrow).await?;
        let e = outstanding(&env).await?;
        let res = line_call(who, &env, method, args).await?;
        assert_fails(res, code);
        assert_eq!(
            get_agreement(&env.escrow, &id).await?,
            before,
            "{name}: state unchanged"
        );
        assert_eq!(
            storage_usage(&env.escrow).await?,
            su,
            "{name}: storage unchanged"
        );
        assert_eq!(outstanding(&env).await?, e, "{name}: E unchanged");
        println!("EVIDENCE lf006 rejected case={name:?} code={code}");
    }
    // Entry points are not payable.
    let res = env
        .r
        .supplier
        .call(env.escrow.id(), "submit_delivery")
        .args_json(json!({ "agreement_id": id, "line_id": 1, "evidence_commitment": EV }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert_fails(res, "doesn't accept deposit");
    reconcile(&env, 1, &holders).await?;
    Ok(())
}

#[tokio::test]
async fn lf006_replays_and_conflicts_rejected() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let (id, _h) = funded_agreement(&env, 1, 2, |_| {}).await?;
    for line in [0, 1] {
        line_call(
            &env.r.supplier,
            &env,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": line, "evidence_commitment": EV }),
        )
        .await?
        .into_result()?;
    }
    line_call(
        &env.r.buyer,
        &env,
        "accept_line",
        json!({ "agreement_id": id, "line_id": 0 }),
    )
    .await?
    .into_result()?;
    line_call(
        &env.r.buyer,
        &env,
        "open_dispute",
        json!({ "agreement_id": id, "line_id": 1 }),
    )
    .await?
    .into_result()?;
    let cases: Vec<(&str, &Account, &str, Value)> = vec![
        (
            "double submit",
            &env.r.supplier,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": 0, "evidence_commitment": EV }),
        ),
        (
            "double accept",
            &env.r.buyer,
            "accept_line",
            json!({ "agreement_id": id, "line_id": 0 }),
        ),
        (
            "double dispute",
            &env.r.buyer,
            "open_dispute",
            json!({ "agreement_id": id, "line_id": 1 }),
        ),
        (
            "dispute after accept",
            &env.r.buyer,
            "open_dispute",
            json!({ "agreement_id": id, "line_id": 0 }),
        ),
        (
            "accept after dispute",
            &env.r.buyer,
            "accept_line",
            json!({ "agreement_id": id, "line_id": 1 }),
        ),
        (
            "resubmit disputed line",
            &env.r.supplier,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": 1, "evidence_commitment": EV }),
        ),
    ];
    for (name, who, method, args) in cases {
        let before = get_agreement(&env.escrow, &id).await?;
        let res = line_call(who, &env, method, args).await?;
        assert_fails(res, "ERR_LINE:WrongState");
        assert_eq!(
            get_agreement(&env.escrow, &id).await?,
            before,
            "{name}: state unchanged"
        );
        println!("EVIDENCE lf006 replay/conflict case={name:?} rejected WrongState");
    }
    reconcile(&env, 1, &holders).await?;
    Ok(())
}

#[tokio::test]
async fn lf006_deadlines_in_chain_time() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let now = now_ns(&env.worker).await?;
    let s = 1_000_000_000u64;
    let delivery = now + 90 * s;
    let (id, _h) = funded_agreement(&env, 1, 2, |t| {
        t["acceptance_deadline_ns"] = json!((now + 30 * s).to_string());
        t["funding_deadline_ns"] = json!((now + 40 * s).to_string());
        t["lines"][0]["delivery_deadline_ns"] = json!(delivery.to_string());
        t["lines"][1]["delivery_deadline_ns"] = json!(delivery.to_string());
        t["review_window_ns"] = json!((60 * s).to_string()); // 60 s minimum
    })
    .await?;
    line_call(
        &env.r.supplier,
        &env,
        "submit_delivery",
        json!({ "agreement_id": id, "line_id": 0, "evidence_commitment": EV }),
    )
    .await?
    .into_result()?;
    let submitted_at: u64 = get_agreement(&env.escrow, &id).await?["lines"][0]["submitted_at_ns"]
        .as_str()
        .expect("s")
        .parse()?;
    // Past the delivery cutoff (grace 0): late submission rejected.
    while now_ns(&env.worker).await? < delivery {
        env.worker.fast_forward(100).await?;
    }
    let res = line_call(
        &env.r.supplier,
        &env,
        "submit_delivery",
        json!({ "agreement_id": id, "line_id": 1, "evidence_commitment": EV }),
    )
    .await?;
    assert_fails(res, "ERR_LINE:SubmissionDeadlinePassed");
    let v = get_agreement(&env.escrow, &id).await?;
    assert_eq!(line_status(&v, 1), "FUNDED");
    assert_eq!(
        v["lines"][1]["non_delivery_t0_ns"],
        json!(delivery.to_string()),
        "NON_DELIVERY eligible, T0 = deadline + grace"
    );
    // Past review end: no automatic acceptance; accept/dispute rejected.
    while now_ns(&env.worker).await? < submitted_at + 60 * s {
        env.worker.fast_forward(100).await?;
    }
    for method in ["accept_line", "open_dispute"] {
        let res = line_call(
            &env.r.buyer,
            &env,
            method,
            json!({ "agreement_id": id, "line_id": 0 }),
        )
        .await?;
        assert_fails(res, "ERR_LINE:ReviewWindowClosed");
    }
    let v = get_agreement(&env.escrow, &id).await?;
    let l0 = &v["lines"][0];
    assert_eq!(
        line_status(&v, 0),
        "SUBMITTED",
        "buyer silence does not accept the work"
    );
    assert_eq!(
        (l0["supplier_claimable"].as_str(), l0["locked"].as_str()),
        (Some("0"), Some("500000000")),
        "funds stay locked"
    );
    assert_eq!(
        l0["no_response_t0_ns"],
        json!((submitted_at + 60 * s).to_string()),
        "NO_RESPONSE eligible, T0 = submitted_at + review"
    );
    reconcile(&env, 1, &holders).await?;
    println!(
        "EVIDENCE lf006 chain-time: late submit rejected (NON_DELIVERY t0={delivery}); after review end accept/dispute rejected, line SUBMITTED, NO_RESPONSE t0={}",
        submitted_at + 60 * s
    );
    Ok(())
}

// ---- LF-006b: permissionless advance_case on genuinely funded lines ---------
// Plan: evidence/lf006b/lf006b-spec-and-test-plan.md.

async fn wait_until(env: &Env, t: u64) -> TestResult {
    let mut rounds = 0;
    while now_ns(&env.worker).await? < t {
        env.worker.fast_forward(100).await?;
        rounds += 1;
        assert!(rounds < 200, "chain time did not advance");
    }
    Ok(())
}

/// Short timing: acceptance +30 s, funding +40 s, delivery +90 s, review 60 s.
fn short_timing(now: u64) -> impl Fn(&mut Value) {
    move |t: &mut Value| {
        let s = 1_000_000_000u64;
        t["acceptance_deadline_ns"] = json!((now + 30 * s).to_string());
        t["funding_deadline_ns"] = json!((now + 40 * s).to_string());
        for i in 0..t["lines"].as_array().expect("lines").len() {
            t["lines"][i]["delivery_deadline_ns"] = json!((now + 90 * s).to_string());
        }
        t["review_window_ns"] = json!((60 * s).to_string());
    }
}

async fn advance(
    env: &Env,
    who: &Account,
    id: &str,
    line: u32,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error>> {
    line_call(
        who,
        env,
        "advance_case",
        json!({ "agreement_id": id, "line_id": line }),
    )
    .await
}

#[tokio::test]
async fn lf006b_no_response_on_funded_line() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let now = now_ns(&env.worker).await?;
    let (id, _h) = funded_agreement(&env, 1, 2, short_timing(now)).await?;
    for line in [0, 1] {
        line_call(
            &env.r.supplier,
            &env,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": line, "evidence_commitment": EV }),
        )
        .await?
        .into_result()?;
    }
    let v = get_agreement(&env.escrow, &id).await?;
    let t0 = |l: usize| -> u64 {
        v["lines"][l]["submitted_at_ns"]
            .as_str()
            .expect("s")
            .parse::<u64>()
            .expect("u64")
            + 60_000_000_000
    };
    let (t0_0, t0_1) = (t0(0), t0(1));
    wait_until(&env, t0_0.max(t0_1)).await?;
    // A third party advances line 0.
    let su = storage_usage(&env.escrow).await?;
    let res = advance(&env, &env.r.stranger, &id, 0).await?;
    let r = receipt(&res);
    res.into_result()?;
    let called_at = now_ns(&env.worker).await?;
    assert_eq!(storage_usage(&env.escrow).await?, su, "storage delta 0");
    let v = get_agreement(&env.escrow, &id).await?;
    let l0 = &v["lines"][0];
    assert_eq!(
        (l0["status"].as_str(), l0["dispute_reason"].as_str()),
        (Some("DISPUTED"), Some("NO_RESPONSE"))
    );
    assert_eq!(
        l0["dispute_t0_ns"],
        json!(t0_0.to_string()),
        "T0 = submitted_at + review, not the call time"
    );
    assert_eq!(
        (l0["locked"].as_str(), l0["supplier_claimable"].as_str()),
        (Some("500000000"), Some("0")),
        "no settlement"
    );
    assert_eq!(v["lines"][1]["status"], "SUBMITTED", "line 1 untouched");
    reconcile(&env, 1, &holders).await?;
    println!(
        "EVIDENCE lf006b method=advance_case reason=NO_RESPONSE caller=stranger t0={t0_0} chain_time_after_call={called_at} storage_delta=0 {r}"
    );
    // Late invocation: much later, T0 of line 1 stays its own fixed deadline.
    wait_until(&env, called_at + 120_000_000_000).await?;
    let res = advance(&env, &env.r.supplier, &id, 1).await?;
    let r = receipt(&res);
    res.into_result()?;
    let late_at = now_ns(&env.worker).await?;
    let v = get_agreement(&env.escrow, &id).await?;
    assert_eq!(
        v["lines"][1]["dispute_t0_ns"],
        json!(t0_1.to_string()),
        "late call keeps fixed T0"
    );
    assert!(late_at > t0_1 + 120_000_000_000, "the call really was late");
    reconcile(&env, 1, &holders).await?;
    println!(
        "EVIDENCE lf006b late advance caller=supplier t0={t0_1} called_at>={late_at} (late by {} ns) {r}",
        late_at - t0_1
    );
    Ok(())
}

#[tokio::test]
async fn lf006b_non_delivery_on_funded_line() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let now = now_ns(&env.worker).await?;
    let (id, _h) = funded_agreement(&env, 1, 1, short_timing(now)).await?;
    let delivery = now + 90_000_000_000;
    let res = advance(&env, &env.r.primary, &id, 0).await?;
    assert_fails(res, "ERR_LINE:NotEligible");
    wait_until(&env, delivery).await?;
    let su = storage_usage(&env.escrow).await?;
    let res = advance(&env, &env.r.primary, &id, 0).await?;
    let r = receipt(&res);
    res.into_result()?;
    assert_eq!(storage_usage(&env.escrow).await?, su, "storage delta 0");
    let v = get_agreement(&env.escrow, &id).await?;
    let l = &v["lines"][0];
    assert_eq!(
        (l["status"].as_str(), l["dispute_reason"].as_str()),
        (Some("DISPUTED"), Some("NON_DELIVERY"))
    );
    assert_eq!(
        l["dispute_t0_ns"],
        json!(delivery.to_string()),
        "T0 = delivery deadline + grace (0)"
    );
    assert_eq!(l["locked"], json!("500000000"));
    // The submission window stays closed.
    let res = line_call(
        &env.r.supplier,
        &env,
        "submit_delivery",
        json!({ "agreement_id": id, "line_id": 0, "evidence_commitment": EV }),
    )
    .await?;
    assert_fails(res, "ERR_LINE:WrongState");
    reconcile(&env, 1, &holders).await?;
    println!(
        "EVIDENCE lf006b method=advance_case reason=NON_DELIVERY caller=primary t0={delivery} storage_delta=0 {r}"
    );
    Ok(())
}

#[tokio::test]
async fn lf006b_rejections() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let now = now_ns(&env.worker).await?;
    let (id, _h) = funded_agreement(&env, 1, 3, short_timing(now)).await?;
    for line in [0, 1, 2] {
        line_call(
            &env.r.supplier,
            &env,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": line, "evidence_commitment": EV }),
        )
        .await?
        .into_result()?;
    }
    line_call(
        &env.r.buyer,
        &env,
        "accept_line",
        json!({ "agreement_id": id, "line_id": 0 }),
    )
    .await?
    .into_result()?;
    line_call(
        &env.r.buyer,
        &env,
        "open_dispute",
        json!({ "agreement_id": id, "line_id": 1 }),
    )
    .await?
    .into_result()?;
    let mut cases: Vec<(&str, String, u32, &str)> = vec![
        (
            "premature (review still open)",
            id.clone(),
            2,
            "ERR_LINE:NotEligible",
        ),
        ("ALLOCATED line", id.clone(), 0, "ERR_LINE:NotAdvanceable"),
        (
            "buyer-DISPUTED line",
            id.clone(),
            1,
            "ERR_LINE:NotAdvanceable",
        ),
        (
            "unknown agreement",
            "9".to_string(),
            0,
            "ERR_AGREEMENT_NOT_FOUND",
        ),
        ("unknown line", id.clone(), 3, "ERR_LINE:LineNotFound"),
    ];
    for (name, aid, line, code) in cases.drain(..) {
        let before = get_agreement(&env.escrow, &id).await?;
        let su = storage_usage(&env.escrow).await?;
        let e = outstanding(&env).await?;
        assert_fails(advance(&env, &env.r.stranger, &aid, line).await?, code);
        assert_eq!(
            get_agreement(&env.escrow, &id).await?,
            before,
            "{name}: state unchanged"
        );
        assert_eq!(
            storage_usage(&env.escrow).await?,
            su,
            "{name}: storage unchanged"
        );
        assert_eq!(outstanding(&env).await?, e, "{name}: E unchanged");
        println!("EVIDENCE lf006b rejected case={name:?} code={code}");
    }
    // Replay after a successful advance; and attached deposit.
    let v = get_agreement(&env.escrow, &id).await?;
    let t0: u64 = v["lines"][2]["submitted_at_ns"]
        .as_str()
        .expect("s")
        .parse::<u64>()?
        + 60_000_000_000;
    wait_until(&env, t0).await?;
    advance(&env, &env.r.buyer, &id, 2).await?.into_result()?;
    let before = get_agreement(&env.escrow, &id).await?;
    assert_fails(
        advance(&env, &env.r.buyer, &id, 2).await?,
        "ERR_LINE:NotAdvanceable",
    );
    assert_eq!(
        get_agreement(&env.escrow, &id).await?,
        before,
        "replay: state unchanged"
    );
    let res = env
        .r
        .stranger
        .call(env.escrow.id(), "advance_case")
        .args_json(json!({ "agreement_id": id, "line_id": 2 }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert_fails(res, "doesn't accept deposit");
    reconcile(&env, 1, &holders).await?;
    println!("EVIDENCE lf006b replay rejected NotAdvanceable; attached deposit rejected");
    Ok(())
}

// ---- LF-007 mutual settlement on genuinely funded lines ---------------------------

async fn propose(
    env: &Env,
    who: &Account,
    id: &str,
    line: u32,
    b: u128,
    s: u128,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error>> {
    line_call(
        who,
        env,
        "propose_split",
        json!({ "agreement_id": id, "line_id": line,
                "buyer_amount": b.to_string(), "supplier_amount": s.to_string() }),
    )
    .await
}

async fn accept(
    env: &Env,
    who: &Account,
    id: &str,
    line: u32,
    pid: u64,
    b: u128,
    s: u128,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error>> {
    line_call(
        who,
        env,
        "accept_split",
        json!({ "agreement_id": id, "line_id": line, "proposal_id": pid.to_string(),
                "buyer_amount": b.to_string(), "supplier_amount": s.to_string() }),
    )
    .await
}

#[tokio::test]
async fn lf007_settle_after_buyer_dispute() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let (id, _h) = funded_agreement(&env, 1, 3, |_| {}).await?;
    for line in [0, 1] {
        line_call(
            &env.r.supplier,
            &env,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": line, "evidence_commitment": EV }),
        )
        .await?
        .into_result()?;
    }
    line_call(
        &env.r.buyer,
        &env,
        "open_dispute",
        json!({ "agreement_id": id, "line_id": 1 }),
    )
    .await?
    .into_result()?;
    let before = get_agreement(&env.escrow, &id).await?;
    let su = storage_usage(&env.escrow).await?;
    // Buyer proposes 100M / 200M; supplier counter-proposes 50M / 250M.
    let res = propose(&env, &env.r.buyer, &id, 1, 100_000_000, 200_000_000).await?;
    let r1 = receipt(&res);
    let p1: String = res.into_result()?.json()?;
    let res = propose(&env, &env.r.supplier, &id, 1, 50_000_000, 250_000_000).await?;
    let r2 = receipt(&res);
    let p2: String = res.into_result()?.json()?;
    assert_eq!((p1.as_str(), p2.as_str()), ("1", "2"), "per-line nonce");
    assert_eq!(
        storage_usage(&env.escrow).await?,
        su,
        "propose: storage delta 0"
    );
    // The superseded proposal can no longer be accepted, even by its counterparty.
    let snap = get_agreement(&env.escrow, &id).await?;
    assert_fails(
        accept(&env, &env.r.supplier, &id, 1, 1, 100_000_000, 200_000_000).await?,
        "ERR_LINE:StaleProposal",
    );
    assert_fails(
        accept(&env, &env.r.buyer, &id, 1, 2, 100_000_000, 200_000_000).await?,
        "ERR_LINE:ProposalMismatch",
    );
    assert_fails(
        accept(&env, &env.r.supplier, &id, 1, 2, 50_000_000, 250_000_000).await?,
        "ERR_LINE:OwnProposal",
    );
    assert_eq!(
        get_agreement(&env.escrow, &id).await?,
        snap,
        "rejections: state unchanged"
    );
    let res = accept(&env, &env.r.buyer, &id, 1, 2, 50_000_000, 250_000_000).await?;
    let r3 = receipt(&res);
    res.into_result()?;
    assert_eq!(
        storage_usage(&env.escrow).await?,
        su,
        "accept: storage delta 0"
    );
    let v = get_agreement(&env.escrow, &id).await?;
    let l = &v["lines"][1];
    assert_eq!(
        (
            l["status"].as_str(),
            l["locked"].as_str(),
            l["buyer_claimable"].as_str(),
            l["supplier_claimable"].as_str(),
            l["allocation_mode"].as_str(),
            l["allocation_source_id"].as_str(),
            l["proposal_status"].as_str(),
        ),
        (
            Some("ALLOCATED"),
            Some("0"),
            Some("50000000"),
            Some("250000000"),
            Some("MUTUAL"),
            Some("2"),
            Some("ACCEPTED")
        )
    );
    for j in [0, 2] {
        assert_eq!(v["lines"][j], before["lines"][j], "line {j} unchanged");
    }
    assert_eq!(
        outstanding(&env).await?,
        1_000_000_000,
        "E unchanged by allocation"
    );
    assert_eq!(
        (
            balance(&env.token, env.r.supplier.id().as_str()).await?,
            balance(&env.token, env.escrow.id().as_str()).await?
        ),
        (0, 1_000_000_000),
        "no outgoing token transfer"
    );
    reconcile(&env, 1, &holders).await?;
    // Final allocation is immutable.
    let fin = get_agreement(&env.escrow, &id).await?;
    for res in [
        accept(&env, &env.r.buyer, &id, 1, 2, 50_000_000, 250_000_000).await?,
        propose(&env, &env.r.supplier, &id, 1, 0, 300_000_000).await?,
    ] {
        assert_fails(res, "ERR_LINE:AlreadyFinalized");
    }
    assert_eq!(get_agreement(&env.escrow, &id).await?, fin);
    println!("EVIDENCE lf007 method=propose_split caller=buyer proposal_id=1 storage_delta=0 {r1}");
    println!(
        "EVIDENCE lf007 method=propose_split caller=supplier proposal_id=2 storage_delta=0 {r2}"
    );
    println!("EVIDENCE lf007 method=accept_split caller=buyer proposal_id=2 storage_delta=0 {r3}");
    Ok(())
}

#[tokio::test]
async fn lf007_settle_after_no_response_and_non_delivery() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let now = now_ns(&env.worker).await?;
    let (id, _h) = funded_agreement(&env, 1, 2, short_timing(now)).await?;
    line_call(
        &env.r.supplier,
        &env,
        "submit_delivery",
        json!({ "agreement_id": id, "line_id": 0, "evidence_commitment": EV }),
    )
    .await?
    .into_result()?;
    // Not disputed yet: settlement is rejected.
    assert_fails(
        propose(&env, &env.r.supplier, &id, 0, 0, 500_000_000).await?,
        "ERR_LINE:WrongState",
    );
    wait_until(&env, now + 90_000_000_000).await?;
    let v = get_agreement(&env.escrow, &id).await?;
    let t0_0 = v["lines"][0]["submitted_at_ns"]
        .as_str()
        .expect("s")
        .parse::<u64>()?
        + 60_000_000_000;
    wait_until(&env, t0_0).await?;
    advance(&env, &env.r.stranger, &id, 0)
        .await?
        .into_result()?;
    advance(&env, &env.r.stranger, &id, 1)
        .await?
        .into_result()?;
    // Line 0 (NO_RESPONSE): supplier proposes everything to itself, buyer accepts.
    let res = propose(&env, &env.r.supplier, &id, 0, 0, 500_000_000).await?;
    let p: String = res.into_result()?.json()?;
    let res = accept(&env, &env.r.buyer, &id, 0, p.parse()?, 0, 500_000_000).await?;
    let r0 = receipt(&res);
    res.into_result()?;
    // Line 1 (NON_DELIVERY): buyer proposes a full refund, supplier accepts.
    let res = propose(&env, &env.r.buyer, &id, 1, 300_000_000, 0).await?;
    let p: String = res.into_result()?.json()?;
    let res = accept(&env, &env.r.supplier, &id, 1, p.parse()?, 300_000_000, 0).await?;
    let r1 = receipt(&res);
    res.into_result()?;
    let v = get_agreement(&env.escrow, &id).await?;
    assert_eq!(
        (
            v["lines"][0]["dispute_reason"].as_str(),
            v["lines"][0]["supplier_claimable"].as_str(),
            v["lines"][0]["buyer_claimable"].as_str(),
        ),
        (Some("NO_RESPONSE"), Some("500000000"), Some("0"))
    );
    assert_eq!(
        (
            v["lines"][1]["dispute_reason"].as_str(),
            v["lines"][1]["buyer_claimable"].as_str(),
            v["lines"][1]["supplier_claimable"].as_str(),
        ),
        (Some("NON_DELIVERY"), Some("300000000"), Some("0"))
    );
    assert_eq!(outstanding(&env).await?, 800_000_000);
    reconcile(&env, 1, &holders).await?;
    println!("EVIDENCE lf007 settled NO_RESPONSE line 0/500000000 {r0}");
    println!("EVIDENCE lf007 settled NON_DELIVERY line 300000000/0 {r1}");
    Ok(())
}

#[tokio::test]
async fn lf007_rejections() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let (id, _h) = funded_agreement(&env, 1, 1, |_| {}).await?;
    line_call(
        &env.r.supplier,
        &env,
        "submit_delivery",
        json!({ "agreement_id": id, "line_id": 0, "evidence_commitment": EV }),
    )
    .await?
    .into_result()?;
    line_call(
        &env.r.buyer,
        &env,
        "open_dispute",
        json!({ "agreement_id": id, "line_id": 0 }),
    )
    .await?
    .into_result()?;
    let snap = get_agreement(&env.escrow, &id).await?;
    for who in [&env.r.primary, &env.r.backup, &env.r.stranger] {
        assert_fails(
            propose(&env, who, &id, 0, 250_000_000, 250_000_000).await?,
            "ERR_LINE:NotAuthorized",
        );
    }
    for (b, s) in [
        (250_000_000u128, 249_999_999u128),
        (500_000_000, 1),
        (u128::MAX, 1),
    ] {
        assert_fails(
            propose(&env, &env.r.buyer, &id, 0, b, s).await?,
            "ERR_LINE:AllocationSumMismatch",
        );
    }
    let res = line_call(
        &env.r.buyer,
        &env,
        "propose_split",
        json!({ "agreement_id": id, "line_id": 0,
                "buyer_amount": "+250000000", "supplier_amount": "250000000" }),
    )
    .await?;
    assert_fails(res, "ERR_AMOUNT_FORMAT:NonCanonicalDecimal");
    assert_fails(
        accept(&env, &env.r.supplier, &id, 0, 1, 250_000_000, 250_000_000).await?,
        "ERR_LINE:NoActiveProposal",
    );
    assert_eq!(
        get_agreement(&env.escrow, &id).await?,
        snap,
        "state unchanged"
    );
    propose(&env, &env.r.buyer, &id, 0, 250_000_000, 250_000_000)
        .await?
        .into_result()?;
    let snap = get_agreement(&env.escrow, &id).await?;
    for who in [&env.r.primary, &env.r.backup, &env.r.stranger] {
        assert_fails(
            accept(&env, who, &id, 0, 1, 250_000_000, 250_000_000).await?,
            "ERR_LINE:NotAuthorized",
        );
    }
    for (method, args) in [
        (
            "propose_split",
            json!({ "agreement_id": id, "line_id": 0,
                    "buyer_amount": "1", "supplier_amount": "499999999" }),
        ),
        (
            "accept_split",
            json!({ "agreement_id": id, "line_id": 0, "proposal_id": "1",
                    "buyer_amount": "250000000", "supplier_amount": "250000000" }),
        ),
    ] {
        let res = env
            .r
            .supplier
            .call(env.escrow.id(), method)
            .args_json(args)
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?;
        assert_fails(res, "doesn't accept deposit");
    }
    assert_eq!(
        get_agreement(&env.escrow, &id).await?,
        snap,
        "state unchanged"
    );
    assert_fails(
        accept(&env, &env.r.buyer, &id, 0, 1, 250_000_000, 250_000_000).await?,
        "ERR_LINE:OwnProposal",
    );
    assert_eq!(get_agreement(&env.escrow, &id).await?, snap);
    assert_eq!(outstanding(&env).await?, 500_000_000);
    reconcile(&env, 1, &holders).await?;
    println!(
        "EVIDENCE lf007 rejections: unauthorized, sum, format, no proposal, deposit, own; state and E unchanged"
    );
    Ok(())
}

#[tokio::test]
async fn lf007_large_principal() -> TestResult {
    let env = setup_with_supply(25, u128::MAX).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let (id, h) = agreed(&env, 1, 1, |t| {
        t["lines"][0]["principal"] = json!(u128::MAX.to_string());
    })
    .await?;
    let res = transfer_call(
        &env.r.buyer,
        &env.token,
        env.escrow.id().as_str(),
        u128::MAX,
        &msg(&id, 0, &h),
        None,
    )
    .await?;
    assert_eq!(used(&res), u128::MAX);
    line_call(
        &env.r.supplier,
        &env,
        "submit_delivery",
        json!({ "agreement_id": id, "line_id": 0, "evidence_commitment": EV }),
    )
    .await?
    .into_result()?;
    line_call(
        &env.r.buyer,
        &env,
        "open_dispute",
        json!({ "agreement_id": id, "line_id": 0 }),
    )
    .await?
    .into_result()?;
    assert_fails(
        propose(&env, &env.r.buyer, &id, 0, u128::MAX, 1).await?,
        "ERR_LINE:AllocationSumMismatch",
    );
    let res = propose(&env, &env.r.supplier, &id, 0, u128::MAX - 1, 1).await?;
    let p: String = res.into_result()?.json()?;
    let res = accept(&env, &env.r.buyer, &id, 0, p.parse()?, u128::MAX - 1, 1).await?;
    let r = receipt(&res);
    res.into_result()?;
    let l = &get_agreement(&env.escrow, &id).await?["lines"][0];
    assert_eq!(
        (
            l["buyer_claimable"].as_str(),
            l["supplier_claimable"].as_str()
        ),
        (Some((u128::MAX - 1).to_string().as_str()), Some("1"))
    );
    assert_eq!(
        outstanding(&env).await?,
        u128::MAX,
        "E = u128::MAX unchanged"
    );
    reconcile(&env, 1, &holders).await?;
    println!("EVIDENCE lf007 large principal u128::MAX split (MAX-1, 1) {r}");
    Ok(())
}

// ---- LF-008 timed arbitration and fallback on genuinely funded lines -------------

const SEC: u64 = 1_000_000_000;
const W: u64 = 300 * SEC; // N = A = B = 300 s (accelerated test timing)

/// short_timing plus 300 s negotiation / primary / backup windows.
fn lf008_timing(now: u64) -> impl Fn(&mut Value) {
    let base = short_timing(now);
    move |t: &mut Value| {
        base(t);
        for k in [
            "negotiation_window_ns",
            "primary_window_ns",
            "backup_window_ns",
        ] {
            t[k] = json!(W.to_string());
        }
    }
}

fn t0_of(v: &Value, line: usize) -> u64 {
    v["lines"][line]["dispute_t0_ns"]
        .as_str()
        .expect("t0")
        .parse()
        .expect("u64")
}

async fn ruling(
    env: &Env,
    who: &Account,
    id: &str,
    line: u32,
    b: u128,
    s: u128,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error>> {
    line_call(
        who,
        env,
        "submit_ruling",
        json!({ "agreement_id": id, "line_id": line,
                "buyer_amount": b.to_string(), "supplier_amount": s.to_string() }),
    )
    .await
}

async fn fallback(
    env: &Env,
    who: &Account,
    id: &str,
    line: u32,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error>> {
    line_call(
        who,
        env,
        "trigger_fallback",
        json!({ "agreement_id": id, "line_id": line }),
    )
    .await
}

async fn phase(env: &Env, id: &str, line: usize) -> Result<String, Box<dyn std::error::Error>> {
    Ok(
        get_agreement(&env.escrow, id).await?["lines"][line]["dispute_phase"]
            .as_str()
            .expect("phase")
            .to_string(),
    )
}

/// Funded agreement with every line SUBMITTED and buyer-disputed.
async fn disputed_agreement(
    env: &Env,
    nonce: u64,
    lines: usize,
) -> Result<String, Box<dyn std::error::Error>> {
    let now = now_ns(&env.worker).await?;
    let (id, _h) = funded_agreement(env, nonce, lines, lf008_timing(now)).await?;
    for line in 0..lines as u32 {
        line_call(
            &env.r.supplier,
            env,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": line, "evidence_commitment": EV }),
        )
        .await?
        .into_result()?;
        line_call(
            &env.r.buyer,
            env,
            "open_dispute",
            json!({ "agreement_id": id, "line_id": line }),
        )
        .await?
        .into_result()?;
    }
    Ok(id)
}

#[tokio::test]
async fn lf008_primary_and_backup_rulings() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let id = disputed_agreement(&env, 1, 2).await?;
    let v = get_agreement(&env.escrow, &id).await?;
    let (t0a, t0b) = (t0_of(&v, 0), t0_of(&v, 1));
    assert_eq!(v["lines"][0]["dispute_phase"], "NEGOTIATION");
    // Negotiation: no arbitrator may rule.
    assert_fails(
        ruling(&env, &env.r.primary, &id, 0, 1, 499_999_999).await?,
        "ERR_LINE:NotRulingWindow",
    );
    wait_until(&env, t0a + W).await?;
    assert_eq!(phase(&env, &id, 0).await?, "PRIMARY");
    let snap = get_agreement(&env.escrow, &id).await?;
    assert_fails(
        ruling(&env, &env.r.backup, &id, 0, 1, 499_999_999).await?,
        "ERR_LINE:NotRulingWindow",
    );
    for who in [&env.r.buyer, &env.r.supplier, &env.r.stranger] {
        assert_fails(
            ruling(&env, who, &id, 0, 1, 499_999_999).await?,
            "ERR_LINE:NotAuthorized",
        );
    }
    assert_eq!(
        get_agreement(&env.escrow, &id).await?,
        snap,
        "rejections: state unchanged"
    );
    let su = storage_usage(&env.escrow).await?;
    let res = ruling(&env, &env.r.primary, &id, 0, 100_000_000, 400_000_000).await?;
    let rp = receipt(&res);
    res.into_result()?;
    assert_eq!(storage_usage(&env.escrow).await?, su, "storage delta 0");
    // Line 1: wait for its backup window; primary authority has expired.
    wait_until(&env, t0b + 2 * W).await?;
    assert_eq!(phase(&env, &id, 1).await?, "BACKUP");
    assert_fails(
        ruling(&env, &env.r.primary, &id, 1, 0, 300_000_000).await?,
        "ERR_LINE:NotRulingWindow",
    );
    let res = ruling(&env, &env.r.backup, &id, 1, 0, 300_000_000).await?;
    let rb = receipt(&res);
    res.into_result()?;
    let v = get_agreement(&env.escrow, &id).await?;
    assert_eq!(
        (
            v["lines"][0]["allocation_mode"].as_str(),
            v["lines"][0]["buyer_claimable"].as_str(),
            v["lines"][0]["supplier_claimable"].as_str(),
            v["lines"][1]["allocation_mode"].as_str(),
            v["lines"][1]["supplier_claimable"].as_str(),
        ),
        (
            Some("PRIMARY_RULING"),
            Some("100000000"),
            Some("400000000"),
            Some("BACKUP_RULING"),
            Some("300000000")
        )
    );
    assert_eq!(outstanding(&env).await?, 800_000_000, "E unchanged");
    assert_eq!(
        balance(&env.token, env.r.supplier.id().as_str()).await?,
        0,
        "no payout"
    );
    reconcile(&env, 1, &holders).await?;
    println!("EVIDENCE lf008 method=submit_ruling role=primary storage_delta=0 {rp}");
    println!("EVIDENCE lf008 method=submit_ruling role=backup storage_delta=0 {rb}");
    Ok(())
}

#[tokio::test]
async fn lf008_fallback_after_silence_with_rounding() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let now = now_ns(&env.worker).await?;
    let timing = lf008_timing(now);
    let (id, h) = agreed(&env, 1, 1, |t| {
        timing(t);
        t["lines"][0]["principal"] = json!("1001");
        t["lines"][0]["fallback_buyer_bps"] = json!(6_667);
        t["lines"][0]["fallback_supplier_bps"] = json!(3_333);
    })
    .await?;
    let res = transfer_call(
        &env.r.buyer,
        &env.token,
        env.escrow.id().as_str(),
        1001,
        &msg(&id, 0, &h),
        None,
    )
    .await?;
    assert_eq!(used(&res), 1001);
    line_call(
        &env.r.supplier,
        &env,
        "submit_delivery",
        json!({ "agreement_id": id, "line_id": 0, "evidence_commitment": EV }),
    )
    .await?
    .into_result()?;
    line_call(
        &env.r.buyer,
        &env,
        "open_dispute",
        json!({ "agreement_id": id, "line_id": 0 }),
    )
    .await?
    .into_result()?;
    let t0 = t0_of(&get_agreement(&env.escrow, &id).await?, 0);
    // Arbitrators stay silent through both windows.
    for (at, ph) in [(t0 + W, "PRIMARY"), (t0 + 2 * W, "BACKUP")] {
        wait_until(&env, at).await?;
        assert_eq!(phase(&env, &id, 0).await?, ph);
        assert_fails(
            fallback(&env, &env.r.stranger, &id, 0).await?,
            "ERR_LINE:FallbackNotEligible",
        );
    }
    wait_until(&env, t0 + 3 * W).await?;
    assert_eq!(phase(&env, &id, 0).await?, "FALLBACK");
    assert_fails(
        ruling(&env, &env.r.backup, &id, 0, 1001, 0).await?,
        "ERR_LINE:NotRulingWindow",
    );
    let res = fallback(&env, &env.r.stranger, &id, 0).await?;
    let r = receipt(&res);
    res.into_result()?;
    let l = &get_agreement(&env.escrow, &id).await?["lines"][0];
    assert_eq!(
        (
            l["allocation_mode"].as_str(),
            l["buyer_claimable"].as_str(),
            l["supplier_claimable"].as_str()
        ),
        (Some("FALLBACK"), Some("668"), Some("333")),
        "docs/07: supplier = floor(1001 * 3333 / 10000) = 333, buyer = 668"
    );
    assert_eq!(outstanding(&env).await?, 1001);
    reconcile(&env, 1, &holders).await?;
    println!("EVIDENCE lf008 method=trigger_fallback caller=stranger split=668/333 {r}");
    Ok(())
}

#[tokio::test]
async fn lf008_late_entry_into_backup_and_fallback() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let now = now_ns(&env.worker).await?;
    let (id, _h) = funded_agreement(&env, 1, 2, lf008_timing(now)).await?;
    // Line 1 delivered and then ignored by the buyer (NO_RESPONSE later).
    line_call(
        &env.r.supplier,
        &env,
        "submit_delivery",
        json!({ "agreement_id": id, "line_id": 1, "evidence_commitment": EV }),
    )
    .await?
    .into_result()?;
    let sub1: u64 = get_agreement(&env.escrow, &id).await?["lines"][1]["submitted_at_ns"]
        .as_str()
        .expect("s")
        .parse()?;
    // Line 0 never delivered: NON_DELIVERY T0 = delivery deadline (grace 0).
    let t0_nd = now + 90 * SEC;
    wait_until(&env, t0_nd + 2 * W).await?; // backup window of line 0
    advance(&env, &env.r.stranger, &id, 0)
        .await?
        .into_result()?;
    let v = get_agreement(&env.escrow, &id).await?;
    assert_eq!(t0_of(&v, 0), t0_nd, "late advance keeps T0");
    assert_eq!(
        v["lines"][0]["dispute_phase"], "BACKUP",
        "entered directly into BACKUP"
    );
    assert_fails(
        ruling(&env, &env.r.primary, &id, 0, 500_000_000, 0).await?,
        "ERR_LINE:NotRulingWindow",
    );
    let res = ruling(&env, &env.r.backup, &id, 0, 500_000_000, 0).await?;
    let rb = receipt(&res);
    res.into_result()?;
    // Line 1: NO_RESPONSE T0 = submitted_at + 60 s; advanced after its longstop.
    let t0_nr = sub1 + 60 * SEC;
    wait_until(&env, t0_nr + 3 * W + 30 * SEC).await?;
    advance(&env, &env.r.supplier, &id, 1)
        .await?
        .into_result()?;
    let v = get_agreement(&env.escrow, &id).await?;
    assert_eq!(t0_of(&v, 1), t0_nr, "late advance keeps T0");
    assert_eq!(
        v["lines"][1]["dispute_phase"], "FALLBACK",
        "entered directly into FALLBACK"
    );
    for who in [&env.r.primary, &env.r.backup] {
        assert_fails(
            ruling(&env, who, &id, 1, 0, 300_000_000).await?,
            "ERR_LINE:NotRulingWindow",
        );
    }
    let res = fallback(&env, &env.r.buyer, &id, 1).await?;
    let rf = receipt(&res);
    res.into_result()?;
    let v = get_agreement(&env.escrow, &id).await?;
    // terms(): line 1 fallback bps buyer 6 000 / supplier 4 000 of 300 000 000.
    assert_eq!(
        (
            v["lines"][1]["buyer_claimable"].as_str(),
            v["lines"][1]["supplier_claimable"].as_str()
        ),
        (Some("180000000"), Some("120000000"))
    );
    assert_eq!(outstanding(&env).await?, 800_000_000);
    reconcile(&env, 1, &holders).await?;
    println!("EVIDENCE lf008 late NON_DELIVERY advance into BACKUP then backup ruling {rb}");
    println!("EVIDENCE lf008 late NO_RESPONSE advance into FALLBACK then fallback {rf}");
    Ok(())
}

#[tokio::test]
async fn lf008_rejections() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let id = disputed_agreement(&env, 1, 1).await?;
    let t0 = t0_of(&get_agreement(&env.escrow, &id).await?, 0);
    wait_until(&env, t0 + W).await?;
    let snap = get_agreement(&env.escrow, &id).await?;
    let res = line_call(&env.r.primary, &env, "submit_ruling",
        json!({ "agreement_id": id, "line_id": 0, "buyer_amount": "+1", "supplier_amount": "499999999" })).await?;
    assert_fails(res, "ERR_AMOUNT_FORMAT:NonCanonicalDecimal");
    assert_fails(
        ruling(&env, &env.r.primary, &id, 0, 1, 1).await?,
        "ERR_LINE:AllocationSumMismatch",
    );
    assert_fails(
        fallback(&env, &env.r.stranger, &id, 0).await?,
        "ERR_LINE:FallbackNotEligible",
    );
    for (method, args) in [
        (
            "submit_ruling",
            json!({ "agreement_id": id, "line_id": 0, "buyer_amount": "1", "supplier_amount": "499999999" }),
        ),
        (
            "trigger_fallback",
            json!({ "agreement_id": id, "line_id": 0 }),
        ),
    ] {
        let res = env
            .r
            .primary
            .call(env.escrow.id(), method)
            .args_json(args)
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?;
        assert_fails(res, "doesn't accept deposit");
    }
    assert_eq!(
        get_agreement(&env.escrow, &id).await?,
        snap,
        "state unchanged"
    );
    ruling(&env, &env.r.primary, &id, 0, 1, 499_999_999)
        .await?
        .into_result()?;
    let fin = get_agreement(&env.escrow, &id).await?;
    assert_fails(
        ruling(&env, &env.r.primary, &id, 0, 1, 499_999_999).await?,
        "ERR_LINE:AlreadyFinalized",
    );
    wait_until(&env, t0 + 3 * W).await?;
    assert_fails(
        fallback(&env, &env.r.stranger, &id, 0).await?,
        "ERR_LINE:AlreadyFinalized",
    );
    assert_fails(
        propose(&env, &env.r.buyer, &id, 0, 0, 500_000_000).await?,
        "ERR_LINE:AlreadyFinalized",
    );
    let after = get_agreement(&env.escrow, &id).await?;
    assert_eq!(
        after["lines"][0]["allocation_mode"],
        fin["lines"][0]["allocation_mode"]
    );
    assert_eq!(
        after["lines"][0]["buyer_claimable"],
        fin["lines"][0]["buyer_claimable"]
    );
    assert_eq!(
        after["lines"][0]["allocation_finalized_at_ns"],
        fin["lines"][0]["allocation_finalized_at_ns"]
    );
    reconcile(&env, 1, &holders).await?;
    println!(
        "EVIDENCE lf008 rejections: format, sum, early fallback, deposit, replay, post-final; state and E unchanged"
    );
    Ok(())
}

/// Submit `a` and `b` asynchronously (back to back) and await both.
async fn race(
    a: near_workspaces::operations::CallTransaction,
    b: near_workspaces::operations::CallTransaction,
) -> Result<(ExecutionFinalResult, ExecutionFinalResult), Box<dyn std::error::Error>> {
    let (sa, sb) = (a.transact_async().await?, b.transact_async().await?);
    Ok((sa.await?, sb.await?))
}

fn exec_block(r: &ExecutionFinalResult) -> String {
    r.receipt_outcomes()
        .first()
        .map(|o| o.block_hash.to_string())
        .unwrap_or_default()
}

#[tokio::test]
async fn lf008_race_same_block_mutual_vs_ruling_and_fallback() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let mut same_block_seen = 0;
    for (round, (order_mutual_first, fallback_phase)) in
        [(true, false), (false, false), (true, true), (false, true)]
            .into_iter()
            .enumerate()
    {
        let id = disputed_agreement(&env, round as u64 + 1, 1).await?;
        let t0 = t0_of(&get_agreement(&env.escrow, &id).await?, 0);
        wait_until(&env, if fallback_phase { t0 + 3 * W } else { t0 + W }).await?;
        let pid: String = propose(&env, &env.r.buyer, &id, 0, 200_000_000, 300_000_000)
            .await?
            .into_result()?
            .json()?;
        let accept_tx = env
            .r
            .supplier
            .call(env.escrow.id(), "accept_split")
            .args_json(
                json!({ "agreement_id": id, "line_id": 0, "proposal_id": pid,
                               "buyer_amount": "200000000", "supplier_amount": "300000000" }),
            )
            .max_gas();
        let other_tx = if fallback_phase {
            env.r
                .stranger
                .call(env.escrow.id(), "trigger_fallback")
                .args_json(json!({ "agreement_id": id, "line_id": 0 }))
                .max_gas()
        } else {
            env.r
                .primary
                .call(env.escrow.id(), "submit_ruling")
                .args_json(json!({ "agreement_id": id, "line_id": 0,
                                   "buyer_amount": "0", "supplier_amount": "500000000" }))
                .max_gas()
        };
        let (m, o) = if order_mutual_first {
            race(accept_tx, other_tx).await?
        } else {
            let (o, m) = race(other_tx, accept_tx).await?;
            (m, o)
        };
        let (bm, bo) = (exec_block(&m), exec_block(&o));
        let same = bm == bo;
        same_block_seen += usize::from(same);
        let ok = [m.is_success(), o.is_success()];
        assert_eq!(
            ok.iter().filter(|x| **x).count(),
            1,
            "exactly one finalization succeeds: {ok:?}"
        );
        let (winner_mode, loser) = if ok[0] {
            ("MUTUAL", o)
        } else {
            (
                if fallback_phase {
                    "FALLBACK"
                } else {
                    "PRIMARY_RULING"
                },
                m,
            )
        };
        assert_fails(loser, "ERR_LINE:AlreadyFinalized");
        let l = &get_agreement(&env.escrow, &id).await?["lines"][0];
        assert_eq!(l["allocation_mode"], winner_mode);
        assert_eq!(l["status"], "ALLOCATED");
        println!(
            "EVIDENCE lf008 race round={round} other={} submitted_first={} winner={winner_mode} same_execution_block={same} block_mutual={bm} block_other={bo}",
            if fallback_phase {
                "trigger_fallback"
            } else {
                "submit_ruling"
            },
            if order_mutual_first {
                "accept_split"
            } else {
                "other"
            },
        );
    }
    assert_eq!(
        outstanding(&env).await?,
        4 * 500_000_000,
        "E unchanged by all races"
    );
    reconcile(&env, 4, &holders).await?;
    println!("EVIDENCE lf008 race rounds=4 same_execution_block_rounds={same_block_seen}");
    Ok(())
}

#[tokio::test]
async fn lf008_race_sequential_both_orders() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let id = disputed_agreement(&env, 1, 2).await?;
    let t0 = t0_of(&get_agreement(&env.escrow, &id).await?, 1);
    wait_until(&env, t0 + W).await?;
    for line in [0u32, 1] {
        assert_eq!(phase(&env, &id, line as usize).await?, "PRIMARY");
        propose(
            &env,
            &env.r.buyer,
            &id,
            line,
            200_000_000,
            line_principal(line as usize) - 200_000_000,
        )
        .await?
        .into_result()?;
    }
    // Line 0: ruling first, then the exact accept loses.
    let p0 = (200_000_000u128, line_principal(0) - 200_000_000);
    ruling(&env, &env.r.primary, &id, 0, 0, 500_000_000)
        .await?
        .into_result()?;
    let snap = get_agreement(&env.escrow, &id).await?;
    assert_fails(
        accept(&env, &env.r.supplier, &id, 0, 1, p0.0, p0.1).await?,
        "ERR_LINE:AlreadyFinalized",
    );
    assert_eq!(
        get_agreement(&env.escrow, &id).await?,
        snap,
        "loser leaves state unchanged"
    );
    // Line 1: accept first, then the ruling loses.
    accept(&env, &env.r.supplier, &id, 1, 1, 200_000_000, 100_000_000)
        .await?
        .into_result()?;
    let snap = get_agreement(&env.escrow, &id).await?;
    assert_fails(
        ruling(&env, &env.r.primary, &id, 1, 300_000_000, 0).await?,
        "ERR_LINE:AlreadyFinalized",
    );
    assert_eq!(
        get_agreement(&env.escrow, &id).await?,
        snap,
        "loser leaves state unchanged"
    );
    let v = get_agreement(&env.escrow, &id).await?;
    assert_eq!(
        (
            v["lines"][0]["allocation_mode"].as_str(),
            v["lines"][1]["allocation_mode"].as_str()
        ),
        (Some("PRIMARY_RULING"), Some("MUTUAL"))
    );
    assert_eq!(outstanding(&env).await?, 800_000_000);
    reconcile(&env, 1, &holders).await?;
    println!(
        "EVIDENCE lf008 sequential races: ruling-then-accept and accept-then-ruling; loser AlreadyFinalized, state unchanged"
    );
    Ok(())
}

fn line_principal(line: usize) -> u128 {
    [500_000_000u128, 300_000_000, 200_000_000][line]
}

// ---- LF-009 secure withdrawals on genuinely funded lines -----------------------

/// Withdraw with the given deposit (yocto) and gas (Tgas).
async fn withdraw_with(
    env: &Env,
    who: &Account,
    id: &str,
    line: u32,
    ben: &str,
    yocto: u128,
    tgas: u64,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error>> {
    Ok(who
        .call(env.escrow.id(), "withdraw")
        .args_json(json!({ "agreement_id": id, "line_id": line, "beneficiary": ben }))
        .deposit(NearToken::from_yoctonear(yocto))
        .gas(Gas::from_tgas(tgas))
        .transact()
        .await?)
}

async fn withdraw(
    env: &Env,
    who: &Account,
    id: &str,
    line: u32,
    ben: &str,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error>> {
    withdraw_with(env, who, id, line, ben, 1, 100).await
}

async fn wslot(
    env: &Env,
    id: &str,
    line: u32,
    ben: &str,
) -> Result<Value, Box<dyn std::error::Error>> {
    Ok(env
        .escrow
        .view("get_withdrawal")
        .args_json(json!({ "agreement_id": id, "line_id": line, "beneficiary": ben }))
        .await?
        .json::<Value>()?)
}

async fn summary(env: &Env) -> Result<Value, Box<dyn std::error::Error>> {
    Ok(env.escrow.view("custody_summary").await?.json::<Value>()?)
}

/// Funded agreement whose lines are all settled mutually: line i gets
/// (buyer, supplier) = splits[i].
async fn settled_agreement(
    env: &Env,
    nonce: u64,
    splits: &[(u128, u128)],
) -> Result<String, Box<dyn std::error::Error>> {
    let (id, _h) = funded_agreement(env, nonce, splits.len(), |_| {}).await?;
    settle_lines(env, &id, splits).await?;
    Ok(id)
}

async fn settle_lines(env: &Env, id: &str, splits: &[(u128, u128)]) -> TestResult {
    for (line, &(b, s)) in splits.iter().enumerate() {
        let line = line as u32;
        line_call(
            &env.r.supplier,
            env,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": line, "evidence_commitment": EV }),
        )
        .await?
        .into_result()?;
        line_call(
            &env.r.buyer,
            env,
            "open_dispute",
            json!({ "agreement_id": id, "line_id": line }),
        )
        .await?
        .into_result()?;
        let p: String = propose(env, &env.r.buyer, id, line, b, s)
            .await?
            .into_result()?
            .json()?;
        accept(env, &env.r.supplier, id, line, p.parse()?, b, s)
            .await?
            .into_result()?;
    }
    Ok(())
}

/// Gas of each receipt of a withdraw transaction: (withdraw, ft_transfer, callback).
fn wd_gas(r: &ExecutionFinalResult) -> String {
    let g: Vec<String> = r
        .receipt_outcomes()
        .iter()
        .map(|o| format!("{}", o.gas_burnt.as_gas()))
        .collect();
    format!(
        "tx_total_gas={} receipt_gas=[{}]",
        r.total_gas_burnt.as_gas(),
        g.join(",")
    )
}

fn outcome_of(r: ExecutionFinalResult) -> Result<String, Box<dyn std::error::Error>> {
    let v: Value = r.into_result()?.json()?;
    Ok(v["outcome"].as_str().expect("outcome").to_string())
}

#[tokio::test]
async fn lf009_buyer_and_supplier_withdraw_success() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let id = settled_agreement(&env, 1, &[(200_000_000, 300_000_000)]).await?;
    reconcile(&env, 1, &holders).await?;
    let (b0, s0) = (
        balance(&env.token, env.r.buyer.id().as_str()).await?,
        balance(&env.token, env.r.supplier.id().as_str()).await?,
    );
    let su = storage_usage(&env.escrow).await?;
    let r = withdraw(&env, &env.r.supplier, &id, 0, "SUPPLIER").await?;
    let gs = wd_gas(&r);
    let tx = receipt(&r);
    assert_eq!(outcome_of(r)?, "PAID");
    assert_eq!(
        storage_usage(&env.escrow).await?,
        su,
        "withdraw + callback: storage delta 0"
    );
    assert_eq!(
        balance(&env.token, env.r.supplier.id().as_str()).await?,
        s0 + 300_000_000
    );
    let w = wslot(&env, &id, 0, "SUPPLIER").await?;
    assert_eq!(
        (
            w["state"].as_str(),
            w["withdrawal_id"].as_str(),
            w["amount"].as_str()
        ),
        (Some("PAID"), Some("1"), Some("300000000"))
    );
    assert_eq!(outstanding(&env).await?, 200_000_000, "E -= paid amount");
    reconcile(&env, 1, &holders).await?;
    let r = withdraw(&env, &env.r.buyer, &id, 0, "BUYER").await?;
    let gb = wd_gas(&r);
    assert_eq!(outcome_of(r)?, "PAID");
    assert_eq!(
        balance(&env.token, env.r.buyer.id().as_str()).await?,
        b0 + 200_000_000
    );
    let l = &get_agreement(&env.escrow, &id).await?["lines"][0];
    assert_eq!(
        (
            l["buyer_paid"].as_str(),
            l["supplier_paid"].as_str(),
            l["buyer_claimable"].as_str()
        ),
        (Some("200000000"), Some("300000000"), Some("0"))
    );
    let s = summary(&env).await?;
    assert_eq!(
        (
            s["outstanding_liabilities"].as_str(),
            s["open_withdrawals"].as_str(),
            s["last_withdrawal_id"].as_str()
        ),
        (Some("0"), Some("0"), Some("2"))
    );
    // Nothing left: a further withdrawal is rejected.
    assert_fails(
        withdraw(&env, &env.r.buyer, &id, 0, "BUYER").await?,
        "ERR_LINE:NothingToWithdraw",
    );
    reconcile(&env, 1, &holders).await?;
    println!("EVIDENCE lf009 withdraw SUPPLIER PAID storage_delta=0 {gs} {tx}");
    println!("EVIDENCE lf009 withdraw BUYER PAID {gb}");
    Ok(())
}

#[tokio::test]
async fn lf009_unregistered_recipient_definite_failure_then_retry() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let id = settled_agreement(&env, 1, &[(100_000_000, 400_000_000)]).await?;
    // The supplier closes its token storage (balance 0): ft_transfer must fail.
    env.r
        .supplier
        .call(env.token.id(), "storage_unregister")
        .args_json(json!({}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let r = withdraw(&env, &env.r.supplier, &id, 0, "SUPPLIER").await?;
    let g = wd_gas(&r);
    assert_eq!(
        outcome_of(r)?,
        "FAILED",
        "definite failure reported by the callback"
    );
    let w = wslot(&env, &id, 0, "SUPPLIER").await?;
    assert_eq!(
        (
            w["state"].as_str(),
            w["withdrawal_id"].as_str(),
            w["epoch"].as_u64()
        ),
        (Some("FAILED"), Some("1"), Some(1))
    );
    let l = &get_agreement(&env.escrow, &id).await?["lines"][0];
    assert_eq!(
        (
            l["supplier_claimable"].as_str(),
            l["supplier_pending"].as_str()
        ),
        (Some("400000000"), Some("0")),
        "restored exactly once"
    );
    assert_eq!(
        outstanding(&env).await?,
        500_000_000,
        "E unchanged on failure"
    );
    assert_eq!(summary(&env).await?["open_withdrawals"], "0");
    reconcile(&env, 1, &holders).await?;
    // Operator registers the supplier again; the retry gets a new id and epoch.
    register(&env.operator, &env.token, env.r.supplier.id().as_str()).await?;
    let r = withdraw(&env, &env.r.supplier, &id, 0, "SUPPLIER").await?;
    assert_eq!(outcome_of(r)?, "PAID");
    let w = wslot(&env, &id, 0, "SUPPLIER").await?;
    assert_eq!(
        (
            w["state"].as_str(),
            w["withdrawal_id"].as_str(),
            w["epoch"].as_u64()
        ),
        (Some("PAID"), Some("2"), Some(2))
    );
    assert_eq!(
        balance(&env.token, env.r.supplier.id().as_str()).await?,
        400_000_000
    );
    reconcile(&env, 1, &holders).await?;
    println!("EVIDENCE lf009 unregistered recipient FAILED then retry PAID {g}");
    Ok(())
}

#[tokio::test]
async fn lf009_rejections_gas_deposit_roles_forged_callback() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let id = settled_agreement(&env, 1, &[(250_000_000, 250_000_000)]).await?;
    let snap = get_agreement(&env.escrow, &id).await?;
    let sum0 = summary(&env).await?;
    for (who, ben, yocto, tgas, code) in [
        (
            &env.r.buyer,
            "BUYER",
            1u128,
            54u64,
            "ERR_WITHDRAW:InsufficientGas",
        ),
        (
            &env.r.buyer,
            "BUYER",
            0,
            100,
            "ERR_WITHDRAW:DepositMustBeOneYocto",
        ),
        (
            &env.r.buyer,
            "BUYER",
            2,
            100,
            "ERR_WITHDRAW:DepositMustBeOneYocto",
        ),
        (&env.r.primary, "BUYER", 1, 100, "ERR_LINE:NotAuthorized"),
        (&env.r.backup, "SUPPLIER", 1, 100, "ERR_LINE:NotAuthorized"),
        (&env.r.stranger, "BUYER", 1, 100, "ERR_LINE:NotAuthorized"),
        (&env.r.buyer, "SUPPLIER", 1, 100, "ERR_LINE:NotAuthorized"),
        (&env.r.buyer, "buyer", 1, 100, "ERR_WITHDRAW:BadBeneficiary"),
    ] {
        assert_fails(
            withdraw_with(&env, who, &id, 0, ben, yocto, tgas).await?,
            code,
        );
    }
    // Forged callbacks: an outsider cannot deliver an outcome.
    for who in [&env.r.stranger, &env.r.buyer] {
        let res = who.call(env.escrow.id(), "on_withdrawal_transfer")
            .args_json(json!({ "agreement_id": id, "line_id": 0, "beneficiary": "BUYER", "withdrawal_id": "1", "epoch": 1 }))
            .max_gas().transact().await?;
        assert_fails(res, "private");
    }
    assert_eq!(
        get_agreement(&env.escrow, &id).await?,
        snap,
        "rejections: state unchanged"
    );
    assert_eq!(
        summary(&env).await?,
        sum0,
        "rejections: counters and E unchanged"
    );
    // Minimum accepted gas: exactly the floor (55 Tgas) succeeds end to end.
    let r = withdraw_with(&env, &env.r.buyer, &id, 0, "BUYER", 1, 55).await?;
    let g = wd_gas(&r);
    assert_eq!(outcome_of(r)?, "PAID", "the floor is sufficient");
    reconcile(&env, 1, &holders).await?;
    println!("EVIDENCE lf009 rejections ok; withdraw at the 55 Tgas floor PAID {g}");
    Ok(())
}

#[tokio::test]
async fn lf009_duplicate_concurrent_withdraw_same_block() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let id = settled_agreement(&env, 1, &[(500_000_000, 0)]).await?;
    let b0 = balance(&env.token, env.r.buyer.id().as_str()).await?;
    let mk = || {
        env.r
            .buyer
            .call(env.escrow.id(), "withdraw")
            .args_json(json!({ "agreement_id": id, "line_id": 0, "beneficiary": "BUYER" }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(100))
    };
    let (a, b) = race(mk(), mk()).await?;
    let same = exec_block(&a) == exec_block(&b);
    let ok = [a.is_success(), b.is_success()];
    assert_eq!(
        ok.iter().filter(|x| **x).count(),
        1,
        "exactly one withdrawal of the same claim: {ok:?}"
    );
    let loser = if ok[0] { b } else { a };
    let msg = format!("{:?}", loser.into_result().expect_err("loser"));
    assert!(
        msg.contains("WithdrawalAlreadyPending") || msg.contains("NothingToWithdraw"),
        "{msg}"
    );
    assert_eq!(
        balance(&env.token, env.r.buyer.id().as_str()).await?,
        b0 + 500_000_000,
        "paid exactly once"
    );
    assert_eq!(outstanding(&env).await?, 0);
    reconcile(&env, 1, &holders).await?;
    println!(
        "EVIDENCE lf009 concurrent duplicate withdraw: one PAID, loser rejected; same_execution_block={same}"
    );
    Ok(())
}

#[tokio::test]
async fn lf009_three_lines_concurrent_independent_with_surplus() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let id = settled_agreement(
        &env,
        1,
        &[
            (100_000_000, 400_000_000),
            (300_000_000, 0),
            (50_000_000, 150_000_000),
        ],
    )
    .await?;
    // Legitimate surplus: a plain transfer (no message) is never credited.
    env.r
        .buyer
        .call(env.token.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": env.escrow.id(), "amount": "7777" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    reconcile_with_surplus(&env, 1, &holders, 7777).await?;
    let mut st = Vec::new();
    for (line, who, ben) in [
        (0u32, &env.r.buyer, "BUYER"),
        (0, &env.r.supplier, "SUPPLIER"),
        (1, &env.r.buyer, "BUYER"),
        (2, &env.r.buyer, "BUYER"),
        (2, &env.r.supplier, "SUPPLIER"),
    ] {
        st.push(
            who.call(env.escrow.id(), "withdraw")
                .args_json(json!({ "agreement_id": id, "line_id": line, "beneficiary": ben }))
                .deposit(NearToken::from_yoctonear(1))
                .gas(Gas::from_tgas(100))
                .transact_async()
                .await?,
        );
    }
    // Before every callback has landed, E still counts the pending amounts.
    let during = summary(&env).await?;
    let mut outcomes = Vec::new();
    for s in st {
        outcomes.push(outcome_of(s.await?)?);
    }
    assert!(outcomes.iter().all(|o| o == "PAID"), "{outcomes:?}");
    assert_eq!(outstanding(&env).await?, 0, "all claims paid");
    let l = &get_agreement(&env.escrow, &id).await?["lines"];
    assert_eq!(
        l[1]["supplier_withdrawal"], "EMPTY",
        "zero-value side never withdrawn"
    );
    assert_eq!(
        balance(&env.token, env.escrow.id().as_str()).await?,
        7777,
        "only the surplus remains"
    );
    reconcile_with_surplus(&env, 1, &holders, 7777).await?;
    let s = summary(&env).await?;
    assert_eq!(
        (
            s["open_withdrawals"].as_str(),
            s["last_withdrawal_id"].as_str()
        ),
        (Some("0"), Some("5"))
    );
    println!(
        "EVIDENCE lf009 five concurrent withdrawals over three lines all PAID; surplus 7777 untouched; mid-flight summary={during}"
    );
    Ok(())
}

#[tokio::test]
async fn lf009_u128_max_withdrawal() -> TestResult {
    let env = setup_with_supply(25, u128::MAX).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let (id, h) = agreed(&env, 1, 1, |t| {
        t["lines"][0]["principal"] = json!(u128::MAX.to_string());
    })
    .await?;
    let r = transfer_call(
        &env.r.buyer,
        &env.token,
        env.escrow.id().as_str(),
        u128::MAX,
        &msg(&id, 0, &h),
        None,
    )
    .await?;
    assert_eq!(used(&r), u128::MAX);
    settle_lines(&env, &id, &[(1, u128::MAX - 1)]).await?;
    assert_eq!(
        outcome_of(withdraw(&env, &env.r.supplier, &id, 0, "SUPPLIER").await?)?,
        "PAID"
    );
    assert_eq!(outstanding(&env).await?, 1);
    assert_eq!(
        balance(&env.token, env.r.supplier.id().as_str()).await?,
        u128::MAX - 1
    );
    assert_eq!(
        outcome_of(withdraw(&env, &env.r.buyer, &id, 0, "BUYER").await?)?,
        "PAID"
    );
    assert_eq!(outstanding(&env).await?, 0);
    reconcile(&env, 1, &holders).await?;
    println!("EVIDENCE lf009 u128::MAX principal withdrawn as (1, MAX-1); E 0; balances reconcile");
    Ok(())
}

fn starve_wasm() -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/near-starve/linefair_escrow.wasm");
    std::fs::read(&p).map_err(|e| format!(
        "missing {} ({e}); build with `scripts/build-artifacts.sh` (isolated target dir; never the shared-target starve command)",
        p.display()).into())
}

/// T040 / T067: a callback that cannot complete leaves the withdrawal PENDING
/// forever; nothing can change it; the transfer itself happened, so the
/// observed balance is E − A (an observation only, never acted on).
#[tokio::test]
async fn lf009_inconclusive_stays_pending_starve_build() -> TestResult {
    let worker = sandbox().await?;
    let r = roles(&worker).await?;
    let operator = worker
        .root_account()?
        .create_subaccount("operator")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    let token = deploy_token(&worker, &r.buyer).await?;
    let escrow = worker.dev_deploy(&starve_wasm()?).await?;
    escrow
        .call("new")
        .args_json(
            json!({ "network_id": "sandbox", "allowlisted_ft_id": token.id(),
        "operator_treasury_id": TREASURY, "max_agreements": 25, "creator_allowlist": CREATORS }),
        )
        .transact()
        .await?
        .into_result()?;
    for who in [
        escrow.id().as_str(),
        r.supplier.id().as_str(),
        r.stranger.id().as_str(),
    ] {
        register(&operator, &token, who).await?;
    }
    let env = Env {
        worker,
        token,
        escrow,
        r,
        operator,
        supply: SUPPLY,
    };
    let v: String = env.escrow.view("contract_version").await?.json()?;
    assert!(v.ends_with("+test-starve-callback"), "starve build: {v}");
    let id = settled_agreement(&env, 1, &[(0, 500_000_000)]).await?;
    let res = withdraw(&env, &env.r.supplier, &id, 0, "SUPPLIER").await?;
    let g = wd_gas(&res);
    let failed_receipts = res.receipt_failures().len();
    for (i, o) in res.receipt_outcomes().iter().enumerate() {
        println!(
            "STARVE receipt[{i}] executor={} gas={} success={} logs={:?}",
            o.executor_id,
            o.gas_burnt.as_gas(),
            o.is_success(),
            o.logs
        );
    }
    println!(
        "STARVE tx is_success={} failures={failed_receipts}",
        res.is_success()
    );
    assert!(failed_receipts >= 1, "the starved callback must fail");
    assert_eq!(
        balance(&env.token, env.r.supplier.id().as_str()).await?,
        500_000_000,
        "the transfer itself happened"
    );
    let w = wslot(&env, &id, 0, "SUPPLIER").await?;
    assert_eq!(
        (w["state"].as_str(), w["amount"].as_str()),
        (Some("PENDING"), Some("500000000")),
        "inconclusive stays PENDING"
    );
    let s = summary(&env).await?;
    assert_eq!(
        (
            s["outstanding_liabilities"].as_str(),
            s["open_withdrawals"].as_str()
        ),
        (Some("500000000"), Some("1")),
        "E still counts it"
    );
    let esc = balance(&env.token, env.escrow.id().as_str()).await?;
    assert_eq!(esc, 0, "observation: O = E - A (never used onchain)");
    // No path changes it: a new withdrawal is rejected, much later as well.
    assert_fails(
        withdraw(&env, &env.r.supplier, &id, 0, "SUPPLIER").await?,
        "ERR_LINE:WithdrawalAlreadyPending",
    );
    env.worker.fast_forward(500).await?;
    assert_fails(
        withdraw(&env, &env.r.supplier, &id, 0, "SUPPLIER").await?,
        "ERR_LINE:WithdrawalAlreadyPending",
    );
    assert_eq!(wslot(&env, &id, 0, "SUPPLIER").await?["state"], "PENDING");
    println!(
        "EVIDENCE lf009 inconclusive (starve build {v}): transfer done, callback failed ({failed_receipts} failed receipts), slot PENDING, E=500000000, O=0 {g}"
    );
    Ok(())
}

// ---- LF-010A creator allowlist (genuine sandbox) -------------------------------

#[tokio::test]
async fn allowlist_stranger_cannot_consume_slots() -> TestResult {
    let worker = sandbox().await?;
    let r = roles(&worker).await?;
    let c = deploy(&worker, 2).await?;
    let deadline = now_ns(&worker).await? + HOUR;
    let su = storage_usage(&c).await?;
    let state0 = c.view_state().await?;
    // 25 junk proposals from non-listed accounts: all rejected, nothing stored.
    for nonce in 0..25u64 {
        let who = [&r.stranger, &r.primary, &r.backup][nonce as usize % 3];
        let mut t = terms(&r, nonce + 100, deadline, 1);
        t["buyer_id"] = json!(who.id());
        let res = who
            .call(c.id(), "create_agreement")
            .args_json(json!({ "terms": t }))
            .max_gas()
            .transact()
            .await?;
        assert_fails(res, "ERR_CREATOR_NOT_ALLOWLISTED");
    }
    assert_eq!(
        storage_usage(&c).await?,
        su,
        "rejected creations: storage unchanged"
    );
    assert_eq!(
        c.view_state().await?,
        state0,
        "rejected creations: state byte-identical"
    );
    let cfg: Value = c.view("get_config").await?.json()?;
    assert_eq!(cfg["agreements_created"], "0", "no slot consumed");
    assert_eq!(cfg["creator_allowlist"], json!(CREATORS));
    // The listed buyer can still use every slot; the cap stays enforced.
    for nonce in 0..2u64 {
        r.buyer
            .call(c.id(), "create_agreement")
            .args_json(json!({ "terms": terms(&r, nonce, deadline, 1) }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    let res = r
        .buyer
        .call(c.id(), "create_agreement")
        .args_json(json!({ "terms": terms(&r, 9, deadline, 1) }))
        .max_gas()
        .transact()
        .await?;
    assert_fails(res, "ERR_AGREEMENT_CAP_REACHED");
    println!(
        "EVIDENCE lf010a 25 non-listed create attempts rejected, storage and state unchanged; listed buyer used 2/2 slots; cap enforced"
    );
    Ok(())
}

#[tokio::test]
async fn allowlist_init_validation_in_sandbox() -> TestResult {
    let worker = sandbox().await?;
    let c = worker.dev_deploy(&wasm()?).await?;
    let base = |list: Value| {
        json!({ "network_id": "sandbox", "allowlisted_ft_id": FT,
            "operator_treasury_id": TREASURY, "max_agreements": 5, "creator_allowlist": list })
    };
    let eleven: Vec<String> = (0..11).map(|i| format!("c{i}.test.near")).collect();
    for (list, code) in [
        (json!([]), "ERR_INIT_CREATOR_ALLOWLIST_SIZE"),
        (json!(eleven), "ERR_INIT_CREATOR_ALLOWLIST_SIZE"),
        (
            json!(["a.test.near", "a.test.near"]),
            "ERR_INIT_CREATOR_ALLOWLIST_DUPLICATE",
        ),
        (
            json!(["a.test.near", FT]),
            "ERR_INIT_CREATOR_ALLOWLIST_RESERVED",
        ),
        (
            json!(["a.test.near", TREASURY]),
            "ERR_INIT_CREATOR_ALLOWLIST_RESERVED",
        ),
        (json!([c.id()]), "ERR_INIT_CREATOR_ALLOWLIST_RESERVED"),
    ] {
        assert_fails(c.call("new").args_json(base(list)).transact().await?, code);
    }
    assert!(c.view("get_config").await.is_err(), "still uninitialised");
    // A malformed account id is rejected by argument parsing before init runs.
    let res = c
        .call("new")
        .args_json(base(json!(["NOT A VALID ID"])))
        .transact()
        .await?;
    assert!(res.is_failure(), "invalid account id must be rejected");
    assert!(c.view("get_config").await.is_err(), "still uninitialised");
    println!(
        "EVIDENCE lf010a init rejects empty, 11 entries, duplicate, FT, treasury, escrow, malformed id"
    );
    Ok(())
}

#[tokio::test]
async fn allowlist_full_flow_with_non_listed_roles() -> TestResult {
    // Only the buyer is listed. Supplier and arbitrators (not listed) keep every
    // existing right: accept, deliver, rule, withdraw.
    let worker = sandbox().await?;
    let r = roles(&worker).await?;
    let operator = worker
        .root_account()?
        .create_subaccount("operator")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    let token = deploy_token(&worker, &r.buyer).await?;
    let escrow = worker.dev_deploy(&wasm()?).await?;
    escrow
        .call("new")
        .args_json(json!({ "network_id": "sandbox", "allowlisted_ft_id": token.id(),
            "operator_treasury_id": TREASURY, "max_agreements": 25, "creator_allowlist": ["buyer.test.near"] }))
        .transact()
        .await?
        .into_result()?;
    for who in [
        escrow.id().as_str(),
        r.supplier.id().as_str(),
        r.stranger.id().as_str(),
    ] {
        register(&operator, &token, who).await?;
    }
    let env = Env {
        worker,
        token,
        escrow,
        r,
        operator,
        supply: SUPPLY,
    };
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    // The supplier (not listed) cannot create, even as buyer of its own terms.
    let deadline = now_ns(&env.worker).await? + HOUR;
    let mut t = terms(&env.r, 77, deadline, 1);
    t["ft_contract_id"] = json!(env.token.id());
    t["buyer_id"] = json!(env.r.supplier.id());
    let res = env
        .r
        .supplier
        .call(env.escrow.id(), "create_agreement")
        .args_json(json!({ "terms": t }))
        .max_gas()
        .transact()
        .await?;
    assert_fails(res, "ERR_CREATOR_NOT_ALLOWLISTED");
    let now = now_ns(&env.worker).await?;
    let (id, _h) = funded_agreement(&env, 1, 1, lf008_timing(now)).await?;
    line_call(
        &env.r.supplier,
        &env,
        "submit_delivery",
        json!({ "agreement_id": id, "line_id": 0, "evidence_commitment": EV }),
    )
    .await?
    .into_result()?;
    line_call(
        &env.r.buyer,
        &env,
        "open_dispute",
        json!({ "agreement_id": id, "line_id": 0 }),
    )
    .await?
    .into_result()?;
    let t0 = t0_of(&get_agreement(&env.escrow, &id).await?, 0);
    wait_until(&env, t0 + W).await?;
    ruling(&env, &env.r.primary, &id, 0, 100_000_000, 400_000_000)
        .await?
        .into_result()?;
    assert_eq!(
        outcome_of(withdraw(&env, &env.r.supplier, &id, 0, "SUPPLIER").await?)?,
        "PAID"
    );
    assert_eq!(
        outcome_of(withdraw(&env, &env.r.buyer, &id, 0, "BUYER").await?)?,
        "PAID"
    );
    assert_eq!(outstanding(&env).await?, 0);
    reconcile(&env, 1, &holders).await?;
    println!(
        "EVIDENCE lf010a non-listed supplier and arbitrator completed accept, deliver, ruling and withdrawal; non-listed create rejected"
    );
    Ok(())
}

// ---- LF-010 end-to-end lifecycle and adversarial scenarios (docs/29) -----------

/// Record a successful step's receipt for the evidence log.
fn step(log: &mut Vec<String>, name: &str, res: &ExecutionFinalResult) {
    log.push(format!("{name}: {}", receipt(res)));
}

/// The step must succeed; its receipt is logged (returns the result).
fn must_v(log: &mut Vec<String>, name: &str, res: ExecutionFinalResult) -> ExecutionFinalResult {
    step(log, name, &res);
    assert!(
        res.is_success(),
        "{name} failed: {:?}",
        res.clone().into_result().err()
    );
    res
}

/// The step must succeed; its receipt is logged.
fn must(log: &mut Vec<String>, name: &str, res: ExecutionFinalResult) {
    let _ = must_v(log, name, res);
}

fn print_log(test: &str, log: &[String]) {
    for l in log {
        println!("EVIDENCE lf010 {test} {l}");
    }
}

async fn submit_line(
    env: &Env,
    id: &str,
    line: u32,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error>> {
    line_call(
        &env.r.supplier,
        env,
        "submit_delivery",
        json!({ "agreement_id": id, "line_id": line, "evidence_commitment": EV }),
    )
    .await
}

#[tokio::test]
async fn lf010_three_line_all_paths() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let mut log = Vec::new();
    // The supplier starts unregistered on the token (balance 0) to force one definite failure.
    must(
        &mut log,
        "supplier storage_unregister",
        env.r
            .supplier
            .call(env.token.id(), "storage_unregister")
            .args_json(json!({}))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?,
    );
    let b0 = balance(&env.token, env.r.buyer.id().as_str()).await?;
    let now = now_ns(&env.worker).await?;
    let (id, _h) = funded_agreement(&env, 1, 3, lf008_timing(now)).await?;
    reconcile(&env, 1, &holders).await?;
    for line in [0u32, 1] {
        must(
            &mut log,
            &format!("submit line {line}"),
            submit_line(&env, &id, line).await?,
        );
    }
    // Line 0: buyer accepts; first payout fails (unregistered), retry after registration.
    must(
        &mut log,
        "accept_line 0",
        line_call(
            &env.r.buyer,
            &env,
            "accept_line",
            json!({ "agreement_id": id, "line_id": 0 }),
        )
        .await?,
    );
    let r = must_v(
        &mut log,
        "withdraw line 0 SUPPLIER (unregistered)",
        withdraw(&env, &env.r.supplier, &id, 0, "SUPPLIER").await?,
    );
    assert_eq!(outcome_of(r)?, "FAILED");
    assert_eq!(
        get_agreement(&env.escrow, &id).await?["lines"][0]["supplier_claimable"],
        "500000000",
        "restored once"
    );
    reconcile(&env, 1, &holders).await?;
    register(&env.operator, &env.token, env.r.supplier.id().as_str()).await?;
    let r = must_v(
        &mut log,
        "withdraw line 0 SUPPLIER retry",
        withdraw(&env, &env.r.supplier, &id, 0, "SUPPLIER").await?,
    );
    assert_eq!(outcome_of(r)?, "PAID");
    let w = wslot(&env, &id, 0, "SUPPLIER").await?;
    assert_eq!(
        (
            w["state"].as_str(),
            w["withdrawal_id"].as_str(),
            w["epoch"].as_u64()
        ),
        (Some("PAID"), Some("2"), Some(2)),
        "retry has a new id"
    );
    reconcile(&env, 1, &holders).await?;
    // Line 1: buyer dispute, proposal, counter-proposal, exact acceptance, both withdraw.
    must(
        &mut log,
        "open_dispute 1",
        line_call(
            &env.r.buyer,
            &env,
            "open_dispute",
            json!({ "agreement_id": id, "line_id": 1 }),
        )
        .await?,
    );
    must(
        &mut log,
        "propose 1 buyer",
        propose(&env, &env.r.buyer, &id, 1, 100_000_000, 200_000_000).await?,
    );
    must(
        &mut log,
        "propose 1 supplier",
        propose(&env, &env.r.supplier, &id, 1, 50_000_000, 250_000_000).await?,
    );
    assert_fails(
        accept(&env, &env.r.supplier, &id, 1, 1, 100_000_000, 200_000_000).await?,
        "ERR_LINE:StaleProposal",
    );
    must(
        &mut log,
        "accept_split 1",
        accept(&env, &env.r.buyer, &id, 1, 2, 50_000_000, 250_000_000).await?,
    );
    for (who, ben) in [(&env.r.buyer, "BUYER"), (&env.r.supplier, "SUPPLIER")] {
        let r = must_v(
            &mut log,
            &format!("withdraw line 1 {ben}"),
            withdraw(&env, who, &id, 1, ben).await?,
        );
        assert_eq!(outcome_of(r)?, "PAID");
        reconcile(&env, 1, &holders).await?;
    }
    // Line 2: never delivered → NON_DELIVERY → primary ruling → both withdraw.
    let t0 = now + 90 * SEC;
    wait_until(&env, t0).await?;
    must(
        &mut log,
        "advance_case 2 (stranger)",
        advance(&env, &env.r.stranger, &id, 2).await?,
    );
    assert_eq!(t0_of(&get_agreement(&env.escrow, &id).await?, 2), t0);
    wait_until(&env, t0 + W).await?;
    must(
        &mut log,
        "submit_ruling 2 primary",
        ruling(&env, &env.r.primary, &id, 2, 150_000_000, 50_000_000).await?,
    );
    for (who, ben) in [(&env.r.buyer, "BUYER"), (&env.r.supplier, "SUPPLIER")] {
        let r = must_v(
            &mut log,
            &format!("withdraw line 2 {ben}"),
            withdraw(&env, who, &id, 2, ben).await?,
        );
        assert_eq!(outcome_of(r)?, "PAID");
        reconcile(&env, 1, &holders).await?;
    }
    // Final accounting: everything paid exactly as allocated.
    assert_eq!(outstanding(&env).await?, 0);
    assert_eq!(balance(&env.token, env.escrow.id().as_str()).await?, 0);
    assert_eq!(
        balance(&env.token, env.r.supplier.id().as_str()).await?,
        500_000_000 + 250_000_000 + 50_000_000
    );
    assert_eq!(
        balance(&env.token, env.r.buyer.id().as_str()).await?,
        b0 - 1_000_000_000 + 50_000_000 + 150_000_000
    );
    let s = summary(&env).await?;
    assert_eq!(
        (
            s["open_withdrawals"].as_str(),
            s["last_withdrawal_id"].as_str()
        ),
        (Some("0"), Some("6"))
    );
    reconcile(&env, 1, &holders).await?;
    print_log("three_line_all_paths", &log);
    println!(
        "EVIDENCE lf010 three_line_all_paths final: E=0 escrow_balance=0 supplier=800000000 buyer_delta=-800000000 withdrawals=6 (1 FAILED+restored, 5 PAID)"
    );
    Ok(())
}

#[tokio::test]
async fn lf010_silence_backup_fallback() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let mut log = Vec::new();
    let now = now_ns(&env.worker).await?;
    let (id, _h) = funded_agreement(&env, 1, 2, lf008_timing(now)).await?;
    for line in [0u32, 1] {
        must(
            &mut log,
            &format!("submit line {line}"),
            submit_line(&env, &id, line).await?,
        );
    }
    // Buyer silent: after the review window both lines go NO_RESPONSE.
    let v = get_agreement(&env.escrow, &id).await?;
    let sub = |l: usize| -> u64 {
        v["lines"][l]["submitted_at_ns"]
            .as_str()
            .expect("s")
            .parse()
            .expect("u64")
    };
    let (t0a, t0b) = (sub(0) + 60 * SEC, sub(1) + 60 * SEC);
    wait_until(&env, t0b).await?;
    for line in [0u32, 1] {
        must(
            &mut log,
            &format!("advance_case {line} (supplier)"),
            advance(&env, &env.r.supplier, &id, line).await?,
        );
    }
    // Primary silent; backup rules line 0 in its window.
    wait_until(&env, t0a.max(t0b) + 2 * W).await?;
    assert_eq!(phase(&env, &id, 0).await?, "BACKUP");
    assert_fails(
        ruling(&env, &env.r.primary, &id, 0, 0, 500_000_000).await?,
        "ERR_LINE:NotRulingWindow",
    );
    must(
        &mut log,
        "submit_ruling 0 backup",
        ruling(&env, &env.r.backup, &id, 0, 0, 500_000_000).await?,
    );
    // Everyone silent on line 1: deterministic fallback (terms bps 6 000 / 4 000).
    wait_until(&env, t0b + 3 * W).await?;
    must(
        &mut log,
        "trigger_fallback 1 (stranger)",
        fallback(&env, &env.r.stranger, &id, 1).await?,
    );
    let l1 = &get_agreement(&env.escrow, &id).await?["lines"][1];
    assert_eq!(
        (
            l1["buyer_claimable"].as_str(),
            l1["supplier_claimable"].as_str()
        ),
        (Some("180000000"), Some("120000000"))
    );
    for (line, who, ben) in [
        (0u32, &env.r.supplier, "SUPPLIER"),
        (1, &env.r.buyer, "BUYER"),
        (1, &env.r.supplier, "SUPPLIER"),
    ] {
        let r = must_v(
            &mut log,
            &format!("withdraw line {line} {ben}"),
            withdraw(&env, who, &id, line, ben).await?,
        );
        assert_eq!(outcome_of(r)?, "PAID");
        reconcile(&env, 1, &holders).await?;
    }
    assert_eq!(outstanding(&env).await?, 0);
    print_log("silence_backup_fallback", &log);
    Ok(())
}

#[tokio::test]
async fn lf010_two_agreements_isolation() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let mut log = Vec::new();
    let (a, _) = funded_agreement(&env, 1, 2, |_| {}).await?;
    let (b, _) = funded_agreement(&env, 2, 1, |_| {}).await?;
    reconcile(&env, 2, &holders).await?;
    // (agreement, signer, method, args) — interleaved; after each step the
    // other agreement's full view must be byte-identical.
    let ops: Vec<(&str, &Account, &str, Value)> = vec![
        (
            &a,
            &env.r.supplier,
            "submit_delivery",
            json!({ "agreement_id": a, "line_id": 0, "evidence_commitment": EV }),
        ),
        (
            &b,
            &env.r.supplier,
            "submit_delivery",
            json!({ "agreement_id": b, "line_id": 0, "evidence_commitment": EV }),
        ),
        (
            &b,
            &env.r.buyer,
            "open_dispute",
            json!({ "agreement_id": b, "line_id": 0 }),
        ),
        (
            &a,
            &env.r.buyer,
            "accept_line",
            json!({ "agreement_id": a, "line_id": 0 }),
        ),
        (
            &b,
            &env.r.supplier,
            "propose_split",
            json!({ "agreement_id": b, "line_id": 0, "buyer_amount": "100000000", "supplier_amount": "400000000" }),
        ),
        (
            &a,
            &env.r.supplier,
            "submit_delivery",
            json!({ "agreement_id": a, "line_id": 1, "evidence_commitment": EV }),
        ),
        (
            &b,
            &env.r.buyer,
            "accept_split",
            json!({ "agreement_id": b, "line_id": 0, "proposal_id": "1", "buyer_amount": "100000000", "supplier_amount": "400000000" }),
        ),
        (
            &a,
            &env.r.buyer,
            "accept_line",
            json!({ "agreement_id": a, "line_id": 1 }),
        ),
    ];
    for (k, (x, who, method, args)) in ops.into_iter().enumerate() {
        let other = if x == a.as_str() {
            b.as_str()
        } else {
            a.as_str()
        };
        let before = get_agreement(&env.escrow, other).await?;
        must(
            &mut log,
            &format!("op{k} {method} on {x}"),
            line_call(who, &env, method, args).await?,
        );
        assert_eq!(
            get_agreement(&env.escrow, other).await?,
            before,
            "op{k} {method} on {x} changed {other}"
        );
        reconcile(&env, 2, &holders).await?;
    }
    for (x, line, who, ben) in [
        (&a, 0u32, &env.r.supplier, "SUPPLIER"),
        (&b, 0, &env.r.buyer, "BUYER"),
        (&a, 1, &env.r.supplier, "SUPPLIER"),
        (&b, 0, &env.r.supplier, "SUPPLIER"),
    ] {
        let other = if x.as_str() == a.as_str() {
            b.as_str()
        } else {
            a.as_str()
        };
        let before = get_agreement(&env.escrow, other).await?;
        let r = must_v(
            &mut log,
            &format!("withdraw {x} line {line} {ben}"),
            withdraw(&env, who, x, line, ben).await?,
        );
        assert_eq!(outcome_of(r)?, "PAID");
        assert_eq!(
            get_agreement(&env.escrow, other).await?,
            before,
            "withdraw on {x} changed {other}"
        );
        reconcile(&env, 2, &holders).await?;
    }
    assert_eq!(outstanding(&env).await?, 0);
    print_log("two_agreements_isolation", &log);
    Ok(())
}

#[tokio::test]
async fn lf010_inconclusive_with_other_lines_live() -> TestResult {
    // Starve build: every withdrawal callback starves. One frozen PENDING
    // withdrawal must not disturb any other line or agreement.
    let worker = sandbox().await?;
    let r = roles(&worker).await?;
    let operator = worker
        .root_account()?
        .create_subaccount("operator")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    let token = deploy_token(&worker, &r.buyer).await?;
    let escrow = worker.dev_deploy(&starve_wasm()?).await?;
    escrow
        .call("new")
        .args_json(
            json!({ "network_id": "sandbox", "allowlisted_ft_id": token.id(),
        "operator_treasury_id": TREASURY, "max_agreements": 25, "creator_allowlist": CREATORS }),
        )
        .transact()
        .await?
        .into_result()?;
    for who in [
        escrow.id().as_str(),
        r.supplier.id().as_str(),
        r.stranger.id().as_str(),
    ] {
        register(&operator, &token, who).await?;
    }
    let env = Env {
        worker,
        token,
        escrow,
        r,
        operator,
        supply: SUPPLY,
    };
    let mut log = Vec::new();
    let (a, _) = funded_agreement(&env, 1, 2, |_| {}).await?;
    let (b, _) = funded_agreement(&env, 2, 1, |_| {}).await?;
    must(&mut log, "A submit 0", submit_line(&env, &a, 0).await?);
    must(
        &mut log,
        "A accept 0",
        line_call(
            &env.r.buyer,
            &env,
            "accept_line",
            json!({ "agreement_id": a, "line_id": 0 }),
        )
        .await?,
    );
    let frozen = withdraw(&env, &env.r.supplier, &a, 0, "SUPPLIER").await?;
    step(
        &mut log,
        "A withdraw 0 SUPPLIER (starved callback)",
        &frozen,
    );
    assert!(frozen.is_failure(), "starved callback fails the tx");
    let slot0 = wslot(&env, &a, 0, "SUPPLIER").await?;
    assert_eq!(slot0["state"], "PENDING");
    // Everything else keeps working: settlement on A line 1, acceptance on B.
    must(&mut log, "A submit 1", submit_line(&env, &a, 1).await?);
    must(
        &mut log,
        "A dispute 1",
        line_call(
            &env.r.buyer,
            &env,
            "open_dispute",
            json!({ "agreement_id": a, "line_id": 1 }),
        )
        .await?,
    );
    let p: String = must_v(
        &mut log,
        "A propose 1",
        propose(&env, &env.r.buyer, &a, 1, 100_000_000, 200_000_000).await?,
    )
    .json()?;
    must(
        &mut log,
        "A accept_split 1",
        accept(
            &env,
            &env.r.supplier,
            &a,
            1,
            p.parse()?,
            100_000_000,
            200_000_000,
        )
        .await?,
    );
    must(&mut log, "B submit 0", submit_line(&env, &b, 0).await?);
    must(
        &mut log,
        "B accept 0",
        line_call(
            &env.r.buyer,
            &env,
            "accept_line",
            json!({ "agreement_id": b, "line_id": 0 }),
        )
        .await?,
    );
    assert_eq!(
        wslot(&env, &a, 0, "SUPPLIER").await?,
        slot0,
        "frozen slot untouched by other activity"
    );
    assert_fails(
        withdraw(&env, &env.r.supplier, &a, 0, "SUPPLIER").await?,
        "ERR_LINE:WithdrawalAlreadyPending",
    );
    // E still counts the frozen 500 M; the token balance shows it left (observation only).
    let e = outstanding(&env).await?;
    assert_eq!(
        e,
        500_000_000 + 300_000_000 + 500_000_000,
        "E = all allocations, incl. the frozen pending"
    );
    assert_eq!(
        balance(&env.token, env.escrow.id().as_str()).await?,
        e - 500_000_000,
        "observation: O = E - frozen A"
    );
    assert_eq!(summary(&env).await?["open_withdrawals"], "1");
    print_log("inconclusive_with_other_lines_live", &log);
    Ok(())
}

#[tokio::test]
async fn lf010_cap_and_worst_case_storage() -> TestResult {
    // Longest possible account ids (64 chars) for all roles and the FT id, 3 lines,
    // 25 agreements: measure real storage against the 4 096 B cap and the budget.
    let worker = sandbox().await?;
    let root = worker.root_account()?;
    let mk = |c: char| std::iter::repeat_n(c, 54).collect::<String>();
    let mut made = Vec::new();
    for c in ['b', 's', 'p', 'k', 'x'] {
        made.push(
            root.create_subaccount(&mk(c))
                .initial_balance(NearToken::from_near(10))
                .transact()
                .await?
                .into_result()?,
        );
    }
    let [buyer, supplier, primary, backup, stranger]: [Account; 5] =
        made.try_into().map_err(|_| "five")?;
    assert_eq!(buyer.id().as_str().len(), 64);
    let r = Roles {
        buyer,
        supplier,
        primary,
        backup,
        stranger,
    };
    let long_ft = format!("{}.test.near", mk('f'));
    let c = worker.dev_deploy(&wasm()?).await?;
    c.call("new").args_json(json!({ "network_id": "sandbox", "allowlisted_ft_id": long_ft,
        "operator_treasury_id": TREASURY, "max_agreements": 25, "creator_allowlist": [r.buyer.id()] })).transact().await?.into_result()?;
    let su0 = storage_usage(&c).await?;
    let deadline = now_ns(&worker).await? + HOUR;
    let mut max_delta = 0u64;
    for nonce in 0..25u64 {
        let mut t = terms(&r, nonce, deadline, 3);
        t["ft_contract_id"] = json!(long_ft);
        let before = storage_usage(&c).await?;
        r.buyer
            .call(c.id(), "create_agreement")
            .args_json(json!({ "terms": t }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        let d = storage_usage(&c).await? - before;
        assert!(d <= 4_096, "agreement {nonce}: {d} B > cap");
        max_delta = max_delta.max(d);
    }
    let total = storage_usage(&c).await?;
    let mut t = terms(&r, 99, deadline, 3);
    t["ft_contract_id"] = json!(long_ft);
    let res = r
        .buyer
        .call(c.id(), "create_agreement")
        .args_json(json!({ "terms": t }))
        .max_gas()
        .transact()
        .await?;
    assert_fails(res, "ERR_AGREEMENT_CAP_REACHED");
    assert_eq!(storage_usage(&c).await?, total, "cap rejection atomic");
    // Acceptances only flip pre-allocated flags.
    let h = get_agreement(&c, "0").await?["terms_hash"]
        .as_str()
        .expect("h")
        .to_string();
    let before = storage_usage(&c).await?;
    r.supplier
        .call(c.id(), "accept_terms")
        .args_json(json!({ "agreement_id": "0", "terms_hash": h }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        storage_usage(&c).await?,
        before,
        "accept_terms storage delta 0"
    );
    let near = |b: u64| b as f64 * 1e19 / 1e24;
    println!(
        "EVIDENCE lf010 worst_case_storage init={su0} B ({:.4} NEAR) max_agreement_delta={max_delta} B (cap 4096) 25_agreements_total={} B ({:.4} NEAR) contract_total={total} B ({:.4} NEAR at 1e19 yocto/B)",
        near(su0),
        total - su0,
        near(total - su0),
        near(total)
    );
    Ok(())
}

#[tokio::test]
async fn lf010_replay_every_tx() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    let deadline = now_ns(&env.worker).await? + HOUR;
    let mut t = terms(&env.r, 1, deadline, 1);
    t["ft_contract_id"] = json!(env.token.id());
    // (signer, receiver, method, args, deposit yocto) of every successful step.
    let mut done: Vec<(Account, String, String, Value, u128)> = Vec::new();
    let run = |who: &Account, to: &str, m: &str, a: Value, d: u128| {
        (who.clone(), to.to_string(), m.to_string(), a, d)
    };
    let s = run(
        &env.r.buyer,
        env.escrow.id().as_str(),
        "create_agreement",
        json!({ "terms": t }),
        0,
    );
    let id: String = env
        .r
        .buyer
        .call(env.escrow.id(), "create_agreement")
        .args_json(&s.3)
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    done.push(s);
    let h = get_agreement(&env.escrow, &id).await?["terms_hash"]
        .as_str()
        .expect("h")
        .to_string();
    for (who, m) in [
        (&env.r.buyer, "accept_terms"),
        (&env.r.supplier, "accept_terms"),
        (&env.r.primary, "accept_appointment"),
        (&env.r.backup, "accept_appointment"),
    ] {
        let s = run(
            who,
            env.escrow.id().as_str(),
            m,
            json!({ "agreement_id": id, "terms_hash": h }),
            0,
        );
        who.call(env.escrow.id(), m)
            .args_json(&s.3)
            .transact()
            .await?
            .into_result()?;
        done.push(s);
    }
    let fund =
        json!({ "receiver_id": env.escrow.id(), "amount": "500000000", "msg": msg(&id, 0, &h) });
    let r = env
        .r
        .buyer
        .call(env.token.id(), "ft_transfer_call")
        .args_json(&fund)
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert_eq!(used(&r), 500_000_000);
    let steps = [
        (
            env.r.supplier.clone(),
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": 0, "evidence_commitment": EV }),
            0u128,
        ),
        (
            env.r.buyer.clone(),
            "accept_line",
            json!({ "agreement_id": id, "line_id": 0 }),
            0,
        ),
        (
            env.r.supplier.clone(),
            "withdraw",
            json!({ "agreement_id": id, "line_id": 0, "beneficiary": "SUPPLIER" }),
            1,
        ),
    ];
    for (who, m, a, d) in steps {
        let mut c = who
            .call(env.escrow.id(), m)
            .args_json(&a)
            .gas(Gas::from_tgas(100));
        if d > 0 {
            c = c.deposit(NearToken::from_yoctonear(d));
        }
        c.transact().await?.into_result()?;
        done.push(run(&who, env.escrow.id().as_str(), m, a, d));
    }
    reconcile(&env, 1, &holders).await?;
    // Snapshot, then replay everything (incl. the funding transfer and a stale callback).
    let snap = (
        get_agreement(&env.escrow, &id).await?,
        summary(&env).await?,
        balance(&env.token, env.r.supplier.id().as_str()).await?,
        balance(&env.token, env.r.buyer.id().as_str()).await?,
    );
    let mut codes = Vec::new();
    for (who, to, m, a, d) in &done {
        let mut c = who
            .call(&to.parse()?, m)
            .args_json(a)
            .gas(Gas::from_tgas(100));
        if *d > 0 {
            c = c.deposit(NearToken::from_yoctonear(*d));
        }
        let res = c.transact().await?;
        assert!(res.is_failure(), "replay of {m} must be rejected");
        let msg = format!("{:?}", res.into_result().expect_err("failure"));
        codes.push(format!("{m}={}", err_codes(&msg).join("+")));
    }
    let r = env
        .r
        .buyer
        .call(env.token.id(), "ft_transfer_call")
        .args_json(&fund)
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert_eq!(used(&r), 0, "replayed funding is fully refunded");
    let res = env.r.stranger.call(env.escrow.id(), "on_withdrawal_transfer")
        .args_json(json!({ "agreement_id": id, "line_id": 0, "beneficiary": "SUPPLIER", "withdrawal_id": "1", "epoch": 1 })).max_gas().transact().await?;
    assert_fails(res, "private");
    let after = (
        get_agreement(&env.escrow, &id).await?,
        summary(&env).await?,
        balance(&env.token, env.r.supplier.id().as_str()).await?,
        balance(&env.token, env.r.buyer.id().as_str()).await?,
    );
    assert_eq!(after, snap, "replays changed state or balances");
    reconcile(&env, 1, &holders).await?;
    println!(
        "EVIDENCE lf010 replay_every_tx all rejected, state and balances unchanged: {}; ft_transfer_call refunded; stale callback rejected (private)",
        codes.join(" ")
    );
    Ok(())
}

#[tokio::test]
async fn lf010_deposit_and_gas_abuse() -> TestResult {
    let env = setup(25).await?;
    let id = disputed_agreement(&env, 1, 1).await?;
    let snap = get_agreement(&env.escrow, &id).await?;
    let su = storage_usage(&env.escrow).await?;
    let deadline = now_ns(&env.worker).await? + HOUR;
    let mut t = terms(&env.r, 5, deadline, 1);
    t["ft_contract_id"] = json!(env.token.id());
    let cases: Vec<(&Account, &str, Value)> = vec![
        (&env.r.buyer, "create_agreement", json!({ "terms": t })),
        (
            &env.r.buyer,
            "accept_terms",
            json!({ "agreement_id": id, "terms_hash": "00".repeat(32) }),
        ),
        (
            &env.r.primary,
            "accept_appointment",
            json!({ "agreement_id": id, "terms_hash": "00".repeat(32) }),
        ),
        (
            &env.r.supplier,
            "submit_delivery",
            json!({ "agreement_id": id, "line_id": 0, "evidence_commitment": EV }),
        ),
        (
            &env.r.buyer,
            "accept_line",
            json!({ "agreement_id": id, "line_id": 0 }),
        ),
        (
            &env.r.buyer,
            "open_dispute",
            json!({ "agreement_id": id, "line_id": 0 }),
        ),
        (
            &env.r.stranger,
            "advance_case",
            json!({ "agreement_id": id, "line_id": 0 }),
        ),
        (
            &env.r.buyer,
            "propose_split",
            json!({ "agreement_id": id, "line_id": 0, "buyer_amount": "1", "supplier_amount": "499999999" }),
        ),
        (
            &env.r.supplier,
            "accept_split",
            json!({ "agreement_id": id, "line_id": 0, "proposal_id": "1", "buyer_amount": "1", "supplier_amount": "499999999" }),
        ),
        (
            &env.r.primary,
            "submit_ruling",
            json!({ "agreement_id": id, "line_id": 0, "buyer_amount": "1", "supplier_amount": "499999999" }),
        ),
        (
            &env.r.stranger,
            "trigger_fallback",
            json!({ "agreement_id": id, "line_id": 0 }),
        ),
    ];
    for (who, m, a) in &cases {
        let res = who
            .call(env.escrow.id(), m)
            .args_json(a)
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?;
        assert_fails(res, "doesn't accept deposit");
    }
    // Withdraw: wrong deposits and gas below the floor; create with tiny gas.
    for (y, g, code) in [
        (0u128, 100u64, "ERR_WITHDRAW:DepositMustBeOneYocto"),
        (2, 100, "ERR_WITHDRAW:DepositMustBeOneYocto"),
        (1, 54, "ERR_WITHDRAW:InsufficientGas"),
    ] {
        assert_fails(
            withdraw_with(&env, &env.r.buyer, &id, 0, "BUYER", y, g).await?,
            code,
        );
    }
    let res = env
        .r
        .buyer
        .call(env.escrow.id(), "create_agreement")
        .args_json(&cases[0].2)
        .gas(Gas::from_ggas(300))
        .transact()
        .await?;
    assert!(
        res.is_failure(),
        "create with 0.3 Tgas must fail (2 Tgas was measured to be enough)"
    );
    assert_eq!(
        get_agreement(&env.escrow, &id).await?,
        snap,
        "abuse: agreement unchanged"
    );
    assert_eq!(
        storage_usage(&env.escrow).await?,
        su,
        "abuse: storage unchanged"
    );
    assert_eq!(
        env.escrow.view("get_config").await?.json::<Value>()?["agreements_created"],
        "1"
    );
    println!(
        "EVIDENCE lf010 deposit_and_gas_abuse: 11 non-payable methods reject 1 yocto; withdraw 0/2 yocto and 54 Tgas rejected; create at 0.3 Tgas fails (2 Tgas measured sufficient); state and storage unchanged"
    );
    Ok(())
}

/// Mirror of the unit-level `mx_expected` oracle (src/lib.rs) for the states
/// exercised on chain. `None` = success (not executed here: it would mutate).
fn chain_mx_expected(allocated: bool, method: &str, caller: &str) -> Option<&'static str> {
    let (b, s, p, k) = (
        "buyer.test.near",
        "supplier.test.near",
        "primary.test.near",
        "backup.test.near",
    );
    let party = caller == b || caller == s;
    match method {
        "submit_delivery" => Some(if caller == s {
            "ERR_LINE:WrongState"
        } else {
            "ERR_LINE:NotAuthorized"
        }),
        "accept_line" | "open_dispute" => Some(if caller == b {
            "ERR_LINE:WrongState"
        } else {
            "ERR_LINE:NotAuthorized"
        }),
        "advance_case" => Some("ERR_LINE:NotAdvanceable"),
        "propose_split" | "accept_split" => {
            if !party {
                Some("ERR_LINE:NotAuthorized")
            } else if allocated {
                Some("ERR_LINE:AlreadyFinalized")
            } else if method == "accept_split" {
                Some("ERR_LINE:NoActiveProposal")
            } else {
                None
            }
        }
        "submit_ruling" => {
            if caller != p && caller != k {
                Some("ERR_LINE:NotAuthorized")
            } else if allocated {
                Some("ERR_LINE:AlreadyFinalized")
            } else if caller == p {
                None
            } else {
                Some("ERR_LINE:NotRulingWindow")
            }
        }
        "trigger_fallback" => Some(if allocated {
            "ERR_LINE:AlreadyFinalized"
        } else {
            "ERR_LINE:FallbackNotEligible"
        }),
        _ => {
            let me = if method == "withdraw_BUYER" { b } else { s };
            if caller != me {
                Some("ERR_LINE:NotAuthorized")
            } else if !allocated {
                Some("ERR_LINE:WrongState")
            } else {
                None
            }
        }
    }
}

#[tokio::test]
async fn lf010_matrix_rejections_on_chain() -> TestResult {
    let env = setup(25).await?;
    // State 1: DISPUTED in the primary window. State 2: ALLOCATED (mutual).
    let primary_id = disputed_agreement(&env, 1, 1).await?;
    let t0 = t0_of(&get_agreement(&env.escrow, &primary_id).await?, 0);
    let alloc_id = disputed_agreement(&env, 2, 1).await?;
    let p: String = propose(&env, &env.r.buyer, &alloc_id, 0, 200_000_000, 300_000_000)
        .await?
        .into_result()?
        .json()?;
    accept(
        &env,
        &env.r.supplier,
        &alloc_id,
        0,
        p.parse()?,
        200_000_000,
        300_000_000,
    )
    .await?
    .into_result()?;
    wait_until(&env, t0 + W).await?;
    let callers = [
        &env.r.buyer,
        &env.r.supplier,
        &env.r.primary,
        &env.r.backup,
        &env.r.stranger,
    ];
    let methods = [
        "submit_delivery",
        "accept_line",
        "open_dispute",
        "advance_case",
        "propose_split",
        "accept_split",
        "submit_ruling",
        "trigger_fallback",
        "withdraw_BUYER",
        "withdraw_SUPPLIER",
    ];
    let (mut checked, mut skipped) = (0, 0);
    for (allocated, id) in [(false, primary_id.as_str()), (true, alloc_id.as_str())] {
        assert_eq!(phase(&env, &primary_id, 0).await?, "PRIMARY");
        for method in methods {
            for who in callers {
                let Some(want) = chain_mx_expected(allocated, method, who.id().as_str()) else {
                    skipped += 1;
                    continue;
                };
                let before = (get_agreement(&env.escrow, id).await?, summary(&env).await?);
                let res = if let Some(ben) = method.strip_prefix("withdraw_") {
                    withdraw(&env, who, id, 0, ben).await?
                } else {
                    let args = match method {
                        "submit_delivery" => {
                            json!({ "agreement_id": id, "line_id": 0, "evidence_commitment": EV })
                        }
                        "propose_split" | "submit_ruling" => {
                            json!({ "agreement_id": id, "line_id": 0, "buyer_amount": "200000000", "supplier_amount": "300000000" })
                        }
                        "accept_split" => {
                            json!({ "agreement_id": id, "line_id": 0, "proposal_id": "1", "buyer_amount": "200000000", "supplier_amount": "300000000" })
                        }
                        _ => json!({ "agreement_id": id, "line_id": 0 }),
                    };
                    line_call(who, &env, method, args).await?
                };
                let msg = format!("{:?}", res.clone().into_result().err());
                assert!(
                    res.is_failure(),
                    "{method} by {} (allocated={allocated}) must be rejected",
                    who.id()
                );
                assert_eq!(
                    err_codes(&msg),
                    vec![want.to_string()],
                    "{method} by {} (allocated={allocated})",
                    who.id()
                );
                assert_eq!(
                    (get_agreement(&env.escrow, id).await?, summary(&env).await?),
                    before,
                    "{method} by {}: state changed",
                    who.id()
                );
                println!(
                    "CHAIN_MATRIX allocated={allocated},{method},{},{want}",
                    who.id()
                );
                checked += 1;
            }
        }
    }
    println!(
        "EVIDENCE lf010 matrix_rejections_on_chain checked={checked} skipped_success_cells={skipped} (exact codes, state unchanged)"
    );
    Ok(())
}

// ---- F3 funding guard with the genuine token -------------------------------------

#[tokio::test]
async fn f3_late_deposit_refunded_zero_liability() -> TestResult {
    let env = setup(25).await?;
    let holders = [
        env.r.buyer.id().as_str(),
        env.r.supplier.id().as_str(),
        env.r.stranger.id().as_str(),
    ];
    // short_timing: acceptance +30 s, funding +40 s, delivery +90 s, review 60 s
    // → F3 limit = now + 30 s; the funding deadline (+40 s) is later.
    let now = now_ns(&env.worker).await?;
    let (id, h) = agreed(&env, 1, 2, short_timing(now)).await?;
    let limit = now + 30 * SEC;
    // On time: line 0 is credited.
    let r = transfer_call(
        &env.r.buyer,
        &env.token,
        env.escrow.id().as_str(),
        500_000_000,
        &msg(&id, 0, &h),
        None,
    )
    .await?;
    assert_eq!(used(&r), 500_000_000);
    reconcile(&env, 1, &holders).await?;
    // Past the F3 limit but before the funding deadline: refunded in full.
    wait_until(&env, limit + SEC).await?;
    assert!(
        now_ns(&env.worker).await? < now + 40 * SEC,
        "still before the funding deadline"
    );
    let before = (
        get_agreement(&env.escrow, &id).await?,
        outstanding(&env).await?,
        balance(&env.token, env.r.buyer.id().as_str()).await?,
        balance(&env.token, env.escrow.id().as_str()).await?,
        env.escrow.view("get_config").await?.json::<Value>()?["agreements_created"].clone(),
    );
    let r = transfer_call(
        &env.r.buyer,
        &env.token,
        env.escrow.id().as_str(),
        300_000_000,
        &msg(&id, 1, &h),
        None,
    )
    .await?;
    let rc = receipt(&r);
    assert!(
        has_log(&r, "DeliveryTimeTooShort"),
        "refund code logged: {:?}",
        r.logs()
    );
    assert_eq!(used(&r), 0, "nothing credited");
    let after = (
        get_agreement(&env.escrow, &id).await?,
        outstanding(&env).await?,
        balance(&env.token, env.r.buyer.id().as_str()).await?,
        balance(&env.token, env.escrow.id().as_str()).await?,
        env.escrow.view("get_config").await?.json::<Value>()?["agreements_created"].clone(),
    );
    assert_eq!(
        after, before,
        "late deposit: agreement, E, buyer and escrow balances, capacity unchanged"
    );
    assert_eq!(line_status(&after.0, 1), "UNFUNDED");
    reconcile(&env, 1, &holders).await?;
    // The on-time line keeps its unchanged lifecycle (deadlines not extended).
    let l0 = &after.0["lines"][0];
    assert_eq!(l0["status"], "FUNDED");
    assert_eq!(
        after.0["terms"]["lines"][0]["delivery_deadline_ns"],
        json!((now + 90 * SEC).to_string())
    );
    println!(
        "EVIDENCE f3 late deposit refunded in full (LF_FT_REFUND:DeliveryTimeTooShort); E, balances, agreement and capacity unchanged {rc}"
    );
    Ok(())
}

// ---- F4 deployment preflight script against a real local node -----------------

fn preflight(
    cfg: &Value,
    phase: &str,
    allow_non_testnet: bool,
) -> Result<(i32, String), Box<dyn std::error::Error>> {
    let release = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/near/linefair_escrow.wasm");
    preflight_with(cfg, phase, allow_non_testnet, &release)
}

fn preflight_with(
    cfg: &Value,
    phase: &str,
    allow_non_testnet: bool,
    wasm_path: &std::path::Path,
) -> Result<(i32, String), Box<dyn std::error::Error>> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let p = std::env::temp_dir().join(format!(
        "linefair-preflight-{}-{}.json",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::write(&p, cfg.to_string())?;
    let script = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../deploy/testnet_preflight.py");
    let mut cmd = std::process::Command::new("python3");
    cmd.arg("-I")
        .arg(&script)
        .arg("--config")
        .arg(&p)
        .arg("--phase")
        .arg(phase);
    if phase == "pre" {
        cmd.arg("--wasm").arg(wasm_path);
    }
    cmd.env_remove("LINEFAIR_PREFLIGHT_ALLOW_NON_TESTNET");
    if allow_non_testnet {
        cmd.env("LINEFAIR_PREFLIGHT_ALLOW_NON_TESTNET", "1");
    }
    let out = cmd.output()?;
    let _ = std::fs::remove_file(&p);
    Ok((
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
    ))
}

#[tokio::test]
async fn f4_preflight_script_fail_closed() -> TestResult {
    let env = setup(25).await?;
    let root = env.worker.root_account()?;
    let treasury = root
        .create_subaccount("treasury")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(treasury.id().as_str(), TREASURY);
    for who in [env.r.primary.id().as_str(), env.r.backup.id().as_str()] {
        register(&env.operator, &env.token, who).await?;
    }
    // The preflight reads at `final` finality: let setup transactions become final.
    env.worker.fast_forward(5).await?;
    let chain = env.worker.status().await?.chain_id;
    let digest: [u8; 32] = Sha256::digest(wasm()?).into();
    let escrow_sha: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    let base = json!({
        "rpc_url": env.worker.rpc_addr(), "expected_chain_id": chain, "network_id": "sandbox",
        "escrow_account_id": env.escrow.id(), "ft_account_id": env.token.id(),
        "operator_treasury_id": TREASURY, "operator_account_id": env.operator.id(),
        "roles": { "buyer": env.r.buyer.id(), "supplier": env.r.supplier.id(), "primary": env.r.primary.id(), "backup": env.r.backup.id() },
        "creator_allowlist": CREATORS, "max_agreements": 25,
        "expected_escrow_wasm_sha256": escrow_sha, "expected_ft_wasm_sha256": TOKEN_WASM_SHA256,
        "forbidden_escrow_wasm_sha256": ["76618fe6be7bf5fa6ae9290fef2355ae6a038ee0c550e9ec206c6318409fcecb", "4ab256c77850c06f8a0df6bf3a251965ca5c667d067c119b6c9f05ed406ae52b", "1b024ec18034cd1fac560d8f399809bab2b042d9f6f63a4a8f79025dee4ef53a"],
        "expected_contract_version": "linefair-escrow 0.1.0 (lf-012 f3)",
        "min_balances_near": { "escrow": 1, "ft": 1, "operator": 1, "role": 1 }
    });
    let (code, out) = preflight(&base, "post", true)?;
    println!("{out}");
    assert_eq!(code, 0, "positive post-deploy preflight must pass:\n{out}");
    // The sandbox override is visibly labelled and never reads as a deployment pass.
    assert!(out.contains("SANDBOX TEST MODE"), "{out}");
    assert!(
        out.contains("PASSED (SANDBOX TEST MODE, NOT VALID FOR DEPLOYMENT)"),
        "{out}"
    );
    // The test-only override cannot bypass network verification on a normal path.
    let mut c = base.clone();
    c["expected_chain_id"] = json!("mainnet");
    let (code, out) = preflight(&c, "post", true)?;
    assert_eq!(code, 1, "mainnet + override must fail:\n{out}");
    assert!(
        out.contains("FAIL  config: test override never applies to mainnet"),
        "{out}"
    );
    let mut c = base.clone();
    c["rpc_url"] = json!("http://192.0.2.1:3030"); // TEST-NET-1, never contacted
    let (code, out) = preflight(&c, "post", true)?;
    assert_eq!(
        code, 1,
        "override with a non-loopback RPC must fail:\n{out}"
    );
    assert!(
        out.contains("FAIL  config: test override only with a loopback sandbox RPC"),
        "{out}"
    );
    assert!(
        !out.contains("network: RPC chain_id"),
        "must stop before any RPC call:\n{out}"
    );
    let mut c = base.clone();
    c["expected_chain_id"] = json!("testnet");
    let (code, out) = preflight(&c, "post", true)?;
    assert_eq!(
        code, 1,
        "override is ignored when testnet is expected:\n{out}"
    );
    assert!(!out.contains("SANDBOX TEST MODE"), "{out}");
    println!(
        "EVIDENCE f4 override hardening: labelled sandbox pass; mainnet + override refused; non-loopback RPC + override refused before any RPC; override ignored for testnet"
    );
    // Fail-closed cases: each must exit 1.
    let mut cases: Vec<(&str, Value, &str, bool)> = Vec::new();
    let mut c = base.clone();
    c["expected_chain_id"] = json!("testnet");
    cases.push((
        "wrong network (sandbox RPC, testnet expected)",
        c,
        "post",
        false,
    ));
    cases.push((
        "non-testnet expectation without explicit test override",
        base.clone(),
        "post",
        false,
    ));
    let mut c = base.clone();
    c["expected_escrow_wasm_sha256"] = json!(format!("{}0", &escrow_sha[..63]));
    cases.push(("escrow code hash mismatch", c, "post", true));
    let mut c = base.clone();
    c["expected_contract_version"] =
        json!("linefair-escrow 0.1.0 (lf-012 f3) +test-starve-callback");
    cases.push(("contract_version mismatch", c, "post", true));
    let mut c = base.clone();
    c["roles"]["backup"] = json!(env.r.stranger.id());
    c["roles"]["primary"] = json!(treasury.id());
    cases.push(("role is treasury", c, "post", true));
    let mut c = base.clone();
    c["creator_allowlist"] = json!(["buyer.test.near", "buyer.test.near"]);
    cases.push(("duplicate creators", c, "post", true));
    let mut c = base.clone();
    c["creator_allowlist"] = json!([]);
    cases.push(("empty creators", c, "post", true));
    let mut c = base.clone();
    c["roles"]["backup"] = json!("nobody-here.test.near");
    cases.push(("role account does not exist", c, "post", true));
    let mut c = base.clone();
    c["roles"]["backup"] = json!("Bad_ID");
    cases.push(("invalid account id", c, "post", true));
    let mut c = base.clone();
    c.as_object_mut().expect("o").remove("max_agreements");
    cases.push(("missing config key", c, "post", true));
    let mut c = base.clone();
    c["expected_ft_wasm_sha256"] = json!("c26d0ac1");
    cases.push(("abbreviated digest refused", c, "post", true));
    cases.push((
        "pre phase on an already deployed escrow (never redeploy onto state)",
        base.clone(),
        "pre",
        true,
    ));
    let mut c = base.clone();
    c["max_agreements"] = json!(24);
    cases.push(("get_config mismatch", c, "post", true));
    for (name, cfg, phase, allow) in cases {
        let (code, out) = preflight(&cfg, phase, allow)?;
        assert_eq!(code, 1, "{name} must fail closed:\n{out}");
        println!(
            "EVIDENCE f4 preflight fail-closed: {name} -> exit 1 ({})",
            out.lines()
                .filter(|l| l.starts_with("FAIL"))
                .take(2)
                .collect::<Vec<_>>()
                .join(" | ")
        );
    }
    // Positive pre-deploy run against a fresh, empty account (and an implicit-looking id is valid syntax).
    let fresh = root
        .create_subaccount("freshescrow")
        .initial_balance(NearToken::from_near(7))
        .transact()
        .await?
        .into_result()?;
    // The preflight reads at `final` finality: let the new account become final.
    env.worker.fast_forward(5).await?;
    let mut c = base.clone();
    c["escrow_account_id"] = json!(fresh.id());
    c["min_balances_near"]["escrow"] = json!(6);
    let (code, out) = preflight(&c, "pre", true)?;
    assert_eq!(code, 0, "positive pre-deploy preflight must pass:\n{out}");
    // Refuse to deploy the test-only starve artifact (and any other WASM).
    let base_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let (code, out) = preflight_with(
        &c,
        "pre",
        true,
        &base_dir.join("target/near-starve/linefair_escrow.wasm"),
    )?;
    assert_eq!(code, 1, "starve artifact must be refused:\n{out}");
    assert!(
        out.contains("FAIL  artifact: not a forbidden build"),
        "{out}"
    );
    let (code, out) = preflight_with(
        &c,
        "pre",
        true,
        &base_dir.join("../test-ft/target/near/linefair_test_ft.wasm"),
    )?;
    assert_eq!(code, 1, "a different WASM must be refused:\n{out}");
    println!(
        "EVIDENCE f4 preflight positive: post on deployed escrow PASSED; pre on fresh empty account with the release WASM PASSED; starve and foreign WASM refused before deploy"
    );
    Ok(())
}
