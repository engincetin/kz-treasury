# kz-treasury · çalışma kuralları

Bu repo Kanzasset (KZ) tarafındaki hazine çekirdeğidir. Rafineri tarafı `amr-app` reposundadır. Kurallar iki repoda aynıdır; burada Kanzasset'e özgü olanlar eklidir.

## Kaynak dokümanlar (önce bunlara bak)

- `docs/KZ_AMR_Akislar.md`: rafineri ile Kanzasset arasındaki akışlar ve rakamlı örnekler.
- `docs/KZ_AMR_Sistemi.md`: ekranlar (K1..K9 bu repo, R1..R10 amr-app), API, soket protokolü, veri modeli, kontroller, sprint planı.
- `docs/KARARLAR.md`: tasarımda karşılığı olmayan kararlar. Tasarımda olmayan bir karar verince buraya tek satır yazılır.
- `docs/DEMO.md` (sunum), `docs/KULLANIM_KILAVUZU.md` (personel), `docs/TEST_RAPORU.md` (kapsam ve bilinen eksikler).
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

## Kasa talimatları (vault.ts) ve hazine alım satımı (treasury.ts)

- Sıra kuraldır, tersi K1'i bozar: **girişte fiş önce mint sonra**, **çıkışta burn önce talep sonra**. `requestOut` burn'ü kendi içinde yapar.
- Mint yalnız Kasa Giriş Fişi'ne karşıdır. `mintBlock()` iki sebeple bloke eder: RECONCILE ve T+3 gecikmesi. Bloke sırasında fiş "mint bekliyor" durur; bloke kalkınca `flushMints()` işler. Bloke, büyük alışın teslimini de bekletir (kısmi teslim yok).
- Tavan `committedPlacingMg()` ile bakılır: rafinerideki `kasaya konuluyor` + yoldaki (REQUESTED) talepler. Aşılacaksa talep `HOLD` olur, alım devam eder, gramlar T'de birikir.
- `applyFill(..., { deliver: false })`: müşteriye teslim olmayan fill'ler (büyük alışta mint öncesi, geç fill, hazine emri). Teslim `applyDelivery` ile ayrı adımdır.
- Envanter hedefi `K` yalnız hazine alım satımında ve fill anında değişir (`shiftTarget`); zincirin başında ve sonunda `S + T = K` tutar, arada geçiş vardır.
- Maker-checker: maker kendi talebini onaylayamaz, aynı onaycı iki kez onaylayamaz, **son onaycı canlı fiyatla gönderir** (talep anındaki fiyat yalnız bilgidir).

## Teslimat ve rafinasyon (fulfilment.ts)

- Talep anında tokenler emanete alınır (`E +x`), arz değişmez; teslimde `burnEscrow` ile yakılır (`A −x`, `E −x`), hazine stoku `S` etkilenmez, böylece K2 korunur.
- Burn anı parametredir: `DELIVERED` (varsayılan) ya da `SHIPPED`.
- Teslimatta Kanzasset marj ve komisyon almaz, lojistik masrafı müşteriden aynen alınır; rafinasyonda müşteri fiyatı marj ve komisyon dahildir, rafineriye yalnız bedel ödenir.
- Katalog rafineriden çekilir, `catalog.updated` olayında kendiliğinden yenilenir.

## Mahsuplaşma (settlement.ts)

- Rafineri pencereyi açtığında (`settlement.opened`) mutabakat kendiliğinden çalışır: rafineri ekstresi KZ kaydıyla karşılaştırılır.
- Eşitse rafinerinin ekstre özeti onaylanır (RECONCILED); farklıysa kendi toplamlarımız gönderilir ve pencere MISMATCH olur.
- Altın bacağı kasa talimatları masasına devredilir (`SETTLEMENT` tetikli); kabul edilince `markGoldLegDone` çağrılır.
- Para bacağında borçluysak ödeme YALNIZ şirket banka hesabından yapılır (K5); alacaklıysak ödeme alındı deriz. Ödeme cari hesabın para tarafını kapatır.

## Sprint durumu

Sprint 1'den 6'ya tamam: soket istemcisi, fiyatlama, durdur / başlat, bildirimler, SSE, REST istemcisi (HMAC), emir masası, KZ kaydı ve eşleşme, olay alımı, kasa talimatları ve mint / burn eşlemesi, büyük alış / satış, hazine alım satımı, fiziksel teslimat ve rafinasyon, mahsuplaşma, parametreler; ekranlar K1'den K9'a hepsi. Teslim paketi hazır: `npm run demo` ile S0..S9 senaryoları, sunum senaryosu, kullanım kılavuzu, Docker ve test raporu. Plan `README.md` sonunda.
