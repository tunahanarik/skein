// minimal keccak256 + gentle JSON-RPC helper (read-only)
const RC=[1n,0x8082n,0x800000000000808an,0x8000000080008000n,0x808bn,0x80000001n,0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n];
const R=[0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];const M=(1n<<64n)-1n;
const rot=(x,n)=>n?((x<<BigInt(n))|(x>>BigInt(64-n)))&M:x;
function f(s){for(let r=0;r<24;r++){const C=[];for(let x=0;x<5;x++)C[x]=s[x]^s[x+5]^s[x+10]^s[x+15]^s[x+20];for(let x=0;x<5;x++){const D=C[(x+4)%5]^rot(C[(x+1)%5],1);for(let y=0;y<25;y+=5)s[y+x]^=D}
const B=[];for(let x=0;x<5;x++)for(let y=0;y<5;y++)B[y+5*((2*x+3*y)%5)]=rot(s[x+5*y],R[x+5*y]);
for(let x=0;x<5;x++)for(let y=0;y<5;y++)s[x+5*y]=B[x+5*y]^((~B[(x+1)%5+5*y])&M&B[(x+2)%5+5*y]);s[0]^=RC[r]}}
function keccak(data){const b=typeof data=="string"?Buffer.from(data):Buffer.from(data);const rate=136;const p=Buffer.alloc(Math.ceil((b.length+1)/rate)*rate);b.copy(p);p[b.length]^=1;p[p.length-1]^=0x80;const s=new Array(25).fill(0n);
for(let o=0;o<p.length;o+=rate){for(let i=0;i<rate/8;i++)s[i]^=p.readBigUInt64LE(o+i*8);f(s)}const out=Buffer.alloc(32);for(let i=0;i<4;i++)out.writeBigUInt64LE(s[i],i*8);return "0x"+out.toString("hex")}
const sel=sig=>keccak(sig).slice(0,10);
const RPC="https://rpc.mainnet.chain.robinhood.com";let last=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function batch(calls){ // calls: [{method,params}] max 10
 if(calls.length>10)throw new Error(">10");
 for(let a=0;a<10;a++){const w=last+1300-Date.now();if(w>0)await sleep(w);last=Date.now();
  const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(calls.map((c,i)=>({jsonrpc:"2.0",id:i,method:c.method,params:c.params})))});
  if(r.status==429){await sleep(6000*(a+1));continue}
  const j=await r.json();if(!Array.isArray(j)){if(JSON.stringify(j).includes("429")||JSON.stringify(j).toLowerCase().includes("rate")){await sleep(6000*(a+1));continue}throw new Error(JSON.stringify(j))}
  j.sort((x,y)=>x.id-y.id);return j}
 throw new Error("429 persist")}
async function batchAll(calls){const out=[];for(let i=0;i<calls.length;i+=10)out.push(...await batch(calls.slice(i,i+10)));return out}
const pad=h=>h.replace(/^0x/,"").toLowerCase().padStart(64,"0");
const call=(to,data,block="latest")=>({method:"eth_call",params:[{to,data},block]});
const words=h=>{h=h.replace(/^0x/,"");const w=[];for(let i=0;i<h.length;i+=64)w.push(BigInt("0x"+h.slice(i,i+64)));return w};
const addr=w=>"0x"+w.toString(16).padStart(40,"0");
const str=h=>{h=h.replace(/^0x/,"");if(h.length<192)return null;const len=parseInt(h.slice(64,128),16);return Buffer.from(h.slice(128,128+len*2),"hex").toString()};
module.exports={keccak,sel,batch,batchAll,pad,call,words,addr,str,sleep};
