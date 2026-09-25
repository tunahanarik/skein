# In-app swaps

The server stays read-only. Swaps are built in the browser and signed in the user's own wallet.

## Wallets

Browser-extension wallets are discovered with EIP-6963 (MetaMask, Rabby, OKX Wallet, Coinbase
Wallet, Trust Wallet, …), with `window.ethereum` as a fallback. That fallback also covers wallets
with a built-in dApp browser, such as Robinhood Wallet (mobile), once the site is reachable from the phone.
WalletConnect (QR code) is not enabled: it needs a Reown project id.

The page reaches the wallet through a method allowlist (`web/src/wallet.tsx`): accounts, chain id,
`wallet_switchEthereumChain` / `wallet_addEthereumChain`, `eth_call`, `eth_getTransactionReceipt`,
`eth_sendTransaction`. No message or typed-data signing, no permits. The address stays in memory.

## What can be sent

`web/src/swap/uniswap.ts` builds exactly two transaction shapes, and `checkTx` refuses anything else
right before `eth_sendTransaction`:

| Step | Target | Call |
| --- | --- | --- |
| Approve (only if the allowance is short) | the route's input token | `approve(SwapRouter02, amountIn)`: exact amount, never unlimited |
| Swap | SwapRouter02 `0xcaf6…5cb2` | `multicall(deadline = now + 10 min, [exactInput(path, recipient = user, amountIn, amountOutMinimum)])` |

The transaction has no ETH value. The recipient is always the connected address.

Only routes whose every hop is a Uniswap v3 pool with a known fee tier (1–2 hops) get a Swap button.
Ramses, Uniswap v4 and mixed-venue routes link to the protocol's own app.

## Flow

1. The user enters an amount and compares routes (server quotes, indicative).
2. Swap opens a dialog. It checks the network and offers a switch to Robinhood Chain. It then
   reads the balance, the allowance and a **fresh QuoterV2 quote** through the wallet's own RPC,
   so the page makes no third-party calls (CSP unchanged).
3. Just before signing, it re-quotes and sets `amountOutMinimum = quote × (1 − slippage)`.
   Slippage can be 0.1%, 0.5% (the default), 1% or 3%. The transaction is dry-run with `eth_call`,
   then sent. High or extreme price impact needs an explicit acknowledgement.
4. The receipt is polled through the wallet and linked on Blockscout.

## Verification

- `test/unit/swap.test.ts`: route eligibility, path packing, calldata, `minOut`, and `checkTx`
  rejecting another sender, an ETH value, another target or recipient, no minimum, another path,
  or an approval to another spender or token. It also checks that the constants equal the
  server's verified deployment.
- `web/src/app.test.tsx`: the full UI flow against a fake EIP-6963 wallet (discover, connect,
  approve the exact amount, swap). It also checks that no signing methods are called and that the
  address is not stored.
- `pnpm validate:swap` (live, nothing sent): SwapRouter02 identity (factory, WETH9). The browser
  quote equals the server quote for the same route (Δ 0 bps). The browser's exact calldata executes on the
  real router via `eth_call` with a state-overridden balance, for 1 and 2 hops: output equals
  the quote. It reverts when the minimum is above what the pool gives.
