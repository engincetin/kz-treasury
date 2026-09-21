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

## Yapı

```
packages/contract   @kz/contract   amr-app'ten kopyalanan sözleşme (elle düzenlenmez, npm run contract:sync)
apps/kz-server      @kz/server     Fastify: soket istemcisi, fiyatlama, durum, bildirimler, SSE, statik web
apps/kz-web         @kz/web        React 19 + Vite, hazine ekranları K1..K9
scripts/contract-sync.sh           sözleşmeyi ../amr-app'ten kopyalar
docs/                              KZ_AMR_Akislar, KZ_AMR_Sistemi (md + html)
```

## Çalıştırma

Gereksinim: Node 22.12 veya üstü. Önce `amr-app` çalışıyor olmalı (fiyat oradan gelir).

```bash
npm install
npm run dev          # kz-server (5000) + kz-web (5001, Vite)
```

Tarayıcı: `http://localhost:5001` (geliştirme) ya da `npm run build && npm start` sonrası `http://localhost:5000`.

Test: `npm test`. Sözleşme güncelle: `npm run contract:sync` (amr-app yan klasörde `../amr-app` olmalı, başka yol için `scripts/contract-sync.sh <yol>`).

## Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `5000` | API + statik web |
| `AMR_WS_URL` | `ws://localhost:4000/v1/prices` | rafineri fiyat soketi |
| `AMR_HTTP_URL` | ws adresinden türetilir (`http://localhost:4000`) | rafineri REST tabanı |
| `KZ_API_KEY` / `KZ_API_SECRET` | `kz-dev-key` / `kz-dev-secret` | rafinerinin verdiği kimlik |
| `KZ_DATA_DIR` | `apps/kz-server/data` | kalıcı durum (KZ kaydı, emirler, bildirimler, olaylar; JSON) |
| `KZ_OPENING_MG` | `0` | açılış devri: kasada duran gram (demo `20000000`; AMR `VAULT_OPENING_MG` ile aynı) |
| `KZ_DEMO` | `1` | `0` ise demo ucu (`/api/debug/record-skew`) kapanır |
| `LOG_LEVEL` | `info` | |

## Panel API'si

`GET /api/refinery/status` · `GET /api/refinery/ticks?limit=50` · `POST /api/trading/stop {reason}` · `POST /api/trading/start` · `GET /api/notifications` · `POST /api/notifications/:id/read` · `PUT /api/pricing {marginBps, marginCapBps, commissionBps}` · `PUT /api/order-params {slippageBps, timeLimitMs, unansweredGraceMs, minOrderUsdCents}` · SSE `GET /api/stream` · `GET /health`.

Emirler: `GET /api/orders` · `POST /api/orders {side, qty_mg, ccy}` (müşteri emri; demo kutusu) · `GET /api/orders/:id` · `POST /api/orders/:id/decision {decision: CLOSE | CARRY}` · `POST /api/orders/:id/resolve`.
KZ kaydı: `GET /api/record` · `POST /api/record/snapshot` · `POST /api/record/resolve {explanation}` · `GET /api/record/statement` · `GET /api/documents/:id`.
Olaylar: `POST /api/events` (rafineri çağırır, HMAC) · `GET /api/events`.

## Sprint planı

| Sprint | Kapsam | Ekranlar |
|---|---|---|
| 1 ✓ | soket istemcisi, bayatlık ve yeniden bağlanma, müşteri fiyatı, işlemleri durdur / başlat, bildirimler | K1 |
| 2 ✓ | emirler (stoktan alış / satış), bakiye bilgisi ↔ KZ kaydı eşleşmesi, RECONCILE çözümü, cevapsız emir ve geç fill kararı, olay alımı | K2, K3 |
| 3 | kasa talimatları + fişler, büyük alış / satış, hazine alım satımı (maker-checker) | K4, K5 |
| 4 | fiziksel teslimat, rafinasyon (katalog, teklif, onay) | K6, K7 |
| 5 | mahsuplaşma (kesim saati otomatik, talep iki yönlü), parametreler | K8, K9 |
| 6 | demo senaryoları S0..S9 (KZ simülatörü), kullanım kılavuzu, teslim paketi | |
