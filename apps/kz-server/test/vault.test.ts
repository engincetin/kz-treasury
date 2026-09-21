/**
 * Kasa talimatları, mint / burn sırası ve büyük alış / satış testleri
 * (Akışlar 05, 06, 07, 08 · ekran K4).
 * Rakamlar dokümandaki örneklerle aynı: 07'de S 19.052,360 · emir 15.000 · eksik 5.947,640;
 * 08'de S 20.000 · satış 10.000 · fazla 10.000.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrderResponse, VaultRequest } from "@amr/contract";
import { applyFill, checks, emptyRecord, type KzRecord } from "../src/record.ts";
import { DEFAULT_STOCK_PARAMS, VaultDesk, type StockParams } from "../src/vault.ts";
import { DEFAULT_ORDER_PARAMS, OrderDesk } from "../src/orders.ts";
import type { AmrClient } from "../src/amrClient.ts";

/** Rafineri taklidi: kasa talimatlarını hemen kabul eder (otomatik kabul), emirleri istenen fiyattan doldurur. */
function fakeAmr(opts: { autoAccept?: boolean; fillPx?: string; reject?: string } = {}) {
  const calls: { kind: string; qty_mg: number; ref?: string; side?: string }[] = [];
  let n = 0;
  const vaultReply = (type: "IN" | "OUT", qty_mg: number, ref: string): VaultRequest => ({
    request_id: `vr_${++n}`, type, qty_mg, ref,
    status: (opts.autoAccept ?? true) ? "ACCEPTED" : "REQUESTED",
    doc_id: (opts.autoAccept ?? true) ? `${type === "IN" ? "KGF" : "KCF"}-${n}` : undefined,
    requested_ts: new Date().toISOString(),
  });
  const amr = {
    async placeOrder(o: any): Promise<OrderResponse> {
      calls.push({ kind: "order", qty_mg: o.qty_mg, side: o.side });
      if (opts.reject) return { order_id: `ord_${++n}`, client_order_id: o.client_order_id, status: "REJECTED", side: o.side, qty_mg: o.qty_mg, ccy: o.ccy, quote_seq: o.quote_seq, limit_px: o.limit_px, reject_reason: opts.reject as any, received_ts: new Date().toISOString() };
      const px = opts.fillPx ?? (o.side === "BUY" ? "142.00" : "141.80");
      const amount_cents = Math.round((Math.round(Number(px) * 100) * o.qty_mg) / 1000);
      return {
        order_id: `ord_${++n}`, client_order_id: o.client_order_id, status: "FILLED", side: o.side, qty_mg: o.qty_mg, ccy: o.ccy,
        quote_seq: o.quote_seq, limit_px: o.limit_px, fill: { px, qty_mg: o.qty_mg, amount_cents, ccy: o.ccy, trade_ts: new Date().toISOString() },
        received_ts: new Date().toISOString(),
      };
    },
    async vaultIn(qty_mg: number, ref: string) { calls.push({ kind: "vaultIn", qty_mg, ref }); return vaultReply("IN", qty_mg, ref); },
    async vaultOut(qty_mg: number, ref: string) { calls.push({ kind: "vaultOut", qty_mg, ref }); return vaultReply("OUT", qty_mg, ref); },
  } as unknown as AmrClient;
  return { amr, calls };
}

function setup(record: KzRecord, opts: { autoAccept?: boolean; stock?: Partial<StockParams>; reject?: string } = {}) {
  const { amr, calls } = fakeAmr({ autoAccept: opts.autoAccept, reject: opts.reject });
  const stock: StockParams = { ...DEFAULT_STOCK_PARAMS, ...opts.stock };
  const notices: { type: string; title: string }[] = [];
  const notify = (type: string, title: string) => { notices.push({ type, title }); };
  const vault: VaultDesk = new VaultDesk({
    amr, record: () => record, params: () => stock, notify, onChange: () => {},
    onMinted: (i) => desk.deliverPending(i),
  });
  const desk: OrderDesk = new OrderDesk({
    amr,
    priceState: () => ({ seq: 48_211, lastPrices: [{ ccy: "USD", bid: "141.80", ask: "142.00" }] }) as any,
    tradingOpen: () => ({ open: true, reason: "" }),
    pricing: () => ({ marginBps: 30, marginCapBps: 100, commissionBps: 15 }),
    params: () => ({ ...DEFAULT_ORDER_PARAMS }),
    record: () => record, onChange: () => {}, notify,
    stock: () => stock, vault: () => vault,
  });
  return { amr, calls, vault, desk, stock, record, notices };
}

