"""1a extension: v3-fork factories getPool for NVDA/USDG; check expected GT/DS pools."""
from common import *
from eth_abi import encode
N="0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"; U="0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
F={"up-v3":"0x1ac9db4a2608ba45d6127b1737949b51bb54b7f3","ramses-cl":"0xe0c4ceb92d08ca985bb70fe0a22feb121a9854a8"}
calls=[]; lab=[]
for n,f in F.items():
    for fee in (500,3000):
        calls.append(ecall(f, sel("getPool(address,address,uint24)")+encode(["address","address","uint24"],[N,U,fee]))); lab.append((n,"uint24 fee",fee))
    for ts in (1,10,60):
        calls.append(ecall(f, sel("getPool(address,address,int24)")+encode(["address","address","int24"],[N,U,ts]))); lab.append((n,"int24 tickSpacing",ts))
calls=calls[:10]
r=batch(calls)
for l,x in zip(lab,r): print(l, x.get("result","ERR "+str(x.get("error"))))
r=batch([ecall("0x18a5af4e442f8be68968cc1f00d537f8af2d12cd",sel("factory()")),ecall("0x18a5af4e442f8be68968cc1f00d537f8af2d12cd",sel("fee()")),
         ecall("0xdac1904d823f7d6bcaaf431ceee40c934fed321b",sel("factory()")),ecall("0xdac1904d823f7d6bcaaf431ceee40c934fed321b",sel("fee()")),ecall("0xdac1904d823f7d6bcaaf431ceee40c934fed321b",sel("tickSpacing()"))])
print("up pool factory/fee",[x.get("result") for x in r[:2]]); print("ramses pool factory/fee/ts",[x.get("result") for x in r[2:]])
