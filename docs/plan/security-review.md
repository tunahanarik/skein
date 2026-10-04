# Güvenlik incelemesi (2026-10-01)

Kapsam: sunucu ve proxy'ler (`apps/server`, `packages/core/src/lib/http.ts`, kaynak istemcileri), işlem oluşturucular ve cüzdan akışları (`packages/tx`, `apps/web`).

İnceleme salt-okunur yapıldı. Kanıt kodları (PoC) repoya girmedi. "Doğrulandı" diye işaretli bulgular kod çalıştırılarak yeniden üretildi. Yüksek önemdeki işlem bulguları ayrıca koddan elle kontrol edildi.

Kapsam dışı kalanlar:
- Bağımlılık ve yapılandırma taramasının tamamı ile analitik motorun veri bütünlüğü incelemesi. Bu iş otomatik onay sistemi tarafından engellendi; onay gelirse yapılacak.
- Sunucu incelemesi `pnpm audit`'i çalıştırdı: bilinen açık yok.

> **Durum (2026-10-02):** Swap, köprü, agregatör ve `/api/img` görsel proxy'si siteden tamamen kaldırıldı. Bu yüzden şu bulgular kodla birlikte ortadan kalktı:
> - TX-1…TX-5 ve tüm düşük önemli işlem bulguları
> - SRV-6 ve SRV-7
>
> Cüzdan artık yalnızca adres ve zincir okuyor (`eth_requestAccounts`, `eth_accounts`, `eth_chainId`). CSP `connect-src 'self'`. Açık kalanlar SRV-1…SRV-5, SRV-8, SRV-9 ve düşük önemli sunucu bulguları.

> **Durum (2026-10-04):** Şu bulgular kapandı. Her birinin testi var.
> - **D1:** %100'ün üstündeki kazanç oranları `outlier` olarak işaretleniyor. Sıralamada sona düşüyor, "Top yield" ve "en iyi" başlıklarına girmiyor. Kartta sayı yerine "Outlier" etiketi ve bildirilen değer gösteriliyor.
> - **SRV-1:** `//a:b` gibi istek hedefleri ayrıştırılmadan 400 alıyor. Beklenmeyen hata logu tek satır yazıp süreçten çıkıyor.
> - **SRV-2:** Statik dosyalar `pipeline` ile sunuluyor.
> - **SRV-3:** `TtlCache` girdi sayısıyla sınırlı (varsayılan 1000, görünüm önbelleği 200). Tutar girilmiş teklif görünümleri önbelleğe alınmıyor. Fiyat teklifleri için global eşzamanlılık sınırı 24.
> - **SRV-4:** `TRUST_PROXY=1` iken en sağdaki `X-Forwarded-For` değeri kullanılıyor.
> - **SRV-5:** IPv6 /64 önekiyle anahtarlanıyor. Kova sınırında herkes sıfırlanmıyor; en eski %10 atılıyor.
> - **SRV-8:** İstemci erken koparsa akış hiç açılmıyor. Kapanış tek seferlik.
> - **SRV-9:** Açılış ve ölümcül hata loglarında URL'ler origin'e kısaltılıyor.
> - **A1:** CLI raporları, ortamdaki RPC URL'lerini dosyaya ve konsola yazmadan önce maskeliyor.
> - **A2:** Mod artık fail-closed çalışıyor: değişkenlerden biri production derse ya da değer `prod` ise üretim sayılıyor. Bilinmeyen değerde sunucu başlamıyor.
> - **A3:** `.gitignore`'a `.npmrc`, `*.pem` ve `*.key` eklendi.
> - **C1, C2:** CI'da `permissions: contents: read` var. Action'lar SHA'ya sabitlendi. `persist-credentials: false`, zaman aşımı ve concurrency ayarlandı.
> - **Düşük önemli:** `/api/health` dışarıya yalnızca `{status, latestBlock}` açıyor.
>
> Açık kalanlar: D2–D10, B2, B3 (sunucu konteynerde `tsx` ile çalışıyor), E1–E2 ve diğer düşük önemliler.

## Özet

