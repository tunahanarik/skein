# Arkham Intelligence araştırması

Araştırma tarihi: 2026-10-01.

Kaynaklar şunlar: Arkham'ın resmî dokümanları (codex.arkm.com, docs.intel.arkm.com), duyuruları (info.arkm.com/announcements), resmî kullanım rehberi ve bağımsız incelemeler. Uygulamanın kendisi (arkm.com/explorer) bot doğrulamasının arkasında olduğu için sayfalar doğrudan gezilemedi; bu yüzden içerik belgelere dayanıyor.

Çelişkili ya da doğrulanamayan bilgiler **(doğrulanmadı)** diye işaretli.

## Arkham nedir

Arkham Intelligence bir **zincir üstü istihbarat (onchain intelligence) platformu**. Temel fikri, blockchain'in anonimliğini kaldırmak (deanonymization): adresleri gerçek dünyadaki **varlıklara (entity)** bağlıyor (borsalar, fonlar, ekipler, balinalar, kişiler) ve bu varlıkların hareketlerini izlemek, analiz etmek ve uyarı almak için araçlar sunuyor.

| Ölçek | Değer |
|---|---|
| Etiket (label) | 300 milyondan fazla |
| İsimlendirilmiş varlık | 800 binden fazla. Eski kaynaklarda 150 bin varlık sayfası yazıyor |
| Etiketleme yöntemi | "Ultra" adlı yapay zekâ motoru + araştırma ekibi + topluluk (Intel Exchange) |
| Token | ARKM. Ödüller, ödüllü görevler (bounty) ve premium erişim için kullanılıyor |

**Robinhood Chain'i 22 Temmuz 2026'dan beri destekliyor.** Duyuruda öne çıkanlar:
- Bu zincirdeki "sofistike" yatırımcıları ve kârlı trader'ları izlemek.
- Büyük fon hareketleri için uyarı kurmak.
- Robinhood Chain memecoin'lerini takip etmek (ör. CASHCAT; 144 dolardan yaklaşık 4 milyon dolara çıkan bir trader örneği veriliyor).
- Arkham API'si Robinhood Chain'de diğer zincirlerdeki tüm endpoint'lerle birlikte çalışıyor.

**Bu bizim için en önemli rekabet bilgisi:** Arkham bu zincirde var, ama **genel amaçlı** bir şekilde. Duyuruda Stock Tokens, hisse semantiği ve DeFi pozisyonlarına dair hiçbir şey yok.

## Ürünler ve özellikler

### 1. Arama ve varlık sayfaları
- **Arama çubuğu**: varlık adı (ör. "Binance"), adres, token ya da işlem hash'i ile arama.
- **Varlık (entity) sayfası**: bir kuruma veya kişiye ait cüzdanların toplamı. Kısa biyografi (bio), sosyal bağlantılar ve tüm zincirlerdeki faaliyet burada görünüyor.
- **Adres sayfası**: tek bir cüzdanın profili.
- **Etiketler (label)**: tek adrese verilen isim, ör. "Binance Hot Wallet 14".
- **Davranış etiketleri (tag)**: "Polymarket Whale", "Hacker", "Scam", "FOMO User" gibi.
- **Özel varlıklar**: kullanıcı cüzdanları kendisi gruplayabiliyor. Bu gruplar özel (private) tutulabiliyor, herkese açık yapılabiliyor ya da başka kullanıcılarla paylaşılabiliyor.

### 2. Profiler (bir varlığın veya adresin tam profili)
- Portföy: hangi token'dan ne kadar var, zincir bazında dağılım.
- Bakiye geçmişi: grafik halinde, yakınlaştırılabiliyor.
- Kâr/zarar (P&L).
- Borsa kullanımı: hangi borsaya ne kadar yatırıp ne kadar çekmiş.
- En çok işlem yapılan karşı taraflar (top counterparties).
- İşlem geçmişi: fiyat, token, karşı taraf ve zamana göre filtrelenebiliyor; DEX takasları ayrıca görünüyor.
- DeFi borç ve kredileri (borrows & loans).
- **Archive**: bir kişinin ya da kurumun portföyünü geçmişteki herhangi bir anda görme.

### 3. Visualizer ve Tracer
- **Visualizer**: varlıklar arasındaki ilişkiyi ağ grafiği (network graph) olarak çiziyor. Düğümler varlıkları, kenarlar transferleri gösteriyor. Token, USD değeri ve zaman aralığına göre filtrelenebiliyor.
- **Tracer**: paranın adresten adrese, adım adım ve zincirler arası akışını takip ediyor. İşlem kayıtları açılıp genişletilebiliyor.

### 4. Token sayfaları
- Piyasa verisi, en büyük sahipler (top holders), borsa giriş-çıkışları (exchange flows), hacim ve filtrelenebilir transferler.

### 5. Transfer gezgini
- Tüm transferler büyüklük, varlık, zincir, token ve zamana göre filtrelenebiliyor.

### 6. Alerts (uyarılar)
- Kriterler: işlem büyüklüğü, varlık, zincir, token, USD eşiği.
- Kanallar: e-posta, Telegram, Slack, webhook.
- Uyarı kurmak için hesap gerekiyor.

