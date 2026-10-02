# RPC layer

`packages/chain/src/`. Engine code talks to the chain only through the `ChainReader` interface. That interface has no signing or sending method.

```ts
interface ChainReader {
  chainId: 4663
  assertChainId()                       // eth_chainId must be 4663, else throw
  getLatestBlock()                      // number, hash, timestamp
  getNativeBalance(address, block)
  multicall(calls, { blockNumber })     // order-preserving; per-call success/failure; never throws per call
  readContract(call, { blockNumber })
  health()                              // RpcHealthSnapshot
}
```

`ViemChainReader` implements it on viem, pointed at any provider.

## Configuration (`rpcConfig.ts`, env)

| Variable | Default | Notes |
|---|---|---|
| `ROBINHOOD_RPC_URL` | public `https://rpc.mainnet.chain.robinhood.com` | **production (`APP_ENV`/`NODE_ENV=production`) refuses the public RPC** and https is required |
| `RPC_MULTICALL_CHUNK_SIZE` | 400 | calls per `aggregate3` request |
| `RPC_MAX_ATTEMPTS` | 4 | per request |
| `RPC_TIMEOUT_MS` | 20,000 | per request |
| `RPC_RETRY_BASE_MS` | 600 | linear backoff; ×3 for rate limits |

Official providers (docs /chain/connecting) are Alchemy, QuickNode, Chainstack and others; the choice is still open.

## Behaviour
- **Retries** live in the reader, not in viem, so each attempt is counted.
  - 429 / rate limit → longer backoff.
  - Timeout → normal backoff.
  - A contract revert is deterministic and is not retried (`readContract`).
- **Multicall3** `0xcA11…CA11` `aggregate3` with `allowFailure: true`, chunked by call count (viem's byte chunking is disabled with `batchSize: 0`). The reason for this contract: Robinhood's documented L2 Multicall `0x2cAC…DaD1` has no `aggregate3` (verified in Phase 0).
- **Partial failure:**
  - A reverting call → `{status: "failure", kind: "REVERT"}`.
  - A chunk failing after retries → each of its calls is `{kind: "RPC"}` and the next chunk still runs.
- **Deterministic:** results are in request order, every read is pinned to one `blockNumber`, and there are no `latest` reads mid-portfolio.

## Health (`health.ts`)
The reader tracks:
- requests, successes, failures
- rate-limited count, timeouts, retries
- average and p95 latency over the last 200 requests
- latest block seen
- last error
- `status`: HEALTHY, DEGRADED (any failure in the window), DOWN (last 3 requests failed) or UNKNOWN (no requests yet)

The endpoint is reported as scheme + host only, because provider URLs carry API keys in the path. The portfolio attaches the snapshot and raises `RPC_DEGRADED` / `PUBLIC_RPC_IN_USE`, so degradation can be told apart from bugs.

Live 2026-09-24 (public RPC, full Phase 1 validation): 22 requests, 0 failures, avg 224 ms, p95 425 ms, HEALTHY.
