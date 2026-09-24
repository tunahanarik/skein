"""1e: execution data. QuoterV2.quoteExactInputSingle (v3) and V4Quoter.quoteExactInputSingle (v4) via eth_call; price impact vs mid."""
import json
from common import *
from eth_abi import encode, decode

Q2 = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"
Q4 = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94"
SV = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"
USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"
WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"
V3POOL = "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3"  # USDG(t0)/NVDA(t1) fee 500
V3WETH = "0x62ab521f71431f78ac374cdbadc6cda3c8916b6c"  # WETH(t0)/NVDA(t1) fee 500
SIG2 = "quoteExactInputSingle((address,address,uint256,uint24,uint160))"
SIG4 = "quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))"
print("V3 sel", sel(SIG2).hex(), "V4 sel", sel(SIG4).hex())

def q2(tin, tout, amt, fee):
    return ecall(Q2, cd(SIG2, ["(address,address,uint256,uint24,uint160)"], [(tin, tout, amt, fee, 0)]))
def q4(key, z41, amt, hookdata=b""):
    return ecall(Q4, cd(SIG4, ["((address,address,uint24,int24,address),bool,uint128,bytes)"], [(key, z41, amt, hookdata)]))

K_hookless = (USDG, NVDA, 3000, 60, "0x0000000000000000000000000000000000000000")          # poolId 0x3bb34a...
K_hooked = (USDG, NVDA, 8388608, 10, "0x66622f77b797d506e5376f7798b67ab288966080")         # poolId 0x7990aa... (dynamic fee hook)
# sanity: poolId = keccak(abi.encode(PoolKey))
for k in (K_hookless, K_hooked):
    print("poolId", "0x" + k256(encode(["address", "address", "uint24", "int24", "address"], list(k))).hex())

sizes_usdg = [1_000, 10_000, 100_000]
blk = int(rpc("eth_blockNumber", [])["result"], 16)
tag = hex(blk)
def at(c):  # pin to block
    m, p = c; p = list(p); p[1] = tag; return (m, p)

calls = [at(ecall(V3POOL, cd("slot0()"))), at(ecall(V3WETH, cd("slot0()"))),
         at(ecall(SV, cd("getSlot0(bytes32)") + bytes.fromhex("3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1"))),
         at(ecall(SV, cd("getSlot0(bytes32)") + bytes.fromhex("7990aad9e8fb048f49a155a7df5603db0366f0657035b78eb4196395cccb3dcd")))]
for s in sizes_usdg:
    calls.append(at(q2(USDG, NVDA, s * 10**6, 500)))
r = batch(calls)
res = {"block": blk, "v3": [], "v4": [], "raw_errors": []}
def sp_of(x): return decode(["uint160"], bytes.fromhex(x["result"][2:66]))[0]
mid_v3 = 1 / ((sp_of(r[0]) / 2**96) ** 2 * 10 ** (6 - 18))            # USDG per NVDA
mid_v3w = (sp_of(r[1]) / 2**96) ** 2                                     # NVDA per WETH (both 18d)
mid_v4a = 1 / ((sp_of(r[2]) / 2**96) ** 2 * 10 ** (6 - 18))
mid_v4b = 1 / ((sp_of(r[3]) / 2**96) ** 2 * 10 ** (6 - 18))
res["mid"] = {"v3_0.05%_USDG_per_NVDA": mid_v3, "v3_WETH_0.05%_NVDA_per_WETH": mid_v3w, "v4_0.3%_USDG_per_NVDA": mid_v4a, "v4_hooked_USDG_per_NVDA": mid_v4b}
print(res["mid"])
for s, x in zip(sizes_usdg, r[4:]):
    if "error" in x: res["raw_errors"].append({"v3": s, "err": x["error"]}); print("ERR", x["error"]); continue
    out, spa, ticks, gas = decode(["uint256", "uint160", "uint32", "uint256"], bytes.fromhex(x["result"][2:]))
    nv = out / 1e18; ideal = s / mid_v3
    res["v3"].append({"pool": V3POOL, "fee": 500, "in_USDG": s, "out_NVDA": nv, "exec_px": s / nv, "mid": mid_v3,
                      "cost_vs_mid_pct": (1 - nv / ideal) * 100, "impact_ex_fee_pct": (1 - nv / (ideal * (1 - 0.0005))) * 100,
                      "ticksCrossed": ticks, "gasEstimate": gas})
# reverse direction NVDA->USDG and WETH pool
calls = [at(q2(NVDA, USDG, n * 10**18, 500)) for n in (5, 50, 500)] + [at(q2(WETH, NVDA, int(w * 1e18), 500)) for w in (1, 10, 50)]
# v4 quotes: zeroForOne = USDG->NVDA (USDG is currency0)
calls += [at(q4(K_hookless, True, s * 10**6)) for s in sizes_usdg]
calls += [at(q4(K_hooked, True, s * 10**6)) for s in sizes_usdg[:1]]
r = batch(calls)
for n, x in zip((5, 50, 500), r[0:3]):
    if "error" in x: res["raw_errors"].append({"v3rev": n, "err": x["error"]}); continue
    out = decode(["uint256", "uint160", "uint32", "uint256"], bytes.fromhex(x["result"][2:]))
    u = out[0] / 1e6; ideal = n * mid_v3
    res["v3"].append({"pool": V3POOL, "fee": 500, "in_NVDA": n, "out_USDG": u, "exec_px": u / n, "cost_vs_mid_pct": (1 - u / ideal) * 100, "ticksCrossed": out[2], "gasEstimate": out[3]})
for w, x in zip((1, 10, 50), r[3:6]):
    if "error" in x: res["raw_errors"].append({"v3weth": w, "err": x["error"]}); continue
    out = decode(["uint256", "uint160", "uint32", "uint256"], bytes.fromhex(x["result"][2:]))
    nv = out[0] / 1e18; ideal = w * mid_v3w
    res["v3"].append({"pool": V3WETH, "fee": 500, "in_WETH": w, "out_NVDA": nv, "cost_vs_mid_pct": (1 - nv / ideal) * 100, "ticksCrossed": out[2], "gasEstimate": out[3]})
for (s, x, label, mid) in [(s, x, "v4 hookless 0.3% 0x3bb34a", mid_v4a) for s, x in zip(sizes_usdg, r[6:9])] + [(1000, r[9], "v4 hooked dyn-fee 0x7990aa", mid_v4b)]:
    if "error" in x:
        res["raw_errors"].append({"v4": label, "size": s, "err": x["error"]}); print("V4 ERR", label, s, x["error"]); continue
    out, gas = decode(["uint256", "uint256"], bytes.fromhex(x["result"][2:]))
    nv = out / 1e18; ideal = s / mid
    res["v4"].append({"pool": label, "in_USDG": s, "out_NVDA": nv, "exec_px": s / nv if nv else None, "mid": mid, "cost_vs_mid_pct": (1 - nv / ideal) * 100, "gasEstimate": gas})
print(json.dumps(res, indent=1))
save("quotes.json", res)
