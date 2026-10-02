# Üretim mimarisi önerisi

Tarih: 2026-10-02.

Dayanak:
- Mimari araştırması: kaynaklar ve doğrulanmamış maddeler aşağıda.
- Herkese açık RPC'den yapılan salt-okunur hacim ölçümleri.

Mevcut kod yapısı için: [../structure.md](../structure.md). Yol haritası için: [roadmap.md](roadmap.md).

## En önemli bulgu: zincir beklenenden çok büyük

| Ölçü | Değer |
|---|---|
| Blok süresi | ~0,1 s, yani günde ~864 bin blok |
| Log / gün | ~15–35 milyon (son 24 saatte ölçülen ~31 milyon) |
| Transfer log / gün | ~8–16 milyon |
| Swap / gün | ~1,6 milyon Uniswap v3 + ~2 milyon v4 |
| `TransferWithScaledUI` / gün | ~1,3 milyon |
| İşlem / gün | ~7 milyon |
| 1 Temmuz'dan bu yana toplam transfer | ~1,1–1,5 milyar; yılda ~4–6 milyar artıyor |

Bu rakamlar örneklemeye dayanıyor ve trafik çok dalgalı; gerçek değer ±2 kat oynayabilir.

**Sonuç:** Tüm zincirin transferlerini indekslemek ilk günden milyarlarca satırlık bir iş. Bu yüzden:
- Olaylar yalnızca PostgreSQL'de tutulamaz.
- Olay başına ücret alan hazır servisler (Goldsky Turbo, hosted subgraph'ler) bu hacimde çok pahalı: ayda 3,6 bin ile 50 bin dolar arası.
- Zincirin ucunu blok blok RPC ile takip etmek pahalı: ayda ~170–350 dolar ve geçmişi doldurmak (backfill) ~470–820 dolar.

## Öneri

```
           tarayıcılar · API istemcileri · (dışa) Telegram / e-posta / webhook
                                     │ HTTPS
   ┌─────────────────────────────────▼──────────────────────────────────┐
   │ Cloudflare: DNS + proxy, WAF, DDoS, herkese açık GET'ler için      │
   │ edge cache, 1–2 IP rate-limit kuralı; statik web uygulaması        │
   └─────────────────────────────────┬──────────────────────────────────┘
                                     │ cloudflared tüneli (açık giriş portu yok)
   ┌─────────────────────────────────▼───────── Hetzner dedicated (Docker Compose) ─┐
   │                                                                                 │
   │  ┌─────────────┐  SELECT (salt-okunur, kotalı)  ┌──────────────────────────┐    │
   │  │ api (1..n)  │───────────────────────────────►│ ClickHouse               │    │
   │  │ JSON + SSE  │                                │ bloklar, transferler,    │    │
   │  │ SIWE, keys  │                                │ bakiyeler, swap'lar,     │    │
   │  └──┬────┬─────┘                                │ protokol olayları, fiyat │    │
   │     │    │ cache / pub-sub / kota sayaçları     └────────────▲─────────────┘    │
   │     │    ▼                                                   │ INSERT           │
   │     │  ┌────────┐ ◄── olay akışı (XADD), fiyat yayını ──┐    │                  │
   │     │  │ Valkey │                                       │    │                  │
   │     │  └───┬────┘                               ┌───────┴────┴────────────┐     │
   │     │      │                                    │ indexer (zincir başına 1)│     │
   │     ▼      ▼                                    │ HyperSync → RPC yedeği   │     │
   │  ┌──────────────┐   pg-boss işleri              │ reorg kontrolü, imleç    │     │
   │  │ PostgreSQL   │◄──────────┐                   └──────────────────────────┘     │
   │  │ kullanıcı,   │      ┌────┴───────────┐                                        │
   │  │ etiket, key, │      │ worker         │──► Telegram / e-posta / webhook        │
   │  │ uyarı, imleç │      │ uyarı, snapshot│    (imzalı, tekrarlı, SSRF korumalı)   │
   │  └──────────────┘      │ mutabakat      │                                        │
   │                        └────────────────┘                                        │
   │   otel-collector ──► Grafana Cloud     gece yedekleri ──► S3 uyumlu depolama      │
   └──────────────────────────────────────────────────────────────────────────────────┘
```

### Servisler (tek Docker imajı, farklı giriş noktaları)

| Servis | Ne yapar | Bugünkü karşılığı |
|---|---|---|
| **web** | Statik React uygulaması: Cloudflare Pages ya da origin + edge cache | `apps/web` |
| **api** (1..n) | JSON API + SSE, SIWE oturumları, API anahtarları ve kredi ölçümü. Durumsuz; ClickHouse'u salt-okunur kullanıcıyla okur | `apps/server` → `apps/api` |
| **indexer** (zincir başına tam 1 tane) | HyperSync'ten blok ve log çeker, RPC'yi yedek ve doğrulama için kullanır, ClickHouse'a toplu yazar, reorg'ları geri alır. İmleci PostgreSQL'de tutar; tek yazıcıyı PostgreSQL advisory lock garanti eder | yeni: `packages/indexer` + `apps/indexer` |
| **worker** | pg-boss işleri: uyarı eşleştirme ve gönderim, fiyat snapshot'ları, mutabakat, etiket içe aktarma. Bugün `main.ts` içinde `setInterval` ile dönen her şey buraya taşınır | yeni: `apps/worker` |
| **postgres** | İşlemsel veri: varlıklar ve etiketler (kanıtlarıyla), kullanıcılar, oturumlar, API anahtarları ve kredileri, izleme listeleri, uyarılar, panolar, indexer imleçleri, iş kuyruğu | yeni |
| **clickhouse** | Olay verisi: bloklar, transferler (adres sıralı kopyasıyla), bakiyeler, Stock Token çarpanları, swap'lar, protokol olayları, dakikalık fiyatlar | yeni |
| **valkey** | Önbellek, SSE için pub/sub, olay akışı (Redis Streams), API kota sayaçları. Redis'in BSD lisanslı çatalı | yeni |
| **otel-collector** | Metrik, log ve trace → Grafana Cloud | yeni |

### Neden bu seçimler

- **İndeksleme: HyperSync + kendi ince indexer'ımız.**
  - Envio HyperSync Robinhood Chain'i (4663) destekliyor; canlı uç noktasını doğruladık.
  - Blok ve log verisini birlikte, toplu olarak döndürüyor ve TypeScript istemcisi var.
  - Ücretsiz plan var; Starter 70 $/ay, Pro 480 $/ay.
  - Bağımlılık riskini bir `LogSource` arayüzüyle sınırlıyoruz. Yedek olarak, bugün `@skein/chain` içinde zaten bulunan `getLogs` bölme mantığıyla ücretli RPC kullanılır.
  - Hazır framework'ler (Ponder, Envio HyperIndex) PostgreSQL odaklı olduğu için bu hacme uymuyor. Plan B: rindexer (Rust, ClickHouse'a yazabiliyor).
