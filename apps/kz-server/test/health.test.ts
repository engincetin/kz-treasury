/** Sağlık ucu: alt sistemleri ayrı ayrı bildirir, bozuk kontrolde iş göremez der. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { healthSnapshot, type HealthDeps } from "../src/health.ts";
import { applyFill, emptyRecord, mint } from "../src/record.ts";
import type { PriceClientState } from "../src/priceClient.ts";

const socketOk: PriceClientState = {
  url: "ws://localhost:4000/v1/prices", connection: "SUBSCRIBED", tradable: true, haltReason: null, stale: false,
  seq: 42, lastMsgTs: new Date().toISOString(), lastTickTs: new Date().toISOString(), lastPrices: [], reconnectAttempt: 0, gaps: 0, lastError: null,
};

function deps(over: Partial<HealthDeps> = {}): HealthDeps {
  return {
    socket: () => socketOk,
    record: () => emptyRecord(20_000_000),
    trading: () => ({ open: true, reason: "" }),
    store: () => ({ path: "/tmp/kz-state.json", ok: true, error: null }),
    counts: () => ({ orders: 0, open_orders: 0, unanswered: 0, late_fills: 0, events: 0, last_event_ts: null, notices_unread: 0 }),
    vault: () => ({ open: 0, holds: 0, awaiting_mint: 0, mint_block: null, vault_out_block: null }),
    settlement: () => ({ open_id: null, open_status: null }),
    amrUrl: "http://localhost:4000",
    ...over,
  };
}

test("her şey yerindeyse ok ve tüm alt sistemler listelenir", () => {
  const h = healthSnapshot(deps());
  assert.equal(h.status, "ok");
  assert.deepEqual(Object.keys(h.checks).sort(), ["controls", "events", "orders", "record", "settlement", "socket", "store", "trading", "vault"]);
  for (const c of Object.values(h.checks)) assert.ok(c.detail.length > 0);
});

test("soket kopuksa ve işlemler durduysa degraded, gerekçe metinde", () => {
  const h = healthSnapshot(deps({
    socket: () => ({ ...socketOk, connection: "DISCONNECTED", lastError: "ECONNREFUSED" }),
    trading: () => ({ open: false, reason: "rafineri soketi bağlı değil" }),
  }));
  assert.equal(h.status, "degraded");
  assert.match(h.checks.socket.detail, /bağlı değil/);
  assert.match(h.checks.trading.detail, /rafineri soketi bağlı değil/);
});

test("uyuşmazlıkta (RECONCILE) kayıt degraded, mint ve kasa çıkışı bloke görünür", () => {
  const r = emptyRecord(20_000_000);
  r.match = "RECONCILE";
  r.diffs = [{ field: "current_account.gold_mg", kz: 1, amr: 2 }];
  r.blocked = { mint: true, vault_out: true };
  const h = healthSnapshot(deps({ record: () => r, vault: () => ({ open: 1, holds: 0, awaiting_mint: 1, mint_block: "eşleşme uyuşmazlığı (RECONCILE)", vault_out_block: "eşleşme uyuşmazlığı (RECONCILE)" }) }));
  assert.equal(h.status, "degraded");
  assert.match(h.checks.record.detail, /uyuşmazlık/);
  assert.match(h.checks.vault.detail, /mint bloke/);
});

test("K1 bozuksa down ve gerekçe metinde (A ≤ V tutmuyor)", () => {
  const r = emptyRecord(20_000_000);
  mint(r, 5_000_000); // kasa karşılığı olmadan mint: A > V
  const h = healthSnapshot(deps({ record: () => r }));
  assert.equal(h.checks.controls.status, "down");
  assert.equal(h.status, "down");
  assert.match(h.checks.controls.detail, /K1/);
});

test("kalıcı durum yazılamıyorsa down", () => {
  const h = healthSnapshot(deps({ store: () => ({ path: "/x/kz-state.json", ok: false, error: "EACCES" }) }));
  assert.equal(h.status, "down");
  assert.match(h.checks.store.detail, /EACCES/);
});

test("cevapsız emir ve geç fill karar beklerken emirler degraded", () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "BUY", 1_000, "USD", 14_200);
  const h = healthSnapshot(deps({ record: () => r, counts: () => ({ orders: 3, open_orders: 1, unanswered: 1, late_fills: 1, events: 5, last_event_ts: new Date().toISOString(), notices_unread: 2 }) }));
  assert.equal(h.checks.orders.status, "degraded");
  assert.match(h.checks.orders.detail, /cevapsız emir/);
});
