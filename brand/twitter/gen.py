import pathlib
root = pathlib.Path(__file__).resolve().parents[2]
fm = (root/"node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2").as_uri()
fi = (root/"node_modules/@fontsource-variable/inter-tight/files/inter-tight-latin-wght-normal.woff2").as_uri()
BASE = f"""<meta charset=utf-8><style>
@font-face{{font-family:M;src:url({fm}) format('woff2');font-weight:100 900}}
@font-face{{font-family:I;src:url({fi}) format('woff2');font-weight:100 900}}
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{overflow:hidden;background:#060706;color:#DFE4DC;font-family:I}}
.m{{font-family:M}} .l{{color:#C8F169}} .mu{{color:#8D948A}} .fa{{color:#5A6158}}
.grid{{position:absolute;inset:0;background-image:linear-gradient(#11150F 1px,transparent 1px),linear-gradient(90deg,#11150F 1px,transparent 1px);background-size:50px 50px}}
</style>"""

pages = {}
# Profile A: lime tile, dark s/
pages["profile-lime"] = (400, 400, BASE + """
<div style="width:400px;height:400px;background:#C8F169;display:grid;place-items:center">
 <div class=m style="font-size:196px;font-weight:800;color:#0A0F04;letter-spacing:-14px;margin-left:-10px;margin-top:-14px">s/</div>
</div>""")
# Profile B: dark, lime slash, grid
pages["profile-dark"] = (400, 400, BASE + """
<div style="position:relative;width:400px;height:400px;display:grid;place-items:center">
 <div class=grid style="opacity:.9;-webkit-mask:radial-gradient(circle at 50% 50%,#000 40%,transparent 72%)"></div>
 <div style="position:absolute;width:250px;height:250px;border-radius:50%;background:radial-gradient(circle,#C8F16922,transparent 70%)"></div>
 <div class=m style="position:relative;font-size:196px;font-weight:800;letter-spacing:-14px;margin-left:-10px;margin-top:-14px">s<span class=l>/</span></div>
</div>""")
# Header A: wallet readout (the product's core: read a wallet, find what each asset can do)
ROWS = [
  ("NVDA","STOCK TOKEN","IDLE","EARN","Morpho"),
  ("USDG","STABLECOIN","IDLE","LEND","Spark"),
  ("WETH","CRYPTO","IN USE","POOL","Uniswap"),
  ("cbBTC","CRYPTO","IDLE","BORROW AGAINST","Morpho"),
]
def row(sym,kind,st,act,proto):
    idle = st=="IDLE"
    return f"""<div style="display:grid;grid-template-columns:44px 150px 96px 1fr;align-items:center;gap:0 14px;padding:10px 18px;border-top:1px solid #161A15">
 <span class=m style="width:34px;height:34px;display:grid;place-items:center;border:1px solid #2A2F28;font-size:11px;font-weight:700;color:#C8F169">{sym[:2].upper()}</span>
 <span><b class=m style="font-size:17px">{sym}</b><br><span class="m fa" style="font-size:10.5px;letter-spacing:1.6px">{kind}</span></span>
 <span class=m style="font-size:11px;letter-spacing:1.6px;padding:4px 8px;justify-self:start;{'color:#0A0F04;background:#E8B44C' if idle else 'color:#8D948A;border:1px solid #2A2F28'}">{st}</span>
 <span class=m style="font-size:14px;text-align:right"><span class=l>→</span> {act} <span class=mu>· {proto}</span></span>
</div>"""
pages["header-wallet"] = (1500, 500, BASE + """
<div style="position:relative;width:1500px;height:500px">
 <div class=grid style="-webkit-mask:linear-gradient(90deg,transparent 10%,#000 55%)"></div>
 <div style="position:absolute;right:-60px;top:-200px;width:820px;height:820px;border-radius:50%;background:radial-gradient(circle,#C8F16912,transparent 62%)"></div>

 <div style="position:absolute;left:96px;top:52px;width:640px">
  <div class=m style="font-size:12.5px;letter-spacing:3px;color:#8D948A"><span class=l>●</span>&nbsp; WALLET RESEARCH · ROBINHOOD CHAIN</div>
  <div class=m style="font-size:84px;font-weight:800;letter-spacing:-5px;line-height:1;margin-top:20px">skein<span class=l>/</span></div>
  <div style="font-size:40px;font-weight:700;letter-spacing:-1px;line-height:1.12;margin-top:22px">See what any wallet<br>could be <span class=l>doing.</span></div>
 </div>

 <div style="position:absolute;right:84px;top:56px;width:610px;border:1px solid #2A2F28;background:#090B09f2;box-shadow:0 30px 80px #0008">
  <div class=m style="display:flex;gap:12px;align-items:center;padding:13px 18px;font-size:11.5px;letter-spacing:2px;color:#8D948A">
   <span style="width:9px;height:9px;background:#C8F169"></span>WALLET READOUT<span style="flex:1"></span><span class=fa>0x ···· ····</span>
  </div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid #1C201B">
   <div style="padding:12px 18px;border-right:1px solid #1C201B"><div class="m fa" style="font-size:10.5px;letter-spacing:2px">ASSETS</div><div class=m style="font-size:24px;font-weight:700;margin-top:3px">4</div></div>
   <div style="padding:12px 18px;border-right:1px solid #1C201B"><div class="m fa" style="font-size:10.5px;letter-spacing:2px">IDLE</div><div class=m style="font-size:24px;font-weight:700;margin-top:3px;color:#E8B44C">3</div></div>
   <div style="padding:12px 18px"><div class="m fa" style="font-size:10.5px;letter-spacing:2px">PROTOCOLS CHECKED</div><div class=m style="font-size:24px;font-weight:700;margin-top:3px" ><span class=l>7</span></div></div>
  </div>
  """ + "".join(row(*r) for r in ROWS) + """
 </div>

 <div class=m style="position:absolute;right:84px;bottom:22px;width:610px;display:flex;justify-content:space-between;font-size:11px;letter-spacing:2.4px;color:#5A6158">
  <span>CHAINLINK PRICED</span><span>·</span><span>READ ONLY</span><span>·</span><span>NO SIGN UP</span><span>·</span><span class=l>● LIVE</span>
 </div>
</div>""")