- **İki veritabanı.**
  - ClickHouse milyarlarca satırı ~6 kat sıkıştırıyor ve sahip/akış/karşı taraf sorgularında hızlı. Nansen de BigQuery'den ClickHouse'a geçti.
  - PostgreSQL düzenlenebilir ve kritik veri için. ClickHouse etiketleri bir PostgreSQL dictionary üzerinden okur.
  - TimescaleDB önerilmiyor: her transferin iki adresi (gönderen ve alan) olduğu için adres bazlı sorgular zaten tabloların çoğaltılmasını gerektiriyor.
- **Kuyruk: pg-boss.**
  - PostgreSQL içinde çalıştığı için ayrı bir kalıcılık katmanı gerekmez.
  - Cron, tekrar deneme ve dead-letter desteği var.
  - Valkey yalnızca hızlı dağıtım ve sayaçlar için kullanılır.
- **Barındırma: Hetzner dedicated + Docker Compose + Cloudflare.**
  - Railway, Fly ve Render durumsuz uygulamalar için iyi, ama veri katmanı için pahalı ve sınırlı (1 TB disk sınırı, RAM ücreti).
  - İsteğe bağlı olarak arayüz için Coolify kullanılabilir.
- **Native ETH.**
  - Üst seviye `value` transferleri işlem gövdesinden alınır.
  - İç (internal) transferler ve gas sonra eklenir: Substreams `balance_changes` (4663 için EXTENDED) ya da QuickNode/Chainstack trace.

### Zincire özgü notlar
- Robinhood Chain bir Arbitrum Orbit rollup'ı. Reorg'lar nadir ve sığ; yine de parent hash zinciri kontrol edilir ve uyuşmazlıkta geri alınır.
- Herkese açık RPC log'larda `blockTimestamp` alanını `0x0` döndürüyor; zaman bilgisi için blok başlıkları gerekiyor (HyperSync bunları birlikte veriyor).
- Herkese açık RPC'de `debug_*` metotları ve arşiv erişimi yok. `getLogs` 10 bin sonuçla sınırlı.
- `Transfer` olayında 3 topic varsa ERC-20, 4 topic varsa ERC-721; topic sayısına göre ayrılır. Stock Tokens ek olarak `TransferWithScaledUI` yayıyor.
- Arayüz ve uyarılar, L1'e yazılmamış (sequencer onaylı) veriyi "onaylanmadı" diye işaretler.

