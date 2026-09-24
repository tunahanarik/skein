import { getAddress, isAddress, type Address } from "viem";

export class ValidationError extends Error {
  override readonly name = "ValidationError";
}

/**
 * Parse an untrusted wallet/contract address. Accepts all-lowercase or correctly checksummed
 * input; rejects mixed case with a bad checksum (a likely typo or tampered paste).
 * Returns the checksummed form, which is what every registry key uses.
 */
export function parseAddress(input: unknown): Address {
  if (typeof input !== "string") throw new ValidationError("address must be a string");
  const trimmed = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) throw new ValidationError(`not a 20-byte hex address: ${trimmed}`);
  if (!isAddress(trimmed, { strict: true })) throw new ValidationError(`address checksum mismatch: ${trimmed}`);
  return getAddress(trimmed);
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** A wallet we will scan: valid and not the zero address. */
export function parseWalletAddress(input: unknown): Address {
  const address = parseAddress(input);
  if (address === ZERO_ADDRESS) throw new ValidationError("zero address is not a wallet");
  return address;
}

/** Case-insensitive identity check. Token identity is the address, never the symbol. */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Parse a chain id from an RPC (`eth_chainId` hex), a wallet (number) or config (string),
 * and require it to be one we support.
 */
export function parseChainId(input: unknown, supported: readonly number[]): number {
  let id: number;
  if (typeof input === "number") id = input;
  else if (typeof input === "bigint") id = Number(input);
  else if (typeof input === "string" && /^0x[0-9a-fA-F]+$/.test(input)) id = Number.parseInt(input, 16);
  else if (typeof input === "string" && /^[0-9]+$/.test(input)) id = Number.parseInt(input, 10);
  else throw new ValidationError(`unparseable chain id: ${String(input)}`);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError(`invalid chain id: ${String(input)}`);
  if (!supported.includes(id)) throw new ValidationError(`unsupported chain id ${id}`);
  return id;
}