test("05 kasa girişi: fiş önce, mint sonra · T −q, kasaya konuluyor +q, A +q, S +q · A ≤ V korunur", async () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "BUY", 5_947_640, "USD", 844_565); // gramlar emirde alındı, T'de duruyor
  const s = setup(r, { autoAccept: false });

  const inst = await s.vault.requestIn(5_947_640, "MANUAL");
  assert.equal(inst.status, "REQUESTED");
  assert.equal(inst.minted, false, "talep anında mint yok");
  assert.equal(r.stock.a_mg, 20_000_000, "arz talep anında değişmez");

  // rafineri kabul etti: Kasa Giriş Fişi geldi
  s.vault.onEvent("vault.in_accepted", { ...asReq(inst), status: "ACCEPTED", doc_id: "KGF-1" });
  assert.equal(r.current_account.gold_mg, 0, "T −q");
  assert.equal(r.vault.placing_mg, 5_947_640);
  assert.equal(s.vault.get(inst.ref)!.minted, true, "fişe karşı mint yapıldı (K4)");
  assert.equal(r.stock.a_mg, 25_947_640, "A +q");
  assert.equal(r.stock.s_mg, 20_000_000, "mint hazine stokuna eklendi: 14.052,360 + 5.947,640");
  assert.ok(checks(r).k1.ok, checks(r).k1.text);

  s.vault.onEvent("vault.in_placed", { ...asReq(inst), status: "PLACED" });
  assert.equal(r.vault.placing_mg, 0);
  assert.equal(r.vault.in_vault_mg, 25_947_640);
  assert.ok(checks(r).k1.ok && checks(r).k2.ok, `${checks(r).k1.text} · ${checks(r).k2.text}`);
});

test("06 kasa çıkışı: burn talepten önce, A ≤ V hiç bozulmaz · kabulde kasada −b, T +b", async () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "SELL", 10_000_000, "USD", 1_418_000_00); // T −10.000
  const s = setup(r, { autoAccept: false });

  const inst = await s.vault.requestOut(10_000_000, "MANUAL");
  assert.equal(inst.burned, true, "burn talepten önce");
  assert.equal(r.stock.a_mg, 10_000_000, "A −b");
  assert.ok(checks(r).k1.ok, `burn sonrası A ≤ V: ${checks(r).k1.text}`);
  assert.equal(r.vault.in_vault_mg, 20_000_000, "kasa henüz değişmedi");

  s.vault.onEvent("vault.out_accepted", { ...asReq(inst), status: "ACCEPTED", doc_id: "KCF-1" });
  assert.equal(r.vault.in_vault_mg, 10_000_000);
  assert.equal(r.current_account.gold_mg, 0, "T kapandı");
  assert.ok(checks(r).k1.ok && checks(r).k2.ok, `${checks(r).k1.text} · ${checks(r).k2.text}`);
});

test("mint bloke (RECONCILE): fiş gelir, mint bekler; bloke kalkınca flushMints mint'i yapar", async () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "BUY", 1_000_000, "USD", 142_000);
  r.blocked = { mint: true, vault_out: true };
  const s = setup(r, { autoAccept: false });

  const inst = await s.vault.requestIn(1_000_000, "MANUAL");
  s.vault.onEvent("vault.in_accepted", { ...asReq(inst), status: "ACCEPTED", doc_id: "KGF-9" });
  assert.equal(s.vault.get(inst.ref)!.minted, false, "bloke sırasında mint yapılmaz");
  assert.equal(s.vault.awaitingMint().length, 1);
  assert.equal(r.stock.a_mg, 20_000_000, "arz değişmedi");
  assert.match(s.vault.mintBlock() ?? "", /RECONCILE/);

  r.blocked = { mint: false, vault_out: false };
  s.vault.flushMints();
  assert.equal(s.vault.get(inst.ref)!.minted, true);
  assert.equal(r.stock.a_mg, 21_000_000);
});

test("kasa çıkışı RECONCILE'de bloke: burn yapılmaz, talep gönderilmez", async () => {
  const r = emptyRecord(20_000_000);
  r.blocked = { mint: true, vault_out: true };
  const s = setup(r);
  const inst = await s.vault.requestOut(1_000_000, "MANUAL");
  assert.equal(inst.status, "HOLD");
  assert.equal(inst.burned, false, "bloke iken burn yapılmaz");
  assert.equal(r.stock.a_mg, 20_000_000);
  assert.equal(s.calls.filter((c) => c.kind === "vaultOut").length, 0, "rafineriye talep gitmez");
});