## Maliyet (MVP)

| Kalem | Aylık |
|---|---|
| Hetzner AX102-1 (16 çekirdek, 128 GB) | 257 € |
| Ayrı uygulama sunucusu (isteğe bağlı, CPX32) | 35 € |
| Nesne depolama (yedekler) | 6,5 € |
| HyperSync Starter (backfill ayında Pro 480 $) | 70 $ |
| Ücretli RPC (QuickNode Build ya da Alchemy kullandıkça öde) | ~49–100 $ |
| Cloudflare (Free → Pro) | 0–20 $ |
| Grafana Cloud | ücretsiz plan |
| **Toplam** | **~450–650 €/ay; yoğun bir ayda ~1.000 €** |

**Yalın başlangıç: ~250 €/ay.** AX42-1, HyperSync Starter ve önce yalnızca kanonik varlıkları indekslemek.

## Güvenlik ve operasyon
- **Kenar (edge):**
  - Cloudflare tüneli kullanılır; sunucuda açık giriş portu olmaz.
  - SSH yalnızca Tailscale ya da yönetici IP'lerinden.
  - İstemci IP'si `CF-Connecting-IP` başlığından okunur. Bu, güvenlik raporundaki SRV-4'ü de çözer.
- **Gizli bilgiler:**
  - SOPS + age ile şifreli env dosyaları.
  - Ortam başına ayrı anahtar.
  - API anahtarları hash'lenerek saklanır.
  - RPC URL'leri asla loglanmaz.
- **En az yetki:**
  - PostgreSQL rolleri: `migrator`, `indexer_rw`, `api_rw`, `worker_rw`.
  - ClickHouse kullanıcıları: `indexer_ins` (yalnızca insert) ve `api_ro` (sorgu süresi, bellek ve satır kotalarıyla).
  - Veritabanları yalnızca iç Docker ağında dinler.
