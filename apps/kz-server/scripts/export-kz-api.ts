/**
 * Panel API'si belgesi (kz-api.json).
 *
 * Uçlar elle listelenmez: sunucu yol tablosunu yazıp çıkacak biçimde çalıştırılır
 * (KZ_ROUTES_DUMP), sonra her yola buradaki açıklama eşlenir. Açıklaması olmayan uç kalırsa
 * betik hata verir; belge ile kod arasındaki fark büyümeden görünür.
 *
 * Çalıştırma: npm run kzapi:export  ·  çıktı: repo kökünde kz-api.json
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { CONTRACT_VERSION } from "@amr/contract";

interface Op { summary: string; description?: string; params?: { name: string; in: string; description?: string }[]; body?: Record<string, string>; returns?: string; approval?: boolean }

/** Her uç için tek cümlelik açıklama. Anahtar: "YÖNTEM /yol". */
const OPS: Record<string, Op> = {
  "GET /health": { summary: "Sağlık durumu: alt sistemler ayrı ayrı", description: "kalıcı durum, rafineri soketi, müşteri işlemleri, KZ kaydı, K1 ve K2 kontrolleri, kasa blokeleri, emirler, olaylar. HTTP 503 yalnız iş göremez durumda (kayıt yazılamıyor ya da kontrol bozuk).", returns: "{ status, uptime_s, checks }" },
  "GET /docs": { summary: "API dokümanı (tek sayfalık görüntüleyici)" },
  "GET /kz-api.json": { summary: "Bu belge" },

  "GET /api/refinery/status": { summary: "K1 bütün durum: soket, müşteri işlemleri, fiyatlar, KZ kaydı, kontroller, kasa, hazine, teslimat, mahsuplaşma", returns: "ekranların tek seferde okuduğu durum nesnesi" },
  "GET /api/refinery/ticks": { summary: "K1 tick geçmişi", params: [{ name: "limit", in: "query" }] },
  "GET /api/stream": { summary: "Canlı akış (SSE): tick, bildirim, durum değişikliği" },
  "POST /api/trading/stop": { summary: "K1 müşteri işlemlerini elle durdur", description: "gerekçe zorunludur; elle durdurulmuşsa otomatik açılmaz.", body: { reason: "durdurma gerekçesi" } },
  "POST /api/trading/start": { summary: "K1 müşteri işlemlerini elle başlat" },
  "GET /api/notifications": { summary: "Bildirimler" },
  "POST /api/notifications/:id/read": { summary: "Bildirimi okundu işaretle" },

  "GET /api/orders": { summary: "K3 emir günlüğü, cevapsız emirler ve geç fill'ler", params: [{ name: "limit", in: "query" }] },
  "GET /api/orders/:id": { summary: "K3 emir ayrıntısı ve zaman çizelgesi" },
  "POST /api/orders": { summary: "K3 müşteri emri (demo kutusu)", description: "müşteri fiyatı hesaplanır, rafineriye FOK emir gider, fill KZ kaydına işlenir. Stok tabanının altına inen alış büyük alış, tavanı aşan satış büyük satıştır.", body: { side: "BUY ya da SELL", qty_mg: "gram (mg)", ccy: "USD, EUR, AED", customer_ref: "müşteri referansı" } },
  "POST /api/orders/:id/decision": { summary: "K3 geç fill kararı", description: "CLOSE ters emirle kapatır, CARRY envanterde taşır.", body: { decision: "CLOSE ya da CARRY" } },
  "POST /api/orders/:id/resolve": { summary: "K3 cevapsız emri kesin cevaba bağla (durum sorgusu, gerekirse iptal)" },

  "GET /api/record": { summary: "K2 KZ kaydı ve kontroller (K1, K2)" },
  "POST /api/record/snapshot": { summary: "K2 rafineriden anlık fotoğraf al ve karşılaştır", returns: "{ account, match, diffs, seqGap }" },
  "POST /api/record/resolve": { summary: "K2 uyuşmazlığı (RECONCILE) açıklamayla çöz", description: "rafineri fotoğrafı esas alınır, düzeltme kaydı tutulur, mint blokesi kalkar.", body: { explanation: "fark açıklaması" }, approval: true },
  "GET /api/record/statement": { summary: "K2 rafinerinin cari hesap ekstresi", params: [{ name: "from", in: "query" }, { name: "to", in: "query" }] },
  "GET /api/documents": { summary: "K9 belgelerin Kanzasset kopyası (künye listesi)", description: "rafineri belgeleri olayla gelen numaradan çekilir, sha256 özeti yeniden hesaplanır (hash_ok), anahtar verilmişse imza doğrulanır (signature_ok) ve saklanır.", returns: "{ count, signature_checked, items[] }" },
  "GET /api/documents/:id": { summary: "K9 belgeyi kendi kaydımızdan getir (yoksa rafineriden çekip saklar)", returns: "{ meta (hash_ok, signature_ok, source dahil), content }" },
  "GET /api/documents/:id/pdf": { summary: "K9 belgenin PDF'i (rafineriden imzalı istekle çekilir, aynen aktarılır)" },
  "POST /api/documents/sync": { summary: "K9 geriye dönük eşitleme: emir, kasa, teslimat, rafinasyon ve mahsuplaşma kayıtlarındaki belge numaralarını tara, eksikleri çek", returns: "{ fetched, failed[], count }" },
  "POST /api/debug/record-skew": { summary: "Demo: KZ kaydını bilerek kaydırır (S9b uyuşmazlık senaryosu)", description: "KZ_DEMO=0 ile kapanır.", body: { gold_mg: "altın kaydırma (mg)", usd_cents: "USD kaydırma (cent)" } },

  "GET /api/events": { summary: "Rafineriden alınan olaylar" },
  "POST /api/events": { summary: "Rafineri olay ucu (webhook)", description: "rafineri çağırır; HMAC doğrulanır, event_id ile tekrar ayıklanır." },

  "GET /api/vault": { summary: "K4 kasa talimatları, tavan sayaçları ve blokeler", params: [{ name: "limit", in: "query" }] },
  "GET /api/vault/:ref": { summary: "K4 talimat ayrıntısı (Kanzasset referansıyla)" },
  "POST /api/vault": { summary: "K4 elle kasa talimatı (gerekçeli)", description: "girişte fiş önce mint sonra, çıkışta burn önce talep sonra: bu sıra A ≤ V kontrolünü korur.", body: { type: "IN ya da OUT", qty_mg: "gram (mg)", reason: "gerekçe" } },
  "POST /api/vault/:ref/retry": { summary: "K4 tavan yüzünden duran (HOLD) talebi yeniden dene" },
  "POST /api/vault/flush-mints": { summary: "K4 bloke kalkınca bekleyen mint'leri işle" },
  "GET /api/vault/statement": { summary: "K4 rafinerinin günlük kasa ekstresi (rezerv kanıtı)", params: [{ name: "date", in: "query" }] },

  "GET /api/treasury": { summary: "K5 hazine alım satım talepleri ve stok parametreleri" },
  "GET /api/treasury/:id": { summary: "K5 talep ayrıntısı" },
  "POST /api/treasury": { summary: "K5 hazine emri talebi (maker)", description: "envanter hedefi K yalnız bu akışta değişir.", body: { side: "BUY ya da SELL", qty_mg: "gram (mg)", ccy: "kur", maker: "talebi açan" } },
  "POST /api/treasury/:id/approve": { summary: "K5 onay (checker)", description: "maker kendi talebini onaylayamaz, aynı onaycı iki kez onaylayamaz, son onaycı canlı fiyatla gönderir.", body: { approver: "onaylayan" } },
  "POST /api/treasury/:id/cancel": { summary: "K5 talebi iptal et", body: { actor: "iptal eden" } },
  "GET /api/treasury-approvals": { summary: "K5 onay matrisi önizlemesi: girilen gram kaç onay ister", params: [{ name: "qty_mg", in: "query" }] },

  "GET /api/fulfilment": { summary: "K6, K7 teslimat ve rafinasyon listesi, emanet ve burn anı" },
  "GET /api/catalog": { summary: "K7 külçe kataloğunu rafineriden tazele" },
  "POST /api/deliveries": { summary: "K6 fiziksel teslimat talebi", description: "talep anında tokenler emanete alınır (E +x), arz değişmez.", body: { qty_mg: "gram (mg)", address_ref: "adres referansı", insured_party_ref: "sigorta lehtarı", customer_ref: "müşteri referansı" } },
  "POST /api/deliveries/:id/approve": { summary: "K6 lojistik teklifini onayla (müşteri onayından sonra)" },
  "POST /api/deliveries/:id/cancel": { summary: "K6 teslimatı iptal et (emanet çözülür)", body: { reason: "gerekçe" } },
  "POST /api/refining": { summary: "K7 rafinasyon talebi (katalog kalemleriyle)", body: { items: "kalem listesi", address_ref: "adres referansı", insured_party_ref: "sigorta lehtarı", customer_ref: "müşteri referansı" } },
  "POST /api/refining/:id/approve": { summary: "K7 rafinasyon teklifini onayla" },
  "POST /api/refining/:id/cancel": { summary: "K7 rafinasyonu iptal et (yalnız üretime kadar)", body: { reason: "gerekçe" } },
  "PUT /api/fulfilment-params": { summary: "K6 burn anı parametresi", description: "DELIVERED (varsayılan) ya da SHIPPED.", body: { burnMoment: "DELIVERED ya da SHIPPED" }, approval: true },

  "GET /api/settlements": { summary: "K8 mahsuplaşma pencereleri" },
  "POST /api/settlements": { summary: "K8 pencere talebi (kapsam seçilebilir)", body: { trigger: "REQUEST_KZ", scope: ["GOLD", "USD"], reason: "gerekçe" } },
  "POST /api/settlements/:id/reconcile": { summary: "K8 mutabakat: rafineri ekstresini KZ kaydıyla karşılaştır", description: "eşitse ekstre onaylanır (RECONCILED), farklıysa kendi toplamlarımız gönderilir (MISMATCH)." },
  "POST /api/settlements/:id/gold/approve": { summary: "K8 rafinerinin altın teklifini onayla", description: "rafineri bize gram borçluyken kasaya konmasını onaylar; onaydan sonra kasa girişi talebi gider, fiş gelince mint olur." },
  "POST /api/settlements/:id/gold-leg": { summary: "K8 altın bacağını kasa talimatları masasına devret" },
  "POST /api/settlements/:id/pay": { summary: "K8 para bacağı: öde ya da ödeme alındı", description: "borçluysak ödeme YALNIZ şirket banka hesabından yapılır (K5).", body: { ccy: "kur" }, approval: true },

  "GET /api/audit": { summary: "K9 denetim günlüğü (kalıcı)", params: [{ name: "limit", in: "query" }], returns: "{ items, second_approval }" },
  "GET /api/approvals": { summary: "K9 ikinci onay bekleyenler ve karara bağlananlar" },
  "POST /api/approvals/:id/approve": { summary: "K9 onayla", description: "isteyen kendi isteğini onaylayamaz, onay bir kez kullanılır.", body: { approver: "onaylayan" } },
  "POST /api/approvals/:id/reject": { summary: "K9 onay isteğini reddet" },
  "GET /api/logs": {
    summary: "K10 kayıtlar: beş kaynak tek biçimde, süzgeçli ve sayfalı",
    description: "Kaynaklar: requests (istek günlüğü), audit (denetim günlüğü), events (rafineri olayları), notifications (bildirimler), ticks (fiyat tick'leri). Satırlar zaman · kim · ne · sonuç olarak döner.",
    params: [{ name: "source", in: "query", description: "requests | audit | events | notifications | ticks" }, { name: "q", in: "query", description: "metin süzgeci" }, { name: "from", in: "query", description: "YYYY-AA-GG" }, { name: "to", in: "query", description: "YYYY-AA-GG" }, { name: "limit", in: "query" }, { name: "offset", in: "query" }],
    returns: "{ items, total, source }",
  },
  "GET /api/requests": { summary: "K9 istek günlüğü (VARA kanıtı)", description: "rafineriye giden ve gelen çağrılar; gövdenin kendisi değil sha256 özeti saklanır.", params: [{ name: "limit", in: "query" }, { name: "direction", in: "query", description: "GİDEN ya da GELEN" }, { name: "errors", in: "query", description: "1 ise yalnız hatalar" }] },
  "PUT /api/log-params": { summary: "K9 istek günlüğü saklama parametreleri", body: { retentionDays: "saklama süresi (gün)", maxRows: "satır tavanı" }, approval: true },
  "PUT /api/pricing": { summary: "K9 fiyatlama: marj, marj tavanı, komisyon", body: { marginBps: "marj (bps)", marginCapBps: "marj tavanı (bps)", commissionBps: "komisyon (bps)" }, approval: true },
  "PUT /api/order-params": { summary: "K9 emir parametreleri", body: { slippageBps: "slippage toleransı", timeLimitMs: "emir zaman sınırı", unansweredGraceMs: "cevapsız emir beklemesi", minOrderUsdCents: "emir minimumu" }, approval: true },
  "PUT /api/stock-params": { summary: "K9 stok bandı, envanter hedefi, mint politikası, kasaya konuluyor tavanı, onay matrisi", approval: true },
};

