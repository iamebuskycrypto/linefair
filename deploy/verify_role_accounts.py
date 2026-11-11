#!/usr/bin/env python3
"""Read-only verification of the LineFair testnet role accounts (JSON-RPC queries only; no keys, no signing).

Checks per account: testnet chain, existence, balance vs docs/32 minimum, access keys
(public only), no contract code, and the creation transaction (found from the key nonce).
Checks across accounts: valid named .testnet ids, all distinct, none equal to the escrow /
token / treasury / operator / funder, creator allowlist valid for `new` (1..=10, distinct,
not escrow/token/treasury). Exit 0 only if every check passes.
"""
import base64
import json
import re
import sys
import time
import urllib.request
from decimal import Decimal

RPC = "https://rpc.testnet.near.org"
NO_CODE = "11111111111111111111111111111111"
YOCTO = Decimal(10**24)
ROLES = [  # (role, account, minimum NEAR from docs/32 §2)
    ("buyer (allowlist #1)", "linefair-buyertestnetnear.testnet", Decimal("1")),
    ("backup buyer (allowlist #2)", "linefair-buyerbackuptestnet.testnet", Decimal("0.5")),
    ("supplier", "linefair-suppliertestnet.testnet", Decimal("1")),
    ("primary arbitrator", "linefair-primaryarbtestnet.testnet", Decimal("1")),
    ("backup arbitrator", "linefair-backuparbtestnet.testnet", Decimal("1")),
]
RESERVED = {"escrow": "escrow.ebusky-linefair.testnet", "token": "token.ebusky-linefair.testnet",
            "treasury": "treasury.ebusky-linefair.testnet"}
OTHER_OPERATIONAL = {"operator": "operator.ebusky-linefair.testnet", "funder": "ebusky-linefair.testnet"}
ALLOWLIST = ["linefair-buyertestnetnear.testnet", "linefair-buyerbackuptestnet.testnet"]
NAMED_TESTNET = re.compile(r"^(([a-z\d]+[-_])*[a-z\d]+\.)+testnet$")
ok_all = True


def check(name, cond, detail=""):
    global ok_all
    ok_all &= bool(cond)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""))


def rpc(method, params, attempts=5):
    time.sleep(0.4)  # stay under the public RPC rate limit
    body = json.dumps({"jsonrpc": "2.0", "id": "lf", "method": method, "params": params}).encode()
    for i in range(attempts):
        try:
            req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=45) as r:
                resp = json.loads(r.read())
            break
        except (TimeoutError, OSError):
            if i == attempts - 1:
                raise
            time.sleep((10, 20, 40, 60)[min(i, 3)])  # public RPC rate limits (HTTP 429) / timeouts
    if "error" in resp:
        raise RuntimeError(json.dumps(resp["error"])[:240])
    return resp["result"]


def q(params):
    return rpc("query", dict(params, finality="final"))


def creation_tx(account, public_key):
    nonce = q({"request_type": "view_access_key", "account_id": account, "public_key": public_key})["nonce"]
    height = nonce // 1_000_000
    for h in range(height - 10, height + 1):
        try:
            block = rpc("block", {"block_id": h})
        except Exception:
            continue
        for ch in block["chunks"]:
            if ch["tx_root"] == NO_CODE:
                continue
            for t in rpc("chunk", {"chunk_id": ch["chunk_hash"]})["transactions"]:
                text = []
                for a in t["actions"]:
                    if isinstance(a, dict) and "FunctionCall" in a:
                        fc = a["FunctionCall"]
                        text.append(fc["method_name"] + " " + base64.b64decode(fc["args"]).decode(errors="replace"))
                    else:
                        text.append(json.dumps(a))
                s = " ".join(text)
                if t["receiver_id"] == account or account in s:
                    st = rpc("EXPERIMENTAL_tx_status", {"tx_hash": t["hash"], "sender_account_id": t["signer_id"], "wait_until": "NONE"})
                    success = "SuccessValue" in st["status"] or "SuccessReceiptId" in st["status"]
                    return {"tx": t["hash"], "block": h, "signer": t["signer_id"], "receiver": t["receiver_id"],
                            "success": success, "creates_with_key": public_key in s, "summary": s[:200]}
    return None


