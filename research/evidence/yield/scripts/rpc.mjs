// usage: node rpc.mjs calls.json out.json ; calls: [{label, method, params}] ; batches of <=10, 1.5s gap, backoff on 429
import fs from 'fs';
const RPC='https://rpc.mainnet.chain.robinhood.com';
const calls=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const BS=+(process.env.BS||5);const out=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<calls.length;i+=BS){
  const chunk=calls.slice(i,i+BS);
  const body=chunk.map((c,j)=>({jsonrpc:'2.0',id:i+j,method:c.method,params:c.params}));
  let res,tries=0;
  while(true){
    const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if(r.status===429){tries++;console.error("429, backoff",tries);await sleep(5000*tries);if(tries>10)throw new Error("429");continue;}
    res=await r.json();break;
  }
  const byId=Object.fromEntries((Array.isArray(res)?res:[res]).map(x=>[x.id,x]));
  chunk.forEach((c,j)=>{const x=byId[i+j]||{};out.push({label:c.label,method:c.method,params:c.params,result:x.result,error:x.error});});
  await sleep(2000);
}
fs.writeFileSync(process.argv[3],JSON.stringify({fetchedAt:new Date().toISOString(),out},null,1));
for(const o of out){const r=o.result;console.log(o.label,'=>',o.error?('ERR '+JSON.stringify(o.error)):(typeof r==='string'&&r.length>140?(o.method==='eth_getCode'?`code ${(r.length-2)/2} bytes`:r.slice(0,140)+'...'):JSON.stringify(r)));}