const APPROVAL_NOTE = "Kritik aksiyon: onay numarası olmadan gelirse 202 ve onay numarası döner; ancak farklı bir kullanıcının onayıyla uygulanır (gövdeye approval_id ve approver eklenir). Aktör X-User başlığından okunur.";

const toOpenApiPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
const pathParams = (p: string) => [...p.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));

// sunucuyu yalnız yol tablosunu yazması için çalıştırır (dinlemez, rafineriye bağlanmaz)
const dir = mkdtempSync(join(tmpdir(), "kz-routes-"));
const dump = join(dir, "routes.json");
const entry = resolve(import.meta.dirname, "../src/index.ts");
const r = spawnSync("npx", ["tsx", entry], {
  env: { ...process.env, KZ_ROUTES_DUMP: dump, KZ_DATA_DIR: dir, NODE_OPTIONS: "--no-warnings", LOG_LEVEL: "silent" },
  encoding: "utf8",
});
if (r.status !== 0) { console.error("yol tablosu alınamadı:", r.stderr?.slice(-800)); process.exit(1); }
const routes = JSON.parse(readFileSync(dump, "utf8")) as { method: string; url: string }[];
// belgede olan ama yol tablosunda görünmeyen sayfalar (görüntüleyici ve belge)
routes.push({ method: "GET", url: "/docs" }, { method: "GET", url: "/kz-api.json" });

