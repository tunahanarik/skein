"""2c: wallet balance scan without an indexer: Multicall3.aggregate3 of balanceOf over the canonical registry (195 Stock Tokens) + WETH + USDG + native ETH."""
import json, time
from common import *
from common import _post
from eth_abi import encode, decode

MC3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
RHMC = "0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1"
NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"
WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"; USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
TR = topic("Transfer(address,address,uint256)")
reg = json.load(open("rhj_assets.json", encoding="utf8"))["assets"]
toks = []
for a in reg:
    for dpl in a["deployments"]:
        if dpl["chainId"] == 4663:
            toks.append((a["tokenSymbol"], dpl["contractAddress"], a["tokenDecimals"], a.get("currentMultiplier")))
toks += [("WETH", WETH, 18, None), ("USDG", USDG, 6, None)]
print("registry tokens", len(toks))
res = {"registry_count": len(toks)}

# 1) selector presence in the two multicall bytecodes
r = batch([("eth_getCode", [MC3, "latest"]), ("eth_getCode", [RHMC, "latest"])])
SELS = {"aggregate": "252dba42", "tryAggregate": "bce38bd7", "blockAndAggregate": "c3077fa9", "aggregate3": "82ad56cb",
        "aggregate3Value": "174dea71", "getEthBalance": "4d2301cc", "getBlockNumber": "42cbb15c"}
res["selectors"] = {}
for name, x in zip(("Multicall3", "RH_L2_Multicall"), r):
    code = x["result"]
    res["selectors"][name] = {"code_bytes": (len(code) - 2) // 2, **{k: ("63" + v in code) for k, v in SELS.items()}}
print(res["selectors"])

# 2) find NVDA recipients in recent blocks
head = int(rpc("eth_blockNumber", [])["result"], 16)
lg = rpc("eth_getLogs", [{"address": NVDA, "fromBlock": hex(head - 3000), "toBlock": hex(head), "topics": [TR]}])
logs = lg.get("result", [])
tos = []
for L in logs:
    t = "0x" + L["topics"][2][-40:]
    if t not in tos and int(t, 16) != 0: tos.append(t)
print("NVDA transfers in 3000 blocks:", len(logs), "unique recipients", len(tos))
res["nvda_transfer_logs_3000_blocks"] = len(logs)
cand = tos[:60]
codes = []
for i in range(0, len(cand), 10):
    codes += batch([("eth_getCode", [c, "latest"]) for c in cand[i:i + 10]])
eoas = [c for c, x in zip(cand, codes) if x["result"] in ("0x", "0x0")]
print("EOA recipients", len(eoas))

def agg3(target, calls, tag):
    data = sel("aggregate3((address,bool,bytes)[])") + encode(["(address,bool,bytes)[]"], [[(t, True, c) for t, c in calls]])
    body = {"to": target, "data": "0x" + data.hex()}
    t0 = time.time()
    rr, nbytes, dt = _post({"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [body, tag]})
    return rr, nbytes, dt, len(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [body, tag]}))

def scan(addr, subset, target=MC3):
    calls = [(t[1], sel("balanceOf(address)") + encode(["address"], [addr])) for t in subset]
    calls.append((MC3, sel("getEthBalance(address)") + encode(["address"], [addr])))
    rr, nbytes, dt, reqbytes = agg3(target, calls, "latest")
    if "error" in rr: return {"error": rr["error"], "sec": dt}
    out = decode(["(bool,bytes)[]"], bytes.fromhex(rr["result"][2:]))[0]
    bals = {}
    for t, (ok, b) in zip(subset, out[:-1]):
        if ok and len(b) >= 32:
            v = int.from_bytes(b[:32], "big")
            if v: bals[t[0]] = v / 10 ** t[2]
        elif not ok: bals[t[0]] = "FAILED"
    eth = int.from_bytes(out[-1][1][:32], "big") / 1e18
    return {"calls": len(calls), "req_bytes": reqbytes, "resp_bytes": nbytes, "sec": round(dt, 3), "nonzero": bals, "eth": eth}

best = None
for a in eoas[:8]:
    s = scan(a, toks)
    n = len(s.get("nonzero", {}))
    print(a, "nonzero", n, "sec", s.get("sec"), "resp", s.get("resp_bytes"))
    if best is None or n > best[1]: best = (a, n)
addr = best[0]
res["address_used"] = addr
res["scan_50"] = scan(addr, toks[:49])        # 49 balanceOf + 1 getEthBalance = 50 subcalls
res["scan_full"] = scan(addr, toks)           # 197 balanceOf + 1 getEthBalance
res["scan_full_repeat"] = scan(addr, toks)
# 3) RH L2 Multicall: aggregate3 attempt vs aggregate
rr, nb, dt, rq = agg3(RHMC, [(t[1], sel("balanceOf(address)") + encode(["address"], [addr])) for t in toks[:49]], "latest")
res["rhmc_aggregate3"] = {"error": rr.get("error"), "result_prefix": (rr.get("result") or "")[:80], "sec": round(dt, 3)}
data = sel("aggregate((address,bytes)[])") + encode(["(address,bytes)[]"], [[(t[1], sel("balanceOf(address)") + encode(["address"], [addr])) for t in toks[:49]]])
t0 = time.time()
rr = rpc("eth_call", [{"to": RHMC, "data": "0x" + data.hex()}, "latest"])
if "error" in rr:
    res["rhmc_aggregate"] = {"error": rr["error"]}
else:
    bn, rets = decode(["uint256", "bytes[]"], bytes.fromhex(rr["result"][2:]))
    res["rhmc_aggregate"] = {"blockNumber": bn, "n": len(rets), "sec": round(time.time() - t0, 3),
                             "nonzero": sum(1 for b in rets if int.from_bytes(b[:32], "big"))}
# 4) failure mode: aggregate (strict) with one bad call
bad = [(toks[0][1], sel("balanceOf(address)") + encode(["address"], [addr])), (MC3, sel("balanceOf(address)") + encode(["address"], [addr]))]
data = sel("aggregate((address,bytes)[])") + encode(["(address,bytes)[]"], [bad])
rr = rpc("eth_call", [{"to": RHMC, "data": "0x" + data.hex()}, "latest"])
res["rhmc_aggregate_with_nonERC20_target"] = rr.get("error") or rr.get("result")[:140]
print(json.dumps({k: v for k, v in res.items()}, indent=1, default=str)[:6000])
save("balances.json", res)
