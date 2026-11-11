"""Read-only verification of LineFair testnet accounts (JSON-RPC queries only; no keys, no signing)."""
import json, sys, urllib.request
from decimal import Decimal

RPC = "https://rpc.testnet.near.org"
NO_CODE = "11111111111111111111111111111111"
ACCOUNTS = [
    ("funder", "ebusky-linefair.testnet", "7NLfVnb8MgDd3vdmXwupFPgz3erZ4AW93W4W7vR6Lv3q"),
    ("escrow", "escrow.ebusky-linefair.testnet", "6PFVdzu8W8MrPDDTiHNWaUHkyjHJHNb3dLV2xPUubJrh"),
    ("token", "token.ebusky-linefair.testnet", "6v9SU72MhBzLZ6UKAhPxVjRgaLWrwCtpEkgzRjm4Upmv"),
    ("operator", "operator.ebusky-linefair.testnet", "8b8avUnuH227FkgfUdUvWT4RkKxzy9mf8QzFKNqNu1A5"),
    ("treasury", "treasury.ebusky-linefair.testnet", "5N4HaMn4PxC8xjK3nP7NUakv7GtDG5TCVYxxprF3NYR9"),
]
FUNDER = ACCOUNTS[0][1]


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": "lf", "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        resp = json.loads(r.read())
    if "error" in resp:
        raise RuntimeError(json.dumps(resp["error"])[:240])
    return resp["result"]


def q(params):
    return rpc("query", dict(params, finality="final"))


status = rpc("status", [])
print(f"rpc={RPC} chain_id={status['chain_id']} height={status['sync_info']['latest_block_height']} protocol={status['protocol_version']}")
assert status["chain_id"] == "testnet"
ok_all = True
for role, acct, txh in ACCOUNTS:
    print(f"\n== {role}: {acct}")
    try:
        a = q({"request_type": "view_account", "account_id": acct})
    except Exception as e:
        print(f"  FAIL exists: {e}")
        ok_all = False
        continue
    near = Decimal(a["amount"]) / Decimal(10**24)
    print(f"  exists: yes | balance {near} NEAR ({a['amount']} yocto) | locked {a['locked']} | storage {a['storage_usage']} B")
    no_code = a["code_hash"] == NO_CODE
    print(f"  code_hash {a['code_hash']} -> {'no contract code' if no_code else 'CONTRACT CODE PRESENT'}")
    ok_all &= no_code
    keys = q({"request_type": "view_access_key_list", "account_id": acct})["keys"]
    full = [k for k in keys if k["access_key"]["permission"] == "FullAccess"]
    print(f"  access keys: {len(keys)} total, {len(full)} full-access")
    for k in keys:
        perm = k["access_key"]["permission"]
        print(f"    {k['public_key']}  {'FullAccess' if perm == 'FullAccess' else 'FunctionCall'}  nonce={k['access_key']['nonce']}")
    if role == "escrow":
        st = q({"request_type": "view_state", "account_id": acct, "prefix_base64": ""})
        empty = len(st.get("values", [])) == 0
        print(f"  contract state entries: {len(st.get('values', []))} -> {'empty' if empty else 'NOT EMPTY'}")
        ok_all &= empty
    # creation transaction (read-only status lookup)
    found = None
    for sender in ([FUNDER] if role != "funder" else [FUNDER, "testnet", "faucet.testnet", "near-faucet.testnet"]):
        try:
            t = rpc("EXPERIMENTAL_tx_status", {"tx_hash": txh, "sender_account_id": sender, "wait_until": "NONE"})
            found = (sender, t)
            break
        except Exception:
            continue
    if found is None:
        print(f"  tx {txh}: not resolvable via RPC with the tried senders (check on testnet.nearblocks.io)")
        continue
    sender, t = found
    tx = t["transaction"]
    st = t.get("status", {})
    outcome = "SuccessValue" if "SuccessValue" in st else ("Failure" if "Failure" in st else str(list(st.keys())))
    acts = []
    for act in tx["actions"]:
        if isinstance(act, str):
            acts.append(act)
        else:
            name = next(iter(act))
            detail = act[name]
            if name == "Transfer":
                acts.append(f"Transfer {Decimal(detail['deposit']) / Decimal(10**24)} NEAR")
            elif name == "FunctionCall":
                acts.append(f"FunctionCall {detail['method_name']} deposit {Decimal(detail['deposit']) / Decimal(10**24)} NEAR")
            elif name == "AddKey":
                acts.append(f"AddKey {detail['public_key']} {'FullAccess' if detail['access_key']['permission'] == 'FullAccess' else 'FunctionCall'}")
            else:
                acts.append(name)
    print(f"  tx {txh}: signer {tx['signer_id']} -> receiver {tx['receiver_id']} | {outcome} | actions: {'; '.join(acts)}")
print("\nRESULT:", "ALL ACCOUNTS PRESENT, NO CODE, ESCROW STATE EMPTY" if ok_all else "CHECK FAILURES ABOVE")
sys.exit(0 if ok_all else 1)
