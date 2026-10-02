# Tasarım revizyonu: premium yön

Tarih: 2026-10-01.

Dayanak:
- Mevcut sitenin incelemesi: 1440 px, 1280 px, 800 px ve 375 px genişlikte ekran görüntüleri, ayrıca `apps/web/src/styles.css` ve bileşenler.
- Premium ürünlerin referans incelemesi.
- Lisansları doğrulanmış asset kaynakları.

**Doğrulanmadı** diye işaretli değerler, uygulamadan önce DevTools'ta ya da lisans dosyasında kontrol edilecek.

## 1. Bugünkü durum: neden "premium" hissettirmiyor

### Sistem sorunları
- **CSS üst üste yamalanmış.**
  - 1.661 satırda en az 4–5 tasarım turu var (soft → neon night → round 3 → terminal) ve her biri bir öncekini geçersiz kılıyor.
  - `.panel` 4 yerde, `.btn` 2 yerde tanımlı.
  - Terminal turu 30 civarı sınıfa `!important` ile `radius: 4px` zorluyor.
  - TSX içinde 139 satır içi stil var; token dışında onlarca sabit renk yazılmış.
  - Sonuç: her yeni detay bir `!important` ile savaşıyor.
- **Yazı tipi ölçeği yok.**
  - 20'den fazla farklı boyut kullanılmış (9; 9.5; 10; 10.5; 11; 11.5; 12; 12.5; 13; 13.5; 14; 15; 16; 17; 18; 20; 22; 26; 28; 30 px).
  - Gövde metni çoğunlukla 11–13 px.
  - Butonlar, etiketler ve başlıklar dahil her yerde büyük harfli JetBrains Mono var. Bu bir "terminal" hissi veriyor ama aynı zamanda gürültü.
- **10 farklı köşe yuvarlaklığı** var (2, 3, 4, 8, 10, 12, 14, 18, 20 ve 99 px).
- **Derinlik yok.** Her yüzey aynı 1 px çerçeveli siyah kutu: katman, ışık ya da doku yok. Arka plan düz `#0a0b0a`.
- **Lime her işi yapıyor.** Link, artış rengi, birincil buton, çerçeve, aktif durum, canlı nokta ve "AVAILABLE" rozetleri hep aynı renkte. Bu yüzden vurgu anlamını yitiriyor.
- **Hareket zayıf.**
  - Geçişler 0,1–0,15 s `ease`.
  - Basma (press) hissi yalnızca 3 yerde, `:focus-visible` yalnızca 8 yerde var.
  - Canlı fiyatlarda sadece renk değişiyor.
  - Sayfa geçişi yok.

### Görünen hatalar
- **Markets tablosu:**
  - Yaklaşık 800 px genişlikte yatay kayma çıkıyor ve varlık adları kesiliyor ("Glo…").
  - Mobilde varlık sütunu tamamen çöküyor (yalnızca logo kalıyor).
- **Header:** Dar ekranda "Connect Wallet" butonu kesiliyor.
- **Birincil eylem zayıf:** "Connect Wallet" dolgulu değil, yalnızca çerçeveli.
- **Asset sayfası:** Tek sütunda çok uzun; yoğun rota tabloları 11 px. Bilgi hiyerarşisi yok.
- **Sol menü:** Etiketler 9 px büyük harf.
- **Paylaşım görseli yok:** Hiçbir sayfada `og:image` yok; bağlantı paylaşıldığında görsel çıkmıyor.

### Güveni zedeleyen veri sunumu
Bunlar tasarım değil, ama premium algısını doğrudan etkiliyor:
- **"Highest yield" başlığında uç değerler:** %2.291 (USDG, Beefy), %556, %328.
  - Öneri: başlık listelerine bir mantıklılık eşiği konur (ör. APY > %100 ise "outlier" rozeti eklenir ve başlıkta gösterilmez).
