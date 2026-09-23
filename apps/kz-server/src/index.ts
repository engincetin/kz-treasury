/**
 * Kanzasset çekirdeği (demo sunucusu).
 *   PORT=5000                 K ekranları API'si + canlı akış (SSE) + kz-web dist (varsa)
 *   AMR_WS_URL                rafineri fiyat soketi (varsayılan ws://localhost:4000/v1/prices)
 *   AMR_HTTP_URL              rafineri REST tabanı (varsayılan ws adresinden türetilir: http://localhost:4000)
 *   KZ_API_KEY / KZ_API_SECRET  AMR'de tanımlı istemci (varsayılan kz-dev-key / kz-dev-secret)
 *   KZ_DATA_DIR               kalıcı durum (KZ kaydı, emirler, olaylar) · varsayılan apps/kz-server/data
 *   KZ_OPENING_MG             açılış devri: kasada Kanzasset adına duran gram (demo 20 kg = 20000000); AMR'de VAULT_OPENING_MG ile aynı olmalı
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import { PRICE_SOCKET, signingString, type Account, type EventEnvelope, type OrderResponse } from "@amr/contract";
import { PriceClient } from "./priceClient.ts";
import { DEFAULT_PRICING, quote, type PricingParams } from "./pricing.ts";
import { AmrClient } from "./amrClient.ts";
import { JsonStore } from "./store.ts";
import { checks, compare, emptyRecord, resolveWithSnapshot, type KzRecord } from "./record.ts";
import { DEFAULT_ORDER_PARAMS, OrderDesk, type CustomerOrder, type OrderParams } from "./orders.ts";
import { DEFAULT_STOCK_PARAMS, VaultDesk, type StockParams, type VaultInstruction } from "./vault.ts";
import { TreasuryDesk, requiredApprovals, type TreasuryRequest } from "./treasury.ts";
import { DEFAULT_FULFILMENT, FulfilmentDesk, type FulfilmentParams, type KzDelivery, type KzRefining } from "./fulfilment.ts";
import { KzSettlementDesk, type KzSettlement } from "./settlement.ts";
import { healthSnapshot } from "./health.ts";
import { docsRoutes } from "./docs.ts";
import { AuditDesk, ApprovalError, SECOND_APPROVAL, type AuditEntry, type ApprovalRequest } from "./audit.ts";
import { DEFAULT_LOG_PARAMS, RequestLog, shouldLogIncoming, type RequestLogParams, type RequestLogRow } from "./reqlog.ts";
import { queryLogs } from "./logs.ts";
import { DocumentDesk, docIdsIn, type KzDocument } from "./documents.ts";
import type { Catalog } from "@amr/contract";

const PORT = Number(process.env.PORT ?? 5000);
const AMR_WS_URL = process.env.AMR_WS_URL ?? "ws://localhost:4000/v1/prices";
const AMR_HTTP_URL = process.env.AMR_HTTP_URL ?? AMR_WS_URL.replace(/^ws/, "http").replace(/\/v1\/prices$/, "");
const API_KEY = process.env.KZ_API_KEY ?? "kz-dev-key";
const API_SECRET = process.env.KZ_API_SECRET ?? "kz-dev-secret";
const DATA_DIR = process.env.KZ_DATA_DIR ?? resolve(import.meta.dirname, "../data");
const OPENING_MG = Number(process.env.KZ_OPENING_MG ?? 0);
/** Rafinerinin belge imza anahtarı (doc.sign_key). Verilirse belge imzaları da doğrulanır; verilmezse yalnız özet. */
const AMR_DOC_KEY = process.env.AMR_DOC_KEY || null;
/** Belge eşitleme sıklığı (dakika). 0 kapatır; canlı toplama her hâlükârda çalışır. */
const DOC_SYNC_MIN = Number(process.env.KZ_DOC_SYNC_MIN ?? 10);

const bus = new EventEmitter();
bus.setMaxListeners(100);

// ---- kalıcı durum ----
interface Notice { id: number; type: string; title: string; body?: string; ts: string; read: boolean }
interface EventLog { event_id: string; type: string; ts: string; received_ts: string; seq?: number; summary: string }
interface State {
  record: KzRecord; orders: CustomerOrder[]; notices: Notice[]; noticeId: number; events: EventLog[];
  pricing: PricingParams; orderParams: OrderParams; market: { manualStop: boolean; manualReason: string | null };
  vault: VaultInstruction[]; treasury: TreasuryRequest[]; stock: StockParams;
  deliveries: KzDelivery[]; refinings: KzRefining[]; catalog: Catalog | null; fulfilment: FulfilmentParams;
  settlements: KzSettlement[];
  audit: AuditEntry[]; auditId: number; approvals: ApprovalRequest[]; approvalId: number;
  requests: RequestLogRow[]; requestId: number; log: RequestLogParams;
  documents: KzDocument[]; docSyncTs: string | null;
}
const store = new JsonStore<State>(resolve(DATA_DIR, "kz-state.json"), () => ({
  record: emptyRecord(OPENING_MG), orders: [], notices: [], noticeId: 0, events: [], pricing: { ...DEFAULT_PRICING }, orderParams: { ...DEFAULT_ORDER_PARAMS }, market: { manualStop: false, manualReason: null },
  vault: [], treasury: [], stock: { ...DEFAULT_STOCK_PARAMS, targetMg: OPENING_MG || DEFAULT_STOCK_PARAMS.targetMg },
  deliveries: [], refinings: [], catalog: null, fulfilment: { ...DEFAULT_FULFILMENT }, settlements: [],
  audit: [], auditId: 0, approvals: [], approvalId: 0,
  requests: [], requestId: 0, log: { ...DEFAULT_LOG_PARAMS },
  documents: [], docSyncTs: null,
}));
const S = store.data;
const ticks: { seq: number; ts: string; tradable: boolean; prices: unknown }[] = [];

// ---- bağlantılar ----
const client = new PriceClient(AMR_WS_URL, API_KEY, API_SECRET);
const amr = new AmrClient(AMR_HTTP_URL, API_KEY, API_SECRET);

