const L=require("./lib");const fs=require("fs");
const F="0x0FBad98595b0186dA120E41f77C102beb49f803c";
const checks=[
 ["morphoVaultV2 Steakhouse USDG","0xBeEff033F34C046626B8D0A041844C5d1A5409dd",["name()","asset()","totalAssets()","totalSupply()","curator()","owner()","liquidityAdapter()","performanceFee()"]],
 ["morphoVaultV2 Ethena x Steakhouse","0xbEeFF0fb1Dc19344A87b8479dAb60A2e16160737",["name()","asset()","totalAssets()","curator()"]],
 ["spark spUSDG vault","0xde770c84FE66E063336b31737cFE9790f18c4087",["name()","symbol()","asset()","totalAssets()","totalSupply()","vsr()","chi()","rho()","nowChi()","getImplementation()"]],
 ["spark ALM_PROXY","0xfD2fD4B046136B540A56C11c75ac679AE7d1dB24",[]],
 ["spark ALM_CONTROLLER","0xcf8d58A6eeF2a1cae2Ce69bC463b1178FB76bA1E",[]],
 ["spark EXECUTOR","0x826AEaeee9233fA8Ba199518dd8621A5962b1D02",[]],
 ["native credit vault (llama)","0x57B8f68ef57Af2dB70BC9aAc891836661CA4cB51",["name()","asset()","totalAssets()","owner()"]],
 ["flock credit vault (llama)","0xd42174d3Db28B0fA2BD25381c3521b18AE9dB490",["name()","asset()","totalAssets()","totalSupply()"]],
 ["ripe HQ (llama)","0xd4e82ae1de673bba3b53386a2d2c630ae6630940",["greenToken()","ripeToken()"]],
 ["gage vault (llama)","0x3D979740785ABd8b7Dd5c2Ff7Bf100CBe86fcBDF",["name()","owner()"]],
 ["spine vault (llama)","0x38cc0dae2c4305c16f3d702f9a0260599e14654f",["name()","asset()","totalAssets()"]],
 ["termmax FactoryV2 (llama)","0x03c4FCF963E5FBC0dC5851d2340624E70492acb9",["owner()"]],
 ["layerbank core (llama)","0x7ED03A856D52172f9501aB0176f184baD287e546",["allMarkets()","owner()"]],
 ["accountable factory (llama)","0xA4d6a4aD35fc632aEE1dC48A2aEc2aaa37B51F9f",["owner()"]],
];
(async()=>{const bn=(await L.batch([{method:"eth_blockNumber",params:[]}]))[0].result;const out={block:parseInt(bn,16)};
 for(const [label,a,sigs] of checks){const calls=[{method:"eth_getCode",params:[a,bn]},...sigs.map(s=>L.call(a,L.sel(s),bn))];
  if(label.startsWith("morphoVaultV2"))calls.push(L.call(F,L.sel("isVaultV2(address)")+L.pad(a),bn));
  const r=await L.batchAll(calls);const o={address:a,codeBytes:((r[0].result||"0x").length-2)/2};
  sigs.forEach((s,i)=>{const x=r[i+1];if(x.error){o[s]="ERR "+x.error.message;return}const h=x.result;o[s]=(/name|symbol|version/.test(s)&&h.length>=194)?L.str(h):h.length==66?(BigInt(h)<(1n<<160n)&&BigInt(h)>(1n<<100n)?L.addr(BigInt(h)):BigInt(h).toString()):h.slice(0,200)});
  if(label.startsWith("morphoVaultV2")){o["factory.isVaultV2"]=r[r.length-1].result}
  out[label]=o;console.log(label,JSON.stringify(o))}
 fs.writeFileSync("onchain_others.json",JSON.stringify(out,null,1))})().catch(e=>{console.error(e);process.exit(1)});