- **Logolar:** Birçok hisse logosu boş daire olarak görünüyor. Aşağıdaki logo lisansı bölümüne bakın.

## 2. Yön: "Instrument" (terminal değil, hassas bir ölçüm aleti)

Kimlik korunuyor: koyu tema, lime vurgu, önce sayılar ve "skein" (örgü) motifi. Değişenler:
- **Yüzeyler:** Tek tip çerçeveli kutular yerine sakin, **grafit tonlu bir malzeme sistemi**:
  - 3 ton seviyesi
  - %6–9 beyaz ince çizgiler (hairline)
  - üst kenarda çok hafif bir iç ışık
- **Cam (blur) yalnızca yüzen katmanlarda:** header, menüler, komut paleti ve modallar. İçerik panellerinde kullanılmaz.
- **Doku ve görsel:** %3–4 film greni. Yalnızca ana sayfa hero'sunda bir "örgü" görseli.
- **Tipografi işin çoğunu yapar:**
  - Cümle düzeninde (sentence case) zarif bir grotesk.
  - Büyük sayılar tabular rakamlarla, sıfırı çizgili.
  - Mono yalnızca gerçekten kod olan şeylerde: adres, hash, blok numarası, yoğun sayı sütunları ve `skein/` logosu.
  - Büyük harfli mono yalnızca nadir "eyebrow" etiketlerde kalır (ör. "LIVE · BLOCK 77,531,593"). Böylece bilinçli bir tercih gibi okunur.
- **Köşeler:** 4 px yerine 6, 8 ve 12 px; zanaat hissi verir ama keskin kalır.
- **Birincil butonlar:** dolgulu lime.
- **Lime kalıyor ama rolü değişiyor.**
  - `#C8F169` zaten favicon'da, X görsellerinde ve tanıtım videosunda kullanılıyor.
  - Robinhood'un "Robin Neon" rengi `#CCFF00`'dan bilinçli olarak daha yumuşak. Böylece ekosisteme yakın duruyor ama onaylanmış (endorsed) izlenimi vermiyor.
  - Bundan sonra yalnızca **sinyal** rengi olarak kullanılacak: birincil CTA, artışlar, focus halkası, aktif menü göstergesi, canlı nokta ve grafik çizgisi. Ekran başına en fazla yaklaşık 3 kullanım.
- **Nötrler:** Yeşile çalan siyahlar yerine hafif soğuk bir grafit. Lime bunun üzerinde öne çıkar.

### Token tablosu (koyu tema, varsayılan)

Kontrast oranları `--bg-1` üzerinde hesaplandı.

| Token | Değer | Kullanım |
|---|---|---|
| `--bg-0` | `#08090A` | sayfa |
| `--bg-1` | `#0E0F11` | panel / kart |
| `--bg-2` | `#15171A` | yükseltilmiş: hover satırı, menü |
| `--bg-3` | `#1C1F23` | input, segment zemini, seçili |
| `--line-1/2/3` | `rgba(255,255,255,.06/.09/.14)` | ayraç / panel çerçevesi / hover-input |
| `--fg-1` | `#EDEFF2` (16.7:1) | birincil metin |
| `--fg-2` | `#A1A7B0` (7.9:1) | ikincil |
| `--fg-3` | `#7D838C` (5.0:1) | etiket, eksen |
| `--fg-4` | `#50555C` | devre dışı, dekoratif |
| `--accent` | `#C8F169` · hover `#D4F585` · press `#B5DE55` | sinyal |
| `--on-accent` | `#0B1004` | lime üstü metin |
| `--accent-a10/a24` | `rgba(200,241,105,.10/.24)` | yumuşak dolgu / çerçeve |
| `--up` / `--down` | `#C8F169` / `#FF7366` | değişimler (eşit algılanan parlaklık) |
| `--warn` / `--info` / `--violet` | `#F2C46B` / `#7CB8FF` / `#B4A6FF` | borrow / LP / sabit getiri |
| Grafik serileri | `#C8F169 #6CC4FF #B4A6FF #F2B85B #FF8FB1 #4FD1B5 #8A9099` | kategorik |