### 7. Dashboards (panolar)
- Widget tabanlı, kişiselleştirilebilir panolar. Beş widget kategorisi var: adres/varlık istihbaratı, token istihbaratı, genel, spot/vadeli piyasa ve opsiyon.
- Bir grup varlığı tek ekranda izlemek için kullanılıyor.

### 8. Kişisel portföy
- Kullanıcı kendi adreslerini ya da Web3 cüzdanını bağlıyor; net varlık, varlık dağılımı ve bakiye geçmişi görünüyor.

### 9. Yapay zekâ araçları
- **Ultra**: zincir üstü ve zincir dışı verileri birleştiren, adresleri varlıklara bağlayan (attribution) yapay zekâ motoru.
- **TXID Checker**: işlem hash'i yapıştırılınca işlemi düz İngilizce özetliyor.
- **Arkham Oracle**: metin prompt'uyla analiz. Bir incelemeye göre bu özellik zayıf kalıyor.

### 10. Intel Exchange (istihbarat pazarı)
- **Bounty**: Bilgi arayan kişi ARKM yatırarak ödül koyuyor, ör. "bu adres kime ait". 2024'te DJT token'ının yaratıcısı için konan 150 bin dolarlık ödül bunun örneği.
- **Auction**: Bilgi sağlayan kişi elindeki istihbaratı açık artırmayla satıyor.
- Alıcıya 90 gün münhasırlık tanınıyor, sonra bilgi herkese açılıyor. Gönderileri Arkham Foundation doğruluyor.

### 11. API
- Kimlik doğrulama `API-Key` başlığıyla yapılıyor. Faturalama kredi bazlı; liste fiyatı yayınlanmıyor, kurumsal teklif alınıyor.
- Endpoint grupları:
  - adres ve varlık istihbaratı (`/intelligence/address/{address}`), kümeler (clusters), varlık tahminleri, etiketler, ağlar (networks)
  - token: sahipler, akışlar, hacim, trend olanlar, bakiyeler
  - transferler ve akışlar: gerçek zamanlı transferler, karşı taraflar, kümülatif USD akışı
  - portföy ve bakiye geçmişi: anlık görüntüler ve zaman serisi
  - **Risk Scores** (Haziran 2026): makine öğrenmesiyle adres ve varlık risk puanı (uyum/compliance kullanımı)
  - **Real-Time Intel** (Eylül 2026)

### 12. Son dönemde eklenenler (2025–2026)
- Tahmin piyasası analitiği: trader sıralamaları (PNL/ROI), ELO sistemi, canlı işlem akışı.
- Liderlik tabloları (leaderboards).
- Pump & FOMO verisi: pump-and-dump tespiti.
- ETF ve hazine takibi: BlackRock ETF'leri, MicroStrategy.
- Zincir eklemeleri: Hyperliquid, Zcash, Sonic, **Robinhood Chain**.
- Swap özelliği (Aralık 2025), mobil uygulama, MoonPay ile fiat onramp, x402 verisi.
- **Arkham Exchange**: spot ve USDT bazlı perp borsası. Mart 2025'te ABD'de açıldı. Bir kaynak Aralık 2025'te kapandığını söylüyor, başka kaynaklar 2026'da da açık diyor **(doğrulanmadı)**.

## Fiyatlandırma
- Temel platform **ücretsiz**: varlık sayfaları, arama, Visualizer, temel uyarılar.
- Premium özellikler ARKM token'ına ve Intel Exchange katılımına bağlı.
- API kurumsal ve kredi bazlı; fiyatı yayınlanmıyor. Üçüncü taraf tahminlerine göre ayda 150 ile 3000 dolar arası **(doğrulanmadı)**.

## Arkham ne yapmıyor / zayıf yanları
- **Zincire özgü derinlik yok**: Tüm zincirleri aynı genel modelle (transfer, bakiye, etiket) ele alıyor. Robinhood Chain duyurusu memecoin ve trader takibiyle sınırlı.
- **Hisse verisi ve hisse semantiği yok**: Bir inceleme açıkça "hisse piyasası verisi sağlamıyor" diyor. Stock Tokens'ın `uiMultiplier` mantığını, hisse karşılığı (share-equivalent) bakiyeyi ve kurumsal işlemleri (temettü, bölünme) modellediğine dair bir bilgi yok.
- **DeFi fırsat keşfi yok**: "Bu varlıkla ne yapabilirim, nerede getiri var" sorusuna cevap vermiyor. Platform izleme ve analiz odaklı.
- **Veri kökeni zayıf**: Etiketlerin doğruluk oranı yayınlanmıyor; Intel Exchange doğrulaması merkezi.
- **Gizlilik tartışması**: Kişilerin anonimliğini kaldırmak ciddi eleştiri alıyor. Forbes 2023: "Privacy Advocates Are Furious".
- **Opak fiyatlandırma ve token bağımlılığı**: Premium erişim ARKM fiyatına bağlı.
- Token'ın iç özelliklerini (enflasyon, gas vb.) göstermiyor; kullanıcı bunun için blok gezginine gitmek zorunda.