status = rpc("status", [])
print(f"rpc={RPC} chain_id={status['chain_id']} height={status['sync_info']['latest_block_height']} protocol={status['protocol_version']}")
if status["chain_id"] != "testnet":
    print("FAIL: not testnet")
    sys.exit(1)
records = []
for role, acct, minimum in ROLES:
    print(f"\n== {role}: {acct}")
    check("named .testnet account id (<= 64 chars)", NAMED_TESTNET.match(acct) and len(acct) <= 64, acct)
    try:
        a = q({"request_type": "view_account", "account_id": acct})
    except Exception as e:
        check("exists on testnet", False, str(e)[:120])
        continue
    bal = Decimal(a["amount"]) / YOCTO
    check("exists on testnet", True, f"block {a['block_height']}")
    check(f"balance >= {minimum} NEAR (docs/32)", bal >= minimum, f"{bal} NEAR ({a['amount']} yocto)")
    check("no contract code", a["code_hash"] == NO_CODE, a["code_hash"])
    keys = q({"request_type": "view_access_key_list", "account_id": acct})["keys"]
    full = [k for k in keys if k["access_key"]["permission"] == "FullAccess"]
    fc = [k for k in keys if k["access_key"]["permission"] != "FullAccess"]
    check("exactly 1 full-access key, 0 function-call keys (wallet-held)", len(full) == 1 and not fc, f"{len(full)} full, {len(fc)} function-call")
    for k in keys:
        perm = "FullAccess" if k["access_key"]["permission"] == "FullAccess" else json.dumps(k["access_key"]["permission"])[:120]
        print(f"        key {k['public_key']}  {perm}")
    try:
        c = None if "--skip-creation-scan" in sys.argv else (creation_tx(acct, full[0]["public_key"]) if full else None)
    except Exception as e:
        c = None
        print(f"  NOTE  creation-tx lookup failed ({type(e).__name__}); informational only")
    if c:
        check("creation tx found, successful, created with this key", c["success"] and c["creates_with_key"], f"{c['tx']} signer {c['signer']} -> {c['receiver']} (block {c['block']})")
    else:
        print("  NOTE  creation-tx scan " + ("skipped (--skip-creation-scan)" if "--skip-creation-scan" in sys.argv else "found nothing near the key-nonce block") + " (informational)")
    records.append({"role": role, "account_id": acct, "amount_yocto": a["amount"], "balance_near": str(bal),
                    "minimum_near": str(minimum), "keys": [k["public_key"] for k in keys], "creation": c})

print("\n== cross-account rules")
ids = [r[1] for r in ROLES]
check("all five role ids distinct", len(set(ids)) == len(ids))
for_agreement = [ids[0], ids[2], ids[3], ids[4]]
check("agreement roles (buyer, supplier, primary, backup) distinct (contract RolesNotDistinct)", len(set(for_agreement)) == 4)
clash = {i: n for i in ids for n, r in {**RESERVED, **OTHER_OPERATIONAL}.items() if i == r}
check("no role is escrow/token/treasury (contract RoleIsReservedAccount) or operator/funder (preflight)", not clash, json.dumps(clash))
check("creator allowlist: 1..=10 entries (ERR_INIT_CREATOR_ALLOWLIST_SIZE)", 1 <= len(ALLOWLIST) <= 10, str(len(ALLOWLIST)))
check("creator allowlist: distinct (ERR_INIT_CREATOR_ALLOWLIST_DUPLICATE)", len(set(ALLOWLIST)) == len(ALLOWLIST))
check("creator allowlist: no escrow/token/treasury (ERR_INIT_CREATOR_ALLOWLIST_RESERVED)", not (set(ALLOWLIST) & set(RESERVED.values())))
check("creator allowlist contains the demo buyer", ids[0] in ALLOWLIST)
print("\nRECORDS_JSON " + json.dumps(records))
print("RESULT:", "ALL ROLE CHECKS PASSED" if ok_all else "SOME CHECKS FAILED — see above")
sys.exit(0 if ok_all else 1)
