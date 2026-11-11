#!/usr/bin/env python3
"""Read-only before/after snapshot of ONE testnet account for the wallet connection test.

JSON-RPC queries only (view_account, view_access_key_list) against the official
testnet RPC. Never reads, prints or needs a private key. Public keys only.

  python3 -I deploy/wallet_connection_snapshot.py snapshot <account.testnet> <out.json>
  python3 -I deploy/wallet_connection_snapshot.py compare <before.json> <after.json>

`compare` exits 1 (STOP) if any access key was added or removed, any permission
changed, or the balance decreased — a connection must not create keys or cost NEAR.
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone

RPC = "https://rpc.testnet.near.org"
ACCOUNT_RE = re.compile(r"^(([a-z\d]+[-_])*[a-z\d]+\.)+testnet$")


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": "lf", "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        resp = json.loads(r.read())
    if "error" in resp:
        raise RuntimeError(json.dumps(resp["error"])[:240])
    return resp["result"]


def snapshot(account):
    if not ACCOUNT_RE.match(account) or len(account) > 64:
        raise ValueError("expected a named NEAR testnet account id")
    status = rpc("status", [])
    if status["chain_id"] != "testnet":
        raise RuntimeError(f"RPC chain_id is {status['chain_id']!r}, expected testnet")
    acct = rpc("query", {"request_type": "view_account", "account_id": account, "finality": "final"})
    keys = rpc("query", {"request_type": "view_access_key_list", "account_id": account, "finality": "final"})["keys"]
    norm = []
    for k in keys:
        p = k["access_key"]["permission"]
        if p == "FullAccess":
            perm = {"type": "FullAccess"}
        else:
            fc = p["FunctionCall"]
            perm = {"type": "FunctionCall", "receiver_id": fc["receiver_id"], "method_names": fc["method_names"], "allowance": fc.get("allowance")}
        norm.append({"public_key": k["public_key"], "permission": perm})
    norm.sort(key=lambda x: x["public_key"])
    return {
        "taken_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "rpc": RPC, "chain_id": status["chain_id"], "block_height": acct["block_height"],
        "account_id": account, "amount_yocto": acct["amount"], "locked_yocto": acct["locked"],
        "code_hash": acct["code_hash"], "storage_usage": acct["storage_usage"], "access_keys": norm,
    }


def compare(a, b):
    problems = []
    if a["account_id"] != b["account_id"]:
        problems.append("different accounts")
    ka = {k["public_key"]: k["permission"] for k in a["access_keys"]}
    kb = {k["public_key"]: k["permission"] for k in b["access_keys"]}
    for pk in sorted(set(kb) - set(ka)):
        problems.append(f"NEW access key {pk} {json.dumps(kb[pk])}")
    for pk in sorted(set(ka) - set(kb)):
        problems.append(f"REMOVED access key {pk}")
    for pk in sorted(set(ka) & set(kb)):
        if ka[pk] != kb[pk]:
            problems.append(f"PERMISSION CHANGED {pk}: {json.dumps(ka[pk])} -> {json.dumps(kb[pk])}")
    if int(b["amount_yocto"]) < int(a["amount_yocto"]):
        problems.append(f"balance decreased by {int(a['amount_yocto']) - int(b['amount_yocto'])} yocto")
    if a["code_hash"] != b["code_hash"]:
        problems.append("code hash changed")
    return problems


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ("snapshot", "compare"):
        print(__doc__)
        sys.exit(2)
    if sys.argv[1] == "snapshot":
        s = snapshot(sys.argv[2])
        with open(sys.argv[3], "w") as f:
            json.dump(s, f, indent=1)
        print(json.dumps(s, indent=1))
        return
    a, b = (json.load(open(p)) for p in sys.argv[2:4])
    problems = compare(a, b)
    print(f"before: block {a['block_height']} keys {len(a['access_keys'])} amount {a['amount_yocto']}")
    print(f"after:  block {b['block_height']} keys {len(b['access_keys'])} amount {b['amount_yocto']}")
    for p in problems:
        print("STOP:", p)
    print("RESULT:", "UNCHANGED — no new keys, permissions or costs" if not problems else "CHANGED — stop the test and report")
    sys.exit(0 if not problems else 1)


if __name__ == "__main__":
    main()
