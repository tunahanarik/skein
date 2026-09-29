# HTTP API and web app (Phase 6)

A read-only JSON API (`src/server/api.ts`) over the Phase 5 service, plus a web app (`web/`, React + Vite) served from the same origin by `src/server/main.ts`. The server uses plain `node:http` and has no framework dependency.

```bash
pnpm start            # build the web app, then serve API + app on http://127.0.0.1:8787
pnpm serve            # serve only (uses an existing web/dist)
pnpm web:dev          # Vite dev server on :5173, proxies /api to :8787 (run `pnpm serve` too)
```

| Env | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | 8787, 127.0.0.1 | listen address |
| `ROBINHOOD_RPC_URL` | public RPC (dev only) | required in production ([rpc.md](rpc.md)) |
| `SNAPSHOT_MAX_STALE_MS` | 300000 | serve an expired engine snapshot this long while it refreshes in the background |
| `RATE_HISTORY_FILE` | `.cache/history/rates.jsonl` | local rate history (headline rate of eligible opportunities, every 10 min, 30-day retention) |
| `DISABLE_THIRD_PARTY_VOLUME` | unset | `1` = do not ask GeckoTerminal for 24h volume |
| `TRUST_PROXY` | unset | `1` = rate-limit by `X-Forwarded-For` (only behind a known proxy) |
| `WEB_DIST` | `web/dist` | built web app |

## Endpoints (GET/HEAD only)
| Path | Returns | Cache-Control |
|---|---|---|
| `/api/health` | `{ chainId, readOnly: true, rpc }` (RPC endpoint redacted) | no-store |
| `/api/assets` | canonical asset list `{ key, symbol, name, type, address, decimals }` | 5 min |
| `/api/assets/:ref?mode=product\|debug&to=&amount=` | `AssetIntelligence` ([asset-intelligence.md](asset-intelligence.md)); `ref` = symbol, address or `4663:0x…` key | 10 s; `no-store` with an amount |
| `/api/portfolio/:address?mode=` | `PortfolioIntelligence` | no-store |
| `/api/coverage` | `{ rows: CoverageRow[] }` | 15 s |
| `/api/assets/:ref/history` | the Chainlink feed's last 49 rounds (`getRoundData`, one multicall), oldest first, with an exact change. Stock Token feeds include the multiplier | 60 s |
| `/api/rates/history?id=` | locally recorded headline-rate history of one opportunity, with `recordingSince` (history exists only while this server runs) | 60 s |
| `/api/logo/:address` | token logo for a canonical asset, proxied from the registry's `logoUrl` | 1 day |

Logo proxy rules (`src/server/logos.ts`):
- Only `https://cdn.robinhood.com`: the only host in the Robinhood registry's `logoUrl` fields.
- Redirects are refused.
- Images are PNG/JPEG/WebP detected by magic number; SVG is refused because it can carry script.
- At most 256 KB.
- Cached in memory and in `.cache/logos` (gitignored). A failure is remembered for 10 min.
- Served with `Content-Security-Policy: default-src 'none'; sandbox`.
- Logos have their own rate-limit bucket (1200/min), because a coverage page shows about 200.

`/asset/:ref` pages get an app shell with the asset's title, description and Open Graph tags, for link previews. The values come from registry data and are HTML-escaped.

Bigints travel as decimal strings (`Wire<T>` in `src/server/wire.ts`), so no precision is lost.

Errors are `{ error: { code, message } }` and never carry stack traces:

| Status | Codes |
|---|---|
| 400 | BAD_MODE, BAD_AMOUNT, AMOUNT_NEEDS_TARGET, SAME_ASSET, BAD_ADDRESS, BAD_ASSET |
| 404 | UNKNOWN_ASSET, NOT_FOUND |
| 405 | METHOD_NOT_ALLOWED |
| 409 | AMBIGUOUS_SYMBOL |
| 429 | RATE_LIMITED |
| 500 | INTERNAL |