| ID | Önem | Alan | Bulgu |
|---|---|---|---|
| TX-1 | **Yüksek** | Köprü / agregatör swap | `checkBridgeQuote` imzalanan calldata'yı (`tx.data`) çözmüyor; yalnızca LI.FI'ın JSON alanlarını karşılaştırıyor |
| TX-2 | **Yüksek** | Köprü | ETH `value` sınırı, aynı yanıtın beyan ettiği "ücretten" geliyor; kendine referans veriyor |
| TX-3 | **Yüksek** | KyberSwap swap | 1 wei minimum çıktı kabul ediliyor; struct'ın çoğu ve fazladan calldata kontrol edilmiyor |
| SRV-1 | **Yüksek** | Sunucu | Tek bir istek (`GET //a:b`) tüm süreci çökertiyor (doğrulandı) |
| SRV-2 | **Yüksek** | Sunucu | Statik dosya sunucusu, istemci bağlantıyı kesince dosya tanıtıcısı (fd) sızdırıyor (doğrulandı) |
| SRV-3 | **Yüksek** | Sunucu | Görünüm önbelleği hiç temizlenmiyor; `?amount=` ile RPC maliyeti katlanabiliyor (doğrulandı) |
| SRV-4 | Yüksek (`TRUST_PROXY=1` iken) | Sunucu | `X-Forwarded-For` ile rate limit ve akış limiti atlatılıyor (doğrulandı) |
| TX-4 | Orta | Swap/köprü | İmzadan önceki yeni fiyat teklifi, kullanıcının gördüğüyle karşılaştırılmıyor |
| TX-5 | Orta | Agregatör | Oracle koruması fiyat yoksa açık kalıyor (fail-open) ve API'nin beyan ettiği miktara dayanıyor |
| SRV-5 | Orta | Sunucu | Rate limiter: IPv6, proxy arkasında ortak kova, 50 bin anahtarda `clear()` |
| SRV-6 | Orta | Sunucu | `/api/img` önbelleği sorgu parametresiyle sınırsız şişirilebiliyor; gövde, boyut sınırından önce okunuyor |
| SRV-7 | Orta | Sunucu | SVG tanıma regex'i üstel zamanlı (ReDoS) |
| SRV-8 | Orta | Sunucu | SSE: istemci erken koparsa yer, zamanlayıcı ve abonelik sızıyor |
| SRV-9 | Orta | Sunucu | Açılışta RPC hatası olursa anahtarlı RPC URL'si stderr'e basılıyor (doğrulandı) |
| Düşük | 16 madde | ikisi de | Aşağıda |

## İşlem akışı (kullanıcı parasını ilgilendiren kısım)

Temel soru şuydu: kötü niyetli ya da ele geçirilmiş bir fiyat API'si, kullanıcıya kontrollerden geçen ama zararlı bir işlem imzalatabilir mi?
- **LI.FI (köprü ve aynı zincirde swap): Evet.**
- **KyberSwap yedek yolu: Evet.**
- **Uniswap v3: Hayır.** İşlem tarayıcıda yerel olarak oluşturuluyor.

LI.FI'ın 2024'te gerçekten saldırıya uğradığını hatırlatalım.

### TX-1 · `checkBridgeQuote` calldata'yı çözmüyor
- **Yer:** `packages/tx/src/bridge/lifi.ts` (`checkBridgeQuote`); çağıranlar `apps/web/src/pages/Bridge.tsx` ve `apps/web/src/components/AggregatorSwap.tsx`.
- **Durum:**
  - Alıcı, gönderen, miktar, token ve zincir kontrolleri `q.*` alanlarıyla yapılıyor. Bu alanlar, `tx.data`'yı üreten aynı yanıttan geliyor.
  - Yanıttan bağımsız olan tek kontroller: hedef kontrat (`tx.to`, sabitlenmiş diamond) ve onay verilen adres (spender).
- **Saldırı:**
  - Yanıt JSON'da `toAddress = kullanıcı` gösteriyor.
  - Ama calldata'daki `BridgeData.receiver`, `destinationChainId`, `minAmount` ya da `hasDestinationCall` alanları saldırganın istediği değerde.
  - Fonlar gerçek LI.FI kontratı üzerinden saldırgana gider.
