/**
 * Fiziksel teslimat (10) ve rafinasyon (11) · Kanzasset tarafı testleri (K6, K7).
 * Emanet (E), burn anı ve kasa hareketleri: A = S + C + E korunur, teslimde A ve V aynı anda düşer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Catalog, Delivery, Refining } from "@amr/contract";
import { checks, emptyRecord, type KzRecord } from "../src/record.ts";
import { DEFAULT_FULFILMENT, FulfilmentDesk, type FulfilmentParams } from "../src/fulfilment.ts";
import type { AmrClient } from "../src/amrClient.ts";

const CATALOG: Catalog = {
  version: 3, updated_ts: new Date().toISOString(),
  items: [
    { item_id: "100g", name: "100 g külçe", weight_mg: 100_000, fineness: "999.9", unit_price_cents: 20_000, ccy: "USD", lead_time_days: 3, active: true },
    { item_id: "1kg", name: "1 kg külçe", weight_mg: 1_000_000, fineness: "999.9", unit_price_cents: 95_000, ccy: "USD", lead_time_days: 7, active: true },
    { item_id: "5g", name: "5 g külçe", weight_mg: 5_000, fineness: "999.9", unit_price_cents: 3_000, ccy: "USD", lead_time_days: 1, active: false },
  ],
};

function setup(record: KzRecord, params: Partial<FulfilmentParams> = {}) {
  const calls: string[] = [];
  let n = 0;
  const amr = {
    async catalog() { calls.push("catalog"); return CATALOG; },
    async deliveryCreate(b: any): Promise<Delivery> {
      calls.push("deliveryCreate");
      return { delivery_id: `dlv_${++n}`, qty_mg: b.qty_mg, address_ref: b.address_ref, insured_party_ref: b.insured_party_ref, ref: b.ref, status: "REQUESTED", requested_ts: new Date().toISOString() };
    },
    async deliveryApprove(id: string): Promise<Delivery> {
      calls.push("deliveryApprove");
      return { delivery_id: id, qty_mg: 0, address_ref: "", insured_party_ref: "", ref: "", status: "APPROVED", requested_ts: new Date().toISOString() };
    },
    async deliveryCancel(id: string): Promise<Delivery> {
      calls.push("deliveryCancel");
      return { delivery_id: id, qty_mg: 0, address_ref: "", insured_party_ref: "", ref: "", status: "CANCELLED", requested_ts: new Date().toISOString() };
    },
    async refiningCreate(b: any): Promise<Refining> {
      calls.push("refiningCreate");
      return { refining_id: `rfn_${++n}`, items: [], total_mg: 0, address_ref: b.address_ref, insured_party_ref: b.insured_party_ref, ref: b.ref, status: "REQUESTED", requested_ts: new Date().toISOString() };
    },
    async refiningApprove(id: string): Promise<Refining> {
      calls.push("refiningApprove");
      return { refining_id: id, items: [], total_mg: 0, address_ref: "", insured_party_ref: "", ref: "", status: "APPROVED", requested_ts: new Date().toISOString() };
    },
  } as unknown as AmrClient;

  const desk = new FulfilmentDesk({
    amr, record: () => record, params: () => ({ ...DEFAULT_FULFILMENT, ...params }),
    pricing: () => ({ marginBps: 30, marginCapBps: 100, commissionBps: 15 }),
    notify: () => {}, onChange: () => {},
  }, { catalog: CATALOG });
  return { desk, record, calls };
}

/** Müşteride 5.000 g dolaşan, kasada 25.000 g olan bir başlangıç. */
function recordWithCustomers(customerMg: number) {
  const r = emptyRecord(20_000_000);
  r.vault.in_vault_mg = 20_000_000 + customerMg;
  r.stock.a_mg = 20_000_000 + customerMg;
  return r;
}

test("10 teslimat: talep emanete alır (E +x, C −x), arz değişmez", async () => {
  const r = recordWithCustomers(5_000_000);
  const s = setup(r);
  const before = { a: r.stock.a_mg, c: checks(r).c_mg };
  const d = await s.desk.requestDelivery({ qty_mg: 1_000_000, address_ref: "ADR-1", insured_party_ref: "SIG-1" });
  assert.equal(d.status, "REQUESTED");
  assert.equal(d.escrowed, true);
  assert.equal(r.stock.e_mg, 1_000_000, "E +x");
  assert.equal(r.stock.a_mg, before.a, "talep anında arz değişmez");
  assert.equal(checks(r).c_mg, before.c - 1_000_000, "C −x");
  assert.ok(checks(r).k1.ok && checks(r).k2.ok);
});