const paths: Record<string, Record<string, unknown>> = {};
const missing: string[] = [];
for (const route of routes) {
  if (route.method === "HEAD" || route.method === "OPTIONS") continue;
  if (route.url === "/*" || route.url === "/") continue; // statik ekranlar
  const key = `${route.method} ${route.url}`;
  const op = OPS[key];
  if (!op) { missing.push(key); continue; }
  const params = [...pathParams(route.url), ...(op.params ?? []).map((p) => ({ schema: { type: "string" }, ...p }))];
  (paths[toOpenApiPath(route.url)] ||= {})[route.method.toLowerCase()] = {
    summary: op.summary,
    description: [op.description, op.approval ? APPROVAL_NOTE : ""].filter(Boolean).join(" ") || undefined,
    ...(params.length ? { parameters: params } : {}),
    ...(op.body ? { requestBody: { content: { "application/json": { schema: { type: "object", properties: Object.fromEntries(Object.entries(op.body).map(([k, v]) => [k, { type: "string", description: v }])) } } } } } : {}),
    responses: {
      "200": { description: op.returns ?? "OK", content: { "application/json": { schema: { type: "object" } } } },
      ...(op.approval ? { "202": { description: "ikinci onay bekleniyor (onay numarası döner)", content: { "application/json": { schema: { type: "object" } } } } } : {}),
    },
  };
}