- **Arayüz metni yanıltıcı:** `bridge.note1` ve `docs/bridge.md` "alıcı eşleşmek zorunda" diyor; bu yalnızca JSON için doğru.
- **Düzeltme:**
  - Facet seçicileri için bir allowlist tutulur. `ILiFi.BridgeData` (aynı zincirde `swapTokensGeneric`) ABI ile çözülür.
  - `receiver`, `sendingAssetId`, `minAmount` ve `destinationChainId` karşılaştırılır. `hasDestinationCall` reddedilir.
  - Minimum çıktı calldata'dan alınır. Çözülemeyen seçiciler reddedilir.

### TX-2 · ETH `value` kontrolü kendine referans veriyor
- **Yer:** `lifi.ts`: `extraNativeFee` yanıttan okunuyor ve `checkBridgeQuote` izin verilen fazlalığı bu değerle sınırlıyor.
- **Saldırı:** ERC-20 (USDC) köprüsünde `tx.value = 100 ETH` ve "100 ETH native ücret" beyanı içeren bir yanıt kontrolden geçiyor.
- **Görünürlük:** Ücret, Bridge sayfasında kapalı bir `<details>` içinde duruyor; agregatör swap'ta hiç gösterilmiyor.
- **Düzeltme:**
  - Ek native ücrete mutlak bir tavan konur ve bağımsız fiyatla miktarın değerine oranla sınırlanır.
  - Aynı zincirde swap ve native olmayan girişte `value == 0` zorunlu tutulur.
  - Ücret görünür yerde gösterilir.

### TX-3 · KyberSwap kontrolü 1 wei minimumu kabul ediyor
- **Yer:** `packages/tx/src/swap/kyber.ts` (`checkKyberTx`) ve `AggregatorSwap.tsx`.
- **Kontrol edilenler:** `to`, `value == 0`, `srcToken`, `dstToken`, `amount`, `dstReceiver`, `minReturnAmount > 0`, ücret yokluğu.
- **Kontrol edilmeyenler:** `callTarget`, `approveTarget`, `targetData`, `srcReceivers`, `srcAmounts`, `flags`, `permit` ve calldata sonuna eklenmiş fazladan veri.
- **Minimum çıktı kullanılmıyor:** `checkKyberTx`'in döndürdüğü `minOut` değeri kullanılmadan atılıyor. %3'lük oracle koruması, API'nin JSON'daki `amountOut` tahminiyle hesaplanıyor.
- **Testin onayladığı durum:** `packages/product/test/aggregator.test.ts`, `amount=100` iken `min=1`'i geçerli kabul ediyor.
- **Düzeltme:**
  - `minReturnAmount >= route.amountOut × (1 − slippage)` zorunlu tutulur ve oracle koruması bu minimumla hesaplanır.
  - `srcReceivers` boş olmalı ya da toplamı `amount`'a eşit olmalı; `flags == 0`; `permit` boş olmalı.
  - Fazladan veriye karşı çözülen işlem yeniden kodlanıp orijinaliyle karşılaştırılır.
  - `packages/tx/test` altına Kyber testleri eklenir.

### TX-4 · İmzadan önceki yeni fiyat teklifi karşılaştırılmıyor (Orta)
- **Uniswap** (`SwapDialog.tsx`): `minOut` yeni zincir üstü fiyat teklifinden hesaplanıyor ve gösterilen çıktıyla karşılaştırılmıyor.
- **Agregatör:** Kullanıcı "iyi" (≤ %1) bir rota gördüyse, %3'e kadar kötüleşmiş yeni rota ikinci onay istenmeden imzaya gidiyor.
- **Köprü:** Kullanılan araç, çıktı miktarı ve ücretler kullanıcıya fark ettirilmeden değişebiliyor.
- **Düzeltme:** Yeni çıktı, gösterilenden bir tolerans kadar (ör. min(slippage, %0,5)) düşükse arayüz güncellenir ve yeniden tıklama istenir.

