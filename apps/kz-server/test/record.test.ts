/** KZ kaydı, eşleşme kuralı (02) ve slippage limiti testleri. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFill, checks, compare, emptyRecord, resolveWithSnapshot } from "../src/record.ts";
import { limitPx } from "../src/orders.ts";
import type { Account } from "@amr/contract";

const acc = (over: Partial<Account["current_account"]> & { seq?: number; vault?: Account["vault"] }): Account => ({
  seq: over.seq ?? 2,
  vault: over.vault ?? { in_vault_mg: 20_000_000, placing_mg: 0, shipping_mg: 0 },
  current_account: { gold_mg: over.gold_mg ?? 0, money: over.money ?? [{ ccy: "USD", cents: 0 }, { ccy: "EUR", cents: 0 }, { ccy: "AED", cents: 0 }] },
  status: "OK",
});

test("stoktan alış 70,104 g: KZ kaydı T +70,104 · P[USD] −9.954,77 · S −70,104 · S + T = K · A ≤ V", () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "BUY", 70_104, "USD", 995_477);
  assert.equal(r.current_account.gold_mg, 70_104);
  assert.equal(r.current_account.money.find((m) => m.ccy === "USD")?.cents, -995_477);
  assert.equal(r.stock.s_mg, 20_000_000 - 70_104);
  const c = checks(r);
  assert.ok(c.k1.ok && c.k2.ok, `${c.k1.text} · ${c.k2.text}`);
  assert.equal(c.c_mg, 70_104, "müşteride dolaşan");
  const res = compare(r, acc({ gold_mg: 70_104, money: [{ ccy: "USD", cents: -995_477 }, { ccy: "EUR", cents: 0 }, { ccy: "AED", cents: 0 }] }));
  assert.equal(res.equal, true);
  assert.equal(r.match, "EŞİT");
  assert.equal(r.seq, 2);
  assert.equal(r.blocked.mint, false);
});

test("uyuşmazlık → RECONCILE, mint ve kasa çıkışı bloke; seq boşluğu işaretlenir; çözümle fotoğraf alınır", () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "SELL", 50_000, "USD", 709_000);
  const res = compare(r, acc({ seq: 7, gold_mg: -50_000, money: [{ ccy: "USD", cents: 709_100 }, { ccy: "EUR", cents: 0 }, { ccy: "AED", cents: 0 }] }));
  assert.equal(res.equal, false);
  assert.equal(res.seqGap, true);
  assert.equal(r.match, "RECONCILE");
  assert.deepEqual(r.blocked, { mint: true, vault_out: true });
  assert.equal(r.diffs[0].field, "current_account.money.USD");
  assert.equal(r.seq, 1, "uyuşmazlıkta seq ilerlemez");
  resolveWithSnapshot(r, acc({ seq: 7, gold_mg: -50_000, money: [{ ccy: "USD", cents: 709_100 }, { ccy: "EUR", cents: 0 }, { ccy: "AED", cents: 0 }] }), "rafineri 1,00 USD yuvarlama farkı, kabul edildi");
  assert.equal(r.match, "EŞİT");
  assert.equal(r.seq, 7);
  assert.equal(r.corrections.length, 1);
});

test("slippage limiti: alışta ask × (1 + s) yukarı, satışta bid × (1 − s) aşağı", () => {
  assert.equal(limitPx("BUY", "142.00", 100), "143.42");
  assert.equal(limitPx("SELL", "141.80", 100), "140.38");
  assert.equal(limitPx("BUY", "142.00", 20), "142.29"); // 142,284 → yukarı
  assert.equal(limitPx("SELL", "142.00", 20), "141.71"); // 141,716 → aşağı
});