const extra = Object.keys(OPS).filter((k) => !routes.some((x) => `${x.method} ${x.url}` === k));
if (missing.length) { console.error("Açıklaması olmayan uçlar var, scripts/export-kz-api.ts içine ekleyin:\n  " + missing.join("\n  ")); process.exit(1); }
if (extra.length) console.warn("Uyarı: artık olmayan uçlar açıklamada duruyor:\n  " + extra.join("\n  "));

const doc = {
  openapi: "3.1.0",
  info: {
    title: "Kanzasset paneli API'si",
    version: CONTRACT_VERSION,
    description:
      "Kanzasset hazine ekranlarının (K1..K9) kullandığı iç uçlar. Rafineri bu uçları kullanmaz; rafineri sözleşmesi /v1 altındadır ve rafinerinin openapi.json belgesindedir. " +
      "Aktör X-User başlığıyla gelir: denetim günlüğüne yazılır ve ikinci onayda 'isteyen ile onaylayan aynı olamaz' kuralını besler. " +
      "Miktarlar tam sayı (gram için mg, para için cent), fiyatlar ondalık dizedir. Mint ve burn Kanzasset işidir; rafineriye giden taleplerde bu kelimeler geçmez.",
  },
  paths,
};

const out = resolve(import.meta.dirname, "../../../kz-api.json");
writeFileSync(out, JSON.stringify(doc, null, 2));
console.log(`panel API belgesi yazıldı: ${out} · ${Object.keys(paths).length} yol`);