const tradingOpen = () => client.priceOk && !S.market.manualStop;
const tradingReason = () => {
  if (S.market.manualStop) return `elle durduruldu: ${S.market.manualReason ?? ""}`;
  const s = client.state;
  if (s.connection !== "SUBSCRIBED") return "rafineri soketi bağlı değil";
  if (s.stale) return "fiyat bayat (10 sn mesaj yok)";
  if (!s.tradable) return `rafineri yayını durdu${s.haltReason ? `: ${s.haltReason}` : ""}`;
  if (!s.lastPrices) return "fiyat gelmedi";
  return "";
};

const notify = (type: string, title: string, body?: string) => {
  const n: Notice = { id: ++S.noticeId, type, title, body, ts: new Date().toISOString(), read: false };
  S.notices.unshift(n);
  if (S.notices.length > 300) S.notices.pop();
  store.save();
  bus.emit("event", { kind: "notice", ...n });
};
const changed = () => { store.save(); bus.emit("event", { kind: "status", status: status() }); collectDocsSoon(); };

/**
 * Durum değiştikten kısa süre sonra yeni belge numaralarına bakar.
 *
 * Belgelerin çoğu olayla gelir ve orada canlı çekilir; bir kısmı ise isteğin kendi cevabında gelir
 * (emir cevabındaki Tahsis Belgesi gibi). Bu kısa gecikmeli tarama onları da alır, iki tarafın
 * belge sayısı birbirini bekletmez. Düzenli tam eşitleme ayrıca çalışır.
 */
let collectTimer: NodeJS.Timeout | null = null;
function collectDocsSoon() {
  if (collectTimer) return;
  collectTimer = setTimeout(() => {
    collectTimer = null;
    const ids = docIdsIn({ orders: S.orders.slice(0, 10), vault: S.vault.slice(0, 10), deliveries: S.deliveries.slice(0, 10), refinings: S.refinings.slice(0, 10), settlements: S.settlements.slice(0, 3) });
    void documents.sync(ids).catch(() => {});
  }, 1500);
  collectTimer.unref();
}

// İstek günlüğü (VARA kanıtı): rafineriye giden ve rafineriden gelen her çağrı.
const reqLog = new RequestLog(S, () => store.save());
amr.onCall = (c) => reqLog.outgoing(c.method, c.path, c.status, c.durationMs, c.body, c.error);

// Belgeler (K9): rafinerinin ürettiği belgelerin Kanzasset kopyası, özet ve imza doğrulamasıyla.
const documents = new DocumentDesk(S, { amr, docKey: AMR_DOC_KEY, save: () => store.save(), notify });

/**
 * Belge eşitleme: kayıtlarımızdaki bütün belge numaralarını tarar, kopyası olmayanı rafineriden çeker.
 * Olayla gelen belge zaten canlı çekilir; bu tarama olay kaçtığında ya da sunucu kapalıyken geçen
 * belgeleri toparlar. Elle "Belgeleri eşitle" de aynı işi yapar.
 */
async function syncDocuments(): Promise<{ fetched: number; failed: string[] }> {
  // metin de taranır: eski kayıtlarda belge numarası yalnız zaman çizelgesi satırında kalmış olabilir
  const known = docIdsIn({ orders: S.orders, vault: S.vault, deliveries: S.deliveries, refinings: S.refinings, settlements: S.settlements, events: S.events }, { scanText: true });
  const r = await documents.sync(known);
  S.docSyncTs = new Date().toISOString();
  store.save();
  return r;
}

// Denetim günlüğü ve ikinci onay (K11 Ayarlar). Aktör X-User başlığından gelir.
const auditDesk = new AuditDesk(S, { save: () => store.save(), notify });
const actorOf = (req: { headers: Record<string, unknown> }): string => String(req.headers["x-user"] ?? "").trim() || "kanzasset";
/** Elle aksiyonlar günlüğe yazılır; sonra ekranlara haber verilir. */
const logged = <T>(req: { headers: Record<string, unknown> }, action: string, summary: string, result: T, before?: unknown, after?: unknown): T => {
  auditDesk.log(actorOf(req), action, summary, before, after);
  return result;
};

// Kasa talimatları (K4): mint yalnız Kasa Giriş Fişi'ne karşı, burn kasa çıkışından önce.
const vault = new VaultDesk({
  amr,
  record: () => S.record,
  params: () => S.stock,
  notify,
  onChange: () => { S.vault = vault.instructions; changed(); },
  onMinted: (inst) => { desk.deliverPending(inst); treasury.onMinted(inst); if (inst.trigger === "SETTLEMENT" && inst.related_id) void settlement.markGoldLegDone(inst.related_id, inst.ref); },
  onOutAccepted: (inst) => { treasury.onOutAccepted(inst); if (inst.trigger === "SETTLEMENT" && inst.related_id) void settlement.markGoldLegDone(inst.related_id, inst.ref); },
}, S.vault);

const desk = new OrderDesk({
  amr,
  priceState: () => client.state,
  tradingOpen: () => ({ open: tradingOpen(), reason: tradingReason() }),
  pricing: () => S.pricing,
  params: () => S.orderParams,
  record: () => S.record,
  onChange: () => { S.orders = desk.orders; changed(); },
  notify,
  stock: () => S.stock,
  vault: () => vault,
}, S.orders);

// Hazine alım satımı (K12): maker-checker, son onaycı canlı fiyatla gönderir.
const treasury = new TreasuryDesk({
  amr,
  priceState: () => client.state,
  tradingOpen: () => ({ open: tradingOpen(), reason: tradingReason() }),
  record: () => S.record,
  stock: () => S.stock,
  orderParams: () => S.orderParams,
  vault: () => vault,
  notify,
  onChange: () => { S.treasury = treasury.requests; changed(); },
}, S.treasury);

// Fiziksel teslimat ve rafinasyon (K6, K7): emanet, burn anı, müşteri fiyatı.
const fulfilment = new FulfilmentDesk({
  amr,
  record: () => S.record,
  params: () => S.fulfilment,
  pricing: () => S.pricing,
  notify,
  onChange: () => { S.deliveries = fulfilment.deliveries; S.refinings = fulfilment.refinings; S.catalog = fulfilment.catalog; changed(); },
}, { deliveries: S.deliveries, refinings: S.refinings, catalog: S.catalog });