# Header B: the map. One wallet, its assets, the threads to every way they can be used.
def node(x,y,w,txt,sub="",hi=False):
    return f"""<div class=m style="position:absolute;left:{x}px;top:{y}px;width:{w}px;height:46px;display:flex;align-items:center;gap:10px;padding:0 14px;border:1px solid {'#C8F169' if hi else '#2A2F28'};background:{'#C8F169' if hi else '#0A0C0A'};color:{'#0A0F04' if hi else '#DFE4DC'};font-size:15px;font-weight:700;letter-spacing:.5px">{txt}<span style="flex:1"></span><span style="font-size:10.5px;letter-spacing:1.8px;font-weight:500;color:{'#0A0F04aa' if hi else '#5A6158'}">{sub}</span></div>"""
W_X, A_X, O_X = 560, 830, 1150
assets = [("NVDA","STOCK",80),("USDG","STABLE",156),("WETH","CRYPTO",232),("TSLA","STOCK",308),("cbBTC","CRYPTO",384)]
opps = [("EARN","Morpho · Beefy",70),("LEND","Spark",142),("BORROW","Morpho",214),("POOL","Uniswap · Ramses",286),("FIXED","Pendle",358),("TRADE","Uniswap",430)]
links = [(0,0),(0,2),(0,3),(1,1),(1,0),(1,4),(2,3),(2,2),(2,5),(3,4),(3,0),(4,2),(4,1),(4,5),(0,5)]
paths = []
wy = 250
for _,_,y in assets:
    paths.append(f'<path d="M{W_X+210} {wy} C {W_X+250} {wy}, {A_X-60} {y+23}, {A_X} {y+23}" stroke="#C8F169" stroke-opacity=".55"/>')
for a,o in links:
    y1 = assets[a][2]+23; y2 = opps[o][2]+23
    paths.append(f'<path d="M{A_X+200} {y1} C {A_X+260} {y1}, {O_X-60} {y2}, {O_X} {y2}" stroke="#C8F169" stroke-opacity="{0.6 if a in (0,1) else 0.22}"/>')
