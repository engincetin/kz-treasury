/**
 * Hazine alım satımı testleri (Akışlar 09 · ekran K5): maker-checker, onay matrisi,
 * son onaycının canlı fiyatla göndermesi ve zincir (fill → kasa girişi / çıkışı → mint / burn).
 * Açılış örneği dokümandaki gibi: 20 kg alınır, kasaya girer, 20.000 AGOLD mint edilir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrderResponse, VaultRequest } from "@amr/contract";
import { checks, emptyRecord, type KzRecord } from "../src/record.ts";
import { DEFAULT_STOCK_PARAMS, VaultDesk, type StockParams } from "../src/vault.ts";
import { DEFAULT_ORDER_PARAMS } from "../src/orders.ts";
import { TreasuryDesk, requiredApprovals } from "../src/treasury.ts";
import type { AmrClient } from "../src/amrClient.ts";

function setup(record: KzRecord, opts: { stock?: Partial<StockParams>; reject?: string } = {}) {
  const stock: StockParams = { ...DEFAULT_STOCK_PARAMS, ...opts.stock };
  const calls: { kind: string; qty_mg: number; side?: string }[] = [];
  let n = 0;
  const amr = {
    async placeOrder(o: any): Promise<OrderResponse> {
      calls.push({ kind: "order", qty_mg: o.qty_mg, side: o.side });
      if (opts.reject) return { order_id: `ord_${++n}`, client_order_id: o.client_order_id, status: "REJECTED", side: o.side, qty_mg: o.qty_mg, ccy: o.ccy, quote_seq: o.quote_seq, limit_px: o.limit_px, reject_reason: opts.reject as any, received_ts: new Date().toISOString() };
      const px = o.side === "BUY" ? "142.00" : "141.80";
      return {
        order_id: `ord_${++n}`, client_order_id: o.client_order_id, status: "FILLED", side: o.side, qty_mg: o.qty_mg, ccy: o.ccy,
        quote_seq: o.quote_seq, limit_px: o.limit_px,
        fill: { px, qty_mg: o.qty_mg, amount_cents: Math.round((Math.round(Number(px) * 100) * o.qty_mg) / 1000), ccy: o.ccy, trade_ts: new Date().toISOString() },
        received_ts: new Date().toISOString(),
      };
    },
    async vaultIn(qty_mg: number, ref: string): Promise<VaultRequest> { calls.push({ kind: "vaultIn", qty_mg }); return { request_id: `vr_${++n}`, type: "IN", qty_mg, ref, status: "ACCEPTED", doc_id: `KGF-${n}`, requested_ts: new Date().toISOString() }; },
    async vaultOut(qty_mg: number, ref: string): Promise<VaultRequest> { calls.push({ kind: "vaultOut", qty_mg }); return { request_id: `vr_${++n}`, type: "OUT", qty_mg, ref, status: "ACCEPTED", doc_id: `KCF-${n}`, requested_ts: new Date().toISOString() }; },
  } as unknown as AmrClient;

  const notify = () => {};
  const vault: VaultDesk = new VaultDesk({
    amr, record: () => record, params: () => stock, notify, onChange: () => {},
    onMinted: (i) => treasury.onMinted(i),
    onOutAccepted: (i) => treasury.onOutAccepted(i),
  });
  const treasury: TreasuryDesk = new TreasuryDesk({
    amr,
    priceState: () => ({ seq: 48_211, lastPrices: [{ ccy: "USD", bid: "141.80", ask: "142.00" }] }) as any,
    tradingOpen: () => ({ open: true, reason: "" }),
    record: () => record, stock: () => stock, orderParams: () => ({ ...DEFAULT_ORDER_PARAMS }),
    vault: () => vault, notify, onChange: () => {},
  });
  return { amr, calls, vault, treasury, record, stock };
}

test("onay matrisi: ≤5 kg 1 onay · ≤15 kg 2 onay · üstü 3 onay", () => {
  const p = DEFAULT_STOCK_PARAMS;
  assert.equal(requiredApprovals(5_000_000, p), 1);
  assert.equal(requiredApprovals(5_000_001, p), 2);
  assert.equal(requiredApprovals(15_000_000, p), 2);
  assert.equal(requiredApprovals(15_000_001, p), 3);
  assert.equal(requiredApprovals(20_000_000, p), 3);
});

test("maker-checker: hazineci kendi talebini onaylayamaz, aynı onaycı iki kez onaylayamaz", async () => {
  const r = emptyRecord(0);
  const s = setup(r);
  const req = s.treasury.create({ side: "BUY", qty_mg: 10_000_000, ccy: "USD", maker: "hazineci" });
  assert.equal(req.required_approvals, 2);
  await assert.rejects(() => s.treasury.approve(req.id, "hazineci"), /kendi talebini onaylayamaz/);
  await s.treasury.approve(req.id, "onaycı-1");
  await assert.rejects(() => s.treasury.approve(req.id, "onaycı-1"), /zaten onayladı/);
  assert.equal(s.treasury.get(req.id)!.status, "ONAY_BEKLİYOR", "eksik onayla emir gitmez");
  assert.equal(s.calls.length, 0);
});

test("09 açılış alımı 20 kg: 3 onay → canlı fiyatla emir → kasa girişi → mint · S = K = 20.000, T 0, A = V", async () => {
  const r = emptyRecord(0);
  // açılış günü 20 kg tek seferde kasaya girer: "kasaya konuluyor" tavanı buna göre açılır
  const s = setup(r, { stock: { placingCapMg: 20_000_000 } });
  const req = s.treasury.create({ side: "BUY", qty_mg: 20_000_000, ccy: "USD", maker: "hazineci" });
  assert.equal(req.required_approvals, 3);
  assert.equal(req.quoted_px, "142.00");
  assert.equal(req.quoted_amount_cents, 2_840_000_00);

  await s.treasury.approve(req.id, "onaycı-1");
  await s.treasury.approve(req.id, "onaycı-2");
  const done = await s.treasury.approve(req.id, "onaycı-3"); // son onaycı gönderir

  assert.equal(done.status, "TAMAM");
  assert.equal(done.fill_px, "142.00");
  assert.equal(done.target_after_mg, 20_000_000, "envanter hedefi K 0 → 20.000");
  assert.equal(r.stock.s_mg, 20_000_000);
  assert.equal(r.stock.a_mg, 20_000_000);
  assert.equal(r.stock.k_mg, 20_000_000);
  assert.equal(r.current_account.gold_mg, 0, "T kapandı");
  assert.equal(r.vault.placing_mg, 20_000_000, "kasaya konuluyor (T+3 içinde kasada olur)");
  assert.ok(checks(r).k1.ok && checks(r).k2.ok, `${checks(r).k1.text} · ${checks(r).k2.text}`);
  assert.equal(r.current_account.money.find((m) => m.ccy === "USD")?.cents, -2_840_000_00, "bedel mahsuplaşmada: Kanzasset borçlu");
  assert.deepEqual(s.calls.map((c) => c.kind), ["order", "vaultIn"]);
});

test("09 hazine satışı 5.000 g: fill → burn → kasa çıkışı · K 20.000 → 15.000", async () => {
  const r = emptyRecord(20_000_000);
  const s = setup(r);
  const req = s.treasury.create({ side: "SELL", qty_mg: 5_000_000, ccy: "USD", maker: "hazineci" });
  assert.equal(req.required_approvals, 1, "5 kg → tek onay");
  const done = await s.treasury.approve(req.id, "onaycı-1");

  assert.equal(done.status, "TAMAM");
  assert.equal(done.fill_px, "141.80");
  assert.equal(done.target_after_mg, 15_000_000, "K 20.000 → 15.000");
  assert.equal(r.stock.s_mg, 15_000_000, "burn hazine stokundan");
  assert.equal(r.stock.a_mg, 15_000_000);
  assert.equal(r.vault.in_vault_mg, 15_000_000, "V −5.000");
  assert.equal(r.current_account.gold_mg, 0, "T kapandı");
  assert.ok(checks(r).k1.ok && checks(r).k2.ok, `${checks(r).k1.text} · ${checks(r).k2.text}`);
  assert.equal(r.current_account.money.find((m) => m.ccy === "USD")?.cents, 709_000_00, "rafineri borçlu 709.000,00 USD");
  assert.deepEqual(s.calls.map((c) => c.kind), ["order", "vaultOut"]);
});

test("hazine satışında yalnız hazine stokundaki tokenler yakılır: stok yetmezse talep açılmaz", () => {
  const r = emptyRecord(1_000_000);
  const s = setup(r);
  assert.throws(() => s.treasury.create({ side: "SELL", qty_mg: 5_000_000, ccy: "USD", maker: "hazineci" }), /hazine stoku yetersiz/);
});

test("emir reddedilirse zincir kurulmaz: kasa talimatı gitmez, hedef değişmez", async () => {
  const r = emptyRecord(20_000_000);
  const s = setup(r, { reject: "PRICE_OUTSIDE_LIMIT" });
  const req = s.treasury.create({ side: "BUY", qty_mg: 3_000_000, ccy: "USD", maker: "hazineci" });
  const done = await s.treasury.approve(req.id, "onaycı-1");
  assert.equal(done.status, "REDDEDİLDİ");
  assert.equal(done.reject_reason, "PRICE_OUTSIDE_LIMIT");
  assert.equal(r.stock.k_mg, 20_000_000, "envanter hedefi değişmedi");
  assert.equal(s.calls.filter((c) => c.kind === "vaultIn").length, 0);
});

test("kasaya konuluyor tavanı hazine alımını da durdurur: emir gerçekleşir, kasa girişi bekler", async () => {
  const r = emptyRecord(0);
  const s = setup(r, { stock: { placingCapMg: 10_000_000 } });
  const req = s.treasury.create({ side: "BUY", qty_mg: 20_000_000, ccy: "USD", maker: "hazineci" });
  await s.treasury.approve(req.id, "onaycı-1");
  await s.treasury.approve(req.id, "onaycı-2");
  const done = await s.treasury.approve(req.id, "onaycı-3");

  assert.equal(done.status, "ZİNCİR_SÜRÜYOR", "zincir kasa girişinde bekler");
  assert.equal(s.vault.get(done.vault_ref!)!.status, "HOLD");
  assert.equal(r.stock.a_mg, 0, "mint yapılmadı");
  assert.equal(r.current_account.gold_mg, 20_000_000, "gramlar cari hesapta birikti (K3 izler)");
});

test("iptal yalnız onay beklerken: gönderilmiş talep iptal edilemez", async () => {
  const r = emptyRecord(20_000_000);
  const s = setup(r);
  const req = s.treasury.create({ side: "BUY", qty_mg: 3_000_000, ccy: "USD", maker: "hazineci" });
  assert.equal(s.treasury.cancel(req.id, "hazineci").status, "İPTAL");
  const req2 = s.treasury.create({ side: "BUY", qty_mg: 3_000_000, ccy: "USD", maker: "hazineci" });
  await s.treasury.approve(req2.id, "onaycı-1");
  assert.throws(() => s.treasury.cancel(req2.id, "hazineci"), /iptal edilemez/);
});