// Mahsuplaşma (K8): pencere, mutabakat, altın ve para bacağı.
const settlement = new KzSettlementDesk({
  amr, record: () => S.record, vault: () => vault, notify,
  onChange: () => { S.settlements = settlement.windows; changed(); },
}, S.settlements);

const status = () => ({
  socket: { ...client.state },
  rest: { url: AMR_HTTP_URL, events_received: S.events.length, last_event_ts: S.events[0]?.received_ts ?? null },
  trading: { open: tradingOpen(), reason: tradingReason(), manualStop: S.market.manualStop, manualReason: S.market.manualReason },
  quotes: client.state.lastPrices?.map((p) => quote(p, S.pricing)) ?? [],
  pricing: S.pricing,
  orderParams: S.orderParams,
  unread: S.notices.filter((n) => !n.read).length,
  record: S.record,
  checks: checks(S.record),
  unanswered: desk.unanswered().length,
  lateFills: desk.lateFills().length,
  stock: S.stock,
  vault: {
    placing_mg: vault.placingMg(),
    in_flight_mg: vault.inFlightMg(),
    committed_placing_mg: vault.committedPlacingMg(),
    placing_cap_mg: S.stock.placingCapMg,
    awaiting_mint: vault.awaitingMint().length,
    holds: vault.holds().length,
    mint_block: vault.mintBlock(),
    vault_out_block: vault.vaultOutBlock(),
    open: vault.instructions.filter((i) => i.status === "REQUESTED" || i.status === "HOLD" || i.status === "ACCEPTED" || i.status === "PLACING" || i.status === "OVERDUE").length,
  },
  treasury: { pending: treasury.pending().length },
  awaitingDelivery: desk.awaitingDelivery().length,
  settlement: { open: settlement.open()?.settlement_id ?? null, status: settlement.open()?.status ?? null, windows: settlement.windows.length },
  fulfilment: {
    deliveries_open: fulfilment.openDeliveries().length,
    refinings_open: fulfilment.openRefinings().length,
    awaiting_approval: fulfilment.awaitingApproval().length,
    burn_moment: S.fulfilment.burnMoment,
    catalog_version: fulfilment.catalog?.version ?? 0,
  },
  ts: new Date().toISOString(),
});

let lastOpen: boolean | null = null;
client.on("state", () => {
  bus.emit("event", { kind: "status", status: status() });
  const open = tradingOpen();
  if (lastOpen !== null && open !== lastOpen) notify(open ? "trading.open" : "trading.stopped", open ? "Müşteri işlemleri açıldı" : "Müşteri işlemleri durdu", open ? "" : tradingReason());
  lastOpen = open;
});
client.on("prices", (m: any) => {
  ticks.unshift({ seq: m.seq, ts: m.ts, tradable: m.tradable, prices: m.prices });
  if (ticks.length > 200) ticks.pop();
  bus.emit("event", { kind: "tick", seq: m.seq, ts: m.ts, tradable: m.tradable, prices: m.prices, quotes: m.prices.map((p: any) => quote(p, S.pricing)) });
});
client.on("notice", (n: { type: string; title: string; body?: string }) => notify(n.type, n.title, n.body));

// ---- API ----
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
// yol tablosu: panel API belgesi (kz-api.json) buradan üretilir, elle liste tutulmaz
const ROUTES: { method: string; url: string }[] = [];
app.addHook("onRoute", (r) => { for (const m of Array.isArray(r.method) ? r.method : [r.method]) ROUTES.push({ method: m, url: r.url }); });
await app.register(cors, { origin: true });
// ham gövde (olay imzası için)
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  (req as any).rawBody = body as string;
  try { done(null, body === "" ? undefined : JSON.parse(body as string)); } catch (e) { done(e as Error, undefined); }
});

// gelen istekler: olaylar ve panelin değiştiricileri günlüğe yazılır (VARA kanıtı)
app.addHook("onRequest", async (req) => { (req as { _t0?: number })._t0 = Date.now(); });
app.addHook("onResponse", async (req, reply) => {
  if (!shouldLogIncoming(req.method, req.url)) return;
  const t0 = (req as { _t0?: number })._t0 ?? Date.now();
  reqLog.incoming(req.method, req.url, reply.statusCode, Date.now() - t0, (req.headers["x-user"] as string) ?? null, (req as { rawBody?: string }).rawBody);
});

app.get("/api/refinery/status", async () => status());
app.get<{ Querystring: { limit?: string } }>("/api/refinery/ticks", async (req) => ticks.slice(0, Math.min(200, Number(req.query.limit ?? 50))));
app.post<{ Body: { reason?: string } }>("/api/trading/stop", async (req, reply) => {
  const reason = req.body?.reason?.trim();
  if (!reason) return reply.code(400).send({ error: "gerekçe zorunlu" });
  S.market.manualStop = true; S.market.manualReason = reason;
  notify("trading.manual_stop", "Müşteri işlemleri elle durduruldu", reason);
  changed();
  return logged(req, "trading.stop", `müşteri işlemleri elle durduruldu: ${reason}`, status());
});
app.post("/api/trading/start", async (req) => {
  S.market.manualStop = false; S.market.manualReason = null;
  notify("trading.manual_start", "Müşteri işlemleri elle başlatıldı");
  changed();
  return logged(req, "trading.start", "müşteri işlemleri elle başlatıldı", status());
});
app.get("/api/notifications", async () => ({ unread: S.notices.filter((n) => !n.read).length, items: S.notices.slice(0, 50) }));
app.post<{ Params: { id: string } }>("/api/notifications/:id/read", async (req) => {
  const n = S.notices.find((x) => x.id === Number(req.params.id));
  if (n) n.read = true;
  changed();
  return { ok: true };
});

// ---- K9: denetim günlüğü ve ikinci onay ----
/** Kritik değişiklik iki adımdır: istek 202 ile onay numarası döner, onay farklı kullanıcıdan gelir. */
interface Approvable { approval_id?: number; approver?: string }
function gate<T>(req: { headers: Record<string, unknown>; body?: (T & Approvable) | undefined }, action: string): { pending: ApprovalRequest } | { payload: T } {
  const { approval_id, approver, ...values } = (req.body ?? {}) as T & Approvable;
  return auditDesk.gate(action, values as T, actorOf(req), approval_id === undefined ? undefined : Number(approval_id), approver);
}
const needsApproval = (r: { pending: ApprovalRequest }) => ({
  needs_approval: true as const, approval_id: r.pending.id, requested_by: r.pending.requested_by,
  message: `${r.pending.summary}: ikinci onay bekleniyor, onaylayan isteyenden farklı olmalı`,
  values: r.pending.payload,
});

