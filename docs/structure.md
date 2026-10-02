# Kod yapısı

Skein bir **pnpm workspace monoreposu**. Kod iki gruba ayrılıyor:
- **Kütüphaneler** (`packages/*`): Her biri tek bir işi yapar ve kendi `package.json`'ında bağımlılıklarını açıkça bildirir. Başka bir projeye taşınabilir ya da ayrı bir repoya çıkarılabilir.
- **Uygulamalar** (`apps/*`): Kütüphaneleri bir araya getirip çalıştırır. Kütüphaneler hiçbir zaman bir uygulamayı import etmez.

```
apps/
  server/      @skein/server    HTTP API (node:http) + derlenmiş web uygulamasını sunar; SSE canlı fiyatlar
  web/         @skein/web       React + Vite arayüzü
  cli/         @skein/cli       komut satırı araçları ve canlı salt-okunur doğrulama scriptleri (validate-*)
packages/
  core/        @skein/core      zincirden bağımsız temel: model, kesin (exact) matematik, kaynak/tazelik, uygunluk politikası, standart ABI'ler
  networks/    @skein/networks  ağ tanımları (chain id, viem chain, public RPC); ağ başına bir dosya
  chain/       @skein/chain     salt-okunur RPC: ChainReader, yeniden deneme, multicall, log tarama, RPC sağlığı
  robinhood/   @skein/robinhood Robinhood Chain'e özgü her şey: kanonik varlık kaydı, Stock Token kaynakları,
                                protokol adresleri, routing hub'ları; data/registry altında commit'li snapshot
  pricing/     @skein/pricing   Price Service: önce Chainlink, yedek olarak Robinhood fiyatı; tazelik ve çelişki kontrolü
  portfolio/   @skein/portfolio Portfolio Engine: tek blokta bakiyeler, hisse karşılığı, değerleme
  engine/      @skein/engine    Opportunity Engine + trade routing: adapter arayüzü, uygunluk, yaşam döngüsü, trade grafiği
  protocols/   @skein/protocols protokol adaptörleri; protokol başına bir klasör (morpho, pendle, uniswap, ramses, spark, beefy, steer, shared)
  product/     @skein/product   ürün okuma katmanı: AssetIntelligence, kullanılabilirlik, sıralama, grafikler, agregatör; wire ve canlı yayın tipleri
  runtime/     @skein/runtime   bileşim kökü (composition root): env'den reader, registry, fiyat, engine ve product servisini kurar
  testkit/     @skein/testkit   deterministik çevrimdışı fixture'lar (sahte zincir, sahte protokol API'leri)
test/integration/               paketler arası entegrasyon testleri
tools/check-deps.mjs            bağımlılık kurallarını denetler (pnpm check:deps)
docs/  research/  brand/        belgeler, ham araştırma kanıtları, marka dosyaları
```

## Katmanlar (bağımlılık yönü)

Bağımlılıklar yalnızca aşağıdan yukarı akar. Bir paket yalnızca altındaki katmanları import edebilir.

```
apps:        server   web   cli
               │       │     │
composition: runtime ──┘     │            (web: yalnızca product tipleri)
               │
product:     product
               │
domain:      protocols → engine → portfolio → pricing
               │
chain data:  robinhood (registry, sources, config)
               │
access:      chain → networks
               │
foundation:  core                          (hiçbir @skein paketine bağlı değil)
```