## Skein ile karşılaştırma

| Özellik | Arkham | Skein (bugün) |
|---|---|---|
| Kapsam | 20'den fazla zincir, genel | Yalnızca Robinhood Chain, derin |
| Varlık ve etiket veritabanı | 800 binden fazla varlık | **Yok** |
| Adres profili: portföy, değer | Var | Var: kanonik varlıklar, hisse karşılığı ve kaynaklı fiyatla |
| Bakiye geçmişi, P&L | Var | **Yok** (indexer gerekiyor) |
| Transfer geçmişi ve filtreler | Var | **Yok** |
| Karşı taraf analizi | Var | **Yok** |
| DeFi pozisyonları | Borç/kredi (genel) | Morpho, Pendle, LP: sağlık faktörüyle birlikte |
| Token sayfası: sahipler, akışlar | Var | Kısmen: fiyat, piyasalar ve fırsatlar var; sahipler ve akışlar yok |
| Stock Token semantiği | Yok | **Var (fark)** |
| "Bu varlıkla ne yapabilirim" | Yok | **Var (fark)** |
| Her rakamın kaynağı ve tazeliği | Yok | **Var (fark)** |
| Visualizer / Tracer | Var | **Yok** |
| Uyarılar | E-posta, Telegram, Slack, webhook | Kısmen: tarayıcı içinde fiyat ve oran uyarısı |
| Panolar | Var | **Yok** |
| İzleme listesi / takip edilen cüzdanlar | Var | Var (tarayıcıda saklanıyor) |
| Swap / köprü | Swap var | Var: Uniswap, KyberSwap, LI.FI ve köprü |
| API | Ücretli, kredi bazlı | İç kullanım API'si var, herkese açık değil |
| Yapay zekâ ile işlem özeti | Var | **Yok** |
| Topluluk istihbarat pazarı | Var | Yok |

## Skein için çıkarımlar

1. **Rakip zaten zincirde.** Arkham genel bir Robinhood Chain gezgini ve takipçisi sunuyor. Onunla aynı şeyi yapmak yerine **Robinhood Chain'e özgü derinlikle** ayrışmalıyız:
   - **Stock Tokens'a özel istihbarat**: Bir hisse tokenını kim tutuyor (hisse karşılığıyla), balina hareketleri, kurumsal işlemlerin (temettü, bölünme) bakiyelere etkisi, ihraççı kontrolleri (pause, blocklist, USDG freeze).
   - **DeFi pozisyonlarını çözümlemek**: Bir cüzdanın Morpho borcu, Pendle PT'si, LP aralıkları, sağlık faktörü ve likidasyon fiyatı.
   - **"Bu cüzdan ne yapıyor, ne yapabilir"**: izleme ile fırsat keşfi bir arada.
   - **Kanıt**: Her etiketin ve rakamın kaynağı gösteriliyor.
2. **En büyük teknik açık veri altyapısı.** Arkham'ın özellikleri (bakiye geçmişi, P&L, transferler, karşı taraflar, sahipler, akışlar, Visualizer) bir **indexer ve veritabanı** gerektiriyor. Bugün Skein her şeyi RPC'den anlık okuyor. Bu, yeni yapının en önemli büyüme noktası.
3. **Etiketleme ve varlık modeli** ikinci büyük açık. Başlangıç için güvenli ve kanıtlanabilir etiketler kullanılmalı:
   - protokol kontratları
   - köprüler
   - Robinhood altyapısı (Stock Token fabrikası, beacon, registry)
   - borsa (CEX) adresleri
   - kendini açıklamış fonlar
   
   **Bireylerin anonimliğini kaldırmak hukuki ve etik risk taşır**; bunun açık bir politikayla kapsam dışı bırakılmasını öneriyorum.
4. **Kütüphane yapısı burada da işe yarar.** Arkham'ın değeri API'si. Bizim motorumuz paketlere ayrılırsa hem web uygulaması hem herkese açık API hem de agent/MCP aynı kütüphaneleri kullanır.
5. **Çoklu zincir**: Arkham'ın gücü genişlik. Biz zincire özgü her şeyi bir zincir paketinde toplarsak, ikinci zinciri de aynı derinlikle ekleyebiliriz.

## Kaynaklar
- https://info.arkm.com/announcements/robinhood-chain-in-live-on-arkham
- https://info.arkm.com/announcements
- https://codex.arkm.com/the-intelligence-platform
- https://info.arkm.com/research/how-to-use-arkham-intel-guide-explained
- https://docs.intel.arkm.com (API referansı; arama sonuçlarındaki endpoint özetleri)
- https://info.arkm.com/announcements/the-new-arkham-api
- https://coinbureau.com/review/arkham-intelligence-review
- https://en.wikipedia.org/wiki/Arkham_(cryptocurrency_exchange)
- https://www.rfp.wiki/crypto/compliance-analytics/aml-kyc-transaction-monitoring/arkham-intelligence/sumsub (fiyatlandırma, üçüncü taraf)
