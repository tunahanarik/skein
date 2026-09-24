# Robinhood Chain DEX ecosystem (Phase 4 research)

**Phase 4 decisions from this research:**
- **Uniswap is the only integrated TRADE venue** (v3; see [../protocols/uniswap-adapter.md](../protocols/uniswap-adapter.md)).
- **No other venue is integrated in Phase 4**, by instruction. The best-supported next candidates are:
  - **Ramses CL**: official docs, the largest non-Uniswap USDG/NVDA pool, a QuoterV2.
  - **Ekubo v3 / STONX**: official docs and a keyless quoter API, but the API gates equities by jurisdiction.
- **Correction to Phase 0 (`docs/research/dex.md`):** PancakeSwap's official chain config says `infinity: false` for Robinhood Chain. The Infinity-style events come from Orvex and one unattributed pool manager.
- **Robinhood's own "building with stock tokens" page** names only Uniswap (AMM), Rialto (proprietary AMM), Lighter (orderbook), 0x RFQ, 1inch Fusion and LI.FI.

The research below was done by a separate read-only research pass on 2026-09-24 and reviewed before inclusion. Uniswap itself is covered in the adapter doc.

Date: 2026-09-24. Chain: Robinhood Chain, chainId 4663 (`eth_chainId` = `0x1237`). This was read-only research. Nothing was signed, sent or keyed.
Scope: every trading venue that is not Uniswap v2/v3/v4. Uniswap's own factories showed up in the scans (v3 factory `0x1f7d7550…2efa` with 558 pools and 21,040 swaps, v2 factory `0x8bceaa40…937f`, v4 PoolManager `0x8366a39c…0951`). They are left out here and belong to the Uniswap track. Fables and Twofold are covered because they are separate venues built as hooks on the Uniswap v4 PoolManager.

The activity window used below is 20,000 blocks, which is about 34 minutes on this chain (block 71,237,000 had timestamp 1790239508 and block 71,257,000 had 1790241527; live RPC `eth_getBlockByNumber`).
Classes used: **VERIFIED_LIVE** means an official source names the contract, the contract has code, and it had activity in the window. **DISCOVERED_NOT_VERIFIED** means the venue was seen but the official source or the activity is missing. **NOT_SUITABLE** means the matching is offchain, access needs a key, it only executes or aggregates, it is not a spot venue, or it is dead.
`VERIFIED_LIVE*` means the only official source is the project's own production frontend bundle, with no docs page or deployment file. It is a weaker source and is flagged for review.

## Summary table

