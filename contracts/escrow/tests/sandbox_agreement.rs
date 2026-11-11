//! M1 S3 sandbox tests: agreement creation and acceptance through the real
//! WASM entry points (T001–T005, T011–T015, T017, T018, T056 cap part, T065,
//! T078 + replay, deadline, deposit and init checks).

mod common;

use common::*;
use linefair_escrow::hash::{NetworkId, terms_hash};
use linefair_escrow::terms_json::{encode_hex_lower, parse_terms_json};
use near_sdk::serde_json::{Value, json};
use near_workspaces::types::NearToken;

async fn create(
    contract: &near_workspaces::Contract,
    signer: &near_workspaces::Account,
    terms: &Value,
) -> Result<near_workspaces::result::ExecutionFinalResult, Box<dyn std::error::Error>> {
    Ok(signer
        .call(contract.id(), "create_agreement")
        .args_json(json!({ "terms": terms }))
        .max_gas()
        .transact()
        .await?)
}

async fn accept(
    contract: &near_workspaces::Contract,
    signer: &near_workspaces::Account,
    method: &str,
    id: &str,
    hash: &str,
) -> Result<near_workspaces::result::ExecutionFinalResult, Box<dyn std::error::Error>> {
    Ok(signer
        .call(contract.id(), method)
        .args_json(json!({ "agreement_id": id, "terms_hash": hash }))
        .max_gas()
        .transact()
        .await?)
}

fn flags(v: &Value) -> [bool; 4] {
    let a = &v["acceptances"];
    [
        a["buyer"].as_bool().expect("bool"),
        a["supplier"].as_bool().expect("bool"),
        a["primary_arbitrator"].as_bool().expect("bool"),
        a["backup_arbitrator"].as_bool().expect("bool"),
    ]
}

#[tokio::test]
async fn s3_happy_path_and_wasm_hash_matches_native() -> TestResult {
    let worker = sandbox().await?;
    let contract = deploy(&worker, 25).await?;
    let r = roles(&worker).await?;
    let deadline = now_ns(&worker).await? + HOUR;
    let t = terms(&r, 1, deadline, 3);

    // WASM host SHA-256 == native Rust reference for the same (network, escrow, terms).
    let wasm_hash: String = contract
        .view("compute_terms_hash")
        .args_json(json!({ "terms": t }))
        .await?
        .json()?;
    let parsed = parse_terms_json(&t.to_string()).map_err(|e| format!("{e:?}"))?;
    let escrow_id: near_sdk::AccountId = contract.id().as_str().parse()?;
    let native = encode_hex_lower(&terms_hash(NetworkId::Sandbox, &escrow_id, &parsed));
    assert_eq!(wasm_hash, native, "WASM vs native hash");

    // T001 create: id 0, PROPOSED, contract-computed hash; storage within budget.
    let before = storage_usage(&contract).await?;
    let res = create(&contract, &r.buyer, &t).await?;
    let create_gas = res.total_gas_burnt;
    let id: String = res.into_result()?.json()?;
    assert_eq!(id, "0");
    let used = storage_usage(&contract).await? - before;
    println!(
        "EVIDENCE method=create_agreement lines=3 storage_added_bytes={used} gas_burnt={create_gas} gas_burnt_units={}",
        create_gas.as_gas()
    );
    assert!(used <= 4_096, "storage {used} > 4096");
    let v = get_agreement(&contract, "0").await?;
    assert_eq!(v["status"], "PROPOSED");
    assert_eq!(v["terms_hash"], json!(native));
    assert_eq!(v["terms"], t);
    assert_eq!(flags(&v), [false; 4]);
    assert_eq!(v["accelerated_test_timing"], json!(false));
    // S5: line states pre-allocated, unfunded, all buckets zero (no custody).
    let lines = v["lines"].as_array().expect("lines");
    assert_eq!(lines.len(), 3);
    for (i, l) in lines.iter().enumerate() {
        assert_eq!(l["line_id"], json!(i));
        assert_eq!(l["status"], "UNFUNDED");
        for b in [
            "locked",
            "buyer_claimable",
            "supplier_claimable",
            "buyer_pending",
            "supplier_pending",
            "buyer_paid",
            "supplier_paid",
        ] {
            assert_eq!(l[b], "0", "{b}");
        }
        assert_eq!(l["buyer_withdrawal"], "EMPTY");
        assert_eq!(l["supplier_withdrawal"], "EMPTY");
    }

    // T002 buyer accepts exact hash → one approval.
    let res = accept(&contract, &r.buyer, "accept_terms", "0", &native).await?;
    println!(
        "EVIDENCE method=accept_terms role=buyer gas_burnt={} gas_burnt_units={}",
        res.total_gas_burnt,
        res.total_gas_burnt.as_gas()
    );
    res.into_result()?;
    let v = get_agreement(&contract, "0").await?;
    assert_eq!(flags(&v), [true, false, false, false]);
    assert_eq!(v["status"], "PROPOSED");
    // T003 supplier accepts same hash → commercial approvals complete.
    accept(&contract, &r.supplier, "accept_terms", "0", &native)
        .await?
        .into_result()?;
    let v = get_agreement(&contract, "0").await?;
    assert_eq!(flags(&v), [true, true, false, false]);
    assert_eq!(v["status"], "PROPOSED");
    // T004 primary acknowledges → only primary flag.
    accept(&contract, &r.primary, "accept_appointment", "0", &native)
        .await?
        .into_result()?;
    let v = get_agreement(&contract, "0").await?;
    assert_eq!(flags(&v), [true, true, true, false]);
    assert_eq!(v["status"], "PROPOSED");
    // T005 backup acknowledges → AGREED.
    accept(&contract, &r.backup, "accept_appointment", "0", &native)
        .await?
        .into_result()?;
    let v = get_agreement(&contract, "0").await?;
    assert_eq!(flags(&v), [true; 4]);
    assert_eq!(v["status"], "AGREED");

    // Replay after AGREED is rejected for every role; state unchanged.
    for (who, m) in [
        (&r.buyer, "accept_terms"),
        (&r.supplier, "accept_terms"),
        (&r.primary, "accept_appointment"),
        (&r.backup, "accept_appointment"),
    ] {
        assert_fails(
            accept(&contract, who, m, "0", &native).await?,
            "ERR_ACCEPT:AlreadyAccepted",
        );
    }
    assert_eq!(get_agreement(&contract, "0").await?, v);

    let cfg: Value = contract.view("get_config").await?.json()?;
    assert_eq!(cfg["network_id"], "sandbox");
    assert_eq!(cfg["agreements_created"], "1");
    Ok(())
}

