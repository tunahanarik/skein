import { parseAbi } from "viem";

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

/**
 * Stock Token view surface. ERC-8056 names from docs /chain/building-with-stock-tokens;
 * the others were matched from implementation bytecode selectors (verified source is not
 * readable: the explorer API is Cloudflare-blocked). See docs/research/stock-tokens.md.
 */
export const stockTokenAbi = parseAbi([
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function balanceOfUI(address) view returns (uint256)",
  "function totalSupplyUI() view returns (uint256)",
  "function uid() view returns (bytes32)",
  "function paused() view returns (bool)",
  "function oraclePaused() view returns (bool)",
  "function ACCESS_CONTROLLED_REGISTRY() view returns (address)",
  "event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)",
]);

export const chainlinkAggregatorAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/** EIP-1967 storage slots, for reading proxy implementation/admin/beacon. */
export const EIP1967_SLOTS = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
} as const;
