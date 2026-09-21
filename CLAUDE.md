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

## Sprint durumu

Sprint 1 tamam: soket istemcisi (auth, snapshot, tick, heartbeat, halt / resume, seq boşluğu, bayatlık, yeniden bağlanma), fiyatlama, durdur / başlat, bildirimler, SSE, K1 ekranı. Sonraki: Sprint 2 (K2 rafineri hesapları, K3 emir günlüğü). Plan `README.md` sonunda.
