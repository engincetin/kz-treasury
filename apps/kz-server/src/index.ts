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
import { existsSync } from "node:fs";
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

const PORT = Number(process.env.PORT ?? 5000);
const AMR_WS_URL = process.env.AMR_WS_URL ?? "ws://localhost:4000/v1/prices";
const AMR_HTTP_URL = process.env.AMR_HTTP_URL ?? AMR_WS_URL.replace(/^ws/, "http").replace(/\/v1\/prices$/, "");
const API_KEY = process.env.KZ_API_KEY ?? "kz-dev-key";
const API_SECRET = process.env.KZ_API_SECRET ?? "kz-dev-secret";
const DATA_DIR = process.env.KZ_DATA_DIR ?? resolve(import.meta.dirname, "../data");
const OPENING_MG = Number(process.env.KZ_OPENING_MG ?? 0);

const bus = new EventEmitter();
bus.setMaxListeners(100);

// ---- kalıcı durum ----
interface Notice { id: number; type: string; title: string; body?: string; ts: string; read: boolean }
interface EventLog { event_id: string; type: string; ts: string; received_ts: string; seq?: number; summary: string }
interface State {
  record: KzRecord; orders: CustomerOrder[]; notices: Notice[]; noticeId: number; events: EventLog[];
  pricing: PricingParams; orderParams: OrderParams; market: { manualStop: boolean; manualReason: string | null };
  vault: VaultInstruction[]; treasury: TreasuryRequest[]; stock: StockParams;
}
const store = new JsonStore<State>(resolve(DATA_DIR, "kz-state.json"), () => ({
  record: emptyRecord(OPENING_MG), orders: [], notices: [], noticeId: 0, events: [], pricing: { ...DEFAULT_PRICING }, orderParams: { ...DEFAULT_ORDER_PARAMS }, market: { manualStop: false, manualReason: null },
  vault: [], treasury: [], stock: { ...DEFAULT_STOCK_PARAMS, targetMg: OPENING_MG || DEFAULT_STOCK_PARAMS.targetMg },
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
const changed = () => { store.save(); bus.emit("event", { kind: "status", status: status() }); };

// Kasa talimatları (K4): mint yalnız Kasa Giriş Fişi'ne karşı, burn kasa çıkışından önce.
const vault = new VaultDesk({
  amr,
  record: () => S.record,
  params: () => S.stock,
  notify,
  onChange: () => { S.vault = vault.instructions; changed(); },
  onMinted: (inst) => { desk.deliverPending(inst); treasury.onMinted(inst); },
  onOutAccepted: (inst) => { treasury.onOutAccepted(inst); },
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

// Hazine alım satımı (K5): maker-checker, son onaycı canlı fiyatla gönderir.
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
await app.register(cors, { origin: true });
// ham gövde (olay imzası için)
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  (req as any).rawBody = body as string;
  try { done(null, body === "" ? undefined : JSON.parse(body as string)); } catch (e) { done(e as Error, undefined); }
});

app.get("/api/refinery/status", async () => status());
app.get<{ Querystring: { limit?: string } }>("/api/refinery/ticks", async (req) => ticks.slice(0, Math.min(200, Number(req.query.limit ?? 50))));
app.post<{ Body: { reason?: string } }>("/api/trading/stop", async (req, reply) => {
  const reason = req.body?.reason?.trim();
  if (!reason) return reply.code(400).send({ error: "gerekçe zorunlu" });
  S.market.manualStop = true; S.market.manualReason = reason;
  notify("trading.manual_stop", "Müşteri işlemleri elle durduruldu", reason);
  changed();
  return status();
});
app.post("/api/trading/start", async () => {
  S.market.manualStop = false; S.market.manualReason = null;
  notify("trading.manual_start", "Müşteri işlemleri elle başlatıldı");
  changed();
  return status();
});
app.get("/api/notifications", async () => ({ unread: S.notices.filter((n) => !n.read).length, items: S.notices.slice(0, 50) }));
app.post<{ Params: { id: string } }>("/api/notifications/:id/read", async (req) => {
  const n = S.notices.find((x) => x.id === Number(req.params.id));
  if (n) n.read = true;
  changed();
  return { ok: true };
});
app.put<{ Body: Partial<PricingParams> }>("/api/pricing", async (req) => { Object.assign(S.pricing, req.body ?? {}); changed(); return S.pricing; });
app.put<{ Body: Partial<OrderParams> }>("/api/order-params", async (req) => { Object.assign(S.orderParams, req.body ?? {}); changed(); return S.orderParams; });

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
    return inst;
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
  try { return treasury.create({ ...req.body, qty_mg: Number(req.body.qty_mg) }); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
app.post<{ Params: { id: string }; Body: { approver: string } }>("/api/treasury/:id/approve", async (req, reply) => {
  try { return await treasury.approve(req.params.id, req.body?.approver); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
app.post<{ Params: { id: string }; Body: { actor?: string } }>("/api/treasury/:id/cancel", async (req, reply) => {
  try { return treasury.cancel(req.params.id, req.body?.actor?.trim() || "hazineci"); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});
/** Onay matrisi önizlemesi: girilen gram kaç onay ister. */
app.get<{ Querystring: { qty_mg?: string } }>("/api/treasury-approvals", async (req) => ({ qty_mg: Number(req.query.qty_mg ?? 0), required: requiredApprovals(Number(req.query.qty_mg ?? 0), S.stock) }));

/** Stok parametreleri (K9 önü): taban, tavan, hedef, mint politikası, kasaya konuluyor tavanı, onay matrisi. */
app.put<{ Body: Partial<StockParams> }>("/api/stock-params", async (req) => { Object.assign(S.stock, req.body ?? {}); changed(); return S.stock; });

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
app.post<{ Body: { explanation?: string } }>("/api/record/resolve", async (req, reply) => {
  const explanation = req.body?.explanation?.trim();
  if (!explanation) return reply.code(400).send({ error: "fark açıklaması zorunlu" });
  try {
    const acc = await amr.account();
    resolveWithSnapshot(S.record, acc, explanation);
    notify("account.resolved", "RECONCILE çözüldü", explanation);
    vault.flushMints(); // bloke kalktı: fişi gelmiş ama bekleyen mint'ler yapılır
    changed();
    return { record: S.record, mint_block: vault.mintBlock(), awaiting_mint: vault.awaitingMint().length };
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
app.get<{ Params: { id: string } }>("/api/documents/:id", async (req, reply) => {
  try { return await amr.document(req.params.id); } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
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
    case "price.halt": return `yayın durdu: ${d?.reason ?? ""}`;
    case "price.resume": return "yayın açıldı";
    case "settlement.requested": notify("settlement.requested", "Rafineri mahsuplaşma talep etti", d?.reason ?? ""); return `mahsuplaşma talebi (${d?.trigger ?? ""})`;
    case "account.reconcile": notify("account.reconcile", "Rafineri uyuşmazlık bildirdi", JSON.stringify(d)); return "account.reconcile";
    default: {
      if (ev.account) { compare(S.record, ev.account as Account); }
      notify(`event.${ev.type}`, `Rafineri olayı: ${ev.type}`, typeof d === "object" ? JSON.stringify(d).slice(0, 200) : String(d ?? ""));
      return ev.type;
    }
  }
}

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
app.get("/health", async () => ({ ok: true }));

const webDist = resolve(import.meta.dirname, "../../kz-web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api") ? reply.code(404).send({ error: "not found" }) : reply.sendFile("index.html")));
}

client.start();
await app.listen({ port: PORT, host: "0.0.0.0" });
app.log.info(`Kanzasset çekirdeği: http://localhost:${PORT} · rafineri soketi ${AMR_WS_URL} · REST ${AMR_HTTP_URL}`);
