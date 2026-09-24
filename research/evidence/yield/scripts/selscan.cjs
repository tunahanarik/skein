const fs=require('fs');const {toFunctionSelector}=require('C:/Users/cem/Desktop/perch/node_modules/.pnpm/node_modules/viem');
const code=JSON.parse(fs.readFileSync(process.argv[2])).out.find(o=>o.method==='eth_getCode'&&o.label===process.argv[3]).result.slice(2);
// dispatcher selectors: PUSH4 (0x63) xxxxxxxx followed by EQ(0x14) or DUP/GT
const sels=new Set();for(let i=0;i<code.length-10;i+=2){ if(code.slice(i,i+2)==='63'){const s=code.slice(i+2,i+10);const nx=code.slice(i+10,i+14);if(['14','11','81','80'].includes(nx.slice(0,2))) sels.add('0x'+s);} }
const cands=fs.readFileSync(process.argv[4],'utf8').split('\n').map(x=>x.trim()).filter(Boolean);
const map={};for(const c of cands){try{map[toFunctionSelector(c)]=c}catch(e){}}
for(const s of [...sels].sort()) console.log(s,map[s]||'?');