Açık tema ikincil kalıyor: arka plan `#F6F6F4`, yüzey `#FFF`, metin `#111315`, artış `#3D7A0C`, azalış `#C2372B`.

### Yazı ölçeği

| Rol | px / satır yüksekliği · harf aralığı · kalınlık |
|---|---|
| display (hero) | 56/60 · −0.035em · 600 (mobil 36/40) |
| kpi | 40/44 · −0.03em · 600 · tabular |
| h1 / h2 / h3 | 28/34 · 20/28 · 16/24 · 600 |
| body-lg / body / body-sm | 16/26 · 14/22 · 13/20 · 400 |
| label | 12/16 · 500 · cümle düzeni · `--fg-3` |
| eyebrow (nadir) | 11/14 mono · +0.08em · büyük harf |
| tablo sayıları | 13 px · tabular |

### Köşe, boşluk, yükseklik

| | |
|---|---|
| Köşeler | 4 (etiket, kbd) · 6 (buton, input, chip) · 8 (panel, kart, tablo) · 12 (popover, modal, drawer) · 999 (pill, avatar) |
| Boşluk | 4-pt ölçek: 2 4 6 8 12 16 20 24 32 40 48 64 80 |
| Buton yükseklikleri | 32 (küçük) · 36 (varsayılan) · 44 (birincil / mobil). İkon butonlar kare. Mobilde en az 44 px dokunma alanı |
| Tablo satırı | 44 rahat · 36 yoğun · 32 kompakt |
| İçerik genişliği | en fazla 1280 px |

### Yükseklik (elevation)

| Seviye | Tarif |
|---|---|
| e1 panel | `--bg-1` + 1 px `--line-2` + `inset 0 1px 0 rgba(255,255,255,.03)` |
| e2 yükseltilmiş | `--bg-2` + `0 1px 2px rgba(0,0,0,.5), 0 4px 12px -2px rgba(0,0,0,.4)` |
| e3 menü / popover | `rgba(21,23,26,.86)` + `backdrop-filter: blur(16px) saturate(140%)` + 1 px `--line-3` + yumuşak gölge + üst iç ışık |
| e4 modal | e3 + `0 32px 80px -16px rgba(0,0,0,.7)`. Arka plan: `rgba(4,5,6,.6)` + blur(4px) |
| Focus | `0 0 0 1px var(--bg-0), 0 0 0 3px rgba(200,241,105,.45)` |
| Birincil CTA parıltısı | `0 6px 20px -8px rgba(200,241,105,.45)` |

### Hareket

| | |
|---|---|
| Süreler | press 80 ms · hover/renk 120 ms · menü, tooltip, popover giriş 180 / çıkış 120 ms · drawer, modal 260 ms · rakam yuvarlama 450 ms · fiyat flaşı 700 ms · skeleton 1,4 s |
| Eğriler | `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` · `--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1)` · drawer `cubic-bezier(0.16, 1, 0.3, 1)` |
| Basma | `scale(.98)` |
| Popover | `scale(.96)` ve opaklık 0'dan başlar; `transform-origin` tetikleyen elemanda |
| Liste girişi | satır başına 30 ms gecikme, en fazla 8 satır |
| Canlı fiyatlar | Tablo hücreleri arka plan flaşıyla güncellenir. Rakam yuvarlama yalnızca hero KPI'larda kullanılır |
| Sayfa geçişleri | CSS View Transitions; ek kütüphane gerekmez ve CSP ile uyumlu |
| Erişilebilirlik | Hepsi `prefers-reduced-motion` altında kapanır |

## 3. Kullanılacak hazır kaynaklar (lisansı uygun, bundle'a girecek)