Kurallar (`pnpm check:deps` bunları denetler, CI'da da çalışmalı):
1. `src/` içindeki her import (`@skein/*` ya da üçüncü taraf) o paketin `package.json`'ında bildirilmiş olmalı.
2. Paketler arasında döngü olamaz.
3. `packages/*` hiçbir zaman `apps/*`'i import etmez.
4. `@skein/core` ve `@skein/networks` başka hiçbir `@skein` paketine bağlanmaz. `@skein/chain` yalnızca `networks` ve `core`'a bağlanabilir.
5. Skein uçtan uca salt-okunurdur: hiçbir paket işlem oluşturmaz, imzalamaz ya da göndermez. Swap ve köprü bilinçli olarak kaldırıldı (2026-10-02).

Testler bu kurallara tabi değil. Testler kök `package.json`'ın bildirdiği her şeyi (tüm `@skein/*` paketleri ve `@skein/testkit`) kullanabilir.

## Import kuralları

- **Paket içinde**: göreli yol ve `.js` uzantısı (NodeNext). Örnek: `import { foo } from "./bar.js"`.
- **Paketler arasında**: paket adı + `src` altındaki yol, uzantısız. Örnek: `import { TtlCache } from "@skein/core/lib/cache"`.
  - Her paketin `package.json`'ında `"exports": { "./*": "./src/*.ts" }` var. Derleme adımı gerekmez: tsx, Vite ve Vitest kaynak dosyayı doğrudan okur.
- Başka bir paketin içine göreli yolla (`../../packages/...`) girilmez.

## Yeni bir şey nereye eklenir

| Ne | Nereye | Ayrıca |
|---|---|---|
| Yeni protokol adaptörü | `packages/protocols/src/<ad>/` (`adapter.ts`, gerekiyorsa `constants.ts`, `normalize.ts`) | `packages/runtime/src/runtime.ts` içinde engine'e eklenir; testi `packages/protocols/test/<ad>.test.ts`; canlı kontrolü `apps/cli/src/validate-<ad>.ts` |
| Yeni API endpoint'i | `apps/server/src/api.ts` | Veri `@skein/product`'tan gelir; wire tipleri `packages/product/src/wire.ts` |
| Yeni sayfa | `apps/web/src/pages/` | Metinler `apps/web/src/i18n/strings.ts` içinde (site yalnızca İngilizce) |
| Stil | `apps/web/src/styles/`: `tokens` → `base` → `controls` → `content` → `overlays` → `shell` → `pages` (sıra `index.css`te) | Renkler, köşeler, gölgeler ve hareket yalnızca `tokens.css`te tanımlanır; bileşenler token kullanır. Açık tema `:root[data-theme="light"]` altında aynı tokenları ezer. `!important` yalnızca azaltılmış hareket kuralında |
| Yeni ağ | `packages/networks/src/<ağ>.ts` + yeni bir zincir paketi `packages/<ağ>/` (`robinhood` paketinin karşılığı) | Aşağıdaki "çoklu zincir için açık noktalar" |
| Yeni CLI aracı | `apps/cli/src/<araç>.ts` | Kök `package.json`'a script olarak eklenir |
| Yeni paket | `packages/<ad>/` içinde `package.json` (`name`, `type: module`, `exports`, `dependencies`) + `tsconfig.json` (`extends ../../tsconfig.base.json`) + `src/` + `test/` | Kök `package.json` `devDependencies`'e `"@skein/<ad>": "workspace:*"`; `pnpm install`; `tools/check-deps.mjs` içindeki kurallar güncellenir |

## Yol haritasıyla gelecek paketler

Arkham benzeri istihbarat özellikleri ([plan/roadmap.md](plan/roadmap.md)) için öngörülen yerler:

| Paket | İş |
|---|---|
| `packages/indexer` | Zincir olaylarını (Transfer, Swap, protokol olayları) toplar ve normalize eder. Yalnızca `chain`, `core` ve zincir paketine bağlıdır |
| `packages/db` | Şema, migration'lar ve sorgular (bakiye geçmişi, transferler, sahipler, akışlar) |
| `packages/entities` | Etiketler, varlıklar (entity), kanıtları ve atıf kuralları |
| `packages/alerts` | Uyarı kuralları ve teslim kanalları (Telegram, e-posta, webhook) |
| `packages/sdk` | Herkese açık API için tipli istemci |
| `apps/indexer` | Indexer'ı sürekli çalıştıran işçi süreç (worker) |

## Çoklu zincir için açık noktalar

Bugün zincire özgü değerlerin büyük kısmı `@skein/robinhood` ve `@skein/networks` içinde. İkinci bir zincir eklenmeden önce parametreye çevrilmesi gerekenler:
- `packages/engine/src/opportunities/engine.ts`: `chainId: ROBINHOOD_CHAIN_ID` sabit yazılmış.
- `packages/product/src/service.ts`: `4663` sabitleri.
- `packages/chain/src/reader.ts` ve `packages/chain/src/rpcConfig.ts`: viem zinciri ve `ROBINHOOD_RPC_URL` env adları.
- `packages/pricing`: Robinhood fiyat kaynağına göre kurulmuş.
- `apps/web/src`: zincir sabitleri birkaç yerde tekrar ediliyor (`App.tsx`, `common.tsx`, `watchlist.ts`, `format.ts`).

## Veri ve önbellek yolları

| Yol | Sahibi | Not |
|---|---|---|
| `packages/robinhood/data/registry/` | `@skein/robinhood` | commit'li registry snapshot'ı; yol modüle göre çözülür |
| `apps/server/data/logos/` | `@skein/server` | paketle gelen logolar |
| `apps/web/dist/` | `@skein/web` | derleme çıktısı (gitignore'da) |
| `apps/web/snapshot/dist/` | `@skein/web` | sitenin statik, tek dosyalık kopyası (`site.html`). `pnpm serve` açıkken `pnpm web:snapshot` ile üretilir; veriler o anki sunucudan kaydedilir (gitignore'da) |
| `.cache/` | çalışma dizini (repo kökü) | pool listeleri, oran geçmişi, logolar; gitignore'da |
| `research/snapshots/` | `@skein/cli` | doğrulama raporları |

Komutlar her zaman **repo kökünden** çalıştırılır (`pnpm start`, `pnpm test`, `pnpm validate:*`). `.cache` ve `research/snapshots` köke göre çözülür.

## Kontroller

```bash
pnpm check        # check:deps + typecheck + test
pnpm check:deps   # bağımlılık kuralları
pnpm typecheck    # kök program (paketler, server, cli, testler) + web
pnpm test         # tüm çevrimdışı testler
```
