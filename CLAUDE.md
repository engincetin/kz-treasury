# kz-treasury · çalışma kuralları

Bu repo Kanzasset (KZ) tarafındaki hazine çekirdeğidir. Rafineri tarafı `amr-app` reposundadır. Kurallar iki repoda aynıdır; burada Kanzasset'e özgü olanlar eklidir.

## Kaynak dokümanlar (önce bunlara bak)

- `docs/KZ_AMR_Akislar.md`: rafineri ile Kanzasset arasındaki akışlar ve rakamlı örnekler.
- `docs/KZ_AMR_Sistemi.md`: ekranlar (K1..K9 bu repo, R1..R10 amr-app), API, soket protokolü, veri modeli, kontroller, sprint planı.
- Akışlar ile kod çelişirse akışlar kazanır; önce dokümanı düzelt, sonra kodu.

## Değişmez kurallar

- Sözleşme `amr-app/packages/contract` içindedir. Buradaki `packages/contract` kopyadır: **elle düzenlenmez**, `npm run contract:sync` ile alınır.
- Tüm miktarlar **tam sayı**: gram mg, para cent. Fiyatlar ondalık string. Müşteri fiyatı `pricing.ts` içinde hesaplanır: alış `ceil(ask × (1 + marj))`, satış `floor(bid × (1 − marj))`, marj tavanı aşılmaz, komisyon ayrı satır.
- Müşteri işlemleri şu üç durumda kendiliğinden durur: soket kopuk, fiyat bayat (10 sn), rafineri yayını durdu (`tradable=false`). Elle durdurma bunlardan bağımsızdır ve gerekçe ister. Elle durdurulmuşsa otomatik açılmaz.
- Mint yalnız **Kasa Giriş Fişi**'ne karşı; burn kasa çıkışı talebinden **önce**. Mint / burn Kanzasset işidir, rafineriye görünmez; rafineriye giden taleplerde bu kelimeler geçmez.
- Rafineriye ödeme yalnız **şirket banka hesabından** (K5). Cari hesap limiti ve mahsuplaşma kesim saati parametredir (K9).
- Bakiye bilgisi (rafineriden gelen) ile **KZ kaydı** karşılaştırılır: EŞİT ya da RECONCILE. Fark varsa işlem durur, insan çözer.
- Terimler: "mahsuplaşma", "mutabakat", "KZ kaydı", "Eşleşme kuralı", "stoktan alış / satış", "büyük alış / satış". "Ayna", "maksuplaşma" kullanılmaz.
- Metinlerde uzun tire (— –) kullanılmaz; iki nokta, virgül ya da ayrı cümle.

## Teknik

- Node 22.12+, TypeScript `tsx` ile, Fastify 5, `ws`, React 19 + Vite 6, SSE ile canlı ekran. `NODE_OPTIONS=--no-warnings`.
- Portlar: server 5000, web dev 5001. Rafineri tarafı 4000 (soket `/v1/prices`), mock merkez 4100 / 4110.
- Test: `npm test`. Fiyatlama ve eşleşme kuralları için önce test.
- Statik web `apps/kz-web/dist` içinden `@fastify/static` ile (wildcard açık, SPA fallback `index.html`).

## Emir masası (orders.ts) ve KZ kaydı (record.ts)

- `OrderDesk.place`: fiyat → müşteri fiyatı (marj gömülü) ve komisyon → rafineriye FOK emir (`quote_seq`, `limit_px`, `time_limit_ms`) → cevap. Banka ve BitGo bacakları demoda zaman çizelgesi metnidir; rafineri bacağı gerçektir.
- Cevapsız: `AmrTimeout` → `unansweredGraceMs` bekle → `GET /v1/orders/{id}` → açıksa `cancel` (kesin cevap). Geç fill: rafineri bacağı bağlayıcı, müşteriye teslim yok, `decide(CLOSE | CARRY)`.
- `record.ts`: `applyFill` (T, P, S) → `compare(account)`: fark yoksa EŞİT ve seq alınır; varsa RECONCILE ve `blocked = {mint, vault_out}`. `resolveWithSnapshot` düzeltme kaydı tutar. Kontroller `checks()`.
- Durum `KZ_DATA_DIR/kz-state.json` içinde (JsonStore); yeniden başlatmada emirler ve KZ kaydı kalır.

## Sprint durumu

Sprint 1 ve 2 tamam: soket istemcisi, fiyatlama, durdur / başlat, bildirimler, SSE, REST istemcisi (HMAC), emir masası, KZ kaydı ve eşleşme, olay alımı; ekranlar K1, K2, K3. Sonraki: Sprint 3 (K4 kasa talimatları + fişler + mint / burn eşlemesi, K5 hazine alım satımı). Plan `README.md` sonunda.
