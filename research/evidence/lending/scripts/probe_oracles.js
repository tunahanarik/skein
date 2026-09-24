const L=require("./lib");const fs=require("fs");
const oracles=process.argv.slice(2);
const sigs=["price()","BASE_FEED_1()","BASE_FEED_2()","QUOTE_FEED_1()","QUOTE_FEED_2()","BASE_VAULT()","SCALE_FACTOR()","description()","owner()","decimals()","latestRoundData()","token()","asset()","feed()","oracle()","getPrice()","uiMultiplier()","multiplier()","BASE_TOKEN()","underlying()"];
const IMPL="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
(async()=>{const res={};
 for(const o of oracles){const calls=sigs.map(s=>L.call(o,L.sel(s)));calls.push({method:"eth_getCode",params:[o,"latest"]});calls.push({method:"eth_getStorageAt",params:[o,IMPL,"latest"]});
  const r=await L.batchAll(calls);res[o]={};sigs.forEach((s,i)=>{if(r[i].result&&r[i].result!="0x")res[o][s]=r[i].result});res[o].codeBytes=(r[sigs.length].result.length-2)/2;res[o].eip1967impl=r[sigs.length+1].result;
  if(res[o]["description()"])res[o].descriptionText=L.str(res[o]["description()"]);
  console.log(o,JSON.stringify(res[o]));}
 fs.writeFileSync(process.env.OUT||"oracle_probe.json",JSON.stringify(res,null,1));})();
