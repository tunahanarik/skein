# Bridge

`/bridge` moves tokens between Robinhood Chain and every other LI.FI mainnet through **LI.FI**,
the aggregator Robinhood's chain docs list next to the canonical bridge
(docs.robinhood.com/chain/bridging). LI.FI compares bridges (Across, Relay, Stargate, …) and
returns one transaction to its own contract (the "diamond") on the source chain. The user signs
it in their own wallet (docs/swaps.md, "Wallets").

## Trust boundaries

- **The browser calls li.quest directly** (CSP `connect-src 'self' https://li.quest`). The wallet
  address is needed to build the transaction, so it goes to LI.FI, but never through this server.
- **Pinned diamonds**: `web/src/bridge/diamonds.ts`, 63 chains, pinned from li.quest on 2026-09-25.
  A bridge starts only on a pinned EVM chain: that is the only place a transaction is signed.
- **Destination-only networks**: every other LI.FI mainnet: Solana, Bitcoin and Sui, plus EVM
  networks without a diamond (Hyperliquid, Lighter). They are listed with a "to only" tag and
  cannot be picked as the source.
- **Recipient**:
  - EVM destination: always the connected address.
  - Solana, Bitcoin and Sui: the user pastes an address on that chain, and `validRecipient` checks it:
    - Solana: base58 of exactly 32 bytes (Solana addresses carry no checksum).
    - Bitcoin mainnet: bech32 or bech32m checksum, or base58check for "1…" and "3…" addresses.
    - Sui: 0x plus 64 hex.
  - No quote is requested until the recipient is valid. The panel warns that a transfer to a wrong
    address cannot be reversed.
- **`checkBridgeQuote`** runs on every quote and again on the fresh re-quote made right before
  signing. It checks:
  - the source and destination chains, the tokens, the amount, the sender (the user) and the
    recipient all equal the request. The recipient is the user on EVM destinations, or the checked
    address on Solana, Bitcoin and Sui, compared exactly because base58 is case-sensitive.
  - `tx.to` is the pinned diamond of the source chain, and so is the approval spender
  - ETH value: for native input it equals the amount, plus only fees the quote declares as paid
    on top in the native coin (shown to the user); for ERC-20 input it is 0 unless such a fee is declared
  - there is a minimum output
- **Approvals** are for the exact amount only.
- **Token lists**:
  - Robinhood Chain side: only the native coin and canonical registry assets. LI.FI also lists
    look-alikes, such as a second "USDG" at `0x0A3B…`, and these are dropped.
  - Other chains: LI.FI-verified tokens only. Hyperliquid and Lighter have no verified list, so
    LI.FI's own list is shown.
  - Token metadata is sanitized (control and bidi characters removed, length bounded).
- Status is polled from LI.FI `/v1/status` until DONE or FAILED. Transactions link to scan.li.fi.
- Quotes appear automatically. Before a wallet is connected, the quote is built for a throwaway
  address and is only displayed. Sending always re-quotes for the connected address and runs
  `checkBridgeQuote` again.
- Logos:
  - Robinhood Chain tokens use our verified `/api/logo`.
  - Other tokens and all networks use LI.FI's logo URLs, fetched by the server through
    `/api/img` (`src/server/images.ts`). Only allowlisted https hosts and paths are fetched, with
    no redirects, a 256 KB cap and a type check. SVG is served under a sandboxing CSP, and results
    are cached. The browser still loads images only from our own origin.
  - Wallet icons for the install list are bundled in `web/public/wallets` (from each wallet's
    official site; Trust Wallet's from its `trustwallet/assets` repo).

Solana, Bitcoin and Sui cannot be sources yet: that needs non-EVM wallets (Phantom, a Bitcoin wallet, Sui Wallet).

## Verification

- `test/unit/bridge.test.ts`: the pins, plus `checkBridgeQuote` refusing each of these: another
  contract, the wrong chain's diamond, another spender, another recipient or sender, another
  amount or token or chain, ETH value on an ERC-20 bridge, and no minimum. Also token sanitizing.
- `web/src/app.test.tsx`: the full UI flow against fake LI.FI and a fake EIP-6963 wallet. It
  checks that the look-alike token is hidden, the exact approval to the diamond, the re-quote
  before signing, the send to the diamond, and tracking until done.
- `pnpm validate:bridge` (live, nothing sent):
  - pins equal li.quest
  - pins equal LI.FI's GitHub deployment records (lifinance/contracts) for 9 chains, Robinhood included
  - the Robinhood diamond has code
  - five real quotes in both directions pass `checkBridgeQuote`