### TX-5 · Oracle koruması fail-open (Orta)
- **Yer:** `AggregatorSwap.tsx`.
- **Durum:** Fiyatlardan biri yoksa kayıp hesaplanamıyor ve işlem engellenmiyor. Fiyatın ne kadar eski olduğuna da bakılmıyor.
- **Arayüz metni yanlış:** Metin "%3'ten kötü rotalar çalıştırılmaz" diyor.
- **Düzeltme:** Fiyat eksik ya da bayatsa işlem engellenir ya da kullanıcıdan açık onay istenir. Kayıp, calldata'daki minimumla hesaplanır.

### Düşük önemli işlem bulguları
- **`eth_sendTransaction`'da `chainId` yok:** Ağ değiştirme ile gönderme arasında yarış (race) mümkün. Her işleme `chainId` eklenmeli.
- **Çift gönderim:** `busy` durumu ancak await'ten sonra ayarlanıyor. Native köprüde çift tıklama iki işlem gönderebilir.
- **Ağ ekleme parametreleri LI.FI'dan geliyor:** Köprü sayfası, Robinhood Chain dahil, ağ ekleme parametrelerini LI.FI'dan alıyor. Kötü niyetli bir RPC kullanıcıya önerilebilir. 4663 için sabit `ADD_CHAIN_PARAMS` kullanılmalı.
- **`checkTx` (Uniswap) belgelendiğinden zayıf:** Sınırsız approve kontrolden geçiyor. `amountIn`, `minOut` ve `deadline` bağlama göre doğrulanmıyor. Sondaki fazladan veri tolere ediliyor. İşlemler yerelde kurulduğu için risk düşük, ama kontrol sıkılaştırılmalı. Ayrıca kontrollü gönderim tek bir `guarded()` fonksiyonunda toplanmalı.
- **EIP-6963:** Aynı `rdns` ile ilk duyuru kazanıyor. Adı "MetaMask" olan her cüzdana resmî logo ve ad veriliyor. Markalama yalnızca rdns eşleşmesiyle yapılmalı.
- **Görünmez karakterler:** Temizleyiciler sıfır genişlikli karakterleri ve LRM/RLM'yi bırakıyor. `\p{Cf}`, `\p{Zl}`, `\p{Zp}` ve `\p{Cc}` silinmeli.
- **Deadline yerel saatten hesaplanıyor:** Son bloğun zamanı kullanılmalı.
- **Hızlı swap kartı:** Eski fiyat teklifi bir an görünebiliyor (yalnızca kullanıcı deneyimi sorunu).

### Bilgi notları
- Belgeler güncel değil:
  - `docs/swaps.md` "üçüncü taraf çağrısı yok" diyor, ama kullanıcının adresi her fiyat teklifinde LI.FI'a ve KyberSwap'a gidiyor.
  - `agg.ackUnverified` metni korumayı abartıyor.
- `validRecipient` bazı uç durumları kabul ediyor: Solana'nın sıfır adresi (System Program) ve Bitcoin witness v2–v16 (bugün herkes harcayabilir). Bech32 dolgu bitleri de kontrol edilmiyor.
- EVM hedefi her zaman bağlı adres. Hedef zincirde aynı adreste kurulu olmayan akıllı kontrat cüzdanları için bu riskli.
- LI.FI kontrolü başarısız olursa KyberSwap'a sessizce geçiliyor. Kullanıcıya gösterilmeli.

## Sunucu

### SRV-1 · Tek istekle süreç çöküyor
- **Yer:** `apps/server/src/static.ts` (`new URL(req.url, …)` try/catch dışında); `main.ts` içinde `uncaughtException` handler'ı yok.
- **Saldırı:** `GET //a:b HTTP/1.1` gönderilir ve süreç ölür. İstek tekrarlanabildiği için sunucu sürekli düşürülebilir.
- **Düzeltme:**
  - URL tek yerde, try/catch içinde ayrıştırılır; hata olursa 400 dönülür. `/` ile başlamayan istekler reddedilir.
  - `uncaughtException` olursa loglanıp süreçten çıkılır, böylece süreç yöneticisi temiz bir yeniden başlatma yapar.