- **Webhook'lar:** Kullanıcının verdiği URL'lerde SSRF koruması (özel IP'ler engellenir, DNS gönderim anında yeniden çözülür), HMAC imzası ve tekrar deneme.
- **SIWE:** EIP-4361 viem `verifySiweMessage` ile doğrulanır. Nonce tek kullanımlık olur ve Valkey'de tutulur; oturum httpOnly cookie ile taşınır.
- **Yedekler:**
  - PostgreSQL yeri doldurulamaz veri tutuyor. pgBackRest ya da WAL-G ile sürekli yedeklenir ve geri yükleme ayda bir test edilir.
  - ClickHouse HyperSync'ten yeniden doldurulabilir; haftalık yedek yalnızca kurtarmayı hızlandırmak için.
- **İzleme:**
  - OpenTelemetry → Grafana.
  - Temel metrikler: indexer gecikmesi, reorg sayısı, mutabakat uyuşmazlıkları, uyarı gecikmesi, API p95, açık SSE bağlantıları.

## Mevcut paketler nereye gider

| Paket | Kullanan servis | Değişiklik |
|---|---|---|
| core, networks, chain | hepsi | `LogSource` arayüzü eklenir; zincir kimliği parametreye çevrilir |
| robinhood | indexer, api, worker | — |
| pricing, portfolio | api (canlı), worker (geçmiş ve mutabakat) | — |
| engine, protocols | api, worker; indexer yalnızca olay ABI'lerini alır | Olay ABI'leri `protocols/*/events.ts` dosyalarına taşınır |
| product | api | Yeni `@skein/db`'den okur |
| runtime | her uygulamanın kökü | `createApiRuntime`, `createIndexerRuntime`, `createWorkerRuntime` |
| yeni | — | `@skein/db` (PostgreSQL migration'ları + ClickHouse DDL), `@skein/indexer`, `@skein/entities`, `@skein/alerts`, `@skein/auth` (SIWE + anahtarlar), `@skein/sdk` |

## Geçiş planı

| Adım | Süre | İş |
|---|---|---|
| 0 | hafta 0–1 | Kararlar; açık güvenlik bulgularının düzeltilmesi; ücretli RPC ve HyperSync token'ı; mevcut sunucunun önüne Cloudflare |
| 1 | hafta 1–3 | `@skein/db`; `apps/api` ve `apps/worker` ayrılır; `.cache` JSON durumları veritabanına taşınır; paylaşılan snapshot ve SSE dağıtımı için Valkey; Docker Compose, yedekler, OpenTelemetry |
| 2 | hafta 3–6 | **Indexer v1, dar kapsam:** bloklar; kanonik varlıkların Transfer, `TransferWithScaledUI` ve `UIMultiplierUpdated` olayları; WETH; USDG; v4 `Initialize`. Genesis'ten backfill, canlı takip, reorg, mutabakat. **Çıktı:** hisse karşılığıyla Stock Token sahipleri, transfer gezgini, bakiye geçmişi |
| 3 | hafta 6–10 | Tüm ERC-20 transferleri (spam bayrağıyla); swap'lar; Morpho ve Pendle olayları; dakikalık fiyatlar; ETH `value` transferleri; karşı taraflar, akışlar ve P&L |
| 4 | — | Varlıklar ve etiketler: PostgreSQL + ClickHouse dictionary; ilk set protokol kontratları, köprüler, Blockscout'ta doğrulanmış kontrat adları ve kendini açıklamış CEX'ler |
| 5 | — | Hesaplar (SIWE), sunucu tarafı izleme listeleri, uyarılar (önce Telegram), panolar |
| 6 | — | Herkese açık API: anahtar, kredi, kota, OpenAPI, `@skein/sdk` |
| 7 | — | Native ETH iç transferleri ve gas; ikinci zincir |

## Senin karar vermen gerekenler
1. **İndeksleme kapsamı:** Önce yalnızca kanonik varlıklar mı (önerim), yoksa memecoin ve spam dahil tüm token'lar mı? Donanım seviyesini bu belirliyor.
2. **Native ETH derinliği:** Yalnızca üst seviye mi, yoksa iç transferler ve gas da mı? İkincisi ek maliyet getirir.
3. **Ham log saklama:** Tüm ham log'lar mı tutulsun (~2–3 milyar), yoksa yalnızca çözümlenmiş tablolar mı (gerektiğinde HyperSync'ten yeniden çekilir)?
4. **Onaylanmamış veri:** Arayüz ve uyarılar sequencer verisini anında mı göstersin, yoksa L1'e yazılmasını mı (birkaç dakika) beklesin?
5. **ClickHouse:** Kendi sunucumuzda mı, ClickHouse Cloud'da mı?
6. **Giriş yöntemi:** Yalnızca cüzdanla (SIWE) mı, e-posta da olacak mı?
7. **Hukuk:** Analitik site için bölge kısıtı ya da yasal uyarı gerekli mi? Etiketleme politikası "yalnızca kurumlar ve kontratlar" olarak onaylanıyor mu?
8. **Aylık bütçe tavanı.**

## Doğrulanmamış maddeler
- QuickNode'un metot başına kredi değerleri ve Streams çarpanı (4663 için).
- Alchemy'nin `debug_traceBlock*`, Webhooks ve Transfers API "internal" kategorisi (4663 için).
- dRPC'nin trace ve arşiv desteği.
- Substreams sağlayıcı fiyatları.
- HyperSync'in 4663 için trace verisi döndürüp döndürmediği.
- Ücretli sağlayıcıların log'larda `blockTimestamp` alanını doldurup doldurmadığı.
- Satır başına bayt tahminleri: ilk backfill ayından sonra ölçülecek.
- Hacim örneklemeleri: ±2 kat.

## Başlıca kaynaklar
- https://docs.envio.dev/docs/HyperSync/hypersync-supported-networks · https://envio.dev/pricing/hypersync
- https://l2beat.com/scaling/projects/robinhood · https://docs.robinhood.com/chain/connecting · https://docs.robinhood.com/chain/transaction-finality
- https://www.alchemy.com/docs/robinhood-chain/robinhood-chain-api-overview · https://www.quicknode.com/chains/robinhood · https://docs.chainstack.com/reference/robinhood-getting-started · https://blog.drpc.org/announcing-flat-pricing-simple-transparent-fair/
- https://docs.goldsky.com/chains/robinhood-chain · https://goldsky.com/pricing · https://ponder.sh/docs/config/contracts · https://github.com/joshstevens19/rindexer · https://substreams.dev/chain/robinhood-chain · https://docs.blockscout.com/robinhood-api
- https://clickhouse.com/blog/announcing-cryptohouse-free-blockchain-analytics · https://clickhouse.com/blog/unlocking-the-power-of-onchain-analytics-how-nansen-transformed-their-data-infrastructure-with-clickhouse-cloud
- https://github.com/timgit/pg-boss · https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ · https://developers.cloudflare.com/waf/rate-limiting-rules/ · https://clickhouse.com/docs/operations/quotas
