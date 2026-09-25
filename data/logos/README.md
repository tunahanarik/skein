# Bundled token logos

Served by `/api/logo/:address` before any remote source (`src/server/logos.ts`). One file per
canonical asset, named `<lowercase address>.png`. Each was checked by eye against the asset.

| Asset | Address | Source (fetched 2026-09-25) |
| --- | --- | --- |
| WETH | 0x0bd7d308f8e1639fab988df18a8011f41eacad73 | CoinGecko `coins/weth` image |
| USDG (Global Dollar) | 0x5fc5360d0400a0fd4f2af552add042d716f1d168 | CoinGecko `coins/global-dollar` image (lists this Robinhood Chain address) |
| QNT (Quantinuum) | see registry | Financial Modeling Prep `image-stock/QNT.png` (no ISIN logo on Parqet) |
| XNDU (Xanadu Quantum) | see registry | Financial Modeling Prep `image-stock/XNDU.png` (no ISIN logo on Parqet) |

Every other Stock Token uses the Parqet logo for its registry ISIN.
