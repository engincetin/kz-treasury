# kz-treasury

Kanzasset (KZ) tarafında çalışan hazine çekirdeği: rafinerinin (AMR uygulaması) fiyat soketine bağlanır, müşteri fiyatını hesaplar, müşteri işlemlerini açar / durdurur, rafineri hesaplarının Kanzasset kaydını tutar ve hazine ekranlarını sunar. Rafineri tarafı ayrı repodadır: `amr-app`.

İş kuralları ve akışlar: `docs/KZ_AMR_Akislar.html` · sistem tasarımı: `docs/KZ_AMR_Sistemi.html`.

## Ne yapar

- `ws://<amr>/v1/prices` soketine API anahtarı + HMAC ile bağlanır; `snapshot`, `tick`, `heartbeat`, `halt`, `resume` işler.
- Kurallar: 10 sn mesaj yoksa fiyat bayat → müşteri işlemleri durur · rafineri `halt` gönderdiyse durur · soket kopuksa durur · `seq` boşluğunda yeniden abone olur · kopmada 1, 2, 4, 8, 16, 30 sn ile yeniden bağlanır.
- Müşteri fiyatı: marj fiyata gömülü (hedef 30 bps, tavan 100 bps), komisyon ayrı satır (15 bps). Müşteri rafineri fiyatını görmez.
- Hazine elle de durdurabilir (gerekçe zorunlu) ve başlatabilir. Her durum değişikliği bildirim üretir.
- Emirler (03, 04): müşteri emri → rafineri emri birebir (`client_order_id`), `quote_seq`, slippage limiti, FOK, zaman sınırı. Cevapsız emir: kısa bekleme → durum sorgusu → açıksa iptal (kesin cevap). Geç fill → pozisyon kararı (ters emirle kapat / envanterde taşı).
- KZ kaydı (02): her fill KZ kaydına işlenir ve rafineriden gelen bakiye bilgisiyle karşılaştırılır. Eşit değilse RECONCILE, mint ve kasa çıkışı bloke, açıklama ile çözülür. Kontroller K1 `A ≤ V`, K2 `S + T = K` üst şeritte.
- Rafineri olayları (webhook) `POST /api/events` ile alınır (HMAC doğrulanır, `event_id` ile tekrar ayıklanır).
- Kasa talimatları (05, 06): girişte önce rafinerinin **Kasa Giriş Fişi** gelir, sonra mint yapılır; çıkışta önce **burn**, sonra talep. Bu sıra sayesinde `A ≤ V` hiçbir an bozulmaz. Mint uyuşmazlıkta (RECONCILE) ve kasaya koyma vadesi geçtiğinde (T+3) bloke olur; bloke kalkınca bekleyen mint'ler işlenir.
- Büyük alış (07): teslim sonrası stok tabanın altına inecekse fiyat fill'de kilitlenir, eksik kadar kasa girişi istenir ve mint tamamlanınca **tek seferde** teslim edilir. Büyük satış (08): stok tavanı aşılırsa fazla burn edilir ve kasa çıkışı istenir.
- Elle yapılan her aksiyon kalıcı denetim günlüğüne yazılır (kim, ne zaman, ne; öncesi ve sonrasıyla). Kritik aksiyonlar (parametre değişikliği, ödeme talimatı, uyuşmazlık düzeltmesi) tek kişiyle geçmez: isteyen açar, **farklı** bir kullanıcı onaylar, onay bir kez kullanılır. Kural sunucudadır, ekranda değil.
- Hazine alım satımı (09): maker-checker, onay matrisi gram bazında (≤5 kg 1, ≤15 kg 2, üstü 3); son onaycı canlı fiyatla gönderir. Envanter hedefi `K` yalnız burada değişir.

## Yapı

```
packages/contract   @kz/contract   amr-app'ten kopyalanan sözleşme (elle düzenlenmez, npm run contract:sync)
apps/kz-server      @kz/server     Fastify: soket istemcisi, fiyatlama, durum, bildirimler, SSE, statik web
apps/kz-web         @kz/web        React 19 + Vite, hazine ekranları K1..K9
scripts/contract-sync.sh           sözleşmeyi ../amr-app'ten kopyalar
scripts/demo.mjs                   S0..S9 senaryoları (npm run demo)
docs/                              KZ_AMR_Akislar, KZ_AMR_Sistemi (md + html), DEMO, KULLANIM_KILAVUZU, TEST_RAPORU, KARARLAR, ekranlar/
```

