import json, time, urllib.request, urllib.error, os
from Crypto.Hash import keccak
from eth_abi import encode, decode

RPC = "https://rpc.mainnet.chain.robinhood.com"
OUT = os.path.dirname(os.path.abspath(__file__))
_last = [0.0]
LOG = []

def k256(b):
    k = keccak.new(digest_bits=256); k.update(b); return k.digest()

def sel(sig):
    return k256(sig.encode())[:4]

def topic(sig):
    return "0x" + k256(sig.encode()).hex()

def _post(body, timeout=60):
    # pace: >=1.25s between requests
    dt = time.time() - _last[0]
    if dt < 1.25: time.sleep(1.25 - dt)
    for attempt in range(6):
        _last[0] = time.time()
        req = urllib.request.Request(RPC, data=json.dumps(body).encode(),
                                     headers={"content-type": "application/json", "user-agent": "phase0-research/0.1"})
        try:
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
            return json.loads(raw), len(raw), time.time() - t0
        except urllib.error.HTTPError as e:
            if e.code == 429:
                w = 3 * (2 ** attempt); print(f"429, backoff {w}s"); time.sleep(w); continue
            raise
    raise RuntimeError("too many 429s")

def rpc(method, params):
    r, n, t = _post({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    return r

def batch(calls):
    """calls: list of (method, params); max 10 each"""
    assert len(calls) <= 10
    body = [{"jsonrpc": "2.0", "id": i, "method": m, "params": p} for i, (m, p) in enumerate(calls)]
    r, n, t = _post(body)
    if isinstance(r, dict):
        raise RuntimeError(r)
    r = sorted(r, key=lambda x: x["id"])
    return r

def ecall(to, data, block="latest"):
    return ("eth_call", [{"to": to, "data": "0x" + data.hex() if isinstance(data, (bytes, bytearray)) else data}, block])

def cd(sig, types=None, args=None):
    s = sel(sig)
    if types:
        return s + encode(types, args)
    return s

def save(name, obj):
    p = os.path.join(OUT, name)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1, default=str)
    return p

def http_get(url, headers=None, timeout=30):
    h = {"user-agent": "phase0-research/0.1", "accept": "application/json"}
    if headers: h.update(headers)
    req = urllib.request.Request(url, headers=h)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(); return r.status, dict(r.headers), raw, time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(), time.time() - t0

def http_post(url, obj, headers=None, timeout=30):
    h = {"user-agent": "phase0-research/0.1", "content-type": "application/json", "accept": "application/json"}
    if headers: h.update(headers)
    req = urllib.request.Request(url, data=json.dumps(obj).encode(), headers=h)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(); return r.status, dict(r.headers), raw, time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(), time.time() - t0
