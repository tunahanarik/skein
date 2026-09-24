# helper to build calls: python mk.py out.json then lines "label|to|data" or "label|code|addr" or "label|slot|addr|slot"
import sys,json
calls=[]
for line in sys.stdin:
    line=line.strip()
    if not line or line.startswith('#'):continue
    p=line.split('|')
    if p[1]=='code': calls.append({'label':p[0],'method':'eth_getCode','params':[p[2],'latest']})
    elif p[1]=='slot': calls.append({'label':p[0],'method':'eth_getStorageAt','params':[p[2],p[3],'latest']})
    elif p[1]=='raw': calls.append({'label':p[0],'method':p[2],'params':json.loads(p[3])})
    else: calls.append({'label':p[0],'method':'eth_call','params':[{'to':p[1],'data':p[2]},'latest']})
json.dump(calls,open(sys.argv[1],'w'))
