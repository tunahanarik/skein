# Skein yol haritası

**Hedef:** Robinhood Chain için Arkham Intelligence benzeri bir zincir üstü istihbarat (onchain intelligence) platformu. Kim ne tutuyor, ne yapıyor, nereye para taşıyor; her rakam ve etiket kanıtıyla birlikte. İleride başka ağlar da eklenecek.

İlgili belgeler:
- Arkham'ın ayrıntılı analizi: [arkham.md](arkham.md)
- Kod yapısı: [../structure.md](../structure.md)
- Üretim mimarisi (servisler, veritabanları, indexer, maliyet): [architecture.md](architecture.md)
- Güvenlik incelemesi: [security-review.md](security-review.md)
- Tasarım revizyonu ve görsel listesi: [design-revision.md](design-revision.md)

## Konumlandırma

Arkham Robinhood Chain'i Temmuz 2026'dan beri destekliyor, ama genel amaçlı: transfer, bakiye, etiket ve memecoin trader'ları. Skein **bu zincire özgü derinlikle** ayrışır:

| Arkham'ın yaptığı (genel) | Skein'in ekleyeceği (Robinhood Chain'e özgü) |
|---|---|
| Token bakiyesi | Stock Token bakiyesi **hisse karşılığıyla**; temettü ve bölünmenin (uiMultiplier) etkisi |
| Token sahipleri | Hisse tokenı sahipleri, balina hareketleri, ihraççı kontrolleri (pause, blocklist, USDG freeze) |
| "Borrows & loans" | Morpho, Pendle, Uniswap LP, Beefy ve Steer pozisyonları; sağlık faktörü ve likidasyon fiyatıyla |
| İzleme | İzleme + **"bu cüzdan bununla ne yapabilir"** (mevcut fırsat motoru) |
| Etiketler (doğruluk oranı yayınlanmıyor) | Her etiketin ve rakamın **kaynağı, tazeliği ve doğrulama durumu** |

## İlkeler (değişmeyecekler)

1. **Kanıt önce.** Hiçbir rakam ya da etiket kaynağı olmadan gösterilmez. Etiketler kanıt türüyle saklanır: zincir üstü kanıt, resmî belge ya da kendi beyanı.
2. **Kişilerin anonimliği kaldırılmaz.** Yalnızca kurumlar, kontratlar ve kendini açıklamış varlıklar etiketlenir. Bireyleri ifşa etmek (doxxing) kapsam dışıdır (karar: açık soru 1).
3. **Uçtan uca salt-okunur.** Sunucu anahtar tutmaz; uygulama hiçbir işlem oluşturmaz, imzalatmaz ya da göndermez. Swap ve köprü bilinçli olarak kaldırıldı (2026-10-02). Cüzdan bağlantısı yalnızca adresi okur.
4. **Zincirden bağımsız çekirdek.** Zincire özgü her şey zincir paketinde durur (`@skein/robinhood`).
5. **Danışmanlık yok.** Risk puanı ya da "en iyi" sıralaması verilmez; yalnızca olgular ve kullanıcının seçtiği sıralama.

## Fazlar

### Faz 0: Yapı (tamamlandı, bu dal)
- pnpm workspace monoreposu: 12 kütüphane paketi + 3 uygulama. Bağımlılık kuralları `pnpm check:deps` ile denetleniyor.
- Sunucunun web kodunu import ettiği yerler ve paket döngüleri giderildi.
- Kalan işler:
  - README'nin ve eski belgelerin dilinin yeni hedefe göre güncellenmesi
  - CI (GitHub Actions: `pnpm check`)

### Faz 1: Veri altyapısı (temel)
Arkham'ın neredeyse tüm özellikleri geçmiş veri ister. Bugün Skein her şeyi RPC'den anlık okuyor.

| İş | Paket | Not |
|---|---|---|
| Indexer: ERC-20 Transfer, native ETH, Stock Token `TransferWithScaledUI` ve `UIMultiplierUpdated` | `packages/indexer`, `apps/indexer` | Kaynak kararı gerekiyor (açık soru 2) |
| Protokol olayları: Uniswap v3/v4 Swap, Morpho Supply/Borrow, Pendle | `packages/indexer` | Mevcut adaptörlerin ABI'leri yeniden kullanılır |
| Veritabanı: transferler, bakiye geçmişi, fiyat geçmişi | `packages/db` | Veritabanı kararı gerekiyor (açık soru 3) |
| Geçmiş fiyatlar | `packages/pricing` | Chainlink round geçmişi zaten okunuyor; saklanmalı |
| Etiket ve varlık modeli + ilk etiket seti | `packages/entities` | Protokol kontratları, köprüler, Robinhood altyapısı (fabrika, beacon, registry), CEX adresleri, LI.FI diamond'ları |

### Faz 2: Gezgin ve profil (Arkham'ın çekirdeği)
| İş | Arkham karşılığı |
|---|---|
| Arama: adres, varlık, token, işlem hash'i | Search |
| **Adres profili**: portföy (hisse karşılığıyla), bakiye geçmişi, P&L, transferler, karşı taraflar, DeFi pozisyonları, "ne yapabilir" | Profiler |
| **Token sayfası**: sahipler, akışlar, büyük transferler, kurumsal işlemler (multiplier geçmişi), piyasalar ve fırsatlar | Token pages |
| **Varlık sayfası**: bir kurumun tüm adresleri ve toplam faaliyeti | Entity pages |
| Transfer gezgini: büyüklük, token, varlık ve zamana göre filtre | Transactions explorer |
| İşlem açıklayıcı: bir işlemin ne yaptığını protokol bilgisiyle anlatır (swap, deposit, borrow…) | TXID Checker |

### Faz 3: İzleme
| İş | Arkham karşılığı | Not |
|---|---|---|
| Kullanıcı hesabı (cüzdanla giriş, SIWE) | Account | Uyarı ve panolar için gerekli |
| Uyarılar: büyük transfer, adres/varlık hareketi, sağlık faktörü düşüşü, kurumsal işlem | Alerts | Kanallar: Telegram, e-posta, webhook |
| İzleme listeleri ve özel etiketler | Watchlists, private labels | Bugün tarayıcıda saklanıyor; hesaba taşınır |
| Panolar | Dashboards | Widget'lar: portföy, token akışı, pozisyonlar |

### Faz 4: Analiz
| İş | Arkham karşılığı |
|---|---|
| Visualizer: adres ve varlık ağ grafiği | Visualizer |
| Tracer: paranın adım adım akışı (köprüler dahil) | Tracer |
| Liderlik tabloları: Stock Token ve memecoin trader'ları (P&L, ROI) | Leaderboards |
| "Smart money": kârlı cüzdanların ortak hareketleri | Ultra / signals |
| Kümeleme sezgileri (heuristics), yalnızca kurumlar için | Clusters |

### Faz 5: API ve gelir
| İş | Not |
|---|---|
| Herkese açık API (API anahtarı, kredi bazlı) + `packages/sdk` | Arkham'ın API'si kurumsal ve pahalı; burada sade ve şeffaf fiyatlandırma bir fark olabilir |
| MCP sunucusu (AI agent'lar için) | Motor zaten salt-okunur bir API |
| PRO abonelik | Menüde bugün "PRO (soon)" duruyor |

### Faz 6: Çoklu zincir
- İkinci zincir için `packages/networks/src/<ağ>.ts` ve bir zincir paketi eklenir.
- Öncesinde [../structure.md](../structure.md) içindeki "çoklu zincir için açık noktalar" parametreye çevrilir.

### Mevcut özelliklerin yeri
Fırsat keşfi, Markets, trade rotaları (yalnızca bilgi ve gösterge fiyat) ve canlı fiyatlar korunuyor. Swap ve köprü 2026-10-02'de kaldırıldı: Skein bir istihbarat ürünü, işlem aracı değil.

### Sürekli işler
- Ücretli (keyed) RPC: indexer için şart.
- Deploy ve izleme (monitoring).
- Ana JS paketinin bölünmesi (540 KB).
- Hukuki metinler ve bölge kısıtları: Stock Tokens ABD'li kişilere sunulmuyor.

## Senin karar vermen gereken açık sorular
1. **Etiketleme politikası**: Yalnızca kurumlar ve kontratlar mı (önerim), yoksa Arkham gibi bireyler de mi?
2. **Indexer kaynağı**:
   - kendi indexer'ımız + ücretli RPC
   - hazır servisler: Goldsky, Envio/HyperSync, Alchemy
   - Blockscout API: ücretsiz, hızlı başlangıç
3. **Veritabanı**: PostgreSQL (basit, tek sistem) ya da analitik sorgular için ClickHouse? Önerim: PostgreSQL ile başlamak.
4. **RPC sağlayıcısı**: Alchemy ya da QuickNode?
5. **Hesap sistemi**: Yalnızca cüzdanla giriş (SIWE) mi, e-posta da olacak mı?
6. **Gelir modeli**: PRO abonelik, API kredisi ya da ikisi; hangi sırayla?
7. **Barındırma**: Cloudflare, Fly, Railway ya da kendi sunucumuz?
8. **Ürün adı**: "Skein" kesinleşti mi?
