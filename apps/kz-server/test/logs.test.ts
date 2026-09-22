/** Kayıtlar (K10): kaynak seçimi, metin ve tarih süzgeci, sayfalama. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryLogs, type LogSources } from "../src/logs.ts";

const iso = (d: number) => new Date(d).toISOString();
const now = Date.now();

const sources = (): LogSources => ({
  requests: [
    { id: 3, ts: iso(now), direction: "GİDEN", method: "POST", path: "/v1/orders", status: 200, duration_ms: 34, actor: null, body_sha256: "abc", bytes: 10, error: null },
    { id: 2, ts: iso(now - 1000), direction: "GELEN", method: "POST", path: "/api/events", status: 200, duration_ms: 2, actor: null, body_sha256: "def", bytes: 5, error: null },
    { id: 1, ts: iso(now - 3 * 86_400_000), direction: "GİDEN", method: "GET", path: "/v1/account", status: 0, duration_ms: 5000, actor: null, body_sha256: null, bytes: 0, error: "zaman aşımı" },
  ],
  audit: [{ id: 1, ts: iso(now), actor: "yonetici", action: "pricing.update", summary: "fiyatlama değişti" }],
  events: [{ event_id: "ev1", type: "order.filled", ts: iso(now), received_ts: iso(now), seq: 4, summary: "fill" }],
  notifications: [{ id: 1, type: "mint.blocked", title: "Mint bloke", body: "RECONCILE", ts: iso(now), read: false }],
  ticks: [{ seq: 9, ts: iso(now), tradable: true, prices: [{ ccy: "USD", bid: "141.80", ask: "142.00" }] }],
});

test("kaynak seçilir ve satırlar aynı dört sütuna çevrilir", () => {
  for (const [source, who] of [["requests", "rafineriye"], ["audit", "yonetici"], ["events", "rafineriden"], ["notifications", "mint.blocked"], ["ticks", "seq 9"]] as const) {
    const r = queryLogs(sources(), { source });
    assert.equal(r.source, source);
    assert.ok(r.items.length > 0, source);
    assert.equal(r.items[0].who, who);
    assert.ok(r.items[0].what.length > 0);
  }
});

test("metin süzgeci yalnız eşleşenleri döner", () => {
  const r = queryLogs(sources(), { source: "requests", q: "orders" });
  assert.equal(r.total, 1);
  assert.equal(r.items[0].what, "POST /v1/orders");
});

test("tarih aralığı: bugünden öncesi dışarıda kalır", () => {
  const today = new Date(now).toISOString().slice(0, 10);
  const r = queryLogs(sources(), { source: "requests", from: today });
  assert.equal(r.total, 2, "üç gün önceki satır aralık dışında");
});

test("sayfalama: toplam sabit kalır, satırlar kayar", () => {
  const p1 = queryLogs(sources(), { source: "requests", limit: 1, offset: 0 });
  const p2 = queryLogs(sources(), { source: "requests", limit: 1, offset: 1 });
  assert.equal(p1.total, 3);
  assert.equal(p2.total, 3);
  assert.notEqual(p1.items[0].what, p2.items[0].what);
});

test("cevapsız çağrı hata seviyesiyle görünür", () => {
  const r = queryLogs(sources(), { source: "requests", q: "account" });
  assert.equal(r.items[0].state, "hata");
  assert.equal(r.items[0].level, "bad");
  assert.match(r.items[0].detail ?? "", /zaman aşımı/);
});
