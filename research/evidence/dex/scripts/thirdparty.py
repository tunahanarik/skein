"""1d: GeckoTerminal + DexScreener token-pools for NVDA/AAPL/TSLA/USDG (THIRD_PARTY)."""
import json, time
from common import *

T = {"NVDA": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", "AAPL": "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
     "TSLA": "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", "USDG": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"}
meta = []
def get(name, url):
    st, h, raw, dt = http_get(url)
    hk = {k: v for k, v in h.items() if k.lower().startswith(("x-ratelimit", "ratelimit", "retry-after", "cf-cache", "age", "cache-control", "date"))}
    meta.append({"name": name, "url": url, "status": st, "sec": round(dt, 2), "bytes": len(raw), "headers": hk, "fetched_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    print(name, st, len(raw), round(dt, 2), hk)
    with open(name, "wb") as f: f.write(raw)
    time.sleep(2.5)
    return st, raw

for s, a in T.items():
    get(f"gt_{s}_pools_p1.json", f"https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/{a}/pools?page=1")
    get(f"ds_{s}_tokenpairs.json", f"https://api.dexscreener.com/token-pairs/v1/robinhood/{a}")
get("ds_NVDA_latest_tokens.json", f"https://api.dexscreener.com/latest/dex/tokens/{T['NVDA']}")
get("gt_NVDA_token.json", f"https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/{T['NVDA']}")
get("gt_NVDA_pools_p2.json", f"https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/{T['NVDA']}/pools?page=2")
json.dump(meta, open("thirdparty_meta.json", "w"), indent=1)