CSP yalnızca kendi alan adımızdan font ve görsel yüklenmesine izin veriyor. Bu yüzden her şey uygulamayla birlikte paketlenecek.

| Ne | Seçim | Lisans | Not |
|---|---|---|---|
| Yazı tipi | **Geist** (arayüz, başlık, KPI) + **Geist Mono** (adres, hash, yoğun sütunlar) | OFL-1.1 (doğrulandı) | Upstream woff2 dosyaları (`vercel/geist-font/fonts/*/webfonts/`) ve `LICENSE` repoya kopyalanır. `@fontsource` kullanılmaz, çünkü `ss*` ve `case` özelliklerini siliyor. Latin, Latin Extended (TR) ve Kiril var; Yunanca ve ₺ yok (₺ için sistem fontuna düşülür). Arapça, Hintçe ve CJK zaten sistem fontuna düşüyor. Alternatif: Inter v4.1 (OFL; ₺ var, `opsz` ekseni) + JetBrains Mono |
| İkonlar | **Lucide** | ISC | Mevcut 49 elle çizilmiş ikonla aynı yapıda (24 grid, yuvarlak uçlar). Yalnızca path'ler `icons.tsx`'e kopyalanır; çalışma zamanı bağımlılığı olmaz. 16–20 px'te 1,5, 24 px ve üstünde 1,25 kalınlık |
| Gren dokusu | Kodla üretilecek (SVG `feTurbulence` → 256×256 PNG) | lisans sorunu yok | `opacity .035`, `mix-blend-mode: overlay`, sabit katman |
| Nokta ve ızgara desenleri | Saf CSS (`radial-gradient` + `mask-image`) | — | — |
| Hareket | CSS + View Transitions; liste ekleme ve silme için gerekirse AutoAnimate (MIT, ~3 KB) | — | NumberFlow kullanılmayacak: satır içi `<style>` CSP'ye takılıyor ve RTL desteklemiyor. Rakam yuvarlama için ~1 KB'lık kendi bileşenimizi yazarız |

Kullanılmayacaklar:
- **fffuel ve Shapefest:** çıktılarını yeniden dağıtmak yasak; repo public.
- **Haikei:** lisansı yok.
- **Fontshare fontları:** dosyaların yeniden dağıtımı kısıtlı.
- **Unsplash+:** ücretli lisans.

## 4. Logo lisansı: bugünkü kodda yasal risk

- **Hisse logoları:** `apps/server/src/logos.ts` logoları `assets.parqet.com`'dan alıp kendi alan adımızdan sunuyor ve diske önbelleğe alıyor.
  - Parqet'in logo API'si artık Elbstream oldu.
  - Elbstream'in **ücretsiz planı** kendi alan adından sunmayı ve önbelleğe almayı yasaklıyor; ayrıca logonun göründüğü her sayfada 12 pt'lik görünür bir bağlantı istiyor. Bunu kendim doğruladım: https://elbstream.com/logos
  - Kendi alan adından sunma ve önbellek yalnızca Enterprise planda var (fiyat teklif usulü).
- **Repoya commit'lenmiş logolar:** `apps/server/data/logos/` içinde CoinGecko, Financial Modeling Prep ve DefiLlama'dan alınmış logolar var. Repo artık public olduğu için bunlar yeniden dağıtılmış oluyor.
- **Seçenekler:**
  - (a) Elbstream Enterprise
  - (b) logo.dev Pro (~1.260 $/yıl; kendi sunucumuzda barındırma ve önbellek dahil)
  - (c) **Varsayılan olarak tasarlanmış monogram kutucuklar**: ticker baş harfleri, sembole göre sabit bir renk tonunda. Lisansı olan logolar sonradan eklenir.
  
  Önerim: önce (c), sonra (a) ya da (b). Bu bir iş kararı (açık soru).