#[tokio::test]
async fn s3_wasm_hash_matches_native_for_all_vector_terms() -> TestResult {
    // Every vector's terms (golden, 22 mutations, reorders) hashed by the
    // deployed WASM equals the native Rust hash for this contract's binding.
    let worker = sandbox().await?;
    let contract = deploy(&worker, 1).await?;
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared-schemas/vectors/terms_v1.json");
    let doc: Value = near_sdk::serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let escrow_id: near_sdk::AccountId = contract.id().as_str().parse()?;
    let mut all = vec![doc["golden"].clone()];
    all.extend(
        doc["field_mutations"]
            .as_array()
            .expect("array")
            .iter()
            .cloned(),
    );
    all.extend(
        doc["reordered_lines"]
            .as_array()
            .expect("array")
            .iter()
            .cloned(),
    );
    let mut n = 0;
    for v in &all {
        let terms = &v["terms"];
        let wasm_hash: String = contract
            .view("compute_terms_hash")
            .args_json(json!({ "terms": terms }))
            .await?
            .json()?;
        let parsed = parse_terms_json(&terms.to_string()).map_err(|e| format!("{e:?}"))?;
        let native = encode_hex_lower(&terms_hash(NetworkId::Sandbox, &escrow_id, &parsed));
        assert_eq!(wasm_hash, native, "{}", v["label"]);
        n += 1;
    }
    assert_eq!(n, 1 + 22 + 2);
    println!("EVIDENCE wasm_vs_native_hash vectors_checked={n}");
    Ok(())
}