| Venue | Type | Classification | Stock Tokens | USDG | API | Notes |
|---|---|---|---|---|---|---|
| Lighter (RH instance) | Orderbook, offchain matching | NOT_SUITABLE | Yes, 26 stock/ETF spot books | Yes (quote asset) | Keyless reads. Trading uses signed API keys | Robinhood docs name the contract. 240 logs in window |
| Rialto | PropAMM plus router (RFQ-like) | NOT_SUITABLE (keyed) | Yes, 134 stock tokens listed | Yes | `/tokens` keyless. `/quote` needs a key | Router registry verified. Router emitted 172 logs |
| Fables | ve(3,3) hooks on Uniswap v4 | VERIFIED_LIVE* | Yes (NVDA, TSLA, AAPL, SPY, GLD…) | Yes (default quote) | None found | 32 markets in bundle. 534 v4 swaps in window |
| Ramses (CL v2 / DLMM / Legacy) | CL AMM (tickSpacing), LB, Solidly v2 | VERIFIED_LIVE | Yes, USDG/NVDA ts10 pool | Yes | None found. Onchain QuoterV2 | 3,424 CL swaps, 93 DLMM, 6 legacy |
| Up (v3 / v2) | CL (tickSpacing) plus Solidly v2 | VERIFIED_LIVE* | Yes, USDG/NVDA ts60 pool | Yes | None found | 2,449 v3 swaps, 33 v2 |
| Alandale (v3 / v2) | Algebra Integral plus v2 | VERIFIED_LIVE | Yes (small) | Yes | None found | 2,011 swaps |
| GIGA (CL / v2) | PancakeV3-style CL plus v2 | VERIFIED_LIVE* | Yes (small) | Yes | None found | 1,779 swaps |
| Kittenswap (Algebra) | Algebra CL | VERIFIED_LIVE | Yes, USDG/NVDA pool | Yes | None found | 597 swaps |
| SushiSwap v3 (+ v2) | Uni-v3 fork | VERIFIED_LIVE | Pool exists but only about $11 | Yes, deep WETH/USDG | Sushi Swap API v7 keyless | 507 swaps |
| PancakeSwap v3 (+ v2) | PCS v3 | VERIFIED_LIVE | Dust-level NVDA pools | Yes | None tested | 102 swaps. Officially **no Infinity** on RH |
| Ekubo v3 (+ STONX ve33) | Singleton CL plus extensions | VERIFIED_LIVE | Yes, USDG/NVDA via STONX | Yes | Keyless quoter API | 292 core logs. API gates equities by jurisdiction |
| Curve (stableswap-ng / twocrypto / tricrypto) | Stable/crypto AMM | VERIFIED_LIVE (very low activity) | Not checked | Not checked | Curve API does not know RH | 1 to 2 swaps in window |
| Raphael Exchange (CL / AMM) | CL plus Solidly | DISCOVERED_NOT_VERIFIED | Yes (small) | Yes | none | 176 CL plus 5 AMM swaps. Source is DefiLlama only |
| Orvex (CL / v2) | PCS-Infinity-style CL | DISCOVERED_NOT_VERIFIED | Yes, vault holds NVDA | Yes | none | 585 CL swaps. Official addresses page unreadable |
| Long tail (Hybra, RobinSwap, SwapHood, Sheriff, ParitySwap, Phera, 0Swap, Catnip, FrothSwap, KOLSwap, DLMM King, …) | v2/v3/Algebra/LB forks | DISCOVERED_NOT_VERIFIED | Not checked | Not checked | none | 1 to 167 swaps each |
| Unattributed factories and pool managers | Various | DISCOVERED_NOT_VERIFIED | Not checked | Not checked | none | Includes one PM with 211 swaps |
| Twofold, Kipseli, Deepstate | v4 hook / other | DISCOVERED_NOT_VERIFIED | Deepstate: NVDA | Deepstate: USDG | none | Kipseli and Deepstate had 0 logs in window |
| Arcus Perps, Meridian Perps | Perpetuals | NOT_SUITABLE | n/a | n/a | n/a | Not spot venues |
| Arcadia, Beefy, Steer, Snuggle, vfat, StonkBrokers Smart LP, EZManager… | LP managers | NOT_SUITABLE | n/a | n/a | n/a | Not trading venues |
| KyberSwap | Aggregator | NOT_SUITABLE (aggregator) | Yes, routed USDG→NVDA | Yes | Keyless | Routes via Ramses, Up and Uniswap v4 hooks |
| Sushi Swap API | Aggregator (RedSnwapper) | NOT_SUITABLE (aggregator) | Yes, quoted USDG→NVDA | Yes | Keyless | tx `to` = RedSnwapper |
| LI.FI | Meta-aggregator plus intents | NOT_SUITABLE (aggregator) | Yes, WETH→NVDA routes | Yes | Keyless | Tools on 4663 include fly, nordstern, kyberswap, openocean, rialto |
| OpenOcean | Aggregator | NOT_SUITABLE | Unknown | Unknown | dexList keyless. Quote blocked by a Cloudflare challenge | |
| 0x, 1inch | Aggregator / RFQ | NOT_SUITABLE (keyed) | Named by Robinhood docs | – | HTTP 401 without key | |
| Uniswap Trading API | Aggregator | NOT_SUITABLE (keyed) | – | – | Keyed (Phase 0). **Not re-tested here** | |

## Venues

