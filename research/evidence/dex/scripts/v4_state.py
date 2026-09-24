"""1b cont.: filter discovered v4 pools by live StateView getLiquidity/getSlot0, batched through Multicall3.aggregate3."""
import json, time
from common import *
from eth_abi import encode, decode

MC3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
SV = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"
ME = {"NVDA": "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", "AAPL": "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
      "TSLA": "0x322f0929c4625ed5bad873c95208d54e1c003b2d", "USDG": "0x5fc5360d0400a0fd4f2af552add042d716f1d168"}
BASES = {"0x0000000000000000000000000000000000000000": "ETH", "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "WETH",
         "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG"}
DEC = {"ETH": 18, "WETH": 18, "USDG": 6, "NVDA": 18, "AAPL": 18, "TSLA": 18}

def agg3(calls, blocktag="latest"):
    data = sel("aggregate3((address,bool,bytes)[])") + encode(["(address,bool,bytes)[]"], [[(t, True, c) for t, c in calls]])
    t0 = time.time()
    r = rpc("eth_call", [{"to": MC3, "data": "0x" + data.hex()}, blocktag])
    dt = time.time() - t0
    if "error" in r: raise RuntimeError(r["error"])
    return decode(["(bool,bytes)[]"], bytes.fromhex(r["result"][2:]))[0], dt, len(r["result"])

d = json.load(open("v4_init_NVDA_AAPL_TSLA_USDG.json"))
blk = int(rpc("eth_blockNumber", [])["result"], 16)
blkobj = rpc("eth_getBlockByNumber", [hex(blk), False])["result"]
out = {"block": blk, "timestamp": int(blkobj["timestamp"], 16), "calls": [], "pools": {}}
for k, P in d["pools"].items():
    me = ME[k]
    cand = []
    for p in P:
        o = p["currency1"] if p["currency0"] == me else p["currency0"]
        if k == "NVDA" or o in BASES:   # NVDA: check all pools; others: base-paired only
            cand.append(dict(p, counterpart=o, base=BASES.get(o, "other")))
    res = []
    CH = 400
    for i in range(0, len(cand), CH):
        ch = cand[i:i + CH]
        calls = []
        for p in ch:
            pid = bytes.fromhex(p["poolId"][2:])
            calls.append((SV, sel("getLiquidity(bytes32)") + pid))
            calls.append((SV, sel("getSlot0(bytes32)") + pid))
        r, dt, n = agg3(calls, hex(blk))
        out["calls"].append({"token": k, "subcalls": len(calls), "sec": round(dt, 2), "resp_hex_chars": n})
        print(k, i, len(calls), "subcalls", round(dt, 2), "s", n, "chars")
        for j, p in enumerate(ch):
            okL, bL = r[2 * j]; okS, bS = r[2 * j + 1]
            L = decode(["uint128"], bL)[0] if okL else None
            sp, tick, pf, lpf = decode(["uint160", "int24", "uint24", "uint24"], bS) if okS else (None,) * 4
            if L:
                res.append(dict(p, liquidity=str(L), sqrtPriceX96=str(sp), tick=tick, protocolFee=pf, lpFee=lpf))
    # price & virtual reserves (depth near mid) for base-paired pools
    for p in res:
        if p["base"] == "other": continue
        me0 = p["currency0"] == me
        d0 = DEC[k] if me0 else DEC[p["base"]]; d1 = DEC[p["base"]] if me0 else DEC[k]
        sp = int(p["sqrtPriceX96"]) / 2**96; L = int(p["liquidity"])
        px1per0 = sp * sp * 10 ** (d0 - d1)
        p["price_base_per_token"] = px1per0 if me0 else (1 / px1per0 if px1per0 else None)
        # virtual reserves at current price, in human units: x=L/sqrtP (token0), y=L*sqrtP (token1)
        p["virt_r0"] = L / sp / 10 ** d0 if sp else None
        p["virt_r1"] = L * sp / 10 ** d1
    out["pools"][k] = {"candidates_checked": len(cand), "nonzero_liquidity": len(res), "pools": res}
    print(k, "checked", len(cand), "nonzero L", len(res))
save("v4_state.json", out)