## Protections
- **Rate limit:** per client IP, token bucket. 120 requests/min in general, and 20/min for expensive requests (explicit-amount quotes, DEBUG mode, portfolio, coverage). A 429 carries `Retry-After`. The limiter is in memory, so a multi-instance deployment needs a shared store.
- **Input validation:**
  - symbols `^[A-Za-z0-9.\-]{1,16}$`
  - addresses checked with viem `isAddress`
  - amounts are positive decimals of at most 40 characters, with no exponent
  - path segments of at most 100 characters
- **Privacy:**
  - Request logs record the route **template** (`/api/portfolio/:address`), status and duration, never the raw path.
  - Error log lines have addresses masked.
  - Portfolio responses are `no-store`.
  - The wallet address reaches only the onchain balance reader.
- **Headers:**
  - `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, COOP/CORP same-origin, and a restrictive `Permissions-Policy`
  - on the app: a strict CSP (`default-src 'self'`, `script-src 'self'`, `connect-src 'self'`, no inline scripts, `frame-ancestors 'none'`)
  - no third-party origins at all: no CDN, no web fonts, no analytics
- **Static files:** path traversal is rejected, because the resolved path must stay inside `web/dist`. A missing asset file is a 404, not the app shell. Hashed assets are immutable and the shell is revalidated.
- **Timeouts:** headers 20 s, request 60 s.

## Web app
The pages are:
- **Explore:** asset search, a wallet entry and the watchlist (starred assets, kept in localStorage)
- **Asset:** capabilities, categories, a route table, explicit-amount quotes and "show hidden" (DEBUG)
- **Wallet:** holdings and what each holding can do
- **Coverage:** the matrix for all assets
- **Compare:** two assets side by side (`/compare?a=&b=`, public symbols only)
- **How it works**

Wallet handling (`web/src/wallet.tsx`):
- "Use my browser wallet" calls only `eth_requestAccounts`. A wrapper refuses every other EIP-1193 method, so the app cannot request a signature or a transaction even by mistake.
- The address is kept in React state only. It is never put in the URL, localStorage or logs.

Languages: English (default) and Turkish, switchable in the header. The choice is stored in `localStorage` (a UI preference, not personal data). All wording lives in `web/src/i18n/strings.ts`. A test (`test/unit/i18n.test.ts`) checks that both languages have the same keys and placeholders and that neither uses promotional or safety claims. Action labels such as "Supply USDG" are rebuilt on the client from structured card fields, so they translate. Protocol-supplied titles and redemption terms are data and stay in English, labelled as such. Numbers, percentages and dates follow the chosen language's format.

The product name is "Hoodmap" (chosen 2026-09-29; formerly the placeholder "Waypoint"). Robinhood's terms forbid "Robinhood Chain" as a product name, and the footer states the app is not affiliated with or endorsed by Robinhood.

## Performance (public RPC, 2026-09-24)
| Request | Time |
|---|---|
| asset view on a warm snapshot | ≈ 0.4 s |
| NVDA → USDG quote for an explicit amount (14 routes, 3 in flight: `QUOTE_CONCURRENCY`) | ≈ 2.2 s (was ≈ 5.4 s sequential) |

Server start warms the snapshot (≈ 8 s). After that, stale-while-revalidate keeps requests off the cold path.

## Third-party 24h volume
Swap-log indexing is too heavy for the public RPC (P4-5). Route markets therefore carry an optional `volume24h` from GeckoTerminal's keyless API (`src/sources/geckoterminal.ts`), labelled as third party.

Rules:
- Only the pools of the routes actually shown are asked for.
- At most 30 pools go in one request, with a 2.5 s gap between requests.
- After a 429, requests stop for 60 s.
- Results are cached for 5 min.
- A page waits at most 2 s for the source. If it is slow, the page shows no volume.
- Volume is never used for ordering or usability.
- When every hop of a route has a figure, the VOLUME_UNKNOWN note is dropped.

Live check (2026-09-24): GeckoTerminal's TVL for NVDA/USDG 0.05 % was $5.666M. Our onchain TVL for the same pool was $5.647M.

## Alerts
Alerts live in the browser only (localStorage, at most 20):
- conditions: price above/below, or a card's headline rate above/below
- checked every 2 min while the app is open, against our own API
- when one fires: an in-app banner and, if the user allowed it, a browser notification
- no account, no server-side storage
