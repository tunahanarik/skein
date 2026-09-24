import { linkProps } from "../router";

export function AboutPage() {
  return (
    <div className="prose">
      <h1>How it works</h1>
      <p>
        Waypoint answers one question: <em>I hold this asset on Robinhood Chain — what can I actually do with it?</em> It reads protocols directly from the chain and from
        their public APIs, checks what it reads, and shows the result with its source and age. It never moves funds.
      </p>

      <h2>Read-only, by construction</h2>
      <ul>
        <li>The code has no wallet client and no way to sign, approve or send a transaction.</li>
        <li>“Use my browser wallet” only asks the wallet for its public address. That address stays in this tab's memory. It is not saved, not put in the URL and not sent to any protocol.</li>
        <li>Quotes are indicative reads of each pool's onchain quoter. They are not guaranteed prices and carry no minimum output.</li>
      </ul>

      <h2>What gets shown</h2>
      <p>Every opportunity gets one of five statuses. The status is kept separate from how well the data is verified:</p>
      <ul>
        <li>
          <strong>Available</strong>: passes every check we run.
        </li>
        <li>
          <strong>Limited</strong>: can be used, with a stated limitation. Examples: under $10,000 of liquidity, 1–15% price impact for your amount, or stale data.
        </li>
        <li>
          <strong>Info only</strong>: shown for context, but its purpose cannot be met now. Example: a borrow market with nothing left to borrow.
        </li>
        <li>
          <strong>Hidden</strong>: an evidence problem. Examples: conflicting oracle data, a look-alike token, under $50 of liquidity, 15%+ price impact, or a yield figure whose meaning is unresolved.
        </li>
        <li>
          <strong>Unavailable</strong>: matured, paused or closed to deposits.
        </li>
      </ul>
      <p>Hidden and unavailable items can be listed on any asset page with “Show hidden”. Each one comes with its reasons.</p>

      <h2>How lists are ordered</h2>
      <p>
        There is no “best” and no overall score. Categories are never compared with each other. Within one list, available items come first, then the list's own rule applies.
        For example, lending is ordered by supply APY, borrowing by lower borrow APY within the same borrowed asset, and a swap quote by expected output. The rule is printed
        above every list.
      </p>

      <h2>Stock Tokens</h2>
      <p>
        A Stock Token balance is shown as tokens. The share-equivalent (tokens × the onchain multiplier) is shown next to it for reference. Pendle rates for Stock Tokens are measured
        in shares, not tokens, and are labelled that way.
      </p>

      <h2>Coverage and limits</h2>
      <p>
        Today the app reads Uniswap v3 (trading), Morpho (lending, borrowing, vaults) and Pendle (fixed rates, yield tokens, liquidity). Uniswap v4, other exchanges, and 24-hour
        volume are not covered yet. See <a {...linkProps("/coverage")}>Coverage</a> for every asset.
      </p>
      <p className="faint small">
        Prices come from Chainlink feeds, with the Robinhood quote as a fallback. Rates come from each protocol and are cross-checked onchain where possible. This is information, not
        advice.
      </p>
    </div>
  );
}