pages["header-map"] = (1500, 500, BASE + f"""
<div style="position:relative;width:1500px;height:500px">
 <div class=grid style="-webkit-mask:linear-gradient(90deg,transparent 25%,#000 70%)"></div>
 <svg width=1500 height=500 style="position:absolute;inset:0" fill=none stroke-width=1.5>{''.join(paths)}</svg>
 <div style="position:absolute;left:96px;top:52px;width:440px">
  <div class=m style="font-size:12.5px;letter-spacing:3px;color:#8D948A"><span class=l>●</span>&nbsp; ROBINHOOD CHAIN</div>
  <div class=m style="font-size:84px;font-weight:800;letter-spacing:-5px;line-height:1;margin-top:20px">skein<span class=l>/</span></div>
  <div style="font-size:34px;font-weight:700;letter-spacing:-.8px;line-height:1.15;margin-top:22px">Every asset.<br>Every way to <span class=l>use it.</span></div>
 </div>
 {node(W_X,227,210,"WALLET","0x ····",True)}
 {''.join(node(A_X,y,200,s,k) for s,k,y in assets)}
 {''.join(node(O_X,y,250,s,p) for s,p,y in opps)}
 <div class="m fa" style="position:absolute;left:{W_X}px;top:200px;font-size:10.5px;letter-spacing:2px">PASTE</div>
 <div class="m fa" style="position:absolute;left:{A_X}px;top:52px;font-size:10.5px;letter-spacing:2px">READ</div>
 <div class="m fa" style="position:absolute;left:{O_X}px;top:42px;font-size:10.5px;letter-spacing:2px">FIND</div>
</div>""")


# Header B on lime: same map on the profile's lime. Dark tiles carry the text; the headline is two tones.
D, INK, OLIVE, PAPER = "#0B1405", "#E9F5CF", "#4A6418", "#F5FBE6"
def lnode(x,y,w,txt,sub="",hi=False):
    bg, fg, sc, bd = (PAPER, D, OLIVE, D) if hi else (D, INK, "#C8F169", D)
    return f"""<div class=m style="position:absolute;left:{x}px;top:{y}px;width:{w}px;height:46px;display:flex;align-items:center;gap:10px;padding:0 15px;border:1.5px solid {bd};background:{bg};color:{fg};font-size:14.5px;font-weight:600;letter-spacing:.6px;box-shadow:0 10px 24px #3A4D0F2e">{txt}<span style="flex:1"></span><span style="font-size:10.5px;letter-spacing:1.6px;font-weight:500;color:{sc};opacity:.85">{sub}</span></div>"""
lpaths = []
for _,_,y in assets:
    lpaths.append(f'<path d="M{W_X+210} {wy} C {W_X+250} {wy}, {A_X-60} {y+23}, {A_X} {y+23}" stroke="{D}" stroke-opacity=".55"/>')
for a_,o in links:
    y1 = assets[a_][2]+23; y2 = opps[o][2]+23
    lpaths.append(f'<path d="M{A_X+200} {y1} C {A_X+260} {y1}, {O_X-60} {y2}, {O_X} {y2}" stroke="{D}" stroke-opacity="{0.55 if a_ in (0,1) else 0.2}"/>')
pages["header-map-lime"] = (1500, 500, BASE + f"""
<style>body{{-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}}</style>
<div style="position:relative;width:1500px;height:500px;background:radial-gradient(120% 140% at 0% 0%,#D3F57E,#C8F169 45%,#BDE85C);color:{D}">
 <div style="position:absolute;inset:0;background-image:linear-gradient({D}0d 1px,transparent 1px),linear-gradient(90deg,{D}0d 1px,transparent 1px);background-size:50px 50px;-webkit-mask:linear-gradient(90deg,transparent 25%,#000 70%)"></div>
 <svg width=1500 height=500 style="position:absolute;inset:0" fill=none stroke-width=1.4 stroke-linecap=round>{''.join(lpaths)}</svg>
 <div style="position:absolute;left:96px;top:52px;width:440px">
  <div class=m style="font-size:12px;letter-spacing:3.2px;font-weight:500;color:{OLIVE}"><span style="display:inline-block;width:7px;height:7px;background:{D};vertical-align:1px;margin-right:12px"></span>ROBINHOOD CHAIN</div>
  <div class=m style="font-size:80px;font-weight:700;letter-spacing:-4.5px;line-height:1;margin-top:20px">skein<span style="color:{OLIVE}">/</span></div>
  <div style="font-size:35px;font-weight:600;letter-spacing:-1.1px;line-height:1.14;margin-top:24px">Every asset.<br><span style="color:{OLIVE}">Every way to use it.</span></div>
 </div>
 {lnode(W_X,227,210,"WALLET","0x ····",True)}
 {''.join(lnode(A_X,y,200,s_,k) for s_,k,y in assets)}
 {''.join(lnode(O_X,y,250,s_,p) for s_,p,y in opps)}
 <div class=m style="position:absolute;left:{W_X}px;top:200px;font-size:10.5px;letter-spacing:2.4px;font-weight:500;color:{OLIVE}">PASTE</div>
 <div class=m style="position:absolute;left:{A_X}px;top:52px;font-size:10.5px;letter-spacing:2.4px;font-weight:500;color:{OLIVE}">READ</div>
 <div class=m style="position:absolute;left:{O_X}px;top:42px;font-size:10.5px;letter-spacing:2.4px;font-weight:500;color:{OLIVE}">FIND</div>
</div>""")