### SRV-2 · Statik sunucuda dosya tanıtıcısı sızıntısı
- **Yer:** `static.ts`: `createReadStream(file).pipe(res)`.
- **Saldırı:** Ana JS paketi (540 KB) art arda istenir, ilk parçadan sonra bağlantı kapatılır. Her istek açık bir dosya tanıtıcısı (fd) bırakır ve sunucu fd limitine (EMFILE) dayanır.
- **İkinci sorun:** Akışta `'error'` dinleyicisi yok. Deploy sırasında dosya silinirse süreç çöker.
- **Düzeltme:** `stream.pipeline(...)` kullanılır.

### SRV-3 · Sınırsız görünüm önbelleği ve RPC maliyeti katlama
- **Yer:** `packages/product/src/service.ts` (`viewCache`) ve `packages/core/src/lib/cache.ts`. `TtlCache` süresi dolan girdileri hiç silmiyor.
- **Saldırı:**
  - Her farklı `amount` değeri önbellekte yeni bir girdi oluşturur.
  - Her istek yaklaşık 14 rota için gerçek RPC fiyat teklifi tetikler. Teklif eşzamanlılığı 16 (belgede 3 yazıyor).
  - Saldırgan olmasa da her snapshot yeni anahtarlar ürettiği için bellek normal trafikte de sürekli büyür.
- **Düzeltme:**
  - Tutarlı görünümler önbelleğe alınmaz.
  - `TtlCache`'e üst sınır (`maxEntries`) ve süresi dolan girdileri temizleme eklenir.
  - Fiyat teklifleri için global bir eşzamanlılık sınırı (semaphore) konur.

### SRV-4 · `X-Forwarded-For` taklidi (yalnızca `TRUST_PROXY=1` iken)
- **Durum:** En soldaki IP kullanılıyor, ama bu değeri istemci belirleyebiliyor.
- **Etki:**
  - Rate limit ve akış limiti tamamen atlatılır.
  - Taklit edilmiş 300 IP ile canlı fiyat akışı herkes için kapatılabilir.
- **Düzeltme:** Proxy sayısı için bir `TRUSTED_PROXY_HOPS` ayarı eklenir ve sağdan o sıradaki değer alınır. Değer `net.isIP` ile doğrulanır.

### Orta önemli sunucu bulguları
- **SRV-5 · Rate limiter:**
  - IPv6'da kova /64 önekiyle anahtarlanmalı.
  - `TRUST_PROXY` kapalıyken proxy arkasında tüm site tek bir kovayı paylaşıyor.
  - 50 bin anahtarda `clear()` herkesin limitini sıfırlıyor; bunun yerine en eskiler atılmalı.
- **SRV-6 · `/api/img`:**
  - `?cb=N` gibi parametrelerle önbellek sınırsız şişiyor: diskte sınır yok, bellekte 770 MB'a kadar.
  - Gövde boyut sınırından önce tamamen okunuyor; aynı istek eşzamanlı gelirse yeniden kullanılmıyor.
  - Düzeltme: sorgu parametresi ve hash reddedilir, akış 256 KB'ta kesilir, disk ve bellek sınırlanır.
- **SRV-7 · SVG regex (ReDoS):** `(<!--[\s\S]*?-->\s*)*` üstel zamanlı çalışıyor; 26 yorum satırı 387 ms sürüyor. Deterministik bir desen kullanılmalı.
- **SRV-8 · SSE sızıntısı:** `close` dinleyicisi await'ten sonra ekleniyor. İstemci bu arada koparsa yer ve zamanlayıcı sonsuza kadar kalıyor.
- **SRV-9 · RPC anahtarı log'a sızıyor:** Açılıştaki `assertChainId` hatası, URL'yi anahtarıyla birlikte stderr'e basıyor. Hata sarılıp yalnızca mesajı loglanmalı.

### Düşük önemli sunucu bulguları
- **`LogoStore` belleği sınırsız:** Rastgele adreslerle şişirilebiliyor.
- **Yol regex'i:** `/\/+$/` binlerce `/` içeren bir yolda karesel zamanda çalışıyor.
- **İstemci hataları 500 dönüyor:** Bunlar 400 olmalı:
  - korumasız `decodeURIComponent`
  - sıfır adres
  - hassasiyetin altındaki miktar
  - checksum'ı hatalı adres
