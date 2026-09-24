"""1a: Uniswap v3 getPool discovery for NVDA/AAPL/TSLA/USDG vs {WETH, USDG} x fee tiers; read slot0/liquidity/balances."""
from common import *
from eth_abi import decode

F3 = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa"
T = {
 "NVDA": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
 "AAPL": "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
 "TSLA": "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
 "USDG": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
 "WETH": "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
}
FEES = [100, 500, 3000, 10000]
res = {"block": None, "tokens": {}, "pools": []}

# token metadata
calls = []
for s, a in T.items():
    calls.append(ecall(a, cd("decimals()")))
    calls.append(ecall(a, cd("symbol()")))
calls = calls[:10]
r = batch(calls)
for i, s in enumerate(list(T)[:5]):
    d = int(r[2*i]["result"], 16)
    sym = decode(["string"], bytes.fromhex(r[2*i+1]["result"][2:]))[0]
    res["tokens"][s] = {"addr": T[s], "decimals": d, "symbol": sym}
print(res["tokens"])

pairs = []
for s in ["NVDA", "AAPL", "TSLA", "USDG"]:
    for b in ["WETH", "USDG"]:
        if s == b: continue
        for f in FEES:
            pairs.append((s, b, f))
found = []
for i in range(0, len(pairs), 9):
    chunk = pairs[i:i+9]
    calls = [("eth_blockNumber", [])] + [ecall(F3, cd("getPool(address,address,uint24)", ["address","address","uint24"], [T[s], T[b], f])) for s, b, f in chunk]
    r = batch(calls)
    blk = int(r[0]["result"], 16)
    res["block"] = res["block"] or blk
    for (s, b, f), x in zip(chunk, r[1:]):
        addr = "0x" + x["result"][-40:]
        print(blk, s, b, f, addr)
        if int(addr, 16) != 0:
            found.append({"token": s, "base": b, "fee": f, "pool": addr, "getPool_block": blk})

# read state for each found pool
out = []
for p in found:
    pool = p["pool"]
    calls = [("eth_blockNumber", []),
             ecall(pool, cd("slot0()")), ecall(pool, cd("liquidity()")),
             ecall(pool, cd("token0()")), ecall(pool, cd("token1()")),
             ecall(T[p["token"]], cd("balanceOf(address)", ["address"], [pool])),
             ecall(T[p["base"]], cd("balanceOf(address)", ["address"], [pool])),
             ("eth_getBlockByNumber", ["latest", False])]
    r = batch(calls)
    blk = int(r[0]["result"], 16)
    s0 = decode(["uint160","int24","uint16","uint16","uint16","uint8","bool"], bytes.fromhex(r[1]["result"][2:]))
    L = int(r[2]["result"], 16)
    t0 = "0x" + r[3]["result"][-40:]; t1 = "0x" + r[4]["result"][-40:]
    balT = int(r[5]["result"], 16); balB = int(r[6]["result"], 16)
    ts = int(r[7]["result"]["timestamp"], 16); bn2 = int(r[7]["result"]["number"], 16)
    dT = res["tokens"][p["token"]]["decimals"]; dB = res["tokens"][p["base"]]["decimals"]
    d0, d1 = (dT, dB) if t0.lower() == T[p["token"]].lower() else (dB, dT)
    sp = s0[0]
    price1per0 = (sp / 2**96) ** 2 * 10 ** (d0 - d1)  # token1 per token0 (human units)
    tok_is_0 = t0.lower() == T[p["token"]].lower()
    price_base_per_token = price1per0 if tok_is_0 else (1 / price1per0 if price1per0 else 0)
    rec = dict(p, block=blk, block_ts=ts, latest_block_obj=bn2, token0=t0, token1=t1, sqrtPriceX96=str(sp), tick=s0[1],
               unlocked=s0[6], liquidity=str(L), bal_token=balT / 10**dT, bal_base=balB / 10**dB,
               price_base_per_token=price_base_per_token)
    print(rec)
    out.append(rec)
res["pools"] = out
save("v3_pools.json", res)