# Terminal header on lime, same treatment as header-map-lime: dark panel, two tone headline.
pages["header-terminal-lime"] = (1500, 500, BASE + f"""
<style>body{{-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}}</style>
<div style="position:relative;width:1500px;height:500px;background:radial-gradient(120% 140% at 0% 0%,#D3F57E,#C8F169 45%,#BDE85C);color:{D}">
 <div style="position:absolute;inset:0;background-image:linear-gradient({D}0d 1px,transparent 1px),linear-gradient(90deg,{D}0d 1px,transparent 1px);background-size:50px 50px;-webkit-mask:linear-gradient(90deg,transparent 30%,#000 70%)"></div>
 <div style="position:absolute;left:96px;top:46px;width:640px">
  <div class=m style="font-size:12px;letter-spacing:3.2px;font-weight:500;color:{OLIVE}"><span style="display:inline-block;width:7px;height:7px;background:{D};vertical-align:1px;margin-right:12px"></span>ROBINHOOD CHAIN · 4663</div>
  <div class=m style="font-size:88px;font-weight:700;letter-spacing:-5px;line-height:1;margin-top:18px">skein<span style="color:{OLIVE}">/</span></div>
  <div style="font-size:34px;font-weight:600;letter-spacing:-1px;line-height:1.16;margin-top:24px">Read any wallet.<br><span style="color:{OLIVE}">Find what every asset can do.</span></div>
 </div>
 <div style="position:absolute;right:110px;top:74px;width:570px;background:{D};border:1.5px solid {D};box-shadow:0 24px 50px #3A4D0F45">
  <div class=m style="display:flex;gap:10px;align-items:center;padding:13px 18px;border-bottom:1px solid #1F2A14;font-size:11.5px;letter-spacing:2.2px;color:#8FA36A">
   <span style="width:9px;height:9px;background:#C8F169"></span>TERMINAL<span style="flex:1"></span><span style="color:#5F7040">READ ONLY</span>
  </div>
  <div class=m style="padding:20px 22px 22px;font-size:18.5px;line-height:1.75;color:{INK}">
   <div><span style="color:#C8F169">&gt;</span> read wallet <span style="color:#8FA36A">0x ····</span></div>
   <div style="color:#8FA36A">&nbsp; 4 assets · 3 idle</div>
   <div><span style="color:#C8F169">&gt;</span> earn yield on <b>NVDA</b></div>
   <div style="color:#8FA36A">&nbsp; scanning 7 protocols</div>
   <div><span style="color:#C8F169">&nbsp; ✓</span> lend · pool · fixed rate</div>
   <div><span style="color:#C8F169">&gt;</span> borrow against <b>cbBTC</b><span style="display:inline-block;width:10px;height:21px;background:#C8F169;vertical-align:-4px;margin-left:7px"></span></div>
  </div>
 </div>
 <div class=m style="position:absolute;right:110px;bottom:38px;width:570px;display:flex;justify-content:space-between;font-size:11.5px;letter-spacing:2.4px;font-weight:500;color:{OLIVE}">
  <span>READ</span><span>EARN</span><span>LEND</span><span>BORROW</span><span>POOL</span><span style="color:{D}">● LIVE</span>
 </div>
</div>""")