### Lighter (Robinhood Chain instance)
- The official Robinhood doc https://docs.robinhood.com/chain/lighter-domains/ names contract `0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d`, UI https://robinhoodchain.lighter.xyz, API `https://api.rh.lighter.xyz/` and API docs https://apidocs.rh.lighter.xyz/docs/get-started. It calls the deployment "a dedicated Lighter instance" with its own sequencer. Deposits go through the contract. The API docs describe SDKs: `lighter-sdk` (Python) and `elliottech/lighter-go`.
- Live RPC: `eth_getCode` returned 1,367 bytes at about block 71,255,601. `eth_getLogs` on the address returned 240 logs over blocks 71,248,000 to 71,268,000.
- Keyless GET https://api.rh.lighter.xyz/api/v1/orderBooks returned 84 books: 57 perp and 27 spot. Every spot book is `X/USDG`, including NVDA/USDG (2054), AAPL/USDG (2049), TSLA/USDG (2055), ETH/USDG (2048), plus SPY, QQQ, GLD-like ETFs, AMZN, MSFT and others. That is 26 non-ETH spot books.
- For liquidity, `orderBookDetails?market_id=2054` shows NVDA/USDG daily quote volume of about $55.0k across 38 trades, and `orderBookDetails?filter=spot` sums to about $18.2M daily quote volume across 27 spot books. `orderBookOrders` read without a key.
- Routing: not applicable, because each book is a separate market. Matching is offchain in Lighter's sequencer, which the docs call an instance with "separate execution, sequencing"; the contract handles deposits and withdrawals.
- DefiLlama lists "Lighter Robinhood Perps" with about $100.2M TVL (third-party).
- Why not in Phase 4: an offchain orderbook needs an account, a deposit and signed API-key orders, so it cannot be used as an atomic onchain swap leg.

### Rialto (propAMM router)
- Official docs: https://docs.rialto.xyz/developers/router-registries.md lists "RH Chain | 4663 | … | `0x71a120CbBf3Ce7cD910a3c50fF77aFc62735687E`". The full API reference is https://github.com/rialto-plds/rialto-api-docs/blob/main/RIALTO_SWAP_API.md.
- Live RPC `getFeature(2)` and `getFeature(3)` (selector `0x46df01a4`) on the registry at block 71,264,828 both return current router `0xc94135b63772b91d79d0a2daab2a8801f32359bd`, with prev and next set to zero and paused = false. The router has 24,232 bytes of code and emitted 172 logs in blocks 71,244,828 to 71,264,828. The registry itself has 4,968 bytes of code.
- API: base `https://rialto-trade-api.rialto.xyz`. `GET /tokens` is public; per https://docs.rialto.xyz/developers/authentication.md, "Quote and gasless endpoints require a bearer API key". Keys come from a wallet-signed integrator onboarding flow, which was not done.
- Keyless `/tokens` returned 150 tokens, all flagged `liquid:true`. Of those, 134 have `category:"stock"`, including NVDA `0xd0601ce1…9eec`, AAPL and TSLA. USDG `0x5fc5360d…d168` and WETH are also listed.
- Routing: yes. The quote returns a best route across Rialto propAMMs and DEX pools; the docs example shows a `uniswap-v3:chain-4663:…` leg. LI.FI also lists `rialto` as an exchange tool on 4663.
- Liquidity: no keyless figure is available. Not on DefiLlama.
- Why not in Phase 4: quotes and calldata can only be had with an API key from a wallet-signed onboarding, and the rules forbid both.

### Fables (hook-native ve(3,3) on Uniswap v4)
- Official site https://www.fables.fi/ says in its meta description: "Hook-native ve(3,3) exchange on Uniswap v4 … Live on Robinhood Chain."
- The production bundle `https://www.fables.fi/assets/index-C1eKvsMg.js` names `poolManager: 0x8366a39c…0951` and StateView `0xf3334192…673b`. It lists 32 markets with pool ids and hooks (14 distinct hooks), including NVDA/USDG (hook `0x66622f77B797D506e5376F7798b67ab288966080`), TSLA, AAPL, SPY, GLD, META, AMZN, MU, CRCL, MSTR and GLXY. It also names FablesRWAETH-type hook `0xcA89f079…e080` for ETH-AMC and hook `0x06a88987…6080` for an ETH market. The default quote token in the bundle resolves to USDG.
- Registry `0x159a113e…3ef3` is named only by the third-party DefiLlama adapter (https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/fables/index.js). It was not found in the main bundle.
- Live RPC: registry code is 3,726 bytes, NVDA hook 33,070, FablesRampETH 28,189 and FablesRWAETH 43,368. `eth_getLogs` for v4 `Swap` on the PoolManager, filtered to the 32 Fables pool ids over blocks 71,248,000 to 71,268,000, returned **534 swaps**. The top pools were PONS 172, CASHCAT 59, PROLOGUE 37 and CRCL 25.
- Liquidity: DefiLlama shows about $48.1M TVL (third-party).
- API/SDK: none found. Routing is plain v4 PoolKey swaps; there is no Fables aggregator.
- Why not in Phase 4: it is reachable only as Uniswap v4 hooked pools, so it belongs with the v4 integration track (hook allowlisting). The frontend bundle is the only official address source.