test("kasaya konuluyor tavanı: aşacak giriş talebi durur (HOLD), tavan boşalınca yeniden denenir", async () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "BUY", 12_000_000, "USD", 1_704_000_00);
  const s = setup(r, { autoAccept: false, stock: { placingCapMg: 10_000_000 } });

  const first = await s.vault.requestIn(8_000_000, "BIG_BUY");
  assert.equal(first.status, "REQUESTED");
  const second = await s.vault.requestIn(4_000_000, "BIG_BUY");
  assert.equal(second.status, "HOLD", "8.000 + 4.000 > 10.000 tavanı");
  assert.match(second.hold_reason ?? "", /tavanı/);
  assert.equal(s.calls.filter((c) => c.kind === "vaultIn").length, 1, "duran talep rafineriye gitmez");

  // ilk giriş kasaya konunca kuyruk boşalır
  s.vault.onEvent("vault.in_accepted", { ...asReq(first), status: "ACCEPTED", doc_id: "KGF-1" });
  s.vault.onEvent("vault.in_placed", { ...asReq(first), status: "PLACED" });
  assert.equal(s.vault.committedPlacingMg(), 0);
  const retried = await s.vault.retry(second.ref);
  assert.equal(retried.status, "REQUESTED");
});

test("T+3 vadesi geçti: yeni mint bloke olur, kasaya konuldu ile bloke kalkar", async () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "BUY", 2_000_000, "USD", 284_000);
  const s = setup(r, { autoAccept: false });

  const a = await s.vault.requestIn(1_000_000, "MANUAL");
  s.vault.onEvent("vault.in_accepted", { ...asReq(a), status: "ACCEPTED", doc_id: "KGF-1" });
  s.vault.onEvent("vault.in_overdue", { ...asReq(a), status: "OVERDUE" });
  assert.match(s.vault.mintBlock() ?? "", /T\+3/);

  const b = await s.vault.requestIn(1_000_000, "MANUAL");
  s.vault.onEvent("vault.in_accepted", { ...asReq(b), status: "ACCEPTED", doc_id: "KGF-2" });
  assert.equal(s.vault.get(b.ref)!.minted, false, "vade geçmişken yeni mint bloke");

  s.vault.onEvent("vault.in_placed", { ...asReq(a), status: "PLACED" });
  assert.equal(s.vault.mintBlock(), null);
  assert.equal(s.vault.get(b.ref)!.minted, true, "bloke kalkınca bekleyen mint yapıldı");
});

test("07 büyük alış: S 19.052,360 · emir 15.000 → eksik 5.947,640 kasa girişi, mint sonrası TEK SEFERDE teslim", async () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "BUY", 947_640, "USD", 134_565); // gün içi stoktan alışlar: S 19.052,360 · T +947,640
  assert.equal(r.stock.s_mg, 19_052_360);
  const s = setup(r, { autoAccept: true, stock: { floorMg: 10_000_000, targetMg: 20_000_000 } });

  const o = await s.desk.place({ side: "BUY", qty_mg: 15_000_000, ccy: "USD" });
  assert.equal(o.flow, "BÜYÜK_ALIŞ");
  assert.equal(o.chain_mg, 5_947_640, "eksik = 15.000 − (19.052,360 − 10.000)");
  assert.equal(o.customer_status, "TESLİM EDİLDİ", "otomatik kabulde zincir aynı anda kapandı");

  assert.equal(r.stock.s_mg, 10_000_000, "S tabana indi");
  assert.equal(r.current_account.gold_mg, 10_000_000, "T = 10.000");
  assert.equal(r.stock.k_mg, 20_000_000, "envanter hedefi değişmez");
  assert.ok(checks(r).k2.ok, checks(r).k2.text); // S + T = K
  assert.equal(r.vault.in_vault_mg + r.vault.placing_mg, 25_947_640, "V = 25.947,640");
  assert.equal(r.stock.a_mg, 25_947_640, "A = V");
  assert.ok(checks(r).k1.ok, checks(r).k1.text);
  assert.equal(s.calls.filter((c) => c.kind === "vaultIn")[0].qty_mg, 5_947_640);
});

test("07 mint_policy FULL_ORDER: kasa girişi emrin tamamı kadar istenir", async () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "BUY", 947_640, "USD", 134_565);
  const s = setup(r, { autoAccept: true, stock: { mintPolicy: "FULL_ORDER" } });
  const o = await s.desk.place({ side: "BUY", qty_mg: 15_000_000, ccy: "USD" });
  assert.equal(o.chain_mg, 15_000_000);
  assert.equal(r.stock.s_mg, 19_052_360 + 15_000_000 - 15_000_000);
});