- **viem `isAddress` önbelleği:** Uzun çöp girdiler önbellekte birikiyor. Önce uzunluk kontrol edilmeli.
- **`shellWithMeta`:** `String.replace` içindeki `$'` desenleri yorumlanıyor. Enjeksiyon değil, ama fonksiyon replacer kullanılmalı.
- **`/api/health` herkese açık:** RPC host'u, sayaçlar ve son hata görünüyor. Dışarıya yalnızca `{status, latestBlock}` açılmalı.
- **Dış yanıt boyut sınırları zayıf:**
  - `http.ts` gövdeyi boyut kontrolünden önce okuyor.
  - `rhMarket` ve `kyber` çıplak `fetch` kullanıyor.
  - LI.FI çağrısının zaman aşımı yok.
- **`sanitizeLabel` bazı görünmez karakterleri bırakıyor:** Semboller için `sanitizeSymbol` kullanılmalı.

## İyi yapılmış olanlar (dokunulmayacak)
- **Onay verilen adresler:**
  - Hiçbir zaman API'den alınmıyor; her zaman sabitlenmiş kontratlar: SwapRouter02, LI.FI diamond ya da Kyber router.
  - Onaylar tam miktar için veriliyor; sınırsız onay hiçbir yerde yok.
  - 63 LI.FI diamond sabiti canlı li.quest ile karşılaştırıldı: 0 uyuşmazlık.
- **Cüzdan sınırı:**
  - Metot allowlist'i her türlü imzayı ve permit'i dışarıda tutuyor.
  - Ham provider dışarıya açılmıyor.
  - Yapıştırılmış bir adres hiçbir zaman imza atamaz.
- **XSS:** `dangerouslySetInnerHTML`, `innerHTML` ya da `eval` yok. Tüm `href`'ler doğrulanıyor.
- **Başlıklar:** CSP sıkı (`script-src 'self'`, `frame-ancestors 'none'`, `form-action 'none'`), ayrıca `nosniff`, COOP, CORP ve `no-referrer`.
- **Görsel ve logo proxy'si:**
  - SSRF'e karşı sağlam: host tam eşleşme, yalnızca https, userinfo ve port yok, yönlendirme reddi.
  - 256 KB sınırı ve sihirli sayı (magic number) ile dosya tipi kontrolü var.
  - SVG sandbox CSP altında sunuluyor.
- **Statik dosyalar:** Path traversal'a karşı korunuyor.
- **Uniswap akışı:** `value` 0, alıcı kullanıcı, yol yeniden kodlanıp karşılaştırılıyor, gönderimden önce `eth_call` simülasyonu yapılıyor.
- **Önbellek ve dosyalar:** Pool önbelleği zod ile doğrulanıyor, atomik yazılıyor ve zincir üstünde yeniden kontrol ediliyor.
- **Yapılandırma:**
  - Üretimde herkese açık RPC reddediliyor.
  - `/api/health` endpoint'i redakte ediliyor.
  - Sunucu varsayılan olarak `127.0.0.1`'e bağlanıyor.

## Bağımlılıklar, yapılandırma ve veri bütünlüğü (2026-10-02)

`pnpm audit` ve `pnpm audit --prod` temiz. Çalışma ağacında ve git geçmişinde gizli bilgi bulunmadı. Kritik bulgu yok.

Skein bir analitik ürünü olduğu için yanlış rakamlar da bir güvenlik sorunu sayılıyor. Bu yüzden veri bütünlüğü bulguları da burada.

