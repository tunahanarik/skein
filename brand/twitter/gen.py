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
# Header A: terminal
pages["header-terminal"] = (1500, 500, BASE + """
<div style="position:relative;width:1500px;height:500px">
 <div class=grid style="-webkit-mask:linear-gradient(90deg,transparent,#000 45%,#000)"></div>
 <div style="position:absolute;right:-120px;top:-160px;width:760px;height:760px;border-radius:50%;background:radial-gradient(circle,#C8F16914,transparent 65%)"></div>

 <div style="position:absolute;left:110px;top:92px;width:640px">
  <div class=m style="font-size:13px;letter-spacing:3px;color:#8D948A;margin-bottom:18px"><span class=l>●</span>&nbsp; ROBINHOOD CHAIN · 4663</div>
  <div class=m style="font-size:112px;font-weight:800;letter-spacing:-6px;line-height:1">skein<span class=l>/</span></div>
  <div style="font-size:30px;font-weight:600;margin-top:22px;letter-spacing:-.4px;line-height:1.25">Read any wallet.<br>Find what every asset can do.</div>
 </div>

 <div style="position:absolute;right:110px;top:78px;width:560px;border:1px solid #2A2F28;background:#0A0C0Aee">
  <div class=m style="display:flex;gap:10px;align-items:center;padding:12px 16px;border-bottom:1px solid #1C201B;font-size:12px;letter-spacing:2px;color:#8D948A">
   <span style="width:9px;height:9px;background:#C8F169"></span>TERMINAL<span style="flex:1"></span><span class=fa>READ ONLY</span>
  </div>
  <div class=m style="padding:20px 20px 22px;font-size:19px;line-height:1.75">
   <div><span class=l>&gt;</span> earn yield on <b>NVDA</b></div>
   <div class=mu>&nbsp; scanning 7 protocols</div>
   <div><span class=l>&nbsp; ✓</span> lend · lp · fixed rate</div>
   <div style="margin-top:8px"><span class=l>&gt;</span> swap <b>USDG</b> to <b>WETH</b></div>
   <div><span class=l>&nbsp; ✓</span> best route · uniswap v3</div>
   <div style="margin-top:8px"><span class=l>&gt;</span> bridge <b>ETH</b> to <b>base</b><span style="display:inline-block;width:11px;height:22px;background:#C8F169;vertical-align:-4px;margin-left:6px"></span></div>
  </div>
 </div>

 <div class=m style="position:absolute;right:110px;bottom:40px;width:560px;display:flex;justify-content:space-between;font-size:12px;letter-spacing:2.5px;color:#5A6158">
  <span>EXPLORE</span><span>EARN</span><span>LEND</span><span>SWAP</span><span>BRIDGE</span><span class=l>● LIVE</span>
 </div>
</div>""")
# Header B: lime, minimal, strands
pages["header-lime"] = (1500, 500, BASE + """
<div style="position:relative;width:1500px;height:500px;background:#C8F169;color:#0A0F04;overflow:hidden">
 <div style="position:absolute;inset:0;background-image:linear-gradient(#0A0F040d 1px,transparent 1px),linear-gradient(90deg,#0A0F040d 1px,transparent 1px);background-size:50px 50px"></div>
 <svg width=1500 height=500 style="position:absolute;inset:0" fill=none stroke=#0A0F04 stroke-width=2 opacity=.2>
  <path d="M-50 448 C 125 408, 250 488, 425 448 S 775 408, 950 448 S 1300 488, 1550 448"/>
  <path d="M-50 448 C 125 488, 250 408, 425 448 S 775 488, 950 448 S 1300 408, 1550 448"/>
  <path d="M-50 448 L 1550 448"/>
 </svg>
 <div style="position:absolute;left:0;right:0;top:96px;text-align:center">
  <div class=m style="font-size:150px;font-weight:800;letter-spacing:-9px;line-height:1">skein/</div>
  <div class=m style="font-size:20px;font-weight:600;letter-spacing:5px;margin-top:30px">EXPLORE · EARN · SWAP · BRIDGE</div>
  <div style="font-size:24px;font-weight:600;margin-top:14px;opacity:.72">The map of every wallet on Robinhood Chain</div>
 </div>
</div>""")

for name, (w, h, html) in pages.items():
    (pathlib.Path(__file__).parent / f"{name}.html").write_text(f"<!doctype html><html><head>{html.split('</style>')[0]}</style></head><body style='width:{w}px;height:{h}px'>{html.split('</style>')[1]}</body></html>", encoding="utf-8")
    print(name, w, h)
