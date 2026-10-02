# USDG (Global Dollar)

Checked 2026-09-24. Evidence: `research/evidence/yield/` (paxos_usdg_mainnet.txt, rpc_usdg*.json) and `pnpm validate:assets` / `validate:oracles`.

## CONFIRMED

| Field | Value | Source |
|---|---|---|
| Contract | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`: "Global Dollar", USDG, **6 decimals** | [Paxos USDG mainnet addresses](https://docs.paxos.com/guides/stablecoin/usdg/mainnet) ("Robinhood Mainnet"); [docs /chain/contracts](https://docs.robinhood.com/chain/contracts); live |
| Issuer | Paxos Digital Singapore Pte. Ltd. (MAS-supervised), for the Global Dollar Network; redeemable 1:1 for USD through Paxos | [docs.paxos.com/guides/stablecoin/usdg](https://docs.paxos.com/guides/stablecoin/usdg/index.md) |
| Supply | 699.6M USDG (block 71142408) | live `totalSupply()` |
| Supply control | `0xdf5FfF9cb88B3cAb50572FAE73E2EB08599D25D4`; `supplyControl()` onchain returns the same address | Paxos page + RPC |
| Cross-chain | LayerZero OFT model; OFT wrapper `0x0d54755f5106BfdB43f7a35f5D49a23F940628d1` (`token()` = USDG), EndpointV2 `0x6F475642a6e85809B1c36Fa62763669b1b48DD5B`, EID 30416 | Paxos page + RPC |
| Proxy | ERC-1967 (170-byte proxy). Implementation `0x68184C449E1a8f34fA18d289737129FD27B66f8F` (UUPS: the upgrade functions live in the implementation); admin slot empty | live `eth_getStorageAt` |
| Admin | `owner()` = `defaultAdmin()` = `0xcfa0388f5ddf905fdc08c45c716c15dc10a14c6f` (a contract); `defaultAdminDelay` = 3 h | RPC |
| Issuer controls | `pause()`, `isFrozen(address)`, `freeze(address)`, `wipeFrozenAddress(address)` via a facet router. **Paxos can freeze and wipe balances.** | RPC `facets(bytes4)` + 4-byte lookup |
| Chainlink USDG/USD | proxy `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2`, 8 dec, heartbeat 86,400 s, deviation 0.5 %, **not** "stablecoinCapped". Answer **1.00009**, about 14.5 h old at check | directory + live |
| Robinhood partner listing | Paxos (USDG) is the stablecoin partner in the docs' ecosystem table | docs bundle |

## How to value USDG (do not hardcode $1)

Implemented in `apps/cli/src/portfolio.ts`; to become the Price Service rule in Phase 1:

1. **Primary:** the Chainlink USDG/USD answer. Reject it if `answer ≤ 0`, if `now − updatedAt > heartbeat (86,400 s)`, or if `answeredInRound < roundId`. A day-old answer is normal for a stable asset (it only updates on a 0.5 % move or at the heartbeat), so "old" ≠ "wrong".
2. **Cross-check:** the Uniswap v3 WETH/USDG 0.01 % pool `0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca` (about $19.1M TVL) mid × Chainlink ETH/USD. That gives a market price for USDG.
3. **Depeg flag:** raise it when |feed − 1| > 0.5 %, or when feed and DEX disagree by more than 1 %.
4. **Fallback:** $1.00 labelled **"assumed peg"**, with verification `UNVERIFIED`, and never shown silently.
5. **Frozen holders:** if `isFrozen(wallet)` is true, that wallet's USDG is not spendable whatever the price says.

## USDG opportunities found on 4663 (details in protocols.md)

| Venue | Type | Headline (2026-09-24) | Status |
|---|---|---|---|
| Morpho, Steakhouse USDG vault `0xBeEff033…09dd` | VAULT | ≈ 3.97 % net APY, $497.8M | VERIFIED_ONCHAIN. API warning `deposit_disabled`; Merkl marks its 3.05 % reward "Robinhood Users Only" |
| Morpho listed USDG markets (USDe, syrupUSDG, mGLO, spUSDG collateral) | LEND | 2.7–5.0 % supply APY | VERIFIED_ONCHAIN |
| Spark Savings spUSDG `0xde770c84…4087` | YIELD / savings | **3.500 %** (vsr), 14.16M USDG | VERIFIED_ONCHAIN |
| Pendle USDG market `0xc2b89e6e…4f55f4c` | FIXED_YIELD | 3.50 % implied | onchain yes, **not listed** by Pendle |
| Uniswap / Beefy / Steer USDG pairs | LP | varies | VERIFIED (see dex.md) |
| Arcadia USDG lending pool | LEND | – | LIKELY (pool address from DefiLlama adapter) |

## LIKELY
- USDG is issued natively on Robinhood Chain, not bridged: it is Paxos's own contract with its own SupplyControl on 4663, and the OFT wrapper handles cross-chain moves. No sentence in the Paxos or Robinhood docs says "natively issued" in so many words.

## UNVERIFIED
- A Robinhood-published USDG price endpoint (none found; `/rhj/*` covers Stock Tokens only).
- The eligibility and mechanics of Paxos "Global Dollar Network rewards". It is a KYB, off-chain business flow, not an onchain opportunity for our users.
