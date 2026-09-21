/**
 * Kanzasset çekirdeği (demo sunucusu).
 *   PORT=5000                 K ekranları API'si + canlı akış (SSE) + kz-web dist (varsa)
 *   AMR_WS_URL                rafineri fiyat soketi (varsayılan ws://localhost:4000/v1/prices)
 *   KZ_API_KEY / KZ_API_SECRET  AMR'de tanımlı istemci (varsayılan kz-dev-key / kz-dev-secret)
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import { PriceClient } from "./priceClient.ts";
import { DEFAULT_PRICING, quote } from "./pricing.ts";

const PORT = Number(process.env.PORT ?? 5000);
const AMR_WS_URL = process.env.AMR_WS_URL ?? "ws://localhost:4000/v1/prices";

const bus = new EventEmitter();
bus.setMaxListeners(100);

// ---- durum ----
const client = new PriceClient(AMR_WS_URL, process.env.KZ_API_KEY ?? "kz-dev-key", process.env.KZ_API_SECRET ?? "kz-dev-secret");
const market = { manualStop: false as boolean, manualReason: null as string | null };
const pricing = { ...DEFAULT_PRICING };
const ticks: { seq: number; ts: string; tradable: boolean; prices: unknown }[] = [];
const notices: { id: number; type: string; title: string; body?: string; ts: string; read: boolean }[] = [];
let noticeId = 0;

const tradingOpen = () => client.priceOk && !market.manualStop;
const tradingReason = () => {
  if (market.manualStop) return `elle durduruldu: ${market.manualReason ?? ""}`;
  const s = client.state;
  if (s.connection !== "SUBSCRIBED") return "rafineri soketi bağlı değil";
  if (s.stale) return "fiyat bayat (10 sn mesaj yok)";
  if (!s.tradable) return `rafineri yayını durdu${s.haltReason ? `: ${s.haltReason}` : ""}`;
  if (!s.lastPrices) return "fiyat gelmedi";
  return "";
};

const status = () => ({
  socket: { ...client.state },
  trading: { open: tradingOpen(), reason: tradingReason(), manualStop: market.manualStop, manualReason: market.manualReason },
  quotes: client.state.lastPrices?.map((p) => quote(p, pricing)) ?? [],
  pricing,
  unread: notices.filter((n) => !n.read).length,
  // KZ kaydı (Sprint 2'de dolar): rafineri hesaplarının Kanzasset'teki karşılığı
  record: { vault: { in_vault_mg: 0, placing_mg: 0, shipping_mg: 0 }, current_account: { gold_mg: 0, money: [{ ccy: "USD", cents: 0 }, { ccy: "EUR", cents: 0 }, { ccy: "AED", cents: 0 }] }, match: "EŞİT" },
  ts: new Date().toISOString(),
});

const notify = (type: string, title: string, body?: string) => {
  const n = { id: ++noticeId, type, title, body, ts: new Date().toISOString(), read: false };
  notices.unshift(n);
  if (notices.length > 200) notices.pop();
  bus.emit("event", { kind: "notice", ...n });
};

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
  bus.emit("event", { kind: "tick", seq: m.seq, ts: m.ts, tradable: m.tradable, prices: m.prices, quotes: m.prices.map((p: any) => quote(p, pricing)) });
});
client.on("notice", (n: { type: string; title: string; body?: string }) => notify(n.type, n.title, n.body));

// ---- API ----
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });

app.get("/api/refinery/status", async () => status());
app.get<{ Querystring: { limit?: string } }>("/api/refinery/ticks", async (req) => ticks.slice(0, Math.min(200, Number(req.query.limit ?? 50))));
app.post<{ Body: { reason?: string } }>("/api/trading/stop", async (req, reply) => {
  const reason = req.body?.reason?.trim();
  if (!reason) return reply.code(400).send({ error: "gerekçe zorunlu" });
  market.manualStop = true; market.manualReason = reason;
  notify("trading.manual_stop", "Müşteri işlemleri elle durduruldu", reason);
  bus.emit("event", { kind: "status", status: status() });
  return status();
});
app.post("/api/trading/start", async () => {
  market.manualStop = false; market.manualReason = null;
  notify("trading.manual_start", "Müşteri işlemleri elle başlatıldı");
  bus.emit("event", { kind: "status", status: status() });
  return status();
});
app.get("/api/notifications", async () => ({ unread: notices.filter((n) => !n.read).length, items: notices.slice(0, 50) }));
app.post<{ Params: { id: string } }>("/api/notifications/:id/read", async (req) => {
  const n = notices.find((x) => x.id === Number(req.params.id));
  if (n) n.read = true;
  bus.emit("event", { kind: "status", status: status() });
  return { ok: true };
});
app.put<{ Body: Partial<typeof pricing> }>("/api/pricing", async (req) => {
  Object.assign(pricing, req.body ?? {});
  bus.emit("event", { kind: "status", status: status() });
  return pricing;
});
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
app.log.info(`Kanzasset çekirdeği: http://localhost:${PORT} · rafineri soketi ${AMR_WS_URL}`);