# ---- Second round: four different concepts ----
import math
AA = "<style>body{-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}</style>"
L_, C_, O_ = "#C8F169", "#E9F5CF", "#6E8F2A"

# C. Braid: three strands (stocks, stables, crypto) woven like a skein. "Untangle any wallet."
def braid(x0=500, x1=1540, y0=290, amp=74, period=330, w=24):
    # Three strands of a helix. Every pair crosses at t = pi/6 + k*pi/3, so the strip is cut into
    # chunks centred on the crossings; inside a chunk the depth order is fixed and drawn back to front.
    cols = [L_, C_, O_]
    k_t = 2 * math.pi / period
    def path(k, xa, xb):
        ph = k * 2 * math.pi / 3
        pts = [f"{x:.1f},{y0 + amp * math.sin((x - x0) * k_t + ph):.1f}" for x in [xa + (xb - xa) * i / 24 for i in range(25)]]
        return "M" + " L".join(pts)
    out = []
    chunk = period / 6
    n = int((x1 - x0) / chunk) + 1
    for i in range(n):
        xa, xb = x0 + i * chunk, x0 + (i + 1) * chunk
        tc = ((xa + xb) / 2 - x0) * k_t
        order = sorted(range(3), key=lambda k: math.cos(tc + k * 2 * math.pi / 3))
        out.append(f'<clipPath id="b{i}"><rect x="{xa:.2f}" y="0" width="{chunk + .4:.2f}" height="500"/></clipPath><g clip-path="url(#b{i})">')
        for k in order:
            d = path(k, xa - 20, xb + 20)
            out.append(f'<path d="{d}" stroke="#060706" stroke-width="{w + 14}" fill="none"/>')
            out.append(f'<path d="{d}" stroke="{cols[k]}" stroke-width="{w}" fill="none"/>')
            out.append(f'<path d="{d}" stroke="#ffffff" stroke-opacity=".22" stroke-width="3" fill="none" transform="translate(0,-6)"/>')
        out.append("</g>")
    return '<defs><linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".22" stop-color="#fff"/></linearGradient><mask id="fm"><rect x="500" y="0" width="1000" height="500" fill="url(#fade)"/></mask></defs><g mask="url(#fm)">' + "".join(out) + "</g>"

def sw(c):
    return f'<span style="display:inline-block;width:10px;height:10px;background:{c};margin-right:9px"></span>'

pages["header-braid"] = (1500, 500, BASE + AA + f"""
<div style="position:relative;width:1500px;height:500px">
 <div class=grid style="opacity:.6;-webkit-mask:linear-gradient(90deg,transparent 30%,#000)"></div>
 <svg width=1500 height=500 style="position:absolute;inset:0">{braid()}</svg>
 <div class=m style="position:absolute;left:600px;top:96px;display:flex;gap:30px;font-size:11.5px;letter-spacing:2.4px;color:#8D948A">
  <span>{sw(L_)}STOCK TOKENS</span><span>{sw(C_)}STABLECOINS</span><span>{sw(O_)}CRYPTO</span>
 </div>
 <div style="position:absolute;left:96px;top:50px;width:460px">
  <div class=m style="font-size:84px;font-weight:700;letter-spacing:-5px;line-height:1">skein<span class=l>/</span></div>
  <div style="font-size:44px;font-weight:600;letter-spacing:-1.4px;line-height:1.08;margin-top:26px">Untangle<br>any <span class=l>wallet.</span></div>
 </div>
</div>""")

# D. Orbit: the wallet in the middle, assets on the first ring, what they can do on the second.
CX, CY = 1110, 250
def chip(x, y, t, kind):
    st = {"asset": f"background:#0A0C0A;border:1px solid #2A2F28;color:{C_}",
          "act": f"background:#060706;border:1px solid {L_}66;color:{L_}"}[kind]
    return f'<div class=m style="position:absolute;left:{x:.0f}px;top:{y:.0f}px;transform:translate(-50%,-50%);padding:7px 12px;font-size:13px;font-weight:600;letter-spacing:1px;{st}">{t}</div>'
def ring(r, items, kind, start):
    return "".join(chip(CX + r * 1.55 * math.cos(start + i * 2 * math.pi / len(items)), CY + r * math.sin(start + i * 2 * math.pi / len(items)), t, kind) for i, t in enumerate(items))