### Ramses (CL v2, DLMM, Legacy v2)
- Official: https://www.ramses.xyz/docs/contract-addresses, "Robinhood" section. It lists RamsesV3Factory `0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8`, PoolDeployer `0x4b37359B…Dca9`, SwapRouter `0xFCBBe2Af…D2Ae`, QuoterV2 `0x4730e03E…70a6`, UniversalRouter `0xbFbb2BCB…3b1C`, DLMMFactory `0xdcD5F77697914E27f56FD263EF82923C8524AbAc`, DLMMRouter `0xd0019e86…d28b`, PairFactory `0x43B2Bf9f33036a02fC7A00935571c2A6b0108e66` and Legacy Router `0x33D3CDD4…262E`.
- Live RPC: all routers and quoters have code (8,052, 5,823, 15,002, 12,544 and 15,823 bytes at block 71,272,778).
- Activity by `factory()` mapping of swap emitters over blocks 71,237,000 to 71,257,000: CL had 71 pools and 3,424 swaps (v3 Swap topic), DLMM 11 pools and 93 swaps (LB Swap topic), Legacy 2 pairs and 6 swaps.
- Liquidity from onchain `balanceOf` at block 71,270,955: USDG/NVDA ts=10 pool `0xdac1904d…321b` holds 87,914.77 USDG and 573.67 NVDA. WETH/USDG ts=1 pool `0xfae65eaa…bfb0` holds 150.3 WETH and 140,036 USDG. DefiLlama shows CL about $7.30M (third-party).
- KyberSwap's keyless route for 1,000 USDG→NVDA used `ramses-v3` pool `0xf8996e22…e203`.
- Why not in Phase 4: this is the strongest non-Uniswap candidate. It was deferred only because the Ramses CL pool interface (tickSpacing-keyed) needs its own adapter.

### Up (up33.xyz) v3 and v2
- Official source is the frontend bundle only: `https://up33.xyz/assets/index-BGRfDb1H.js` contains `clFactory:"0x1ac9dB4a2608ba45D6127B1737949b51Bb54B7F3"`, a v2 factory `0xFA5429AEBa338BEa2BFcc1b9a889862Ee395bc28` and `swapRouter:"0xC062b870…9415"` (9,867 bytes of code). No docs site was found. DefiLlama's registry (third-party) lists the same factories.
- Activity: v3 had 76 pools and 2,449 swaps; v2 (Solidly Swap topic) had 5 pools and 33 swaps.
- Liquidity: USDG/NVDA ts=60 `0x18a5af4e…12cd` holds 59,076.9 USDG and 560.8 NVDA; WETH/USDG ts=10 holds 115.3 WETH and 276,704 USDG (block 71,270,955). DefiLlama shows v3 about $7.31M.
- The KyberSwap route used this `up-v3` NVDA pool.
- Why not in Phase 4: there is no docs or deployment file, and the tickSpacing CL interface needs an adapter.

### Alandale (Algebra Integral plus classic v2)
- Official: https://alandale.gitbook.io/alandale/reference/contracts lists AlgebraFactory `0x16494A80E08Bcb9285D87b67149d7b01774D82F8`, SwapRouter `0x8971d5A8…2b35`, QuoterV2 `0x58b90bA0…0FE1`, PairFactory `0xe0799417eff30A12249b8c30941BC2d7c52A0339` and RouterV2 `0xB90b0E11…5582`.
- Activity: CL had 47 pools and 2,011 swaps; v2 had 1 pair and 1 swap. Router and quoter have code.
- Liquidity: USDG/NVDA `0xf253847c…a840` holds 2,336 USDG and 5.72 NVDA; WETH/USDG holds 57.3 WETH and 56,905 USDG. DefiLlama shows about $1.14M.
- Why not in Phase 4: stock-token depth is small and it needs an Algebra adapter.