- **Robinhood Chain marka kuralları** (docs.robinhood.com/chain/brand-guidelines):
  - Yalnızca resmî kit kullanılır ve logolar değiştirilmez.
  - En az 20 px yükseklik.
  - Yalnızca 3 renk eşleşmesine izin var.
  - **Robinhood ve Robinhood Chain işaretleri yapay zekâ ile üretilmiş içerikte kullanılamaz.** Görsel üretirken prompt'a bu işaretler asla konmaz.

## 5. Senin üretmen gereken görseller

Ortak kurallar:
- **Asla metin, logo ya da Robinhood işareti olmayacak.**
- Boyutlar CSS'teki gösterim boyutunun 2 katı.
- **Zemin, görsel tipine göre değişiyor:**
  - **Parlayan iplik sahneleri** (1, 4, 5): zemin saf siyah ya da çok koyu grafit olur. Kenarları CSS maskesiyle sayfa rengine eriteceğim; şeffaflık gerekmez.
  - **Nesneler** (2, 3, 6): Araç destekliyorsa **şeffaf PNG** iste. Desteklemiyorsa düz gri (`#808080`) zemin iste; arka planı ben temizlerim. Mat grafit nesneler siyah zeminde kaybolduğu için siyah zemin kullanılmaz.
- Dosyaları bana PNG olarak ver; WebP/AVIF dönüşümünü ve sıkıştırmayı ben yaparım.
- Repo public olduğu için kullandığın görsel aracının **ticari kullanım koşullarını** kontrol et.

Tüm prompt'ların başına eklenecek ortak stil (İngilizce):

> *graphite void, luminous braided threads, lime #C8F169 / pale mint-white / olive strands, glass-fiber macro, soft volumetric rim light, shallow depth of field, fine film grain, minimal, premium, no text, no logos*

Nesne görsellerinde (2, 3, 6) bu satırın yerine şu kullanılır:

> *single isolated object, 3/4 isometric, matte dark graphite with fine brushed texture, one thin glowing lime (#C8F169) edge accent, soft studio rim light, floating, centered, generous padding, transparent background (or flat #808080), no text, no logos*

| # | Görsel | Nerede | Boyut (px) | Prompt (İngilizce) | Gelmezse |
|---|---|---|---|---|---|
| 1 | **Hero arka planı: "skein"** (en önemlisi) | Ana sayfa hero'sunun arkası | **2880×1400** + mobil kırpma **1170×1500** | "three luminous threads braiding into a loose skein, entering from the right edge and dissolving into darkness, left 55% of the frame empty for a headline, cinematic macro" | Mevcut `header-braid` örgüsünün SVG'si + lime radyal ışık + gren |
| 2 | **Boş durum seti (4 adet, tek seferde, aynı ışıkla)** | Cüzdan bağlı değil · takip edilen cüzdan yok · arama sonucu yok · boşta varlık yok | her biri **640×400** | "single matte graphite object — (1) a wallet (2) a spool of thread (3) a magnifier (4) a small resting bell — isometric 30°, lime rim light, floating, soft contact shadow, studio" | 40 px Lucide ikonu, 64 px daire içinde |
| 3 | **"Nasıl çalışır" üçlüsü** | Ana sayfadaki 3 adım | her biri **960×600** | (1) "a glass card with a faint address line etched on it" (2) "one thread fanning out into three strands" (3) "a strand ending in a small glass wallet with a soft glow" | Numaralı kartlar + büyük ikon |
| 4 | **404 / hata görseli** | Bulunamadı ve hata sayfaları | **1600×1000** | "a single lime thread tangled into a loose knot, floating in a graphite void, macro" | Yalnızca metin + gri örgü SVG'si |
| 5 | **Cüzdan bağlama / PRO şeridi** | Cüzdan modalının ve PRO tanıtımının üstü | **1040×320** | "frosted glass slab with braided lime threads refracted behind it, top-down" | İki radyal gradyan + gren |
| 6 | *(Faz 2, sonra)* **Varlık tipi amblemleri (8 adet)** | Varlık sayfalarındaki tip rozetleri: Exchange, Fund, Protocol, Bridge, Market maker, DAO/Treasury, Deployer, Large holder | her biri **256×256** | "embossed glass glyph of [symbol] inside a soft rounded-square tile, graphite with lime inner glow, consistent lighting, centered" | Lucide glif + lime tonlu kutu |

## 6. Benim üreteceklerim (sende iş yok)

- **Gren dokusu:** 256×256, kodla üretilecek.
- **Sosyal paylaşım (OG) kartı:** 1200×630. Mevcut `brand/twitter` HTML hattıyla, hero görseli + `skein/` + "Untangle any wallet" metniyle oluşturulacak. Ardından varlık başına paylaşım kartları gelir.
- **Uygulama ve PWA ikonları:** `favicon.svg`'deki `s/` glifinden vektörel olarak: 1024 → 512, 192, 180, maskable 512. Yapay zekâ harf şekillerini bozduğu için kullanılmayacak.
- **Monogram logo kutucukları:** logo yoksa ya da lisanssızsa gösterilecek.
- **Grafik stili:** lime çizgi, alt tarafa doğru kaybolan gradyan dolgu, ince ızgara, tooltip.

## 7. Uygulama planı

| Adım | İş |
|---|---|
| D1 | **Tasarım sistemini sıfırdan kurmak.** `styles.css` katmanlara ayrılır: `tokens.css` → `base.css` → `components/*.css` → `pages/*.css`. Eski turlar ve `!important`'lar silinir; satır içi stiller sınıflara taşınır. Yeni fontlar ve ikonlar burada gelir |
| D2 | **Bileşenler.** Button, Input, Segmented, Chip/Badge, Panel/Card, Table (yoğunluk seçenekleriyle), Menu/Popover, Modal/Drawer, Tooltip, Skeleton, Tabs, Stat/KPI, PriceCell (flaş), DigitRoll ve Logo/Monogram. Hepsi tek bir örnek sayfada (`/dev/ui`) gösterilir |
| D3 | **Sayfalar.** Header ve sol menü; Home (hero + cüzdan arama); Markets (tablo hataları dahil); Asset (sekmeli yapı: Overview · Markets · Opportunities · Holders, sonra Faz 2 verisiyle); Wallet; Coverage/Compare/About |
| D4 | **Görseller.** Senden gelenler + benim ürettiklerim; OG etiketleri |
| D5 | **Kontrol.** 1440, 1280, 1024, 768 ve 375 px'te ekran görüntüleri; kontrast; klavye ile gezinme; azaltılmış hareket; açık tema |

İstersen D1'e başlamadan önce bu yönü gösteren tek sayfalık bir **örnek görünüm** hazırlayabilirim (Home + Markets satırları + bir buton/kart seti). Önce onu onaylarsın, sonra tüm siteye yayarız.

## Kaynaklar
- Linear UI redesign: https://linear.app/now/how-we-redesigned-the-linear-ui
- Vercel Geist: https://vercel.com/geist, https://vercel.com/geist/materials
- Geist font (OFL-1.1, subsets): https://api.fontsource.org/v1/fonts/geist, https://github.com/vercel/geist-font
- Lucide (ISC): https://lucide.dev
- Grainy gradients: https://css-tricks.com/grainy-gradients/
- View Transitions (baseline): https://web.dev/blog/same-document-view-transitions-are-now-baseline-newly-available
- Motion bundle sizes: https://motion.dev/docs/react-reduce-bundle-size
- NumberFlow: https://number-flow.barvian.me
- Robinhood Chain brand guidelines: https://docs.robinhood.com/chain/brand-guidelines/
- Elbstream logo API terms: https://elbstream.com/logos
- logo.dev pricing: https://logo.dev/pricing
- fffuel license: https://www.fffuel.co/license/
- Unsplash license: https://unsplash.com/license