def ell(r, op, dash=""):
    return f'<ellipse cx="{CX}" cy="{CY}" rx="{r * 1.55}" ry="{r}" fill="none" stroke="{L_}" stroke-opacity="{op}" {dash}/>'

pages["header-orbit"] = (1500, 500, BASE + AA + f"""
<div style="position:relative;width:1500px;height:500px;overflow:hidden">
 <div style="position:absolute;left:{CX - 300}px;top:{CY - 300}px;width:600px;height:600px;border-radius:50%;background:radial-gradient(circle,{L_}1c,transparent 60%)"></div>
 <svg width=1500 height=500 style="position:absolute;inset:0">{ell(95, .35)}{ell(190, .22, 'stroke-dasharray="3 6"')}{ell(285, .12)}</svg>
 {ring(95, ["NVDA", "USDG", "WETH", "cbBTC"], "asset", -math.pi / 2 + 0.4)}
 {ring(190, ["EARN", "LEND", "BORROW", "POOL", "FIXED", "TRADE"], "act", -math.pi / 2)}
 <div class=m style="position:absolute;left:{CX}px;top:{CY}px;transform:translate(-50%,-50%);width:84px;height:84px;display:grid;place-items:center;background:{L_};color:#0A0F04;font-size:34px;font-weight:800;letter-spacing:-3px;box-shadow:0 0 60px {L_}55">s/</div>
 <div style="position:absolute;left:96px;top:46px;width:520px">
  <div class=m style="font-size:12.5px;letter-spacing:3px;color:#8D948A"><span class=l>●</span>&nbsp; WALLET RESEARCH</div>
  <div class=m style="font-size:84px;font-weight:700;letter-spacing:-5px;line-height:1;margin-top:20px">skein<span class=l>/</span></div>
  <div style="font-size:38px;font-weight:600;letter-spacing:-1.2px;line-height:1.12;margin-top:24px">One wallet.<br><span class=mu>Every option</span> <span class=l>around it.</span></div>
 </div>
</div>""")

# E. Asset wall: tickers on the chain, a few lit up; the wordmark on top.
TICK = [t for t in "AAOI AAPL ABCL ADBE AEHR AEIS ALAB AMAT AMBA AMC AMD AMKR AMZN ANET APLD APP ASML ASTS AUR AVAV AVGO AXON AXTI BABA BND BULL CBRS CCL CEG CELH CIEN CLOV CLSK COHR COIN COST CRCL CRDO CRM CRWD CRWV CSCO CTSH CVNA DDOG DELL DJT DOCN ELF EWT EWY FICO FIG FISV FLNC FTNT FUTU GEV GLD GLW GLXY GME GOOGL HIMS HPE HWM IBM INDA INTC INTU IONQ IREN JNJ JOBY KLAC KTOS LLY LMT LRCX LULU LUNR MDB META MRNA MRVL MSFT MSTR MU NBIS NET NFLX NOW NVDA OKLO ORCL PANW PLTR QBTS QCOM QQQ RBLX RDDT RGTI RIVN RKLB SHOP SLV SMCI SMH SNOW SOFI SOUN SPY TSLA TSM TTD UNH USDG WETH cbBTC USDe VRT VST VTI WDAY XOM ZM".split()]
LITS = {(1, 2): "NVDA", (2, 11): "USDG", (3, 4): "TSLA", (4, 13): "WETH", (7, 12): "cbBTC", (8, 4): "SPY", (1, 13): "AAPL", (6, 10): "GLD", (8, 9): "COIN", (2, 0): "PLTR"}
def wall():
    cells = []
    for r in range(10):
        for c in range(15):
            on = (r, c) in LITS
            t = LITS.get((r, c)) or TICK[(r * 15 + c) * 7 % len(TICK)]
            cells.append(f'<div class=m style="position:absolute;left:{c * 100}px;top:{r * 50}px;width:100px;height:50px;border-right:1px solid #10130F;border-bottom:1px solid #10130F;display:grid;place-items:center;font-size:15px;font-weight:{700 if on else 500};color:{L_ if on else "#2E342C"};{"background:#C8F16912" if on else ""}">{t}</div>')
    return "".join(cells)

