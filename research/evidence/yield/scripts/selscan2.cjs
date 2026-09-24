const fs=require('fs');const {toFunctionSelector}=require('C:/Users/cem/Desktop/perch/node_modules/.pnpm/node_modules/viem');
const code=JSON.parse(fs.readFileSync(process.argv[2])).out.find(o=>o.label===process.argv[3]).result.slice(2);
const cands=fs.readFileSync(process.argv[4],'utf8').split('\n').map(x=>x.trim()).filter(Boolean);
const map={};for(const c of cands){try{map[toFunctionSelector(c).slice(2)]=c}catch(e){}}
const found=new Set();for(let i=0;i<code.length-10;i+=2){if(code.slice(i,i+2)==='63'){const s=code.slice(i+2,i+10);if(map[s])found.add(map[s]);}}
console.log([...found].sort().join('\n'));
