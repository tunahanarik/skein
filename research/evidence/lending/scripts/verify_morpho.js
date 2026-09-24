const L=require("./lib");const fs=require("fs");
const MORPHO="0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010";
const official={morpho:MORPHO,adaptiveCurveIrm:"0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",chainlinkOracleV2Factory:"0xB7c16F6F8cF531447Bf27Ca7220f981E79C9cdF2",vaultV2Factory:"0x0FBad98595b0186dA120E41f77C102beb49f803c",morphoVaultV1AdapterFactory:"0x7a91222F3f7B927bB8fb624593Ca86e111C2F85e",morphoMarketV1AdapterV2Factory:"0x79370Ed003CE325C088E530d5e8655c99c2993e1",registryList:"0xe785a2eFD384BA7B95BaEd3851BC76aeD67C676f",vaultV2BluePublicAllocator:"0xCe5c1aFa115fF8b1D6913509bfc79D9AE08CC857",bundler3:"0x6478e9393d4C5bB4d53ee881d1DE78786A0344a6",generalAdapter1:"0xc5E188541D107e8B79e43478bDE365F1406665D6",vaultBundlesV1:"0xcC108538f36242D6E0d6B9255f6D9Ccd137D70Fe",vaultExitBundlesV1:"0xCE29862924756584BBD0D75CA1249d22007E2813",blueBundlesV1:"0x53A1eB6589861F686af7c531211E35Aefe30210f",preLiquidationFactory:"0x0B0cFa151c06d2342799267754b0a2c320C43D5B",midnight:"0x6120765Ba5336150BbdDdD0Cd9108B5bFD369632",midnightBundles:"0x71aa985ff80AbcE3b8b443845633674Ca9f7575C",permit2:"0x000000000022D473030F116dDEE9F6B43aC78BA3"};
const markets=process.argv.slice(2);
const USER=process.env.USER_ADDR;
(async()=>{
 const out={};
 const [cid,bn]=await L.batch([{method:"eth_chainId",params:[]},{method:"eth_blockNumber",params:[]}]);
 const B=bn.result;out.chainId=parseInt(cid.result,16);out.block=parseInt(B,16);console.log("chain",out.chainId,"block",out.block);
 const names=Object.keys(official);
 const codes=await L.batchAll(names.map(n=>({method:"eth_getCode",params:[official[n],B]})));
 out.code={};names.forEach((n,i)=>{out.code[n]={address:official[n],codeBytes:(codes[i].result||"0x").length/2-1,err:codes[i].error}});console.log(out.code);
 const g=await L.batch([L.call(MORPHO,L.sel("owner()"),B),L.call(MORPHO,L.sel("feeRecipient()"),B),L.call(MORPHO,L.sel("isIrmEnabled(address)")+L.pad(official.adaptiveCurveIrm),B),L.call(MORPHO,L.sel("isLltvEnabled(uint256)")+L.pad((915n*10n**15n).toString(16)),B),L.call(MORPHO,L.sel("DOMAIN_SEPARATOR()"),B)]);
 out.owner=L.addr(L.words(g[0].result)[0]);out.feeRecipient=L.addr(L.words(g[1].result)[0]);out.irmEnabled=L.words(g[2].result)[0]==1n;out.lltv915Enabled=L.words(g[3].result)[0]==1n;console.log("owner",out.owner,"feeRecipient",out.feeRecipient,"irmEnabled",out.irmEnabled,"lltv91.5",out.lltv915Enabled);
 out.markets={};
 for(const id of markets){
  const r=await L.batch([L.call(MORPHO,L.sel("idToMarketParams(bytes32)")+L.pad(id),B),L.call(MORPHO,L.sel("market(bytes32)")+L.pad(id),B)]);
  const p=L.words(r[0].result),m=L.words(r[1].result);
  const mp={loanToken:L.addr(p[0]),collateralToken:L.addr(p[1]),oracle:L.addr(p[2]),irm:L.addr(p[3]),lltv:p[4].toString()};
  const ms={totalSupplyAssets:m[0].toString(),totalSupplyShares:m[1].toString(),totalBorrowAssets:m[2].toString(),totalBorrowShares:m[3].toString(),lastUpdate:m[4].toString(),fee:m[5].toString()};
  // recompute id = keccak(abi.encode(marketParams))
  const enc="0x"+p.slice(0,5).map(x=>x.toString(16).padStart(64,"0")).join("");const idCheck=L.keccak(Buffer.from(enc.slice(2),"hex"));
  const rateData=L.sel("borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))")+p.slice(0,5).map(x=>L.pad(x.toString(16))).join("")+m.slice(0,6).map(x=>L.pad(x.toString(16))).join("");
  const c=[L.call(mp.oracle,L.sel("price()"),B),L.call(mp.irm,rateData,B)];if(USER)c.push(L.call(MORPHO,L.sel("position(bytes32,address)")+L.pad(id)+L.pad(USER),B));
  const r2=await L.batch(c);
  const price=r2[0].result?L.words(r2[0].result)[0].toString():("ERR "+JSON.stringify(r2[0].error));
  const rate=r2[1].result?L.words(r2[1].result)[0]:null;
  const util=Number(m[2])/Number(m[0]||1n);const borrowApy=rate!=null?Math.expm1(Number(rate)*31536000/1e18):null;
  const supplyApy=borrowApy!=null?borrowApy*util*(1-Number(m[5])/1e18):null;
  out.markets[id]={params:mp,idCheck:idCheck.toLowerCase()==id.toLowerCase(),state:ms,oraclePrice:price,borrowRatePerSec:rate?.toString(),borrowApyCalc:borrowApy,supplyApyCalc:supplyApy,utilization:util,position:USER&&r2[2]?.result?L.words(r2[2].result).map(String):undefined};
  console.log(id.slice(0,10),JSON.stringify(out.markets[id]));
 }
 fs.writeFileSync(process.env.OUT||"onchain_morpho.json",JSON.stringify(out,null,1));
})().catch(e=>{console.error(e);process.exit(1)});
