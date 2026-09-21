# kz-treasury

Kanzasset (KZ) tarafında çalışan hazine çekirdeği: rafinerinin (AMR uygulaması) fiyat soketine bağlanır, müşteri fiyatını hesaplar, müşteri işlemlerini açar / durdurur, rafineri hesaplarının Kanzasset kaydını tutar ve hazine ekranlarını sunar. Rafineri tarafı ayrı repodadır: `amr-app`.

İş kuralları ve akışlar: `docs/KZ_AMR_Akislar.html` · sistem tasarımı: `docs/KZ_AMR_Sistemi.html`.

## Ne yapar

- `ws://<amr>/v1/prices` soketine API anahtarı + HMAC ile bağlanır; `snapshot`, `tick`, `heartbeat`, `halt`, `resume` işler.
- Kurallar: 10 sn mesaj yoksa fiyat bayat → müşteri işlemleri durur · rafineri `halt` gönderdiyse durur · soket kopuksa durur · `seq` boşluğunda yeniden abone olur · kopmada 1, 2, 4, 8, 16, 30 sn ile yeniden bağlanır.
- Müşteri fiyatı: marj fiyata gömülü (hedef 30 bps, tavan 100 bps), komisyon ayrı satır (15 bps). Müşteri rafineri fiyatını görmez.
- Hazine elle de durdurabilir (gerekçe zorunlu) ve başlatabilir. Her durum değişikliği bildirim üretir.

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
| `KZ_API_KEY` / `KZ_API_SECRET` | `kz-dev-key` / `kz-dev-secret` | rafinerinin verdiği kimlik |
| `LOG_LEVEL` | `info` | |

## Panel API'si

`GET /api/refinery/status` · `GET /api/refinery/ticks?limit=50` · `POST /api/trading/stop {reason}` · `POST /api/trading/start` · `GET /api/notifications` · `POST /api/notifications/:id/read` · `PUT /api/pricing {marginBps, marginCapBps, commissionBps}` · SSE `GET /api/stream` · `GET /health`.

## Sprint planı

| Sprint | Kapsam | Ekranlar |
|---|---|---|
| 1 ✓ | soket istemcisi, bayatlık ve yeniden bağlanma, müşteri fiyatı, işlemleri durdur / başlat, bildirimler | K1 |
| 2 | emirler (stoktan alış / satış), bakiye bilgisi ↔ KZ kaydı eşleşmesi, cari hesap, cevapsız emir durumu | K2, K3 |
| 3 | kasa talimatları + fişler, büyük alış / satış, hazine alım satımı (maker-checker) | K4, K5 |
| 4 | fiziksel teslimat, rafinasyon (katalog, teklif, onay) | K6, K7 |
| 5 | mahsuplaşma (kesim saati otomatik, talep iki yönlü), parametreler | K8, K9 |
| 6 | demo senaryoları S0..S9 (KZ simülatörü), kullanım kılavuzu, teslim paketi | |