test("10 onay: lojistik bedeli cari hesaba, komisyon eklenmez (müşteriden aynen alınır)", async () => {
  const r = recordWithCustomers(5_000_000);
  const s = setup(r);
  const d = await s.desk.requestDelivery({ qty_mg: 1_000_000, address_ref: "A", insured_party_ref: "S" });
  s.desk.onEvent("delivery.quoted", { ref: d.id, quote: { quote_id: "lq1", carrier: "Brinks", amount_cents: 45_000, ccy: "USD", valid_until: new Date(Date.now() + 3600_000).toISOString() } });
  assert.equal(s.desk.getDelivery(d.id)!.status, "QUOTED");
  await s.desk.approveDelivery(d.id);
  assert.equal(r.current_account.money.find((m) => m.ccy === "USD")!.cents, -45_000, "Kanzasset borçlu");
  assert.equal(s.desk.getDelivery(d.id)!.customer_price_cents, 45_000, "müşteriye aynen yansır");
});

test("10 sevkiyat ve teslim: kasadan sevkiyata, teslimde burn · A ve V aynı anda düşer", async () => {
  const r = recordWithCustomers(5_000_000);
  const s = setup(r);
  const d = await s.desk.requestDelivery({ qty_mg: 1_000_000, address_ref: "A", insured_party_ref: "S" });
  const vTotal = () => r.vault.in_vault_mg + r.vault.placing_mg + r.vault.shipping_mg;

  s.desk.onEvent("delivery.ready", { ref: d.id, shipping_doc_id: "SF-1" });
  assert.equal(r.vault.in_vault_mg, 24_000_000);
  assert.equal(r.vault.shipping_mg, 1_000_000);
  assert.equal(vTotal(), 25_000_000, "hazır adımı V toplamını değiştirmez");
  assert.ok(checks(r).k1.ok, checks(r).k1.text);

  s.desk.onEvent("delivery.shipped", { ref: d.id, carrier: "Brinks", tracking_no: "TRK-1" });
  assert.equal(s.desk.getDelivery(d.id)!.burned, false, "varsayılan burn anı teslimdir");

  s.desk.onEvent("delivery.delivered", { ref: d.id, pod_doc_id: "TK-1" });
  const item = s.desk.getDelivery(d.id)!;
  assert.equal(item.burned, true);
  assert.ok(item.burn_tx);
  assert.equal(r.vault.shipping_mg, 0);
  assert.equal(vTotal(), 24_000_000, "V −x");
  assert.equal(r.stock.a_mg, 24_000_000, "A −x");
  assert.equal(r.stock.e_mg, 0, "emanet kapandı");
  assert.ok(checks(r).k1.ok && checks(r).k2.ok, `${checks(r).k1.text} · ${checks(r).k2.text}`);
});

test("10 burn anı SHIPPED: taşıyıcıya verildiğinde yakılır", async () => {
  const r = recordWithCustomers(5_000_000);
  const s = setup(r, { burnMoment: "SHIPPED" });
  const d = await s.desk.requestDelivery({ qty_mg: 1_000_000, address_ref: "A", insured_party_ref: "S" });
  s.desk.onEvent("delivery.ready", { ref: d.id });
  s.desk.onEvent("delivery.shipped", { ref: d.id, carrier: "Brinks", tracking_no: "TRK-2" });
  assert.equal(s.desk.getDelivery(d.id)!.burned, true);
  assert.equal(r.stock.a_mg, 24_000_000);
  s.desk.onEvent("delivery.delivered", { ref: d.id });
  assert.equal(r.stock.a_mg, 24_000_000, "teslimde ikinci kez yakılmaz");
});

test("10 iptal: emanet çözülür, hazırdan iptalde külçe kasaya döner", async () => {
  const r = recordWithCustomers(5_000_000);
  const s = setup(r);
  const d = await s.desk.requestDelivery({ qty_mg: 2_000_000, address_ref: "A", insured_party_ref: "S" });
  s.desk.onEvent("delivery.ready", { ref: d.id });
  assert.equal(r.vault.shipping_mg, 2_000_000);
  s.desk.onEvent("delivery.cancelled", { ref: d.id });
  assert.equal(r.vault.shipping_mg, 0);
  assert.equal(r.vault.in_vault_mg, 25_000_000, "külçe kasaya döndü");
  assert.equal(r.stock.e_mg, 0, "emanet çözüldü");
  assert.equal(checks(r).c_mg, 5_000_000, "tokenler müşteriye döndü");
});

