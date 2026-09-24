import json,sys,datetime
d=json.load(open(sys.argv[1]))
def words(h): h=h[2:]; return [h[i:i+64] for i in range(0,len(h),64)]
def s(h):
    w=words(h)
    try:
        ln=int(w[1],16); return bytes.fromhex(''.join(w[2:])[:ln*2]).decode()
    except Exception: return None
for o in d['out']:
    r=o.get('result')
    if not isinstance(r,str) or o['method']!='eth_call': continue
    w=words(r)
    if len(w)==1:
        v=int(w[0],16); extra=''
        if 1.6e9<v<2.2e9: extra=datetime.datetime.fromtimestamp(v,datetime.UTC).isoformat()
        print(o['label'],v,('0x'+w[0][24:]) if w[0].startswith('0'*24) and v>2**100 else '',extra)
    else:
        st=s(r)
        print(o['label'],'STR:'+st if st else ['0x'+x[24:] if x.startswith('0'*24) and int(x,16)>2**100 else int(x,16) for x in w][:12])