pages["header-wall"] = (1500, 500, BASE + AA + f"""
<div style="position:relative;width:1500px;height:500px;overflow:hidden">
 <div style="position:absolute;inset:0;-webkit-mask:radial-gradient(circle at 229px 530px,transparent 250px,#000 360px)">{wall()}</div>
 <div style="position:absolute;inset:0;background:radial-gradient(42% 70% at 50% 50%,#060706f2 45%,#06070600)"></div>
 <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-54%);text-align:center;white-space:nowrap">
  <div class=m style="font-size:12.5px;letter-spacing:3px;color:#8D948A"><span class=l>●</span>&nbsp; ROBINHOOD CHAIN</div>
  <div class=m style="font-size:112px;font-weight:700;letter-spacing:-7px;line-height:1;margin-top:18px">skein<span class=l>/</span></div>
  <div style="font-size:30px;font-weight:600;letter-spacing:-.8px;margin-top:22px">200+ assets. <span class=l>One map.</span></div>
 </div>
</div>""")

# F. Search: the product in one gesture, on lime.
pages["header-search"] = (1500, 500, BASE + AA + f"""
<div style="position:relative;width:1500px;height:500px;background:radial-gradient(120% 140% at 0% 0%,#D3F57E,#C8F169 45%,#BDE85C);color:{D}">
 <div style="position:absolute;inset:0;background-image:linear-gradient({D}0d 1px,transparent 1px),linear-gradient(90deg,{D}0d 1px,transparent 1px);background-size:50px 50px;-webkit-mask:radial-gradient(70% 90% at 50% 50%,transparent 30%,#000)"></div>
 <div style="position:absolute;left:50%;top:58px;transform:translateX(-50%);width:900px;text-align:center">
  <div class=m style="font-size:76px;font-weight:700;letter-spacing:-4.5px;line-height:1">skein<span style="color:{OLIVE}">/</span></div>
  <div style="font-size:26px;font-weight:600;letter-spacing:-.6px;margin-top:16px;color:{OLIVE}">See what any wallet could be doing.</div>
  <div style="margin-top:30px;display:flex;align-items:stretch;background:{D};box-shadow:0 24px 50px #3A4D0F45;text-align:left">
   <div class=m style="flex:1;display:flex;align-items:center;gap:14px;padding:0 24px;height:72px;font-size:20px;color:#8FA36A">
    <span style="color:{L_}">&gt;</span>paste any wallet address<span style="display:inline-block;width:11px;height:26px;background:{L_}"></span>
   </div>
   <div class=m style="display:grid;place-items:center;padding:0 28px;margin:10px;background:{L_};color:{D};font-size:15px;font-weight:700;letter-spacing:2px">ANALYZE →</div>
  </div>
  <div class=m style="margin-top:20px;font-size:13px;letter-spacing:2px;color:{OLIVE};display:flex;justify-content:center;gap:24px">
   <span>EARN</span><span>·</span><span>LEND</span><span>·</span><span>BORROW</span><span>·</span><span>POOL</span><span>·</span><span>READ ONLY</span>
  </div>
 </div>
</div>""")

PREVIEW = '<div style="position:absolute;left:16px;top:317px;width:426px;height:426px;border-radius:50%;border:8px solid #000;overflow:hidden;background:#000;z-index:9"><img src="profile-lime.png" style="width:100%;height:100%;display:block"></div>'
(pathlib.Path(__file__).parent / "preview").mkdir(exist_ok=True)
for name, (w, h, html) in pages.items():
    if name.startswith("header"):
        head, body = html.split('</style>', 1)
        (pathlib.Path(__file__).parent / "preview" / f"{name}.html").write_text(f"<!doctype html><html><head>{head}</style></head><body style='width:{w}px;height:{h}px;position:relative'>{body}{PREVIEW.replace('src="profile-lime.png', 'src="data:image/png;base64,' + __import__('base64').b64encode((pathlib.Path(__file__).parent / 'profile-lime.png').read_bytes()).decode())}</body></html>", encoding="utf-8")
    (pathlib.Path(__file__).parent / f"{name}.html").write_text(f"<!doctype html><html><head>{html.split('</style>',1)[0]}</style></head><body style='width:{w}px;height:{h}px'>{html.split('</style>',1)[1]}</body></html>", encoding="utf-8")
    print(name, w, h)