test("10 müşteride dolaşan token yetmezse talep açılmaz", async () => {
  const r = recordWithCustomers(500_000);
  const s = setup(r);
  await assert.rejects(() => s.desk.requestDelivery({ qty_mg: 1_000_000, address_ref: "A", insured_party_ref: "S" }), /token yetersiz/);
});

test("11 rafinasyon: kalemler toplam saf grama çevrilir, pasif ürün seçilemez", async () => {
  const r = recordWithCustomers(5_000_000);
  const s = setup(r);
  const x = await s.desk.requestRefining({ items: [{ item_id: "100g", qty: 5 }, { item_id: "1kg", qty: 2 }], address_ref: "A", insured_party_ref: "S" });
  assert.equal(x.total_mg, 2_500_000);
  assert.equal(r.stock.e_mg, 2_500_000);
  await assert.rejects(() => s.desk.requestRefining({ items: [{ item_id: "5g", qty: 1 }], address_ref: "A", insured_party_ref: "S" }), /pasif/);
});

test("11 onay: rafineriye bedel, müşteriye marj ve komisyon dahil fiyat", async () => {
  const r = recordWithCustomers(5_000_000);
  const s = setup(r);
  const x = await s.desk.requestRefining({ items: [{ item_id: "100g", qty: 5 }], address_ref: "A", insured_party_ref: "S" });
  s.desk.onEvent("refining.quoted", { ref: x.id, quote: { quote_id: "rq1", product_cents: 100_000, logistics_cents: 20_000, ccy: "USD", lead_time_days: 3, valid_until: new Date(Date.now() + 3600_000).toISOString() } });
  await s.desk.approveRefining(x.id);
  assert.equal(r.current_account.money.find((m) => m.ccy === "USD")!.cents, -120_000, "rafineriye borç yalnız bedel");
  const item = s.desk.getRefining(x.id)!;
  // marj %0,30 gömülü + komisyon %0,15 ayrı
  assert.equal(item.customer_price_cents, 120_360 + Math.round((120_360 * 15) / 10_000));
});

test("11 teslim: üretim ve sevkiyat sonrası burn, kontroller korunur", async () => {
  const r = recordWithCustomers(5_000_000);
  const s = setup(r);
  const x = await s.desk.requestRefining({ items: [{ item_id: "1kg", qty: 1 }], address_ref: "A", insured_party_ref: "S" });
  s.desk.onEvent("refining.in_production", { ref: x.id });
  assert.equal(s.desk.getRefining(x.id)!.status, "IN_PRODUCTION");
  s.desk.onEvent("refining.ready", { ref: x.id, shipping_doc_id: "SF-2" });
  s.desk.onEvent("refining.shipped", { ref: x.id, carrier: "Brinks", tracking_no: "TRK-3" });
  s.desk.onEvent("refining.delivered", { ref: x.id, pod_doc_id: "TK-2" });
  assert.equal(s.desk.getRefining(x.id)!.burned, true);
  assert.equal(r.stock.a_mg, 24_000_000);
  assert.equal(r.vault.in_vault_mg, 24_000_000);
  assert.equal(r.stock.e_mg, 0);
  assert.ok(checks(r).k1.ok && checks(r).k2.ok, `${checks(r).k1.text} · ${checks(r).k2.text}`);
});

test("teslimat ve rafinasyon hazine stokunu ve envanter hedefini değiştirmez (K2)", async () => {
  const r = recordWithCustomers(5_000_000);
  const s = setup(r);
  const s0 = r.stock.s_mg, k0 = r.stock.k_mg, t0 = r.current_account.gold_mg;
  const d = await s.desk.requestDelivery({ qty_mg: 1_000_000, address_ref: "A", insured_party_ref: "S" });
  s.desk.onEvent("delivery.ready", { ref: d.id });
  s.desk.onEvent("delivery.shipped", { ref: d.id, tracking_no: "T" });
  s.desk.onEvent("delivery.delivered", { ref: d.id });
  assert.equal(r.stock.s_mg, s0);
  assert.equal(r.stock.k_mg, k0);
  assert.equal(r.current_account.gold_mg, t0);
});
