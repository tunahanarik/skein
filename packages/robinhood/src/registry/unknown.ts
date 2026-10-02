/**
 * Unknown tokens: contracts NOT in the canonical registry. Phase 1 does not discover them
 * (that needs an indexer; see docs/asset-registry.md). They can only enter a portfolio when
 * a caller names the address explicitly, and then they are always:
 *   canonical: false · type UNKNOWN · verification UNVERIFIED · unpriced.
 * Their self-reported symbol/name/decimals are data from an untrusted contract.
 */
import type { Address } from "viem";
import { ROBINHOOD_CHAIN_ID } from "@skein/networks/chains";
import { erc20Abi } from "@skein/core/config/abis";
import type { ChainReader } from "@skein/chain/reader";
import { assetKey, type Asset } from "./asset.js";
import type { AssetRegistry } from "./registry.js";
import { sanitizeLabel } from "@skein/core/lib/sanitize";

export interface UnknownTokenInspection {
  asset: Asset;
  /** Canonical assets using the same symbol: this token may be impersonating one of them. */
  lookalikeOf: Asset[];
  metadataReadable: boolean;
}

export async function inspectUnknownToken(
  reader: ChainReader,
  registry: AssetRegistry,
  address: Address,
  blockNumber: bigint,
): Promise<UnknownTokenInspection> {
  const known = registry.get(ROBINHOOD_CHAIN_ID, address);
  if (known) throw new Error(`${address} is in the registry (${known.symbol}); not an unknown token`);
  const [sym, name, dec] = await reader.multicall(
    [
      { address, abi: erc20Abi, functionName: "symbol" },
      { address, abi: erc20Abi, functionName: "name" },
      { address, abi: erc20Abi, functionName: "decimals" },
    ],
    { blockNumber },
  );
  const symbol = sym?.status === "success" && typeof sym.result === "string" ? sanitizeLabel(sym.result, 16) : "";
  const tokenName = name?.status === "success" && typeof name.result === "string" ? sanitizeLabel(name.result) : "";
  // decimals() is uint8 by ABI; anything else means we cannot interpret balances.
  const decimals = dec?.status === "success" && typeof dec.result === "number" && dec.result <= 36 ? dec.result : null;
  const asset: Asset = {
    key: assetKey(ROBINHOOD_CHAIN_ID, address),
    chainId: ROBINHOOD_CHAIN_ID,
    address,
    symbol: symbol || "?",
    name: tokenName || "Unknown token",
    decimals: decimals ?? 0,
    type: "UNKNOWN",
    canonical: false,
    verificationStatus: "UNVERIFIED",
    priceMethods: [],
    provenance: [
      {
        type: "ONCHAIN",
        provider: "robinhood-chain-rpc",
        chainId: ROBINHOOD_CHAIN_ID,
        contract: address,
        method: "symbol()/name()/decimals() — self-reported, untrusted",
        blockNumber,
        observedAt: new Date().toISOString(),
      },
    ],
  };
  return {
    asset,
    lookalikeOf: symbol ? registry.canonicalBySymbol(symbol) : [],
    metadataReadable: decimals !== null,
  };
}
