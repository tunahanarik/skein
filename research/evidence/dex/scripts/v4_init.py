"""1b: discover Uniswap v4 pools for a token via PoolManager Initialize logs filtered by indexed currency0/currency1 topics."""
import sys, time
from common import *
from eth_abi import decode

PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
T0 = topic("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")
T = {
 "NVDA": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
 "AAPL": "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
 "TSLA": "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
 "USDG": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
}
START = 9070
def pad(a): return "0x" + "0" * 24 + a[2:].lower()

attempts = []
def getlogs(frm, to, topics):
    t0 = time.time()
    r = rpc("eth_getLogs", [{"address": PM, "fromBlock": hex(frm), "toBlock": hex(to), "topics": topics}])
    dt = time.time() - t0
    return r, dt

def scan(topics, head):
    """adaptive: try whole range, split on error."""
    stack = [(START, head)]
    logs = []
    while stack:
        a, b = stack.pop()
        r, dt = getlogs(a, b, topics)
        if "error" in r:
            attempts.append({"from": a, "to": b, "err": r["error"], "sec": round(dt, 2)})
            print("  err", a, b, r["error"].get("message"), round(dt, 1))
            mid = (a + b) // 2
            stack += [(mid + 1, b), (a, mid)]
        else:
            attempts.append({"from": a, "to": b, "n": len(r["result"]), "sec": round(dt, 2)})
            print("  ok", a, b, len(r["result"]), round(dt, 1))
            logs += r["result"]
    return logs

which = sys.argv[1:] or list(T)
head = int(rpc("eth_blockNumber", [])["result"], 16)
out = {"head": head, "pools": {}, "attempts": attempts}
for s in which:
    a = T[s]
    allp = []
    for pos in (2, 3):
        # topics[0]=sig, [1]=poolId, [2]=currency0, [3]=currency1
        topics = [T0, None, pad(a)] if pos == 2 else [T0, None, None, pad(a)]
        print(s, "as currency%d" % (pos - 2))
        logs = scan(topics, head)
        for L in logs:
            fee, ts, hooks, sp, tick = decode(["uint24", "int24", "address", "uint160", "int24"], bytes.fromhex(L["data"][2:]))
            allp.append({"poolId": L["topics"][1], "currency0": "0x" + L["topics"][2][-40:], "currency1": "0x" + L["topics"][3][-40:],
                         "fee": fee, "tickSpacing": ts, "hooks": hooks, "sqrtPriceX96_init": str(sp), "block": int(L["blockNumber"], 16), "tx": L["transactionHash"]})
    out["pools"][s] = allp
    print(s, "total v4 pools", len(allp))
save("v4_init_%s.json" % "_".join(which), out)