## Çalıştırma

Gereksinim: Node 22.12 veya üstü. Önce `amr-app` çalışıyor olmalı (fiyat oradan gelir).

```bash
npm install
npm run dev          # kz-server (5000) + kz-web (5001, Vite)
```

Tarayıcı: `http://localhost:5001` (geliştirme) ya da `npm run build && npm start` sonrası `http://localhost:5000`.

Test: `npm test`. Sözleşme güncelle: `npm run contract:sync` (amr-app yan klasörde `../amr-app` olmalı, başka yol için `scripts/contract-sync.sh <yol>`).

## Tek komutla çalıştırma (Docker)

İki repo yan yana dururken:

```bash
cd kz-treasury && docker compose up --build
```

Mock merkez, AMR uygulaması ve Kanzasset hazine çekirdeği birlikte kalkar. Kanzasset ekranları `http://localhost:5000`, rafineri ekranları `http://localhost:4000`. Açılış devirleri iki tarafta da 20 kg'dır (`VAULT_OPENING_MG` ve `KZ_OPENING_MG` eşit olmalı).

Senaryoları koşturmak için (servisler ayaktayken): `npm run demo`.

Docker olmadan, sunum için üç komut: `docs/DEMO.md` → "Sabah başlatma".

## Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `5000` | API + statik web |
| `AMR_WS_URL` | `ws://localhost:4000/v1/prices` | rafineri fiyat soketi |
| `AMR_HTTP_URL` | ws adresinden türetilir (`http://localhost:4000`) | rafineri REST tabanı |
| `KZ_API_KEY` / `KZ_API_SECRET` | `kz-dev-key` / `kz-dev-secret` | rafinerinin verdiği kimlik |
| `KZ_DATA_DIR` | `apps/kz-server/data` | kalıcı durum (KZ kaydı, emirler, bildirimler, olaylar; JSON) |
| `KZ_OPENING_MG` | `0` | açılış devri: kasada duran gram (demo `20000000`; AMR `VAULT_OPENING_MG` ile aynı) |
| `AMR_DOC_KEY` | boş | rafinerinin belge imza anahtarı (`doc.sign_key`); verilirse K9 Belgeler'de imza da doğrulanır, verilmezse yalnız sha256 özeti |
| `KZ_DEMO` | `1` | `0` ise demo ucu (`/api/debug/record-skew`) kapanır |
| `LOG_LEVEL` | `info` | |

## Sağlık ve izleme

`GET /health`: alt sistemler ayrı ayrı (kalıcı durum dosyası, rafineri fiyat soketi, müşteri işlemleri, KZ kaydının eşleşmesi, K1 ve K2 kontrolleri, kasa talimatı blokeleri, emirler, rafineri olayları, açık mahsuplaşma penceresi). Her kontrolde `ok`, `degraded` ya da `down` ve tek cümlelik açıklama vardır. HTTP 503 yalnız `down` durumunda döner: kalıcı durum yazılamıyorsa ya da bir kontrol (K1 `A ≤ V`, K2 `S + T = K`) bozuksa. Soket kopukluğu `degraded` sayılır.

## API dokümanı

`http://localhost:5000/docs`: hazine panel API'si (`/api`) tek sayfalık görüntüleyicide. Ham belge `GET /kz-api.json`, üretimi `npm run kzapi:export` (çalışan sunucunun yol tablosundan; açıklaması olmayan uç kalırsa betik hata verir). Rafineri sözleşmesi rafinerinin kendi sayfasındadır: `http://localhost:4000/docs`, üst şeritten bağlantı verilir. Görüntüleyici sözleşme paketindedir, iki repoda tek kopyadır ve dışarıdan dosya çekmez.

## İstek günlüğü (VARA kanıtı)

İki yön de yazılır: rafineriye giden her REST çağrısı (emir, hesap, kasa talimatı, mahsuplaşma) ve gelen her olay ile paneldeki her değiştirici istek. Her satırda zaman, uç, sonuç, süre, aktör ve **gövdenin sha256 özeti** vardır; gövdenin kendisi saklanmaz. Giden çağrının özeti rafineri tarafındaki gelen kaydın özetiyle birebir aynıdır: iki günlük birbirini doğrular.