test("07 mint bloke: teslim beklemede kalır, bloke kalkınca teslim edilir (kısmi teslim yok)", async () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "BUY", 947_640, "USD", 134_565);
  r.blocked = { mint: true, vault_out: true };
  const s = setup(r, { autoAccept: true });

  const o = await s.desk.place({ side: "BUY", qty_mg: 15_000_000, ccy: "USD" });
  assert.equal(o.customer_status, "TESLİM BEKLİYOR");
  assert.equal(r.stock.s_mg, 19_052_360, "teslim yapılmadı: stok değişmedi");
  assert.equal(s.desk.awaitingDelivery().length, 1);

  r.blocked = { mint: false, vault_out: false };
  s.vault.flushMints();
  assert.equal(s.desk.get(o.id)!.customer_status, "TESLİM EDİLDİ");
  assert.equal(r.stock.s_mg, 10_000_000);
  assert.ok(checks(r).k2.ok, checks(r).k2.text);
});

test("03 stoktan alış: taban aşılmıyorsa zincir kurulmaz, teslim anında yapılır", async () => {
  const r = emptyRecord(20_000_000);
  const s = setup(r, { autoAccept: true });
  const o = await s.desk.place({ side: "BUY", qty_mg: 70_104, ccy: "USD" });
  assert.equal(o.flow, "STOK");
  assert.equal(o.customer_status, "TESLİM EDİLDİ");
  assert.equal(s.calls.filter((c) => c.kind === "vaultIn").length, 0);
  assert.equal(r.stock.s_mg, 20_000_000 - 70_104);
  assert.equal(r.current_account.gold_mg, 70_104);
});

test("08 büyük satış: S 20.000 · satış 10.000 → tavan aşıldı, fazla 10.000 burn + kasa çıkışı", async () => {
  const r = emptyRecord(20_000_000);
  // müşteride 10.000 dolaşıyor: A = V = 30.000, S = 20.000, C = 10.000
  r.vault.in_vault_mg = 30_000_000;
  r.stock.a_mg = 30_000_000;
  const s = setup(r, { autoAccept: true, stock: { ceilingMg: 21_000_000, targetMg: 20_000_000 } });

  const o = await s.desk.place({ side: "SELL", qty_mg: 10_000_000, ccy: "USD" });
  assert.equal(o.flow, "BÜYÜK_SATIŞ");
  assert.equal(o.chain_mg, 10_000_000, "fazla = S(30.000) − hedef(20.000)");
  assert.equal(o.customer_status, "ÖDENDİ");

  assert.equal(r.stock.s_mg, 20_000_000, "stok hedefe döndü");
  assert.equal(r.stock.a_mg, 20_000_000, "A −10.000 (burn)");
  assert.equal(r.vault.in_vault_mg, 20_000_000, "V −10.000 (kasa çıkışı)");
  assert.equal(r.current_account.gold_mg, 0, "T kapandı");
  assert.ok(checks(r).k1.ok && checks(r).k2.ok, `${checks(r).k1.text} · ${checks(r).k2.text}`);
  assert.equal(r.current_account.money.find((m) => m.ccy === "USD")?.cents, 1_418_000_00, "rafineri borçlu 1.418.000,00 USD");
});

test("04 stoktan satış: tavan aşılmıyorsa burn ve kasa çıkışı yok", async () => {
  const r = emptyRecord(20_000_000);
  r.vault.in_vault_mg = 20_050_000;
  r.stock.a_mg = 20_050_000;
  const s = setup(r, { autoAccept: true });
  const o = await s.desk.place({ side: "SELL", qty_mg: 50_000, ccy: "USD" });
  assert.equal(o.flow, "STOK");
  assert.equal(s.calls.filter((c) => c.kind === "vaultOut").length, 0);
  assert.equal(r.stock.s_mg, 20_050_000);
  assert.equal(r.current_account.gold_mg, -50_000);
});

/** Olay gövdesi: rafineriden gelen VaultRequest. */
function asReq(inst: { ref: string; type: "IN" | "OUT"; qty_mg: number; request_id?: string }): VaultRequest {
  return { request_id: inst.request_id ?? "vr_x", type: inst.type, qty_mg: inst.qty_mg, ref: inst.ref, status: "REQUESTED", requested_ts: new Date().toISOString() };
}