#[tokio::test]
async fn s3_authorization_hash_and_replay_rejections() -> TestResult {
    let worker = sandbox().await?;
    let contract = deploy(&worker, 25).await?;
    let r = roles(&worker).await?;
    let deadline = now_ns(&worker).await? + HOUR;
    let t0 = terms(&r, 1, deadline, 3);
    let t1 = terms(&r, 2, deadline, 1);

    // Creation must be signed by the buyer. LF-010A: non-listed callers are
    // rejected first by the allowlist; a listed non-buyer still gets ERR_NOT_BUYER.
    assert_fails(create(&contract, &r.supplier, &t0).await?, "ERR_NOT_BUYER");
    for who in [&r.primary, &r.stranger] {
        assert_fails(
            create(&contract, who, &t0).await?,
            "ERR_CREATOR_NOT_ALLOWLISTED",
        );
    }
    let id0: String = create(&contract, &r.buyer, &t0)
        .await?
        .into_result()?
        .json()?;
    let id1: String = create(&contract, &r.buyer, &t1)
        .await?
        .into_result()?
        .json()?;
    assert_eq!((id0.as_str(), id1.as_str()), ("0", "1"));
    let h0 = get_agreement(&contract, "0").await?["terms_hash"]
        .as_str()
        .expect("h")
        .to_string();
    let h1 = get_agreement(&contract, "1").await?["terms_hash"]
        .as_str()
        .expect("h")
        .to_string();
    assert_ne!(h0, h1);

    // T078 identical preimage rejected; state unchanged (atomic).
    let su = storage_usage(&contract).await?;
    assert_fails(
        create(&contract, &r.buyer, &t0).await?,
        "ERR_DUPLICATE_TERMS",
    );
    assert_eq!(
        storage_usage(&contract).await?,
        su,
        "no state from rejected create"
    );
    let cfg: Value = contract.view("get_config").await?.json()?;
    assert_eq!(cfg["agreements_created"], "2");

    // T017 wrong signer for accept_terms.
    for who in [&r.stranger, &r.primary, &r.backup] {
        assert_fails(
            accept(&contract, who, "accept_terms", "0", &h0).await?,
            "ERR_ACCEPT:NotAuthorizedForMethod",
        );
    }
    // T018 supplier (or buyer) as arbitrator.
    for who in [&r.supplier, &r.buyer, &r.stranger] {
        assert_fails(
            accept(&contract, who, "accept_appointment", "0", &h0).await?,
            "ERR_ACCEPT:NotAuthorizedForMethod",
        );
    }
    // T065 mismatched hash: another agreement's hash, a flipped hash, zeros.
    let mut flipped = h0.clone().into_bytes();
    flipped[63] = if flipped[63] == b'0' { b'1' } else { b'0' };
    let flipped = String::from_utf8(flipped)?;
    for bad in [h1.as_str(), flipped.as_str(), &"0".repeat(64)] {
        assert_fails(
            accept(&contract, &r.buyer, "accept_terms", "0", bad).await?,
            "ERR_ACCEPT:TermsHashMismatch",
        );
        assert_fails(
            accept(&contract, &r.primary, "accept_appointment", "0", bad).await?,
            "ERR_ACCEPT:TermsHashMismatch",
        );
    }
    // Malformed hash text.
    for bad in [
        h0.to_uppercase(),
        h0[..62].to_string(),
        format!("0x{}", &h0[..62]),
        String::new(),
    ] {
        assert_fails(
            accept(&contract, &r.buyer, "accept_terms", "0", &bad).await?,
            "ERR_TERMS_HASH_FORMAT",
        );
    }
    // Unknown agreement.
    assert_fails(
        accept(&contract, &r.buyer, "accept_terms", "7", &h0).await?,
        "ERR_AGREEMENT_NOT_FOUND",
    );
    // Nothing above changed agreement 0.
    assert_eq!(flags(&get_agreement(&contract, "0").await?), [false; 4]);

    // Replay of a successful acceptance.
    accept(&contract, &r.buyer, "accept_terms", "0", &h0)
        .await?
        .into_result()?;
    assert_fails(
        accept(&contract, &r.buyer, "accept_terms", "0", &h0).await?,
        "ERR_ACCEPT:AlreadyAccepted",
    );
    // An acceptance of agreement 0 does not touch agreement 1.
    assert_eq!(flags(&get_agreement(&contract, "1").await?), [false; 4]);
    assert_eq!(
        flags(&get_agreement(&contract, "0").await?),
        [true, false, false, false]
    );

    // Attached deposit is rejected on every call method (no NEAR custody).
    let res = r
        .buyer
        .call(contract.id(), "accept_terms")
        .args_json(json!({ "agreement_id": "1", "terms_hash": h1 }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert_fails(res, "doesn't accept deposit");
    let mut t2 = t1.clone();
    t2["agreement_nonce"] = json!("3");
    let res = r
        .buyer
        .call(contract.id(), "create_agreement")
        .args_json(json!({ "terms": t2 }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert_fails(res, "doesn't accept deposit");
    Ok(())
}

#[tokio::test]
async fn s3_invalid_terms_rejected_by_contract() -> TestResult {
    // Sandbox part of T011–T015 plus parse-level rejection.
    let worker = sandbox().await?;
    let contract = deploy(&worker, 25).await?;
    let r = roles(&worker).await?;
    let deadline = now_ns(&worker).await? + HOUR;
    let base = terms(&r, 1, deadline, 3);
    let su = storage_usage(&contract).await?;

    let mut cases: Vec<(&str, Value, &str)> = Vec::new();
    let mut t = base.clone();
    t["lines"][1]["principal"] = json!("0");
    cases.push(("T011 zero principal", t, "ERR_TERMS_INVALID:ZeroPrincipal"));
    cases.push((
        "T012 four lines",
        terms(&r, 1, deadline, 4),
        "ERR_TERMS_INVALID:LineCountOutOfRange",
    ));
    let mut t = base.clone();
    t["lines"] = json!([]);
    cases.push((
        "T012 zero lines",
        t,
        "ERR_TERMS_INVALID:LineCountOutOfRange",
    ));
    let mut t = base.clone();
    t["supplier_id"] = json!(r.buyer.id());
    cases.push((
        "T013 buyer = supplier",
        t,
        "ERR_TERMS_INVALID:RolesNotDistinct",
    ));
    let mut t = base.clone();
    t["primary_arbitrator_id"] = json!(r.buyer.id());
    cases.push((
        "T014 primary = buyer",
        t,
        "ERR_TERMS_INVALID:RolesNotDistinct",
    ));
    let mut t = base.clone();
    t["backup_arbitrator_id"] = json!(r.supplier.id());
    cases.push((
        "T014 backup = supplier",
        t,
        "ERR_TERMS_INVALID:RolesNotDistinct",
    ));
    let mut t = base.clone();
    t["lines"][0]["fallback_supplier_bps"] = json!(4_999);
    cases.push(("T015 bps sum", t, "ERR_TERMS_INVALID:BpsSumInvalid"));
    let mut t = base.clone();
    t["lines"][0]["fallback_buyer_bps"] = json!(10_001);
    cases.push(("T015 bps > 10000", t, "ERR_TERMS_INVALID:BpsOutOfRange"));
    let mut t = base.clone();
    t["backup_arbitrator_id"] = json!(contract.id());
    cases.push((
        "OQ-09 role = escrow",
        t,
        "ERR_TERMS_INVALID:RoleIsReservedAccount",
    ));
    let mut t = base.clone();
    t["ft_contract_id"] = json!("other-ft.test.near");
    cases.push((
        "FT not allowlisted",
        t,
        "ERR_TERMS_INVALID:FtNotAllowlisted",
    ));
    let mut t = base.clone();
    t["acceptance_deadline_ns"] = json!("1");
    cases.push((
        "acceptance deadline in past",
        t,
        "ERR_TERMS_INVALID:AcceptanceDeadlineNotInFuture",
    ));
    let mut t = base.clone();
    t["review_window_ns"] = json!("59999999999");
    cases.push((
        "T051 window < 60 s",
        t,
        "ERR_TERMS_INVALID:WindowOutOfRange",
    ));
    let mut t = base.clone();
    t["agreement_nonce"] = json!("01");
    cases.push((
        "non-canonical decimal",
        t,
        "ERR_TERMS_PARSE:NonCanonicalDecimal",
    ));
    let mut t = base.clone();
    t["lines"][0]["acceptance_criteria_commitment"] = json!("AB".repeat(32));
    cases.push(("uppercase hex", t, "ERR_TERMS_PARSE:InvalidCommitmentHex"));
    let mut t = base.clone();
    t["memo"] = json!("x");
    cases.push(("unknown field", t, "unknown field"));

    for (name, t, code) in cases {
        let res = create(&contract, &r.buyer, &t).await?;
        assert!(res.is_failure(), "{name} unexpectedly succeeded");
        assert_fails(res, code);
    }
    assert_eq!(
        storage_usage(&contract).await?,
        su,
        "no state from rejected creates"
    );
    let cfg: Value = contract.view("get_config").await?.json()?;
    assert_eq!(cfg["agreements_created"], "0");
    Ok(())
}

#[tokio::test]
async fn s3_acceptance_deadline_in_chain_time() -> TestResult {
    let worker = sandbox().await?;
    let contract = deploy(&worker, 25).await?;
    let r = roles(&worker).await?;
    // Short acceptance deadline (accelerated windows are not needed: the
    // acceptance deadline only has to be in the future).
    let deadline = now_ns(&worker).await? + 30_000_000_000;
    let t = terms(&r, 1, deadline, 1);
    create(&contract, &r.buyer, &t).await?.into_result()?;
    let h = get_agreement(&contract, "0").await?["terms_hash"]
        .as_str()
        .expect("h")
        .to_string();
    accept(&contract, &r.buyer, "accept_terms", "0", &h)
        .await?
        .into_result()?;
    accept(&contract, &r.supplier, "accept_terms", "0", &h)
        .await?
        .into_result()?;
    accept(&contract, &r.primary, "accept_appointment", "0", &h)
        .await?
        .into_result()?;

    // Advance chain time past the deadline.
    let mut rounds = 0;
    while now_ns(&worker).await? <= deadline {
        worker.fast_forward(100).await?;
        rounds += 1;
        assert!(rounds < 50, "chain time did not advance");
    }
    let v = get_agreement(&contract, "0").await?;
    assert_eq!(v["status"], "EXPIRED");
    assert_fails(
        accept(&contract, &r.backup, "accept_appointment", "0", &h).await?,
        "ERR_ACCEPT:AcceptanceDeadlinePassed",
    );
    assert_fails(
        accept(&contract, &r.buyer, "accept_terms", "0", &h).await?,
        "ERR_ACCEPT:AcceptanceDeadlinePassed",
    );
    let v2 = get_agreement(&contract, "0").await?;
    assert_eq!(flags(&v2), [true, true, true, false]);
    assert_eq!(v2["status"], "EXPIRED");
    // Same preimage can never be re-registered (it is also no longer valid).
    assert_fails(
        create(&contract, &r.buyer, &t).await?,
        "ERR_TERMS_INVALID:AcceptanceDeadlineNotInFuture",
    );
    Ok(())
}

#[tokio::test]
async fn s3_init_and_cap() -> TestResult {
    let worker = sandbox().await?;
    let r = roles(&worker).await?;

    // Init: only the contract account, only once, never mainnet.
    let c = worker.dev_deploy(&wasm()?).await?;
    let args = |net: &str, max: u32| json!({ "network_id": net, "allowlisted_ft_id": FT, "operator_treasury_id": TREASURY, "max_agreements": max, "creator_allowlist": CREATORS });
    let res = r
        .stranger
        .call(c.id(), "new")
        .args_json(args("sandbox", 5))
        .transact()
        .await?;
    assert_fails(res, "is private");
    assert_fails(
        c.call("new")
            .args_json(args("mainnet", 5))
            .transact()
            .await?,
        "ERR_INIT_NETWORK",
    );
    assert_fails(
        c.call("new")
            .args_json(args("sandbox", 0))
            .transact()
            .await?,
        "ERR_INIT_MAX_AGREEMENTS",
    );
    assert_fails(
        c.call("new")
            .args_json(args("sandbox", 26))
            .transact()
            .await?,
        "ERR_INIT_MAX_AGREEMENTS",
    );
    // Uninitialised contract refuses calls.
    assert!(c.view("get_config").await.is_err(), "views need init");
    c.call("new")
        .args_json(args("sandbox", 1))
        .transact()
        .await?
        .into_result()?;
    assert_fails(
        c.call("new")
            .args_json(args("sandbox", 1))
            .transact()
            .await?,
        "already been initialized",
    );

    // T056 (cap part): cap reached → rejected atomically.
    let deadline = now_ns(&worker).await? + HOUR;
    create(&c, &r.buyer, &terms(&r, 1, deadline, 1))
        .await?
        .into_result()?;
    let su = storage_usage(&c).await?;
    assert_fails(
        create(&c, &r.buyer, &terms(&r, 2, deadline, 1)).await?,
        "ERR_AGREEMENT_CAP_REACHED",
    );
    assert_eq!(storage_usage(&c).await?, su);
    let cfg: Value = c.view("get_config").await?.json()?;
    assert_eq!(cfg["agreements_created"], "1");
    assert_eq!(cfg["max_agreements"], 1);
    Ok(())
}

#[tokio::test]
async fn s5_storage_and_gas_by_line_count() -> TestResult {
    // Measured (not estimated) storage of pre-allocated line states.
    let worker = sandbox().await?;
    let contract = deploy(&worker, 25).await?;
    let r = roles(&worker).await?;
    let deadline = now_ns(&worker).await? + HOUR;
    let mut added = Vec::new();
    for lines in 1..=3usize {
        let t = terms(&r, 100 + lines as u64, deadline, lines);
        let before = storage_usage(&contract).await?;
        let res = create(&contract, &r.buyer, &t).await?;
        let gas = res.total_gas_burnt;
        res.into_result()?;
        let used = storage_usage(&contract).await? - before;
        println!(
            "EVIDENCE method=create_agreement lines={lines} storage_added_bytes={used} gas_burnt_units={}",
            gas.as_gas()
        );
        assert!(used <= 4_096, "storage {used} > 4096");
        added.push(used);
    }
    // Each extra line adds the same fixed amount.
    let per_line = added[1] - added[0];
    assert_eq!(
        added[2] - added[1],
        per_line,
        "constant per-line storage: {added:?}"
    );
    println!("EVIDENCE storage_per_additional_line_bytes={per_line}");
    Ok(())
}