app.get<{ Querystring: { limit?: string } }>("/api/audit", async (req) => ({
  items: auditDesk.list(Number(req.query.limit ?? 100)),
  second_approval: SECOND_APPROVAL,
}));
app.get("/api/approvals", async () => ({ pending: auditDesk.pending(), items: auditDesk.listApprovals(50) }));

/**
 * Onaylanan kritik aksiyonu uygular.
 *
 * Onay ile uygulama aynı yerde durur: ikinci kullanıcı onayladığı anda iş yapılır,
 * kimsenin ayrıca "şimdi bir daha gönder" demesi gerekmez. İstek hangi ekrandan
 * açılmışsa açılsın (K2, K6, K8, K9) sonuç aynıdır. Onay bir kez uygulanır.
 */
async function applyApproved(a: ApprovalRequest): Promise<string> {
  if (a.consumed) return "zaten uygulanmış";
  a.consumed = true;
  const p = a.payload as Record<string, unknown>;
  switch (a.action) {
    case "pricing.update": Object.assign(S.pricing, p); break;
    case "order-params.update": Object.assign(S.orderParams, p); break;
    case "stock-params.update": Object.assign(S.stock, p); break;
    case "fulfilment-params.update": Object.assign(S.fulfilment, p); break;
    case "log-params.update": {
      if (p.retentionDays !== undefined) S.log.retentionDays = Math.max(0, Number(p.retentionDays));
      if (p.maxRows !== undefined) S.log.maxRows = Math.max(0, Number(p.maxRows));
      reqLog.prune();
      break;
    }
    case "settlement.pay": {
      await settlement.pay(String(p.settlement_id), String(p.ccy ?? "USD"));
      break;
    }
    case "record.resolve": {
      const acc = await amr.account();
      resolveWithSnapshot(S.record, acc, String(p.explanation ?? "onaylı düzeltme"));
      notify("account.resolved", "RECONCILE çözüldü", String(p.explanation ?? ""));
      vault.flushMints();
      break;
    }
    default: a.consumed = false; return `bu aksiyon kendiliğinden uygulanmıyor: ${a.action}`;
  }
  auditDesk.log(a.decided_by ?? "bilinmiyor", `${a.action}:applied`, `${a.summary} onayla birlikte uygulandı (isteyen ${a.requested_by})`, undefined, a.payload);
  changed();
  return "uygulandı";
}
/** Kayıtlar (K10): beş kaynak tek biçimde, filtreli ve sayfalı. */
app.get<{ Querystring: { source?: string; q?: string; from?: string; to?: string; limit?: string; offset?: string } }>("/api/logs", async (req) =>
  queryLogs(
    { requests: S.requests, audit: S.audit, events: S.events, notifications: S.notices, ticks },
    { source: req.query.source, q: req.query.q, from: req.query.from, to: req.query.to, limit: Number(req.query.limit ?? 50), offset: Number(req.query.offset ?? 0) },
  ));

/** İstek günlüğü (VARA kanıtı): giden ve gelen çağrılar, gövde özetiyle. */
app.get<{ Querystring: { limit?: string; direction?: string; path?: string; errors?: string } }>("/api/requests", async (req) => ({
  summary: reqLog.summary(),
  items: reqLog.list({ limit: Number(req.query.limit ?? 200), direction: req.query.direction, path: req.query.path, onlyErrors: req.query.errors === "1" }),
}));
/** Saklama parametreleri kritiktir (kanıt süresi kısaltılıyor): ikinci onay ister. */
app.put<{ Body: Partial<RequestLogParams> & Approvable }>("/api/log-params", async (req, reply) => {
  try {
    const g = gate<Partial<RequestLogParams>>(req, "log-params.update");
    if ("pending" in g) return reply.code(202).send(needsApproval(g));
    const before = { ...S.log };
    if (g.payload.retentionDays !== undefined) S.log.retentionDays = Math.max(0, Number(g.payload.retentionDays));
    if (g.payload.maxRows !== undefined) S.log.maxRows = Math.max(0, Number(g.payload.maxRows));
    reqLog.prune();
    changed();
    return logged(req, "log-params.update", `istek günlüğü saklama süresi ${S.log.retentionDays} gün, tavan ${S.log.maxRows} satır`, S.log, before, { ...S.log });
  } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
});
app.post<{ Params: { id: string }; Body: { approver?: string } }>("/api/approvals/:id/approve", async (req, reply) => {
  let approval: ApprovalRequest;
  try { approval = auditDesk.approve(Number(req.params.id), req.body?.approver?.trim() || actorOf(req)); }
  catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  try {
    const applied = await applyApproved(approval);
    return { ...approval, applied };
  } catch (e) {
    // onay verildi ama uygulama patladı: durum kaydedilir, kullanıcıya sebebi söylenir
    auditDesk.log(approval.decided_by ?? "bilinmiyor", `${approval.action}:apply_failed`, `${approval.summary} uygulanamadı: ${(e as Error).message}`);
    return reply.code(502).send({ error: `onay verildi ama uygulanamadı: ${(e as Error).message}`, approval });
  }
});
app.post<{ Params: { id: string } }>("/api/approvals/:id/reject", async (req, reply) => {
  try { return auditDesk.reject(Number(req.params.id), actorOf(req)); }
  catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
});

app.put<{ Body: Partial<PricingParams> & Approvable }>("/api/pricing", async (req, reply) => {
  try {
    const g = gate<Partial<PricingParams>>(req, "pricing.update");
    if ("pending" in g) return reply.code(202).send(needsApproval(g));
    const before = { ...S.pricing };
    Object.assign(S.pricing, g.payload);
    changed();
    return logged(req, "pricing.update", "fiyatlama parametreleri değişti", S.pricing, before, { ...S.pricing });
  } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
});
app.put<{ Body: Partial<OrderParams> & Approvable }>("/api/order-params", async (req, reply) => {
  try {
    const g = gate<Partial<OrderParams>>(req, "order-params.update");
    if ("pending" in g) return reply.code(202).send(needsApproval(g));
    const before = { ...S.orderParams };
    Object.assign(S.orderParams, g.payload);
    changed();
    return logged(req, "order-params.update", "emir parametreleri değişti", S.orderParams, before, { ...S.orderParams });
  } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
});