| ID | Önem | Bulgu | Düzeltme |
|---|---|---|---|
| **D1** | **Yüksek (ürün için)** | **Beefy ve Steer APY'si API'nin sözüyle yayınlanıyor.** Üst sınır, makullük testi ya da zincir üstü kontrol yok, ama `VERIFIED_OFFICIAL_API` etiketi taşıyor. %4.962 APY gösteren USDG'nin kaynağı TVL'si yalnızca ~3,8 bin dolar olan bir Beefy CLM kasası: günlük bileşik hesaplanmış, ince likiditeli bir ücret APR'ı. Bu değer "best APY", sıralama ve Markets "Top yield" alanlarına doğrudan giriyor. Kendi CLM kasasında wash-trading yapan biri bu sayıyı şişirebilir (makul, test edilmedi). Morpho ve Pendle APY'lerinde de aynı desen var. `CLAUDE.md`'deki "API'den gelen hiçbir şey zincir üstü kontrol olmadan yayınlanmaz" iddiası APY'ler için doğru değil | `ABNORMAL_YIELD` uyarısı (ör. LP için %100 üstü) eklenir; bu değerler başlık, sıralama ve `bestApy` dışında bırakılır ve TVL tabanı uygulanır. APY'nin yanında basit `clmApr` gösterilir. Değer, hacim × ücret kademesi × 365 / TVL ile sınırlandırılır. Etiket "API bildirdi, doğrulanmadı" olarak değiştirilir |
| D2 | Düşük-Orta | Beefy/Steer tazeliği, verinin kaynaktaki zamanından değil, bizim çekme anımızdan ölçülüyor; veri her zaman FRESH görünüyor | Kaynak zaman damgası kullanılır; yoksa `UNKNOWN_AGE` |
| D3 | Orta | Beefy CLM kasa kimliği resmî bir kayda karşı doğrulanmıyor; yalnızca kontratın kendi beyan ettiği değerlere bakılıyor. Steer ise resmî VaultRegistry'yi kontrol ediyor | Beefy fabrikasına veya kaydına karşı doğrulanır; yapılamıyorsa rozet düşürülür |
| D4 | Orta | Chainlink feed adresleri sabitlenmemiş bir uzak JSON'dan (`reference-data-directory.vercel.app`) geliyor. Config'deki sabit `usdFeed` adresleri hiç karşılaştırılmıyor. `heartbeat` sınırsız ve tazelik limitini belirliyor | ETH, USDG, cbBTC ve USDe için sabit proxy'ler zorunlu tutulur. Hisse feed haritası, registry snapshot'ı gibi hash'li olarak commit'lenir. `heartbeat` en fazla 172.800 olur |
| D5 | Düşük-Orta | Stock Token'ın "zincir üstü doğrulaması" token'ın kendi beyanına dayanıyor (`uid`, `symbol` vb.); bir klon aynı değerleri döndürebilir. Beacon storage slot kontrolü yalnızca CLI'da var. Çekirdek varlıklarla adres veya sembol çakışması USDG'yi bozabilir | `getStorageAt` ile EIP-1967 beacon kontrolü eklenir; çekirdek varlıklarla çakışan girdiler reddedilir |
| D6 | Düşük-Orta | Chainlink ile Robinhood fiyatı arasındaki %1'den büyük çelişki portföy toplamını etkilemiyor; kapsam yine COMPLETE görünüyor. Markets tablosu çelişki bayrağını göstermiyor | Toplamlar PARTIAL ya da işaretli olur; güven seviyesi Markets'a taşınır |
| D7 | Düşük | Yedek Robinhood fiyatında alış-satış aralığı sınırı yok (alış 0,01, satış 1000 olursa orta fiyat ~500 çıkıyor). Çarpan için yalnızca `> 0` kontrolü var | En fazla ~%2 aralık; çarpan için makul bir aralık |
| D8 | Düşük | Pool önbelleğindeki kimlik kontrolleri 24 saat boyunca zincirde yeniden okunmadan kabul ediliyor. `.cache/chainlink/*.json` zod'suz okunuyor | İkisi de zod ile doğrulanır; hata olursa dosya yok sayılır |
| D9 | Düşük | `HttpClient`, `maxBytes` kontrolünden önce gövdenin tamamını okuyor | Akış halinde okunur ve bayt sınırında kesilir |
| D10 | Düşük | Pool TVL `balanceOf(pool)` ile hesaplanıyor; havuza token bağışlayarak eşikler aşılabilir | Uyarı mevcut; eşiklerde dikkate alınır |
| **A1** | **Orta** | **Anahtarlı RPC URL'si takip edilen bir dosyaya yazılıyor:** `validate-network` raporu URL'yi `research/snapshots/network.json` dosyasına kaydediyor ve bu dosya git'te takip ediliyor | `redactRpcUrl` kullanılır; `research/snapshots/*.json` gitignore'a eklenir |
| A2 | Düşük-Orta | Üretim RPC koruması açık kalıyor (fail-open): `APP_ENV=prod` yazılırsa ya da hiç ayarlanmazsa herkese açık RPC'ye izin veriliyor | Değişkenlerden biri production derse üretim kabul edilir, bilinmeyen değerde hata verilir, açılışta mod loglanır |
| A3 | Düşük | CLI'daki RPC okuması https ve üretim kontrollerini atlıyor. `.gitignore`'da `.npmrc`, `*.pem` ve `*.key` yok | — |
| A4 | Düşük | Commit'lenmiş dosyalarda eski geliştiricinin yerel yolları var (`file:///C:/Users/cem/...`, `brand/twitter/*.html`). `research/evidence/.../sel*.cjs` dosyaları repo dışındaki mutlak bir yolu `require()` ediyor | Göreli yollar kullanılır |
| B2 | Düşük | pnpm tedarik zinciri politikası yok: `onlyBuiltDependencies` ve `minimumReleaseAge` ayarlanmamış | Allowlist açık yazılır ve `minimumReleaseAge: 1440` eklenir |
| B3 | Bilgi | `pnpm serve`, devDependency olan `tsx` ile çalışıyor; üretim kurulumu geliştirme araçlarını da içeriyor | Sunucu bundle'lanır |
| C1 | Orta-Düşük | CI iş akışında `permissions:` bloğu yok, bu yüzden token repo varsayılanını alıyor | `permissions: contents: read` eklenir |
| C2 | Düşük | GitHub Actions değişebilir etiketlerle (`@v4`) sabitlenmiş | Commit SHA'larına sabitlenir; `persist-credentials: false`, zaman aşımı ve concurrency ayarlanır |
| E1–E2 | Düşük | `brand/video/serve.mjs` ROOT yolunu çalışma dizinine göre çözüyor ve `.git` ile `.env` dosyalarını sunabiliyor. `cdp.mjs` Edge'i yetkisiz bir hata ayıklama portuyla açıyor | ROOT `import.meta.url`'e sabitlenir, uzantı allowlist'i ve Host kontrolü eklenir |

