/**
 * Mahsuplaşma (Akışlar 12) · Kanzasset tarafı testleri (K8).
 * Mutabakat KZ kaydı ile rafineri ekstresini karşılaştırır; altın bacağı kasa talimatıyla,
 * para bacağı şirket banka hesabından ödeme ile kapanır (K5).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Settlement, VaultRequest } from "@amr/contract";
import { applyFill, emptyRecord, type KzRecord } from "../src/record.ts";
import { DEFAULT_STOCK_PARAMS, VaultDesk } from "../src/vault.ts";
import { KzSettlementDesk } from "../src/settlement.ts";
import type { AmrClient } from "../src/amrClient.ts";

function makeSettlement(over: Partial<Settlement> & { gold_mg?: number; usd?: number } = {}): Settlement {
  const gold = over.gold_mg ?? 0;
  const usd = over.usd ?? 0;
  return {
    settlement_id: "stl_1", trigger: "CUTOFF", status: "DRAFT",
    window_from: "2026-09-21T00:00:00.000Z", window_to: "2026-09-21T17:00:00.000Z",
    statement: { window_from: "x", window_to: "y", movements: [], gold_mg: gold, money: [{ ccy: "USD", cents: usd }, { ccy: "EUR", cents: 0 }, { ccy: "AED", cents: 0 }], fees: [], hash: "amr-hash", signature: "sig" },
    statement_hash: "amr-hash",
    gold_leg: { t_net_mg: gold, direction: gold > 0 ? "VAULT_IN" : gold < 0 ? "VAULT_OUT" : "NONE", qty_mg: Math.abs(gold), requests: [], done: gold === 0 },
    money_leg: [
      { ccy: "USD", net_cents: usd, direction: usd < 0 ? "KZ_TO_AMR" : usd > 0 ? "AMR_TO_KZ" : "NONE", paid: usd === 0 },
      { ccy: "EUR", net_cents: 0, direction: "NONE", paid: true },
      { ccy: "AED", net_cents: 0, direction: "NONE", paid: true },
    ],
    opened_ts: "2026-09-21T17:00:00.000Z", history: [],
    ...over,
  } as Settlement;
}

function setup(record: KzRecord, amrGold: number, amrUsd: number) {
  const calls: { kind: string; arg?: unknown }[] = [];
  let confirmedHash = "";
  let n = 0;
  const amr = {
    async settlementOpen() { calls.push({ kind: "open" }); return makeSettlement({ gold_mg: amrGold, usd: amrUsd }); },
    async settlementGet() { calls.push({ kind: "get" }); return makeSettlement({ gold_mg: amrGold, usd: amrUsd }); },
    async settlementConfirm(_id: string, hash: string) {
      confirmedHash = hash;
      calls.push({ kind: "confirm", arg: hash });
      return makeSettlement({ gold_mg: amrGold, usd: amrUsd, status: hash === "amr-hash" ? "RECONCILED" : "MISMATCH" });
    },
    async settlementPaymentNotice() { calls.push({ kind: "notice" }); return makeSettlement({ gold_mg: amrGold, usd: amrUsd, status: "PAYMENT_PENDING" }); },
    async settlementPaymentReceived() { calls.push({ kind: "received" }); return makeSettlement({ gold_mg: amrGold, usd: amrUsd, status: "SETTLED" }); },
    async vaultIn(qty_mg: number, ref: string): Promise<VaultRequest> {
      calls.push({ kind: "vaultIn", arg: qty_mg });
      return { request_id: `vr_${++n}`, type: "IN", qty_mg, ref, status: "REQUESTED", requested_ts: new Date().toISOString() };
    },
    async vaultOut(qty_mg: number, ref: string): Promise<VaultRequest> {
      calls.push({ kind: "vaultOut", arg: qty_mg });
      return { request_id: `vr_${++n}`, type: "OUT", qty_mg, ref, status: "REQUESTED", requested_ts: new Date().toISOString() };
    },
  } as unknown as AmrClient;

  const vault = new VaultDesk({ amr, record: () => record, params: () => ({ ...DEFAULT_STOCK_PARAMS, placingCapMg: 0 }), notify: () => {}, onChange: () => {} });
  const desk = new KzSettlementDesk({ amr, record: () => record, vault: () => vault, notify: () => {}, onChange: () => {} });
  return { desk, vault, calls, record, hash: () => confirmedHash };
}

test("12 mutabakat: KZ kaydı rafineri ekstresiyle eşitse rafinerinin özeti onaylanır", async () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "BUY", 447_640, "USD", 63_732_03);
  const s = setup(r, 447_640, -63_732_03);
  const w = await s.desk.reconcile("stl_1");
  assert.equal(w.status, "RECONCILED");
  assert.equal(s.hash(), "amr-hash", "rafinerinin özeti onaylandı");
  assert.equal(w.diffs, undefined);
  assert.equal(w.kz_gold_mg, 447_640);
});

test("12 mutabakat farkı: KZ kendi toplamlarını gönderir, pencere MISMATCH olur", async () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "BUY", 400_000, "USD", 60_000_00); // rafineriden farklı
  const s = setup(r, 447_640, -63_732_03);
  const w = await s.desk.reconcile("stl_1");
  assert.equal(w.status, "MISMATCH");
  assert.notEqual(s.hash(), "amr-hash", "kendi özetimiz gönderildi");
  assert.ok((w.diffs?.length ?? 0) >= 1);
  assert.equal(w.diffs?.[0].field, "T (altın)");
});

test("12 altın bacağı: T artı ise kasa girişi, eksi ise burn + kasa çıkışı", async () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "BUY", 447_640, "USD", 63_732_03);
  const s = setup(r, 447_640, -63_732_03);
  await s.desk.reconcile("stl_1");
  const w = await s.desk.goldLeg("stl_1");
  assert.equal(w.gold_leg?.direction, "VAULT_IN");
  assert.equal(w.gold_leg?.qty_mg, 447_640);
  assert.equal(s.calls.filter((c) => c.kind === "vaultIn")[0].arg, 447_640);

  const r2 = emptyRecord(20_000_000);
  applyFill(r2, "SELL", 300_000, "USD", 42_540_00);
  const s2 = setup(r2, -300_000, 42_540_00);
  await s2.desk.reconcile("stl_1");
  const w2 = await s2.desk.goldLeg("stl_1");
  assert.equal(w2.gold_leg?.direction, "VAULT_OUT");
  assert.equal(s2.calls.filter((c) => c.kind === "vaultOut")[0].arg, 300_000);
  assert.equal(r2.stock.a_mg, 20_000_000 - 300_000, "burn kasa çıkışından önce yapıldı");
});

test("12 altın bacağı: T sıfırsa işlem yapılmaz", async () => {
  const r = emptyRecord(20_000_000);
  const s = setup(r, 0, 0);
  await s.desk.reconcile("stl_1");
  const w = await s.desk.goldLeg("stl_1");
  assert.equal(w.gold_leg?.direction, "NONE");
  assert.equal(w.gold_leg?.done, true);
  assert.equal(s.calls.filter((c) => c.kind.startsWith("vault")).length, 0);
});

test("12 para bacağı: borçluysak şirket hesabından öderiz ve cari hesap kapanır", async () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "BUY", 447_640, "USD", 63_732_03);
  assert.equal(r.current_account.money.find((m) => m.ccy === "USD")!.cents, -63_732_03);
  const s = setup(r, 447_640, -63_732_03);
  await s.desk.reconcile("stl_1");
  const w = await s.desk.pay("stl_1", "USD");
  assert.equal(w.status, "SETTLED");
  assert.equal(r.current_account.money.find((m) => m.ccy === "USD")!.cents, 0, "para tarafı kapandı");
  assert.deepEqual(s.calls.filter((c) => c.kind === "notice" || c.kind === "received").map((c) => c.kind), ["notice", "received"]);
  assert.ok(w.timeline.some((t) => t.text.includes("ŞİRKET banka hesabından")), "K5: yalnız şirket hesabı öder");
});

test("12 para bacağı: alacaklıysak ödeme bildirimi göndermeyiz, ödeme alındı deriz", async () => {
  const r = emptyRecord(20_000_000);
  applyFill(r, "SELL", 300_000, "USD", 42_540_00);
  const s = setup(r, -300_000, 42_540_00);
  await s.desk.reconcile("stl_1");
  await s.desk.pay("stl_1", "USD");
  assert.equal(r.current_account.money.find((m) => m.ccy === "USD")!.cents, 0);
  assert.equal(s.calls.filter((c) => c.kind === "notice").length, 0, "alacaklı taraf ödeme bildirmez");
  assert.equal(s.calls.filter((c) => c.kind === "received").length, 1);
});

test("12 rafineri pencere açtığında olayla haberdar oluruz", async () => {
  const r = emptyRecord(20_000_000);
  const s = setup(r, 0, 0);
  const note = s.desk.onEvent("settlement.requested", { trigger: "REQUEST_AMR", reason: "limit" });
  assert.match(note, /mahsuplaşma talebi/);
});
