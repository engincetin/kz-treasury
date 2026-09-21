import { test } from "node:test";
import assert from "node:assert/strict";
import { quote, buyTotal } from "../src/pricing.ts";

test("fiyat zinciri: marj gömülü, müşteri aleyhine yuvarlama", () => {
  const q = quote({ ccy: "USD", bid: "141.80", ask: "142.00" });
  assert.equal(q.clientBuy, "142.43"); // 142,00 × 1,0030 = 142,426 → yukarı 142,43 (iş dokümanı örneği)
  assert.equal(q.clientSell, "141.37"); // 141,80 × 0,9970 = 141,3746 → aşağı 141,37
  assert.equal(q.commissionBps, 15);
});

test("marj tavanı aşılamaz", () => {
  const q = quote({ ccy: "USD", bid: "141.80", ask: "142.00" }, { marginBps: 250, marginCapBps: 100, commissionBps: 15 });
  assert.equal(q.clientBuy, "143.42"); // %1 tavan
});

test("emir fişi: bedel + komisyon ayrı satır", () => {
  const t = buyTotal(70_104, "142.43", 15); // 70,104 g
  assert.equal(t.amount_cents, 998491); // 142,43 × 70,104 = 9.984,91
  assert.equal(t.commission_cents, 1498); // %0,15 → 14,98
  assert.equal(t.total_cents, 999989);
});