### Kittenswap (Algebra), Robinhood deployment
- Official: https://docs.kittenswap.finance/tokenomics/deployed-contracts lists AlgebraFactory `0xf03875b5Ec5eAc83cab83A6c2ab17844304AA7a0`, SwapRouter `0x7064C7Bb…374C` and QuoterV2 `0xC45E0e18…E07d`. The docs say Robinhood offers "swap + liquidity", with the full ve(3,3) on HyperEVM.
- Before these docs were found, this factory was the largest unattributed one in the scan. Activity: 4 pools and 597 swaps.
- Liquidity: USDG/NVDA `0xb56d399c…ae7d` holds 17,279 USDG and 163.9 NVDA; WETH/USDG holds 55.2 WETH and 106,491 USDG. DefiLlama shows about $444k.
- Why not in Phase 4: needs an Algebra adapter.

### GIGA (CL and v2)
- Official source is the frontend bundle only: `https://gigadex.fi/assets/index-DYxgB_-G.js` contains factories `0xece6ecd61177336ea6fb9b17937ac439d85ee20b` (CL) and `0x6fdf38f92ead1adfc04b73aaa947ab254f6c0916` (v2). The same bundle also contains `0x831880Bd…1eAA`, which DefiLlama attributes to "BrownFi V3". That is unexplained.
- Activity: the CL pools emit the **PancakeSwap-v3 Swap topic** (`0x19b47279…dc83`): 23 pools and 1,779 swaps. v2 had 1 swap.
- Liquidity: USDG/NVDA fee 100 `0xf2852136…b24a` holds 3,530 USDG and 11.0 NVDA. DefiLlama shows CL about $1.16M.
- Why not in Phase 4: no docs, thin stock liquidity, and a PCS-v3 event and ABI variant.

### SushiSwap v3 (and v2)
- Official npm package `sushi@7.3.15`, `evm/config/features/sushiswap-v3.ts`, `[EvmChainId.ROBINHOOD]` entries: factory `0xe51960f1b45f1c9fb6d166e6a884f866fc70433b`, position manager `0x51d0e518…6107`, quoter `0x3e290e5e…c7b3`. In `red-snwapper.ts`: RedSnwapper `0x8e6fd69a77e88ee20ba4b4fbd59dfcda3ec0e98a`. In `sushiswap-v2.ts`: factory `0xe52abd50…a6b1` and router `0x9a55d3d0…0766`. All have code.
- Activity: v3 had 10 pools and 507 swaps. v2 had no swaps in the window.
- Liquidity: WETH/USDG fee 500 `0x9b050cb1…3c3c` holds 208.98 WETH and 1,106,597 USDG, the deepest WETH/USDG pool found in this check. USDG/NVDA fee 3000 holds only 11.37 USDG and 0.06 NVDA.
- API: keyless GET `https://api.sushi.com/swap/v7/4663?...&sender=0x…01` returned `status: Success` for 1,000 USDG→NVDA with an assumed output of about 4.4843 NVDA and tx `to` = RedSnwapper. So it aggregates, and routes into non-Sushi pools.
- Why not in Phase 4: the Sushi pools have no stock-token depth. The API is an aggregator, not a venue.

### PancakeSwap v3 (and v2)
- Official npm package `@pancakeswap/chains@0.9.0`, `dist/chains/robinhood.d.ts`: v3Factory `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865`, v3Quoter `0x8553AA16…c832`, smartRouter `0x13f4EA83…8Dd4`, universalRouter `0xE28c0e44…64D3`, v2Factory `0x02a84c1b…749E` and v2Router `0x8cFe327C…a2Eb`. Features include `infinity: false` and `aggregator: false`. All listed routers have code.
- The Phase 0 lead of "PancakeSwap Infinity" on RH is **not supported** by the official config. The Infinity-CL-style emitters found are attributed to Orvex, or are unattributed.
- Activity: v3 (PCS Swap topic) had 4 pools and 102 swaps; v2 had 1 swap.
- Liquidity: WETH/USDG fee 500 holds 0.93 WETH and 68,614 USDG; NVDA pools are dust (at most 53 USDG). DefiLlama shows v3 about $2.83M.
- Why not in Phase 4: negligible stock-token liquidity.