İyi yapılmış olanlar:
- RPC URL redaksiyonu.
- Exact bigint matematik; `Number` yalnızca gösterimde kullanılıyor.
- DEX spot fiyatı yalnızca gösterim ve uyarı için kullanılıyor, değerlemeye girmiyor.
- Pendle'ın implied APY'si ve Morpho'nun toplamları zincir üstünde doğrulanıyor.
- Registry'de mükerrer kayıt dışlama ve kimlik değişikliği tespiti var.
- Kilitli lockfile.
- CI `pull_request` kullanıyor (`pull_request_target` değil).

## Düzeltme sırası (önerilen, 2026-10-02 güncel)
1. **D1:** Uç APY'ler başlık, sıralama ve "Top yield" alanlarından çıkarılır; etiket düzeltilir. Arayüz tarafı için kaldırılan tasarım önizlemesindeki kural: yüzde 100 üstü APY başlıkta sayı olarak değil "Outlier" etiketiyle ve kaynağını veren bir açıklamayla gösterilir.
2. **SRV-1, SRV-2:** Çökme ve fd sızıntısı.
3. **A1, C1:** RPC anahtarı sızıntısı ve CI izinleri. Küçük ve hızlı işler.
4. **SRV-3:** Önbellek sınırı ve fiyat teklifi semaphore'u.
5. **D4, D3, D5, A2.**
6. **SRV-4, SRV-5, SRV-8, SRV-9:** Cloudflare'e geçişte SRV-4 kendiliğinden çözülür.
7. Düşük önemliler ve belge düzeltmeleri.

(TX-1…TX-5, SRV-6 ve SRV-7 swap, köprü ve görsel proxy'si kaldırıldığı için kapandı.)
