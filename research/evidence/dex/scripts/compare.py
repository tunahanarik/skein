"""1d: synchronized onchain vs GeckoTerminal vs DexScreener for 1 v3 pool + 2 v4 pools.
v4 TVL onchain = replay ModifyLiquidity(poolId indexed) from genesis -> net liquidity per tick range -> token amounts at current sqrtP.
"""
import json, math, time
from common import *
from eth_abi import decode

PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
SV = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"
USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"
TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d"
V3 = "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3"   # NVDA/USDG 0.05% (token0=USDG, token1=NVDA)
V4 = {"NVDA/USDG 0.3% hookless": ("0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1", 6, 18),  # c0=USDG c1=NVDA
      "TSLA/USDG 0.3% hookless": ("0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e", 18, 6)}  # c0=TSLA c1=USDG
ML = topic("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)")
out = {}

def amounts(L, sp, tl, tu):
    sa = math.sqrt(1.0001 ** tl); sb = math.sqrt(1.0001 ** tu)
    if sp <= sa: return L * (sb - sa) / (sa * sb), 0.0
    if sp >= sb: return 0.0, L * (sb - sa)
    return L * (sb - sp) / (sp * sb), L * (sp - sa)

head = int(rpc("eth_blockNumber", [])["result"], 16)
for name, (pid, d0, d1) in V4.items():
    logs = []; stack = [(9070, head)]
    while stack:
        a, b = stack.pop()
        r = rpc("eth_getLogs", [{"address": PM, "fromBlock": hex(a), "toBlock": hex(b), "topics": [ML, pid]}])
        if "error" in r:
            print("  split", a, b, r["error"]["message"]); m = (a + b) // 2; stack += [(m + 1, b), (a, m)]
        else:
            logs += r["result"]
    net = {}
    for L in logs:
        tl, tu, dl, salt = decode(["int24", "int24", "int256", "bytes32"], bytes.fromhex(L["data"][2:]))
        net[(tl, tu)] = net.get((tl, tu), 0) + dl
    out[name] = {"poolId": pid, "modifyLiquidity_logs": len(logs), "head_for_logs": head, "net": net}
    print(name, "ML logs", len(logs), "ranges", len([v for v in net.values() if v]))

# synchronized snapshot: onchain at block B, then GT, DS immediately
calls = [("eth_blockNumber", []),
         ecall(V3, cd("slot0()")), ecall(USDG, cd("balanceOf(address)", ["address"], [V3])), ecall(NVDA, cd("balanceOf(address)", ["address"], [V3]))]
for name, (pid, d0, d1) in V4.items():
    calls.append(ecall(SV, cd("getSlot0(bytes32)") + bytes.fromhex(pid[2:])))
    calls.append(ecall(SV, cd("getLiquidity(bytes32)") + bytes.fromhex(pid[2:])))
calls.append(("eth_getBlockByNumber", ["latest", False]))
r = batch(calls)
B = int(r[0]["result"], 16); ts = int(r[-1]["result"]["timestamp"], 16)
sp3 = decode(["uint160"], bytes.fromhex(r[1]["result"][2:66]))[0]
usdg = int(r[2]["result"], 16) / 1e6; nvda = int(r[3]["result"], 16) / 1e18
px = (sp3 / 2**96) ** 2 * 10 ** (6 - 18)  # NVDA per USDG
nvda_usdg = 1 / px
snap = {"block": B, "ts": ts, "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)),
        "v3": {"pool": V3, "USDG": usdg, "NVDA": nvda, "px_USDG_per_NVDA": nvda_usdg, "tvl_usdg": usdg + nvda * nvda_usdg}}
i = 4
for name, (pid, d0, d1) in V4.items():
    spx = decode(["uint160", "int24", "uint24", "uint24"], bytes.fromhex(r[i]["result"][2:]))
    Lact = int(r[i + 1]["result"], 16); i += 2
    sp = spx[0] / 2**96; tick = spx[1]
    a0 = a1 = 0.0; inrange = 0
    for (tl, tu), L in out[name]["net"].items():
        if L <= 0: continue
        x, y = amounts(L, sp, tl, tu); a0 += x; a1 += y
        if tl <= tick < tu: inrange += L
    a0 /= 10 ** d0; a1 /= 10 ** d1
    p1per0 = sp * sp * 10 ** (d0 - d1)
    snap[name] = {"poolId": pid, "tick": tick, "L_stateview": str(Lact), "L_inrange_from_replay": str(inrange),
                  "replay_matches_stateview": inrange == Lact, "amount0": a0, "amount1": a1, "price_1_per_0": p1per0}
    out[name]["net"] = {f"{k[0]}:{k[1]}": str(v) for k, v in out[name]["net"].items() if v}
print(json.dumps(snap, indent=1))
st, h, raw, dt = http_get(f"https://api.geckoterminal.com/api/v2/networks/robinhood/pools/multi/{V3},{V4['NVDA/USDG 0.3% hookless'][0]},{V4['TSLA/USDG 0.3% hookless'][0]}")
gt = json.loads(raw) if st == 200 else {"status": st, "body": raw.decode()[:300]}
st2, h2, raw2, dt2 = http_get(f"https://api.dexscreener.com/latest/dex/pairs/robinhood/{V3},{V4['NVDA/USDG 0.3% hookless'][0]},{V4['TSLA/USDG 0.3% hookless'][0]}")
ds = json.loads(raw2) if st2 == 200 else {"status": st2, "body": raw2.decode()[:300]}
snap["gt_fetch_utc"] = h.get("Date"); snap["ds_fetch_utc"] = h2.get("Date")
snap["gt"] = [{"addr": p["attributes"]["address"], "name": p["attributes"]["name"], "reserve_in_usd": p["attributes"]["reserve_in_usd"],
               "base_px_usd": p["attributes"]["base_token_price_usd"], "quote_px_usd": p["attributes"]["quote_token_price_usd"]} for p in gt.get("data", [])] if "data" in gt else gt
snap["ds"] = [{"addr": p["pairAddress"], "liq": p.get("liquidity"), "priceUsd": p.get("priceUsd"), "base": p["baseToken"]["symbol"], "quote": p["quoteToken"]["symbol"]} for p in (ds.get("pairs") or [])] if "pairs" in ds else ds
print(json.dumps({k: snap[k] for k in ("gt_fetch_utc", "ds_fetch_utc", "gt", "ds")}, indent=1))
save("compare.json", {"snapshot": snap, "v4_replay": out})
