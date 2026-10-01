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

 <div style="position:absolute;left:96px;top:70px;width:640px">
  <div class=m style="font-size:12.5px;letter-spacing:3px;color:#8D948A"><span class=l>●</span>&nbsp; WALLET RESEARCH · ROBINHOOD CHAIN</div>
  <div class=m style="font-size:84px;font-weight:800;letter-spacing:-5px;line-height:1;margin-top:20px">skein<span class=l>/</span></div>
  <div style="font-size:40px;font-weight:700;letter-spacing:-1px;line-height:1.12;margin-top:22px">See what any wallet<br>could be <span class=l>doing.</span></div>
  <div class=mu style="font-size:18.5px;line-height:1.5;margin-top:16px;width:560px">Paste an address. Skein reads every asset it holds, spots idle money and finds where each one can earn, lend, pool or be borrowed against.</div>
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
 <div style="position:absolute;left:96px;top:110px;width:440px">
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
 <div style="position:absolute;left:96px;top:84px;width:440px">
  <div class=m style="font-size:12px;letter-spacing:3.2px;font-weight:500;color:{OLIVE}"><span style="display:inline-block;width:7px;height:7px;background:{D};vertical-align:1px;margin-right:12px"></span>ROBINHOOD CHAIN</div>
  <div class=m style="font-size:80px;font-weight:700;letter-spacing:-4.5px;line-height:1;margin-top:20px">skein<span style="color:{OLIVE}">/</span></div>
  <div style="font-size:35px;font-weight:600;letter-spacing:-1.1px;line-height:1.14;margin-top:24px">Every asset.<br><span style="color:{OLIVE}">Every way to use it.</span></div>
  <div style="font-size:16.5px;font-weight:500;line-height:1.55;margin-top:16px;color:{D}a8">Stock tokens, stablecoins and crypto,<br>mapped across 7 protocols.</div>
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
 <div style="position:absolute;left:110px;top:94px;width:640px">
  <div class=m style="font-size:12px;letter-spacing:3.2px;font-weight:500;color:{OLIVE}"><span style="display:inline-block;width:7px;height:7px;background:{D};vertical-align:1px;margin-right:12px"></span>ROBINHOOD CHAIN · 4663</div>
  <div class=m style="font-size:104px;font-weight:700;letter-spacing:-6px;line-height:1;margin-top:18px">skein<span style="color:{OLIVE}">/</span></div>
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

for name, (w, h, html) in pages.items():
    (pathlib.Path(__file__).parent / f"{name}.html").write_text(f"<!doctype html><html><head>{html.split('</style>',1)[0]}</style></head><body style='width:{w}px;height:{h}px'>{html.split('</style>',1)[1]}</body></html>", encoding="utf-8")
    print(name, w, h)