Okuma: K10 Kayıtlar ekranı (beş kaynak, metin ve tarih süzgeci, sayfa geçişi) ya da `GET /api/logs?source=&q=&from=&to=&limit=&offset=`. Kısa liste K9'da da durur (`GET /api/requests`). Saklama süresi ve satır tavanı `PUT /api/log-params` ile değişir ve ikinci onay ister (kanıt süresini kısaltmak kritik aksiyondur).

## Panel API'si

`GET /api/refinery/status` · `GET /api/refinery/ticks?limit=50` · `POST /api/trading/stop {reason}` · `POST /api/trading/start` · `GET /api/notifications` · `POST /api/notifications/:id/read` · `PUT /api/pricing {marginBps, marginCapBps, commissionBps}` · `PUT /api/order-params {slippageBps, timeLimitMs, unansweredGraceMs, minOrderUsdCents}` · SSE `GET /api/stream` · `GET /health`.

Emirler: `GET /api/orders` · `POST /api/orders {side, qty_mg, ccy}` (müşteri emri; demo kutusu) · `GET /api/orders/:id` · `POST /api/orders/:id/decision {decision: CLOSE | CARRY}` · `POST /api/orders/:id/resolve`.
KZ kaydı: `GET /api/record` · `POST /api/record/snapshot` · `POST /api/record/resolve {explanation}` · `GET /api/record/statement` · `GET /api/documents/:id`.
Olaylar: `POST /api/events` (rafineri çağırır, HMAC) · `GET /api/events`.
Kasa hesabı (K4): `GET /api/vault` · `GET /api/vault/:ref` · `POST /api/vault {type, qty_mg, reason}` (elle, gerekçeli) · `POST /api/vault/:ref/retry` (tavan yüzünden duran talep) · `POST /api/vault/flush-mints` · `GET /api/vault/statement` (rafinerinin günlük kasa ekstresi).
Mahsuplaşma (K8): `GET /api/settlements` · `POST /api/settlements` · `POST /api/settlements/:id/reconcile|gold-leg|pay`.
Teslimat ve rafinasyon (K6, K7): `GET /api/fulfilment` · `GET /api/catalog` · `POST /api/deliveries` · `POST /api/deliveries/:id/approve|cancel` · `POST /api/refining` · `POST /api/refining/:id/approve|cancel` · `PUT /api/fulfilment-params {burnMoment}`.
Denetim günlüğü ve ikinci onay (K9): `GET /api/audit?limit=` · `GET /api/approvals` · `POST /api/approvals/:id/approve {approver}` · `POST /api/approvals/:id/reject`. Kritik uçlar (`PUT /api/pricing`, `PUT /api/order-params`, `PUT /api/stock-params`, `PUT /api/fulfilment-params`, `POST /api/settlements/:id/pay`, `POST /api/record/resolve`) onaysız gelince `202` ve onay numarası döner; değişiklik ancak `{approval_id, approver}` ile ve **farklı** bir kullanıcıyla uygulanır. Aktör `X-User` başlığından okunur.
Hazine alım satımı (K5): `GET /api/treasury` · `POST /api/treasury {side, qty_mg, ccy, maker}` · `POST /api/treasury/:id/approve {approver}` · `POST /api/treasury/:id/cancel` · `GET /api/treasury-approvals?qty_mg=` · `PUT /api/stock-params`.

## Sprint planı

| Sprint | Kapsam | Ekranlar |
|---|---|---|
| 1 ✓ | soket istemcisi, bayatlık ve yeniden bağlanma, müşteri fiyatı, işlemleri durdur / başlat, bildirimler | K1 |
| 2 ✓ | emirler (stoktan alış / satış), bakiye bilgisi ↔ KZ kaydı eşleşmesi, RECONCILE çözümü, cevapsız emir ve geç fill kararı, olay alımı | K2, K3 |
| 3 ✓ | kasa talimatları + fişler + mint / burn eşlemesi, büyük alış / satış, hazine alım satımı (maker-checker) | K4, K5 |
| 4 ✓ | fiziksel teslimat (emanet, burn anı), rafinasyon (katalog, teklif, onay) | K6, K7 |
| 5 ✓ | mahsuplaşma (mutabakat, altın ve para bacağı), parametreler ve ikinci onay | K8, K9 |
| 6 ✓ | demo senaryoları S0..S9 (KZ simülatörü), sunum senaryosu, kullanım kılavuzu, Docker, test raporu | |
| + | görsel dil (açılır kapanır yan menü, açık / koyu mod, responsive), kayıtlar ekranı, sağlık ve istek günlüğü | K10 |
