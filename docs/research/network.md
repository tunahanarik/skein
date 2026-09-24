# Robinhood Chain: network facts

Checked 2026-09-24 (live) and 2026-09-23 (prior research in `Desktop/robinhood-terminal/docs/research/evidence/A_network.md`, re-used where marked). Reproduce the live parts with `pnpm validate:network`. The snapshot is `research/snapshots/network.json`.

## CONFIRMED

| Fact | Value | Evidence |
|---|---|---|
| Network name | "Robinhood Chain" (brand rules require exactly this form) | [docs /chain/brand-guidelines](https://docs.robinhood.com/chain/brand-guidelines) |
| Mainnet chain ID | **4663** | [docs /chain/connecting](https://docs.robinhood.com/chain/connecting); live `eth_chainId` = `0x1237`; `ArbSys(0x64).arbChainID()` = 4663 (block 71141644) |
| Testnet chain ID | 46630 | docs /chain/connecting; `eth_chainId` = `0xb626` (2026-09-23) |
| Stack | Arbitrum Orbit (Nitro) rollup settling to Ethereum L1 | docs [/chain/protocol-contracts](https://docs.robinhood.com/chain/protocol-contracts); `l1BlockNumber` matched Ethereum head (2026-09-23) |
| Native gas token | ETH, 18 decimals | docs /chain/connecting |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com`, officially **"Rate-Limited, Not for Production"** | docs /chain/connecting; [ToS](https://docs.robinhood.com/chain/terms-of-service) §2.1 |
| Recommended providers | Alchemy (`https://robinhood-mainnet.g.alchemy.com/v2/{KEY}`), QuickNode, Chainstack, Blockdaemon, dRPC, Validation Cloud, GlobalStake | docs /chain/connecting |
| Explorer | `https://robinhoodchain.blockscout.com` (UI). Its `/api` is behind a Cloudflare challenge for scripts; the ToS forbid bypassing it | 2026-09-23 probe |
| Etherscan V2 | chainid 4663 listed (`robin.etherscan.io`); a key is required; paid tier (Lite+) from 2026-10-16 | [api.etherscan.io/v2/chainlist](https://api.etherscan.io/v2/chainlist) |
| Block time (observed) | **0.101 s/block** over 1,000 blocks (live 2026-09-24); Blockscout stats 0.101 s | live |
| Block timestamps | 1-second resolution; ~10 blocks share a second, so ordering must use `(blockNumber, logIndex)` | 2026-09-23 probe |
| Finality model | soft confirmation (sequencer) → posted to Ethereum (minutes) → Ethereum finality (~13 min after posting). **No numeric confirmation count is recommended.** | [docs /chain/transaction-finality](https://docs.robinhood.com/chain/transaction-finality) |
| `safe` / `finalized` lag | safe 5,732 blocks / 576 s; finalized 9,575 blocks / 966 s behind latest (one sample, 2026-09-24) | live |
| EVM compatibility | Standard EVM with Arbitrum differences: `block.number` in Solidity returns an **L1 estimate** (use `ArbSys.arbBlockNumber()`), 96 KB contract size limit, first-come-first-served ordering | [docs /chain/differences-from-ethereum](https://docs.robinhood.com/chain/differences-from-ethereum) |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11`: 3,808 bytes, **`aggregate3` works** | live |
| Robinhood "L2 Multicall" | `0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1` (listed in the docs): 3,339 bytes, **`aggregate3` reverts**; only `aggregate` / `tryAggregate` | live |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`: "WETH", 18 dec; EIP-1967 impl `0xC6B81b42…947e`, admin `0xa3Acd31A…67dF` (= L2 Proxy Admin in docs) | docs /chain/protocol-contracts + live |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` (canonical) | docs + live (2026-09-23) |
| Oracle provider | Chainlink is the only one documented | [docs /chain/oracles-and-price-feeds](https://docs.robinhood.com/chain/oracles-and-price-feeds) |

### Public RPC limits (observed, not documented)
- HTTP 429 comes quickly. JSON-RPC batches of 10 or fewer, spaced ≥1.2 s apart, are sustainable. viem is configured with `batchSize: 10` and retries.
- **Not archive:** only about 10 minutes of state is kept, and `eth_call` at `safe`/`finalized` fails. Logs go back to genesis.
- `eth_getLogs` fails when one query matches more than 10,000 logs (`-32000`) or runs too long ("log query timed out").
- No WebSocket, no `eth_subscribe`, no `debug_`/`trace_` methods, no `eth_newFilter`.
- A Multicall3 `aggregate3` with 975 subcalls ran in about 0.5 s without problems. This matters most for our design: **one call can read the whole Stock Token registry.**

## LIKELY
- The `safe` tag means "batch in a safe L1 block" and `finalized` means "batch in a finalized L1 block". This fits the observed L1 lags, but no primary Arbitrum page defines it.

## UNVERIFIED
- The public RPC's actual rate-limit numbers.
- Alchemy archive depth and debug support for 4663 (Alchemy's own two pages conflict).
- Official public-launch date. Block 1 is 2026-04-30; "July 1, 2026" appears only in a secondary source.

## Implications for the router
1. The public RPC is fine for validation scripts and low-volume reads. **Production needs a keyed provider** (Alchemy or QuickNode, per the official list).
2. Use Multicall3 `0xcA11…`, not the documented L2 Multicall, for batched reads. `apps/web/src/lib/chain.ts` in PerchSwap already does this; PerchSwap's `shared/addresses.json` labels the wrong one as `multicall3`.
3. Any value we display must be read at `latest` and tagged with its block number; historical `eth_call` is not available without an archive provider.
