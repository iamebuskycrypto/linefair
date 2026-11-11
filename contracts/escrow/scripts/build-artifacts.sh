#!/usr/bin/env bash
# Build the escrow release WASM and the TEST-ONLY starve WASM without letting
# the starve build touch the qualified release outputs in target/near/.
#
#   release -> target/near/        (cargo-near default, shared cargo target)
#   starve  -> target/near-starve/ (isolated CARGO_TARGET_DIR=target/starve-cargo)
#
# Building the starve feature with the shared target dir rewrites
# target/near/linefair_escrow_abi.json with the starve metadata (2026-11-05).
# Fails closed if the release ABI does not describe the release WASM, if the
# starve WASM equals the release, or (when EXPECT_RELEASE_SHA256 is set) if the
# release SHA-256 differs from the qualified value. Never deploy near-starve/.
#
# Usage (from anywhere):
#   EXPECT_RELEASE_SHA256=470db97b62cd04701e68f6a87d7589dd8af9b8d122b96e4f5e12788d4405f2e1 \
#     contracts/escrow/scripts/build-artifacts.sh
set -euo pipefail
cd "$(dirname "$0")/.."

cargo near build non-reproducible-wasm --locked
CARGO_TARGET_DIR="$PWD/target/starve-cargo" \
  cargo near build non-reproducible-wasm --locked --features test-starve-callback --out-dir target/near-starve

python3 -I - "${EXPECT_RELEASE_SHA256:-}" <<'PY'
import hashlib, json, sys
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58(raw):
    n = int.from_bytes(raw, "big"); out = ""
    while n:
        n, r = divmod(n, 58); out = B58[r] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + out
def digest(p):
    return hashlib.sha256(open(p, "rb").read()).digest()
expect = sys.argv[1]
rel, stv = digest("target/near/linefair_escrow.wasm"), digest("target/near-starve/linefair_escrow.wasm")
rel_abi = json.load(open("target/near/linefair_escrow_abi.json"))["metadata"]["wasm_hash"]
stv_abi = json.load(open("target/near-starve/linefair_escrow_abi.json"))["metadata"]["wasm_hash"]
ok = True
def check(name, cond, detail):
    global ok
    ok &= bool(cond)
    print(f"{'PASS' if cond else 'FAIL'}  {name}  [{detail}]")
check("release ABI describes the release WASM", rel_abi == b58(rel), f"abi={rel_abi} wasm={b58(rel)}")
check("starve ABI describes the starve WASM", stv_abi == b58(stv), f"abi={stv_abi} wasm={b58(stv)}")
check("starve WASM is not the release", rel != stv, "")
if expect:
    check("release SHA-256 == EXPECT_RELEASE_SHA256", rel.hex() == expect, rel.hex())
print(f"release sha256 {rel.hex()}  (code hash {b58(rel)})")
print(f"starve  sha256 {stv.hex()}  (TEST-ONLY, never deploy)")
print("ARTIFACTS OK" if ok else "ARTIFACTS FAILED")
sys.exit(0 if ok else 1)
PY
