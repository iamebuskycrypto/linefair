#!/usr/bin/env python3
"""LineFair testnet deployment preflight (F4, founder decision 2026-11-05).

Read-only: uses public JSON-RPC queries only. Never reads, prints or needs a
private key. Fails closed: exit code 0 only if every check passes.

Usage:
  python3 -I deploy/testnet_preflight.py --config deploy/testnet.config.json --phase pre --wasm contracts/escrow/target/near/linefair_escrow.wasm
  python3 -I deploy/testnet_preflight.py --config deploy/testnet.config.json --phase post

`expected_chain_id` must be "testnet". Any other value is refused unless the
environment variable LINEFAIR_PREFLIGHT_ALLOW_NON_TESTNET=1 is set, which is
only for running this script against a local sandbox in tests. The override
is honoured only when `rpc_url` is a loopback address (127.0.0.1, ::1,
localhost), never for "mainnet", is ignored when "testnet" is expected, and a
run that used it ends with "PASSED (SANDBOX TEST MODE, NOT VALID FOR
DEPLOYMENT)" so it can never be mistaken for a deployment preflight.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request

NO_CODE_HASH = "11111111111111111111111111111111"
NAMED_RE = re.compile(r"^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$")
NEAR_IMPLICIT_RE = re.compile(r"^[0-9a-f]{64}$")
ETH_IMPLICIT_RE = re.compile(r"^0x[0-9a-f]{40}$")
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
YOCTO = 10**24
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def b58encode(raw: bytes) -> str:
    n = int.from_bytes(raw, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + out


def account_id_kind(a: str):
    """'named', 'implicit', 'eth-implicit' or None (invalid)."""
    if not isinstance(a, str) or not 2 <= len(a) <= 64:
        return None
    if NEAR_IMPLICIT_RE.match(a):
        return "implicit"
    if ETH_IMPLICIT_RE.match(a):
        return "eth-implicit"
    if NAMED_RE.match(a):
        return "named"
    return None


class Rpc:
    def __init__(self, url):
        self.url = url

    def call(self, method, params):
        body = json.dumps({"jsonrpc": "2.0", "id": "lf", "method": method, "params": params}).encode()
        req = urllib.request.Request(self.url, body, {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            resp = json.loads(r.read())
        if "error" in resp:
            raise RuntimeError(json.dumps(resp["error"])[:300])
        return resp["result"]

    def query(self, params):
        return self.call("query", dict(params, finality="final"))

    def view_account(self, a):
        return self.query({"request_type": "view_account", "account_id": a})

    def view_state_empty(self, a):
        r = self.query({"request_type": "view_state", "account_id": a, "prefix_base64": ""})
        return len(r.get("values", [])) == 0

    def access_keys(self, a):
        return self.query({"request_type": "view_access_key_list", "account_id": a})["keys"]

    def view_fn(self, contract, method, args):
        r = self.query({"request_type": "call_function", "account_id": contract, "method_name": method,
                        "args_base64": base64.b64encode(json.dumps(args).encode()).decode()})
        return json.loads(bytes(r["result"]).decode() or "null")


class Report:
    def __init__(self):
        self.rows = []
        self.test_mode = False

    def check(self, name, ok, detail=""):
        self.rows.append((bool(ok), name, detail))
        return bool(ok)

    def failed(self):
        return [r for r in self.rows if not r[0]]


def sha_hex_to_code_hash(hex_digest):
    return b58encode(bytes.fromhex(hex_digest))


def check_artifact(cfg, path, rep):
    """Pre-deploy: the local WASM about to be deployed must be the qualified
    release build (full 64-hex SHA-256), never a forbidden (e.g. starve) build."""
    with open(path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    forbidden = set(cfg.get("forbidden_escrow_wasm_sha256", []))
    rep.check("artifact: not a forbidden build (test-only starve WASM)", digest not in forbidden, digest)
    rep.check("artifact: SHA-256 == qualified release WASM", digest == cfg["expected_escrow_wasm_sha256"], digest)


def run(cfg, phase, rpc, rep):
    # 1. Network.
    expected = cfg.get("expected_chain_id")
    if expected != "testnet":
        if os.environ.get("LINEFAIR_PREFLIGHT_ALLOW_NON_TESTNET") != "1":
            rep.check("config: expected_chain_id is testnet", False, f"got {expected!r}")
            return
        if expected == "mainnet":
            rep.check("config: test override never applies to mainnet", False, f"got {expected!r}")
            return
        host = urllib.parse.urlparse(str(cfg.get("rpc_url"))).hostname
        if host not in LOOPBACK_HOSTS:
            rep.check("config: test override only with a loopback sandbox RPC", False, f"rpc host {host!r}")
            return
        rep.test_mode = True
        rep.check("SANDBOX TEST MODE: override active; this run is NOT a deployment preflight", True,
                  f"expected_chain_id={expected!r} rpc host={host!r}")
    chain = rpc.call("status", [])["chain_id"]
    if not rep.check("network: RPC chain_id matches", chain == expected, f"rpc={chain} expected={expected}"):
        return
    rep.check("config: network_id is testnet", cfg.get("network_id") == "testnet" or expected != "testnet",
              f"network_id={cfg.get('network_id')}")

    # 2. Account ids: syntax, distinctness, existence, balances.
    roles = cfg["roles"]
    named = {"escrow": cfg["escrow_account_id"], "ft": cfg["ft_account_id"],
             "treasury": cfg["operator_treasury_id"], "operator": cfg["operator_account_id"],
             **{f"role:{k}": v for k, v in roles.items()}}
    creators = cfg["creator_allowlist"]
    for label, a in list(named.items()) + [(f"creator[{i}]", c) for i, c in enumerate(creators)]:
        kind = account_id_kind(a)
        rep.check(f"account id valid: {label}", kind is not None, f"{a} ({kind})")
    four = [roles["buyer"], roles["supplier"], roles["primary"], roles["backup"]]
    rep.check("roles: buyer/supplier/primary/backup distinct (FD-05)", len(set(four)) == 4)
    reserved = {cfg["escrow_account_id"], cfg["ft_account_id"], cfg["operator_treasury_id"]}
    rep.check("roles: none is escrow/ft/treasury", not (set(four) & reserved))
    rep.check("escrow, ft, treasury distinct", len(reserved) == 3)
    rep.check("creator_allowlist: 1..=10 entries", 1 <= len(creators) <= 10, str(len(creators)))
    rep.check("creator_allowlist: distinct", len(set(creators)) == len(creators))
    rep.check("creator_allowlist: no escrow/ft/treasury", not (set(creators) & reserved))
    rep.check("creator_allowlist: contains the buyer used in the demo", roles["buyer"] in creators)
    mins = cfg["min_balances_near"]
    for label, a in list(named.items()) + [(f"creator[{i}]", c) for i, c in enumerate(creators)]:
        try:
            acc = rpc.view_account(a)
        except Exception as e:
            rep.check(f"exists: {label}", False, f"{a}: {e}")
            continue
        rep.check(f"exists: {label}", True, a)
        need = mins.get(label.split(":")[0] if label.startswith("role:") else label)
        if label.startswith("role:"):
            need = mins.get("role")
        if need is not None:
            have = int(acc["amount"]) / YOCTO
            rep.check(f"balance >= {need} NEAR: {label}", have >= need, f"{have:.4f} NEAR")
        if label == "escrow":
            if phase == "pre":
                rep.check("escrow: no contract code yet", acc["code_hash"] == NO_CODE_HASH, acc["code_hash"])
                rep.check("escrow: no contract state (never redeploy onto state, F6)", rpc.view_state_empty(a))
            else:
                want = sha_hex_to_code_hash(cfg["expected_escrow_wasm_sha256"])
                rep.check("escrow: on-chain code hash == qualified release WASM", acc["code_hash"] == want,
                          f"chain={acc['code_hash']} expected={want}")
            keys = rpc.access_keys(a)
            full = [k for k in keys if k["access_key"]["permission"] == "FullAccess"]
            rep.check("escrow: access keys reported (no deletion by this tool)", True,
                      f"{len(keys)} keys, {len(full)} full-access")
            if phase == "pre":
                rep.check("escrow: has a full-access key to deploy with", len(full) >= 1)
        if label == "ft":
            want = sha_hex_to_code_hash(cfg["expected_ft_wasm_sha256"])
            rep.check("ft: on-chain code hash == pinned test token", acc["code_hash"] == want,
                      f"chain={acc['code_hash']} expected={want}")

    # 3. Post-deploy contract configuration.
    if phase == "post":
        esc, ft = cfg["escrow_account_id"], cfg["ft_account_id"]
        version = rpc.view_fn(esc, "contract_version", {})
        rep.check("escrow: contract_version exact (never the starve build, F12)",
                  version == cfg["expected_contract_version"], repr(version))
        conf = rpc.view_fn(esc, "get_config", {})
        for k, v in [("network_id", cfg["network_id"]), ("allowlisted_ft_id", ft),
                     ("operator_treasury_id", cfg["operator_treasury_id"]),
                     ("max_agreements", cfg["max_agreements"]), ("creator_allowlist", creators)]:
            rep.check(f"get_config.{k} matches", conf.get(k) == v, f"{conf.get(k)!r}")
        cs = rpc.view_fn(esc, "custody_summary", {})
        rep.check("custody_summary readable", isinstance(cs, dict), json.dumps(cs)[:120])
        for label, a in [("escrow", esc)] + [(f"role:{k}", v) for k, v in roles.items()]:
            reg = rpc.view_fn(ft, "storage_balance_of", {"account_id": a})
            rep.check(f"ft registration: {label}", reg is not None, a)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--phase", choices=["pre", "post"], required=True)
    ap.add_argument("--wasm", help="local escrow WASM about to be deployed (required for --phase pre)")
    args = ap.parse_args()
    rep = Report()
    try:
        with open(args.config) as f:
            cfg = json.load(f)
        for k in ["rpc_url", "expected_chain_id", "network_id", "escrow_account_id", "ft_account_id",
                  "operator_treasury_id", "operator_account_id", "roles", "creator_allowlist", "max_agreements",
                  "expected_escrow_wasm_sha256", "expected_ft_wasm_sha256", "expected_contract_version",
                  "min_balances_near"]:
            if k not in cfg:
                raise KeyError(f"missing config key {k}")
        for k in ["expected_escrow_wasm_sha256", "expected_ft_wasm_sha256"]:
            if not re.fullmatch(r"[0-9a-f]{64}", cfg[k]):
                raise ValueError(f"{k} must be a full 64-hex SHA-256")
        if args.phase == "pre":
            if not args.wasm:
                raise ValueError("--wasm <path> is required for --phase pre")
            check_artifact(cfg, args.wasm, rep)
        run(cfg, args.phase, Rpc(cfg["rpc_url"]), rep)
    except Exception as e:  # fail closed on any configuration or RPC problem
        rep.check("preflight completed without error", False, f"{type(e).__name__}: {e}")
    for ok, name, detail in rep.rows:
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""))
    bad = rep.failed()
    verdict = "PASSED" if not bad and rep.rows else "FAILED"
    if verdict == "PASSED" and rep.test_mode:
        verdict = "PASSED (SANDBOX TEST MODE, NOT VALID FOR DEPLOYMENT)"
    print(f"PREFLIGHT {args.phase.upper()} {verdict} "
          f"({len(rep.rows) - len(bad)}/{len(rep.rows)} checks)")
    sys.exit(0 if (rep.rows and not bad) else 1)


if __name__ == "__main__":
    main()