### Ekubo v3 and STONX (ve33 extension)
- Official: https://docs.ekubo.org/llms-full.txt, section "Shared deterministic deployments", says v3 is deployed "at the same contract addresses on every chain" with Robinhood Chain among them. It lists Core `0x00000000000014aA86C5d3c41765bb24e11bd701`, QuoteDataFetcher `0x5a3F0F1d…03f1` and others, and describes STONX as "the first ecosystem deployment" of Ve33 on Robinhood Chain.
- Live RPC: Core has 18,797 bytes of code and emitted 292 logs, 237 of them anonymous swap logs. STONX ve33 `0xD18685A5…9953` emitted 413 logs. Window: blocks 71,248,000 to 71,268,000.
- Liquidity: the Core balance at block 71,272,134 is 495,223 USDG and 104.49 NVDA, covering all Ekubo pools. DefiLlama shows Ekubo about $1.66M and STONX about $1.12M.
- API: the keyless quoter `https://prod-api-quoter.ekubo.org` (OpenAPI https://docs.ekubo.org/openapi/quoter.json). `/4663/health` returned block 71,268,112. 1,000 USDG→NVDA returned 4.47707 NVDA through a USDG/NVDA pool whose extension is STONX ve33.
- The docs state that the API refuses to quote or plan "tokenized equities on Robinhood Chain" for restricted jurisdictions, based on the caller's IP.
- Why not in Phase 4: the singleton plus extension model needs a dedicated adapter, and the official API's jurisdiction gating of stock tokens needs a policy decision first.

### Curve
- Official: https://github.com/curvefi/curve-core/blob/main/deployments/prod/robinhood.yaml (chain_id 4663) lists stableswap factory `0x8271e06E…E8aD`, tricrypto factory `0x6E284933…15FB`, twocrypto factory `0xe7FBd704…c88C`, router `0xFF5Cb292…E8d1` and address_provider `0x4574921e…3648`. All have code.
- Activity: 1 TokenExchange (NG topic) from pool `0xec79c414…c2c6`, whose `factory()` is the official tricrypto factory, plus 2 legacy-topic swaps from pool `0x1e8d78e9…f1df`, which has no `factory()`.
- `api.curve.finance` rejects `robinhood` ("Invalid value for param blockchainId"). DefiLlama shows about $642k.
- Why not in Phase 4: almost no swap flow, and stock-token pools were not checked.

### Raphael Exchange (CL and AMM)
- Addresses come only from third-party DefiLlama registries: CL `0x5481864d…E5E3` (tickSpacing PoolCreated) and Solidly AMM `0x1A6745F8…4bd1`. The official site https://raphael.exchange is a JS bundle, and the factories were not found in its first-loaded chunks.
- Activity: CL had 32 pools and 176 swaps; AMM had 3 pools and 5 swaps. USDG/NVDA ts=200 holds 3,250 USDG and 28.9 NVDA.
- Why not in Phase 4: no official address source.

### Orvex
- DefiLlama adapter only (https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/orvex/index.js): CL pool manager `0xd01C774d…4032`, vault `0xFe7E25dE…9b0D` and v2 factory `0x5c98b2d8…Dc09`. The official page https://docs.orvex.fi/developer-resources/contract-addresses exists in its llms.txt, but it rendered as a JS/Cloudflare shell and the addresses could not be read.
- Activity: the pool manager emitted 585 PCS-Infinity-CL `Swap` events (`0x04206ad2…`). The vault holds 129,756 USDG, 159.7 NVDA and 23.2 WETH (block 71,272,134).
- Why not in Phase 4: official addresses are unverified, and the Infinity-style vault/PM architecture needs an adapter.

### Long tail and unattributed (all DISCOVERED_NOT_VERIFIED)
- DefiLlama registry factories, with swaps in the window: SwapHood v3 `0x0Ec554F0…C2A7` (PCS topic, 167), Hybra v3 `0xCeFc5Da4…3d0f` (33), RobinSwap v3 `0xea561e05…3748` (28), 0Swap v2 `0xc802A440…720e` (26), Sheriff v3 `0x21Fd9aB0…bB20` (12), Catnip v2 `0x002EC978…FB49` (8), DLMM King (SectorOne) LB `0x3d8Dc63d…687D` (4), and ParitySwap, RobinSwap v2, SwapHood v2, Sheriff v2 and Phera (1 to 2 each). DefiLlama also lists FrothSwap, KOLSwap, Morpheus, Synthra, BrownFi, Skate, LiquidCore, AEON, Hoodit and Ilyris with no swaps attributed in the window.
- Unattributed swap emitters, meaning `factory()` returned an address in none of the sources checked:
  - `0xee04c687…bc6f`: PCS-Infinity-CL-style PM with 211 swaps. Its code size is 20,885 bytes, the same as the Orvex PM.
  - `0xaa5865dc…8ffb`: v3 factory, 33 swaps.
  - `0xba04837d…e656`: PCS-v3 factory, 7 swaps.
  - `0x3f9010f8…13fb`: v2 factory, 5 swaps. It created USDG/NVDA and WETH/USDG pairs.
  - `0xe7fef2bc…`, `0x6307fc23…`, `0x0841f30f…`, `0x70fb47db…` and `0x2f171c69…`: 1 to 5 swaps each.
  - 73 v2-topic pairs with no `factory()`.
  - OpenOcean's `dexList` for 4663 names further venues, such as Metric, SectorOne, Baseline, PonsV2, Bebop, AeonV4 and SheriffV4, that may account for some of these.
- Twofold (DualPool v4 hook `0xdF1a23B1…6325`, DefiLlama only; code present). Its hook emits no logs, and Twofold pool swaps were not isolated. Kipseli (reserve `0xca9bf993…4ef6`) had 0 logs in the window. Deepstate router `0x6cf19308…7B96` has code but 0 logs in the window; DefiLlama says it holds USDG and NVDA for resting orders.
- Why not in Phase 4: no official source, and/or activity is negligible.

### Not trading venues or not spot
- Perpetuals: Arcus Perps (DefiLlama about $22.0M) and Meridian Perps (exchange `0xD540F47F…F44A`, 16 logs in window). Classified NOT_SUITABLE because they are derivatives, not spot swaps.
- LP managers and vaults: Arcadia V2, Beefy, Steer, Snuggle, vfat, StonkBrokers Smart LP, EZManager, EZMoney, Delta, Quiver and KeelLabs (DefiLlama categories "Liquidity Manager" or "Yield Aggregator"). They sit on top of the DEXes above and are not venues.

### Aggregators and RFQ (execution or routing layers, not venues)
- Robinhood's official doc https://docs.robinhood.com/chain/building-with-stock-tokens names "0x RFQ", "1inch Fusion" and "LiFi" as RFQ aggregators, "Uniswap" as the AMM, "Rialto" as the proprietary AMM, and "Lighter" as the orderbook. It names no other DEX. https://docs.robinhood.com/chain/contracts names only WETH, USDG and the Stock Token registry.
- **KyberSwap**: keyless GET `aggregator-api.kyberswap.com/robinhood/api/v1/routes` (one 50301 "overloaded" on the first try, then success). 1,000 USDG→NVDA gave 4.48597 NVDA through two paths: uniswap-v4-fairflow → ramses-v3, and up-v3. The router returned was `0x6131B5fa…37b5` (13,724 bytes of code). Its router address is not in any official deployment file checked.
- **Sushi API**: keyless, see the Sushi section.
- **LI.FI**: keyless. `/v1/chains` includes 4663 (diamond `0xB477751B…4Af3`). `/v1/tools?chains=4663` exchanges are bitget, openocean, kyberswap, fly, nordstern, lifiIntentsDex, smartDeposits and rialto. `/v1/advanced/routes` for 0.5 WETH→NVDA returned routes via `fly` and `nordstern`; lifiIntentsDex returned NO_QUOTE.
- LI.FI caveats:
  - Its token list has a **second token called "USDG"** at `0x0A3B763d…954F`. This is one more reason every identity in this project is by address, never by symbol.
  - It only matched the canonical USDG address in its correct EIP-55 checksum form.
- **OpenOcean**: `v4/4663/dexList` is keyless and lists 39 DEX codes. The `quote` call hit a Cloudflare challenge, which was not bypassed.
- **0x**: `api.0x.org/swap/chains` returned 401 "No API key found". **1inch**: `api.1inch.dev/swap/v6.0/4663/tokens` returned 401.
- **Uniswap Trading API**: keyed per Phase 0; not re-tested in this pass.
- Why not in Phase 4: aggregators are execution layers. Keyless ones (KyberSwap, Sushi, LI.FI) could serve as a benchmark quote source, but that is a separate decision.

## Method (all reads; no transactions, signatures, keys or accounts)
- RPC `https://rpc.mainnet.chain.robinhood.com`: `eth_chainId` returned 0x1237, and `eth_blockNumber` returned 71,255,601 at the start. Calls were spaced by 0.25 s or more.
- `eth_getCode` on every address cited, at blocks from about 71,255,601 to 71,272,778, reading "latest" at the time of each call.
- Swap-topic scan: `eth_getLogs` with no address filter over blocks 71,237,000 to 71,257,000 in 2,000-block chunks, for these topics:
  - Uni-v3 `Swap(address,address,int256,int256,uint160,uint128,int24)` (30,323 logs)
  - PCS-v3 `…,uint128,uint128)` (2,055)
  - Algebra-Integral 9-arg (0)
  - UniV2 `Swap(address,uint256,uint256,uint256,uint256,address)` (1,170)
  - Solidly `Swap(address,address,uint256,uint256,uint256,uint256)` (38)
  - LB `Swap(address,address,uint24,bytes32,bytes32,uint24,bytes32,bytes32)` (97)
  - Curve TokenExchange variants (2 and 1)
  - v4 `Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)` (36,974, single emitter the Uniswap v4 PM)
  - PCS-Infinity-CL `…,uint24,uint16)` (749)

  Each emitter was mapped with `eth_call factory()` (`getFactory()` for LB).
- Per-contract `eth_getLogs` by address: blocks 71,248,000 to 71,268,000 for Lighter, Ekubo, Orvex, Fables, Curve, Sushi, PCS and the others; blocks 71,244,828 to 71,264,828 for the Rialto router. Fables used v4 `Swap` filtered by the 32 pool ids from the bundle.
- Pool lookups at block 71,270,955: `getPool(a,b,uint24)` over fees 100 to 10000, `getPool(a,b,int24)` over tickSpacings 1 to 200, and Algebra `poolByPair`, followed by `balanceOf` for USDG, NVDA and WETH. Core and vault balances were read at block 71,272,134. The Rialto registry `getFeature(uint128)` was read at block 71,264,828.
- Web and API GETs: docs.robinhood.com/chain/{lighter-domains, contracts, building-with-stock-tokens}; docs.rialto.xyz/{llms.txt, developers/*.md}; rialto-trade-api.rialto.xyz/tokens; api.rh.lighter.xyz/api/v1/{orderBooks, orderBookDetails, orderBookOrders}; apidocs.rh.lighter.xyz; api.llama.fi/protocols and /v2/chains; the DefiLlama-Adapters GitHub (registries/uniswapV2.js, uniswapV3.js, traderJoeV2.js, sumTokens/data*.js, projects/*); registry.npmjs.org tarballs `@pancakeswap/chains@0.9.0`, `@pancakeswap/v3-sdk@3.10.2` and `sushi@7.3.15`; curve-core deployments/prod/robinhood.yaml; api.curve.finance; www.ramses.xyz/docs/contract-addresses; alandale.gitbook.io/alandale/reference/contracts; docs.kittenswap.finance/tokenomics/deployed-contracts; docs.ekubo.org/{llms.txt, llms-full.txt, openapi/quoter.json}; prod-api-quoter.ekubo.org/4663/*; docs.orvex.fi/llms.txt; frontend bundles of fables.fi, up33.xyz and gigadex.fi; li.quest/v1/{chains, tools, tokens, advanced/routes}; api.sushi.com/swap/v7/4663; aggregator-api.kyberswap.com/robinhood; open-api.openocean.finance/v4/4663/{gasPrice, dexList, quote}; api.0x.org; api.1inch.dev.
- Not possible: the Blockscout explorer API (robinhoodchain.blockscout.com) and the OpenOcean quote returned Cloudflare challenges, and they were not bypassed. As a result, contract names from the explorer were not used.
- Caveats: the 20k-block window is about 34 minutes, a snapshot and not a volume measure. TVL figures are DefiLlama (third-party). Pool balances are raw token balances, not in-range liquidity.
