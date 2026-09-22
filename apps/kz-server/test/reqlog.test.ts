/**
 * İstek günlüğü (VARA kanıtı): giden ve gelen çağrılar, gövde özeti, saklama süresi.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DEFAULT_LOG_PARAMS, RequestLog, shouldLogIncoming, type RequestLogState } from "../src/reqlog.ts";

const state = (): RequestLogState => ({ requests: [], requestId: 0, log: { ...DEFAULT_LOG_PARAMS } });

test("giden çağrı yazılır, gövdenin kendisi değil sha256 özeti saklanır", () => {
  const s = state();
  const log = new RequestLog(s, () => {});
  const body = JSON.stringify({ qty_mg: 70_104, ccy: "USD" });
  log.outgoing("POST", "/v1/orders", 200, 42, body);
  assert.equal(s.requests.length, 1);
  const r = s.requests[0];
  assert.equal(r.direction, "GİDEN");
  assert.equal(r.path, "/v1/orders");
  assert.equal(r.status, 200);
  assert.equal(r.body_sha256, createHash("sha256").update(body).digest("hex"));
  assert.ok(!JSON.stringify(r).includes("70104"), "gövdenin kendisi saklanmaz");
});

test("zaman aşımı ve hata da kanıttır", () => {
  const s = state();
  const log = new RequestLog(s, () => {});
  log.outgoing("POST", "/v1/orders", 0, 5000, "{}", "zaman aşımı");
  assert.equal(s.requests[0].status, 0);
  assert.equal(s.requests[0].error, "zaman aşımı");
  assert.equal(log.list({ onlyErrors: true }).length, 1);
});

test("gelen istekler: olaylar ve değiştiriciler yazılır, ekran yenilemeleri yazılmaz", () => {
  assert.equal(shouldLogIncoming("POST", "/api/events"), true, "rafineri olayı kanıttır");
  assert.equal(shouldLogIncoming("POST", "/api/vault"), true, "elle talimat kanıttır");
  assert.equal(shouldLogIncoming("GET", "/api/refinery/status"), false, "ekran yenilemesi gürültüdür");
  assert.equal(shouldLogIncoming("GET", "/api/stream"), false, "canlı akış istek değildir");
  assert.equal(shouldLogIncoming("GET", "/health"), false);
});

test("özet: giden ve gelen ayrı sayılır, hatalar işaretlenir", () => {
  const s = state();
  const log = new RequestLog(s, () => {});
  log.outgoing("GET", "/v1/account", 200, 10);
  log.outgoing("POST", "/v1/orders", 409, 12, "{}", "HTTP 409");
  log.incoming("POST", "/api/events", 200, 3, null, "{}");
  const sum = log.summary();
  assert.equal(sum.last_24h, 3);
  assert.equal(sum.outgoing_24h, 2);
  assert.equal(sum.incoming_24h, 1);
  assert.equal(sum.errors_24h, 1);
  assert.equal(sum.retention_days, 90);
});

test("saklama süresi geçenler ve tavanı aşanlar atılır", () => {
  const s = state();
  const log = new RequestLog(s, () => {});
  log.outgoing("GET", "/v1/account", 200, 1);
  s.requests[0].ts = new Date(Date.now() - 100 * 86_400_000).toISOString();
  log.outgoing("GET", "/v1/account", 200, 1);
  log.prune();
  assert.equal(s.requests.length, 1, "90 günden eski satır atılır");

  s.log.maxRows = 3;
  for (let i = 0; i < 10; i++) log.outgoing("GET", "/v1/account", 200, 1);
  assert.equal(s.requests.length, 3, "tavan aşılmaz");
});