// ---- K3: emirler ----
app.get<{ Querystring: { limit?: string } }>("/api/orders", async (req) => ({ items: desk.list(Math.min(500, Number(req.query.limit ?? 200))), unanswered: desk.unanswered(), lateFills: desk.lateFills() }));
app.get<{ Params: { id: string } }>("/api/orders/:id", async (req, reply) => desk.get(req.params.id) ?? reply.code(404).send({ error: "emir yok" }));
/** Müşteri emri (demo: müşteri ekranı yerine K3'teki deneme kutusu). */
app.post<{ Body: { side: "BUY" | "SELL"; qty_mg: number; ccy: "USD" | "EUR" | "AED"; customer_ref?: string } }>("/api/orders", async (req, reply) => {
  try { return await desk.place(req.body); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
app.post<{ Params: { id: string }; Body: { decision: "CLOSE" | "CARRY" } }>("/api/orders/:id/decision", async (req, reply) => {
  try { return await desk.decide(req.params.id, req.body.decision); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
app.post<{ Params: { id: string } }>("/api/orders/:id/resolve", async (req, reply) => {
  const o = desk.get(req.params.id);
  if (!o) return reply.code(404).send({ error: "emir yok" });
  await desk.resolveUnanswered(o);
  return o;
});

// ---- K4: kasa talimatları ----
app.get<{ Querystring: { limit?: string } }>("/api/vault", async (req) => ({
  items: vault.list(Math.min(500, Number(req.query.limit ?? 200))),
  placing_mg: vault.placingMg(),
  in_flight_mg: vault.inFlightMg(),
  committed_placing_mg: vault.committedPlacingMg(),
  placing_cap_mg: S.stock.placingCapMg,
  awaiting_mint: vault.awaitingMint(),
  holds: vault.holds(),
  mint_block: vault.mintBlock(),
  vault_out_block: vault.vaultOutBlock(),
  record: S.record,
  checks: checks(S.record),
}));
app.get<{ Params: { ref: string } }>("/api/vault/:ref", async (req, reply) => vault.get(req.params.ref) ?? reply.code(404).send({ error: "talimat yok" }));
/** Elle kasa talimatı: yalnız yönetici, gerekçeli (K4). Otomatik talepler 07, 08, 09 ve 12'den gelir. */
app.post<{ Body: { type: "IN" | "OUT"; qty_mg: number; reason?: string } }>("/api/vault", async (req, reply) => {
  const reason = req.body?.reason?.trim();
  if (!reason) return reply.code(400).send({ error: "gerekçe zorunlu (elle kasa talimatı)" });
  if (req.body?.type !== "IN" && req.body?.type !== "OUT") return reply.code(400).send({ error: "tür IN ya da OUT olmalı" });
  try {
    const inst = req.body.type === "IN"
      ? await vault.requestIn(Number(req.body.qty_mg), "MANUAL")
      : await vault.requestOut(Number(req.body.qty_mg), "MANUAL");
    inst.timeline.unshift({ ts: new Date().toISOString(), text: `elle talimat · gerekçe: ${reason}` });
    changed();
    return logged(req, "vault.manual", `elle kasa ${req.body.type === "IN" ? "girişi" : "çıkışı"} ${Number(req.body.qty_mg) / 1000} g · gerekçe: ${reason}`, inst);
  } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
/** Tavan yüzünden duran (HOLD) kasa girişini yeniden dener. */
app.post<{ Params: { ref: string } }>("/api/vault/:ref/retry", async (req, reply) => {
  try { return await vault.retry(req.params.ref); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
/** Bloke kalkınca fişi gelmiş ama mint'i bekleyen girişleri işler. */
app.post("/api/vault/flush-mints", async () => { vault.flushMints(); changed(); return { ok: true, awaiting: vault.awaitingMint().length, block: vault.mintBlock() }; });
app.get<{ Querystring: { date?: string } }>("/api/vault/statement", async (req, reply) => {
  try { return await amr.vaultStatement(req.query.date); } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
});

// ---- K5: hazine alım satımı ----
app.get("/api/treasury", async () => ({ items: treasury.list(), pending: treasury.pending(), stock: S.stock, record: S.record }));
app.get<{ Params: { id: string } }>("/api/treasury/:id", async (req, reply) => treasury.get(req.params.id) ?? reply.code(404).send({ error: "talep yok" }));
app.post<{ Body: { side: "BUY" | "SELL"; qty_mg: number; ccy: "USD" | "EUR" | "AED"; maker: string } }>("/api/treasury", async (req, reply) => {
  try {
    const t = treasury.create({ ...req.body, qty_mg: Number(req.body.qty_mg) });
    return logged(req, "treasury.create", `hazine ${req.body.side === "BUY" ? "alış" : "satış"} talebi ${Number(req.body.qty_mg) / 1000} g · isteyen ${req.body.maker}`, t);
  } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
app.post<{ Params: { id: string }; Body: { approver: string } }>("/api/treasury/:id/approve", async (req, reply) => {
  try {
    const t = await treasury.approve(req.params.id, req.body?.approver);
    return logged(req, "treasury.approve", `hazine talebi ${req.params.id} onaylandı · onaycı ${req.body?.approver}`, t);
  } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
app.post<{ Params: { id: string }; Body: { actor?: string } }>("/api/treasury/:id/cancel", async (req, reply) => {
  try {
    const t = treasury.cancel(req.params.id, req.body?.actor?.trim() || "hazineci");
    return logged(req, "treasury.cancel", `hazine talebi ${req.params.id} iptal edildi`, t);
  } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
/** Onay matrisi önizlemesi: girilen gram kaç onay ister. */
app.get<{ Querystring: { qty_mg?: string } }>("/api/treasury-approvals", async (req) => ({ qty_mg: Number(req.query.qty_mg ?? 0), required: requiredApprovals(Number(req.query.qty_mg ?? 0), S.stock) }));

/** Stok parametreleri (K9 önü): taban, tavan, hedef, mint politikası, kasaya konuluyor tavanı, onay matrisi. */
app.put<{ Body: Partial<StockParams> & Approvable }>("/api/stock-params", async (req, reply) => {
  try {
    const g = gate<Partial<StockParams>>(req, "stock-params.update");
    if ("pending" in g) return reply.code(202).send(needsApproval(g));
    const before = { ...S.stock };
    Object.assign(S.stock, g.payload);
    changed();
    return logged(req, "stock-params.update", "stok bandı ve onay matrisi değişti", S.stock, before, { ...S.stock });
  } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
});

// ---- K6: fiziksel teslimat · K7: rafinasyon ----
app.get("/api/fulfilment", async () => ({
  deliveries: fulfilment.deliveries, refinings: fulfilment.refinings, catalog: fulfilment.catalog,
  awaiting_approval: fulfilment.awaitingApproval().length, burn_moment: S.fulfilment.burnMoment,
  escrow_mg: S.record.stock.e_mg ?? 0, checks: checks(S.record),
}));
app.get("/api/catalog", async (req, reply) => {
  try { return await fulfilment.refreshCatalog(); } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
});
app.post<{ Body: { qty_mg: number; address_ref?: string; insured_party_ref?: string; customer_ref?: string } }>("/api/deliveries", async (req, reply) => {
  try {
    return await fulfilment.requestDelivery({
      qty_mg: Number(req.body?.qty_mg), address_ref: req.body?.address_ref?.trim() || "ADR-DEMO",
      insured_party_ref: req.body?.insured_party_ref?.trim() || "SIG-DEMO", customer_ref: req.body?.customer_ref,
    });
  } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
app.post<{ Params: { id: string } }>("/api/deliveries/:id/approve", async (req, reply) => {
  try { return await fulfilment.approveDelivery(req.params.id); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
app.post<{ Params: { id: string }; Body: { reason?: string } }>("/api/deliveries/:id/cancel", async (req, reply) => {
  try { return await fulfilment.cancelDelivery(req.params.id, req.body?.reason?.trim() || "Kanzasset iptal etti"); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
app.post<{ Body: { items: { item_id: string; qty: number }[]; address_ref?: string; insured_party_ref?: string; customer_ref?: string } }>("/api/refining", async (req, reply) => {
  try {
    return await fulfilment.requestRefining({
      items: req.body?.items ?? [], address_ref: req.body?.address_ref?.trim() || "ADR-DEMO",
      insured_party_ref: req.body?.insured_party_ref?.trim() || "SIG-DEMO", customer_ref: req.body?.customer_ref,
    });
  } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
app.post<{ Params: { id: string } }>("/api/refining/:id/approve", async (req, reply) => {
  try { return await fulfilment.approveRefining(req.params.id); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
app.post<{ Params: { id: string }; Body: { reason?: string } }>("/api/refining/:id/cancel", async (req, reply) => {
  try { return await fulfilment.cancelRefining(req.params.id, req.body?.reason?.trim() || "Kanzasset iptal etti"); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
app.put<{ Body: Partial<FulfilmentParams> & Approvable }>("/api/fulfilment-params", async (req, reply) => {
  try {
    const g = gate<Partial<FulfilmentParams>>(req, "fulfilment-params.update");
    if ("pending" in g) return reply.code(202).send(needsApproval(g));
    const before = { ...S.fulfilment };
    Object.assign(S.fulfilment, g.payload);
    changed();
    return logged(req, "fulfilment-params.update", `burn anı ${S.fulfilment.burnMoment}`, S.fulfilment, before, { ...S.fulfilment });
  } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
});

// ---- K8: mahsuplaşma ----
app.get("/api/settlements", async () => ({ items: settlement.list(), open: settlement.open() ?? null, record: S.record }));
app.post<{ Body: { reason?: string; trigger?: string; scope?: string[]; amounts?: unknown } }>("/api/settlements", async (req, reply) => {
  try {
    const scope = req.body?.scope?.length ? req.body.scope : undefined;
    const w = await settlement.request(req.body?.trigger ?? "REQUEST_KZ", req.body?.reason?.trim(), scope, req.body?.amounts);
    return logged(req, "settlement.request", `mahsuplaşma penceresi istendi${scope ? ` · kapsam ${scope.join(" + ")}` : ""}${req.body?.reason ? ": " + req.body.reason.trim() : ""}`, w);
  } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
});
app.post<{ Params: { id: string } }>("/api/settlements/:id/reconcile", async (req, reply) => {
  try { return await settlement.reconcile(req.params.id); } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
});
/** Rafinerinin "kasaya koyalım mı" teklifini onaylar; ardından kasa girişi talebi gider. */
app.post<{ Params: { id: string } }>("/api/settlements/:id/gold/approve", async (req, reply) => {
  try {
    const w = await settlement.approveGold(req.params.id);
    return logged(req, "settlement.gold_approve", `mahsuplaşma ${req.params.id} altın teklifi onaylandı, kasa girişi talebi gönderildi`, w);
  } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
app.post<{ Params: { id: string } }>("/api/settlements/:id/gold-leg", async (req, reply) => {
  try {
    const w = await settlement.goldLeg(req.params.id);
    return logged(req, "settlement.gold_leg", `mahsuplaşma ${req.params.id} altın bacağı kasa talimatına devredildi`, w);
  } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
/** Ödeme talimatı kritiktir (K5: yalnız şirket banka hesabından): ikinci onay ister. */
app.post<{ Params: { id: string }; Body: { ccy?: string } & Approvable }>("/api/settlements/:id/pay", async (req, reply) => {
  try {
    const g = gate<{ settlement_id: string; ccy?: string }>({ headers: req.headers as Record<string, unknown>, body: { settlement_id: req.params.id, ccy: req.body?.ccy ?? "USD", approval_id: req.body?.approval_id, approver: req.body?.approver } }, "settlement.pay");
    if ("pending" in g) return reply.code(202).send(needsApproval(g));
    const w = await settlement.pay(g.payload.settlement_id, g.payload.ccy ?? "USD");
    return logged(req, "settlement.pay", `mahsuplaşma ${g.payload.settlement_id} · ${g.payload.ccy} bacağı için ödeme talimatı verildi`, w);
  } catch (e) { return reply.code(e instanceof ApprovalError ? 409 : 400).send({ error: (e as Error).message }); }
});

// ---- K2: rafineri hesapları ----
app.get("/api/record", async () => ({ record: S.record, checks: checks(S.record) }));
app.post("/api/record/snapshot", async (req, reply) => {
  try {
    const acc = await amr.account();
    const r = compare(S.record, acc);
    changed();
    if (S.record.match === "RECONCILE") notify("account.reconcile", "Anlık fotoğraf: uyuşmazlık", `${S.record.diffs.length} fark satırı`);
    return { account: acc, match: S.record.match, diffs: S.record.diffs, seqGap: r.seqGap };
  } catch (e) { return reply.code(502).send({ error: `rafineriye ulaşılamadı: ${(e as Error).message}` }); }
});
/** Uyuşmazlık düzeltmesi kritiktir: tek kişi kaydı düzeltemez, ikinci onay ister. */
app.post<{ Body: { explanation?: string } & Approvable }>("/api/record/resolve", async (req, reply) => {
  const explanation = req.body?.explanation?.trim();
  if (!explanation) return reply.code(400).send({ error: "fark açıklaması zorunlu" });
  let approved: { explanation?: string };
  try {
    const g = gate<{ explanation?: string }>(req, "record.resolve");
    if ("pending" in g) return reply.code(202).send(needsApproval(g));
    approved = g.payload;
  } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  void approved;
  try {
    const acc = await amr.account();
    resolveWithSnapshot(S.record, acc, explanation);
    notify("account.resolved", "RECONCILE çözüldü", explanation);
    vault.flushMints(); // bloke kalktı: fişi gelmiş ama bekleyen mint'ler yapılır
    changed();
    return logged(req, "record.resolve", `uyuşmazlık düzeltildi: ${explanation}`, { record: S.record, mint_block: vault.mintBlock(), awaiting_mint: vault.awaitingMint().length });
  } catch (e) { return reply.code(502).send({ error: `rafineriye ulaşılamadı: ${(e as Error).message}` }); }
});
// demo: KZ kaydını bilerek kaydırır (eşleşme uyuşmazlığı senaryosu S6). KZ_DEMO=0 ile kapanır.
if (process.env.KZ_DEMO !== "0") {
  app.post<{ Body: { gold_mg?: number; usd_cents?: number } }>("/api/debug/record-skew", async (req) => {
    S.record.current_account.gold_mg += Number(req.body?.gold_mg ?? 0);
    const usd = S.record.current_account.money.find((m) => m.ccy === "USD")!; usd.cents += Number(req.body?.usd_cents ?? 0);
    notify("debug.skew", "Demo: KZ kaydı bilerek kaydırıldı", `altın ${req.body?.gold_mg ?? 0} mg · USD ${req.body?.usd_cents ?? 0} cent`);
    changed();
    return S.record;
  });
}
app.get<{ Querystring: { from?: string; to?: string } }>("/api/record/statement", async (req, reply) => {
  try { return await amr.statement(req.query.from, req.query.to); } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
});
// ---- belgeler (K9): kendi kopyamız ----
app.get<{ Querystring: { type?: string; q?: string; limit?: string } }>("/api/documents", async (req) => ({
  count: documents.count(),
  signature_checked: AMR_DOC_KEY !== null,
  last_sync_ts: S.docSyncTs,
  auto_sync_minutes: DOC_SYNC_MIN,
  items: documents.list({ type: req.query.type, text: req.query.q, limit: Number(req.query.limit ?? 500) }),
}));
/** Belgeyi kendi kaydımızdan verir; yoksa rafineriden çeker, doğrular ve saklar. */
app.get<{ Params: { id: string } }>("/api/documents/:id", async (req, reply) => {
  try {
    const row = await documents.fetch(req.params.id, "ekrandan istendi");
    if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
    const { content, ...meta } = row;
    return { meta, content };
  } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
});
/** PDF rafineride üretilir; imzalı istekle çekilip aynen aktarılır (tarayıcı HMAC imzalayamaz). */
app.get<{ Params: { id: string } }>("/api/documents/:id/pdf", async (req, reply) => {
  const path = `/v1/documents/${encodeURIComponent(req.params.id)}/pdf`;
  try {
    const res = await fetch(amr.baseUrl + path, { headers: amr.headers("GET", path) });
    if (!res.ok) return reply.code(502).send({ error: `rafineri HTTP ${res.status}` });
    reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="${req.params.id}.pdf"`);
    return reply.send(Buffer.from(await res.arrayBuffer()));
  } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
});
/** Geriye dönük eşitleme: emirler, kasa talimatları, teslimat / rafinasyon ve mahsuplaşma kayıtlarındaki belge numaraları taranır. */
app.post("/api/documents/sync", async (req) => {
  const r = await syncDocuments();
  return logged(req, "documents.sync", `${r.fetched} belge çekildi, ${r.failed.length} çekilemedi`, { ...r, count: documents.count() });
});

// ---- olaylar (webhook, AMR → KZ) ----
app.get("/api/events", async () => S.events.slice(0, 100));
app.post("/api/events", async (req, reply) => {
  const raw = ((req as any).rawBody as string) ?? "";
  const ts = req.headers["x-timestamp"] as string | undefined;
  const sig = req.headers["x-signature"] as string | undefined;
  const key = req.headers["x-api-key"] as string | undefined;
  if (!ts || !sig || key !== API_KEY) return reply.code(401).send({ error: "AUTH_MISSING" });
  if (!Number.isFinite(Date.parse(ts)) || Math.abs(Date.now() - Date.parse(ts)) > PRICE_SOCKET.authSkewMs) return reply.code(401).send({ error: "AUTH_CLOCK" });
  const expected = createHmac("sha256", API_SECRET).update(signingString(ts, "POST", "/api/events", raw)).digest("hex");
  const a = Buffer.from(expected, "hex"); const b = Buffer.from(sig, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: "AUTH_BAD_SIGNATURE" });
  const ev = req.body as EventEnvelope;
  if (S.events.some((e) => e.event_id === ev.event_id)) return { ok: true, duplicate: true };
  const summary = await handleEvent(ev);
  // olayla gelen belge numaraları: belgeyi çek, doğrula, kendi kaydımıza yaz (hata olayı durdurmaz)
  await documents.collect(ev);
  S.events.unshift({ event_id: ev.event_id, type: ev.type, ts: ev.ts, received_ts: new Date().toISOString(), seq: ev.seq, summary });
  if (S.events.length > 500) S.events.pop();
  changed();
  return { ok: true };
});

async function handleEvent(ev: EventEnvelope): Promise<string> {
  const d = ev.data as any;
  switch (ev.type) {
    case "order.filled": case "order.cancelled": case "order.rejected": {
      const r = d as OrderResponse;
      const o = desk.get(r.client_order_id);
      if (o && (o.status === "UNANSWERED" || o.status === "SENT")) { await desk.onResponse(o, r, true); return `${r.client_order_id} → ${r.status} (olayla kapandı)`; }
      return `${r.client_order_id} ${r.status}`;
    }
    case "vault.in_accepted": case "vault.in_placing": case "vault.in_placed": case "vault.in_overdue": case "vault.in_rejected":
    case "vault.out_accepted": case "vault.out_rejected":
      return vault.onEvent(ev.type, d, ev.account as Account | undefined);
    case "delivery.quoted": case "delivery.approved": case "delivery.preparing": case "delivery.ready":
    case "delivery.shipped": case "delivery.delivered": case "delivery.cancelled": case "delivery.failed":
    case "refining.quoted": case "refining.approved": case "refining.in_production": case "refining.ready":
    case "refining.shipped": case "refining.delivered": case "refining.cancelled": case "refining.failed":
      return fulfilment.onEvent(ev.type, d, ev.account as Account | undefined);
    case "catalog.updated": {
      void fulfilment.refreshCatalog().catch(() => {});
      notify("catalog.updated", "Rafineri kataloğu güncellendi", `sürüm ${d?.version ?? ""}`);
      return `katalog sürüm ${d?.version ?? ""}`;
    }
    case "price.halt": return `yayın durdu: ${d?.reason ?? ""}`;
    case "price.resume": return "yayın açıldı";
    case "settlement.requested": case "settlement.opened": case "settlement.statement": case "settlement.reconciled":
    case "settlement.mismatch": case "settlement.payment_notice": case "settlement.payment_received": case "settlement.settled":
      return settlement.onEvent(ev.type, d);
    case "account.reconcile": notify("account.reconcile", "Rafineri uyuşmazlık bildirdi", JSON.stringify(d)); return "account.reconcile";
    default: {
      if (ev.account) { compare(S.record, ev.account as Account); }
      notify(`event.${ev.type}`, `Rafineri olayı: ${ev.type}`, typeof d === "object" ? JSON.stringify(d).slice(0, 200) : String(d ?? ""));
      return ev.type;
    }
  }
}

docsRoutes(app, AMR_HTTP_URL);

app.get("/api/stream", async (req, reply) => {
  reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
  const write = (ev: unknown) => reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
  write({ kind: "status", status: status() });
  const on = (ev: unknown) => write(ev);
  bus.on("event", on);
  const ping = setInterval(() => reply.raw.write(`: ping\n\n`), 15000);
  req.raw.on("close", () => { bus.off("event", on); clearInterval(ping); });
  await new Promise(() => {});
});
/** Sağlık: alt sistemler ayrı ayrı. HTTP 503 yalnız iş göremez durumda (bkz. health.ts). */
app.get("/health", async (_req, reply) => {
  const h = healthSnapshot({
    socket: () => client.state,
    record: () => S.record,
    trading: () => ({ open: tradingOpen(), reason: tradingReason() }),
    store: () => ({ path: store.file, ok: !store.lastError, error: store.lastError }),
    counts: () => ({
      orders: S.orders.length,
      open_orders: S.orders.filter((o) => o.status === "SENT" || o.status === "UNANSWERED").length,
      unanswered: desk.unanswered().length,
      late_fills: desk.lateFills().length,
      events: S.events.length,
      last_event_ts: S.events[0]?.received_ts ?? null,
      notices_unread: S.notices.filter((n) => !n.read).length,
    }),
    vault: () => ({
      open: vault.instructions.filter((i) => i.status === "REQUESTED" || i.status === "HOLD" || i.status === "ACCEPTED" || i.status === "PLACING" || i.status === "OVERDUE").length,
      holds: vault.holds().length,
      awaiting_mint: vault.awaitingMint().length,
      mint_block: vault.mintBlock(),
      vault_out_block: vault.vaultOutBlock(),
    }),
    settlement: () => ({ open_id: settlement.open()?.settlement_id ?? null, open_status: settlement.open()?.status ?? null }),
    amrUrl: AMR_HTTP_URL,
  });
  return reply.code(h.status === "down" ? 503 : 200).send(h);
});

const webDist = resolve(import.meta.dirname, "../../kz-web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api") || req.url.startsWith("/docs") || req.url.startsWith("/health") || req.url.endsWith(".json")
      ? reply.code(404).send({ error: "not found" })
      : reply.sendFile("index.html"));
}

// belge üretimi: yol tablosunu yaz ve çık (sunucu açılmaz, rafineriye bağlanılmaz)
if (process.env.KZ_ROUTES_DUMP) {
  await app.ready();
  writeFileSync(process.env.KZ_ROUTES_DUMP, JSON.stringify(ROUTES, null, 1));
  process.exit(0);
}

client.start();
// Belgeler kendiliğinden eşitlenir: açılıştan kısa süre sonra bir kez, sonra DOC_SYNC_MIN dakikada bir.
if (DOC_SYNC_MIN > 0) {
  const tick = () => { void syncDocuments().catch((e) => app.log.warn(`belge eşitleme: ${(e as Error).message}`)); };
  setTimeout(tick, 15_000).unref();
  setInterval(tick, DOC_SYNC_MIN * 60_000).unref();
}

await app.listen({ port: PORT, host: "0.0.0.0" });
app.log.info(`Kanzasset çekirdeği: http://localhost:${PORT} · rafineri soketi ${AMR_WS_URL} · REST ${AMR_HTTP_URL} · API dokümanı /docs`);
