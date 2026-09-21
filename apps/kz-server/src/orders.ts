/**
 * Emir masası (Akışlar 03 Stoktan alış, 04 Stoktan satış, 07 Büyük alış, 08 Büyük satış, Durum · Cevapsız emir; K3).
 *
 *  Müşteri emri → rafineri emri birebir (0,001 g), client_order_id = müşteri emri id'si.
 *  Sıra (03): bloke → rafineride alış emri → teslim → tahsilat. (04): AGOLD bloke → satış emri → önce ödeme → token stoğa.
 *  Banka ve BitGo bacakları bu demoda simüle edilir (durum metni), rafineri bacağı gerçektir.
 *  quote_seq: emrin dayandığı tick · limit_px: slippage koruması (alışta ask × (1 + s), satışta bid × (1 − s)) · FOK · time_limit_ms.
 *  Cevapsız: zaman sınırı + kısa bekleme → durum sorgusu → açıksa iptal (kesin cevap). Geç fill → pozisyon kararı (kapat / taşı).
 *  Her fill KZ kaydına işlenir ve bakiye bilgisiyle karşılaştırılır (02).
 *
 *  Büyük alış (07): teslim sonrası stok tabanın altına inecekse fiyat fill'de kilitlenir, eksik kadar kasa girişi
 *  istenir (mint_policy: SHORTFALL eksik kısım, FULL_ORDER emrin tamamı), mint tamamlanınca TEK SEFERDE teslim edilir.
 *  Kısmi teslim yoktur; müşteriye "emriniz yeni ihraçla karşılandı" ifşası yapılır.
 *  Büyük satış (08): tokenler stoğa döner, stok tavanı aşılırsa fazla (S − hedef) burn edilir ve kasa çıkışı istenir.
 */
import { randomUUID } from "node:crypto";
import type { Account, Ccy, OrderRequest, OrderResponse } from "@amr/contract";
import { AmrClient, AmrHttpError, AmrTimeout } from "./amrClient.ts";
import { applyDelivery, applyFill, compare, type KzRecord } from "./record.ts";
import { quote, type PricingParams } from "./pricing.ts";
import type { PriceClientState } from "./priceClient.ts";
import type { StockParams, VaultDesk, VaultInstruction } from "./vault.ts";

export interface OrderParams {
  slippageBps: number; // 100 = %1 (aralık %0,2 ile %5)
  timeLimitMs: number; // 3000
  unansweredGraceMs: number; // zaman sınırından sonra sorgudan önce bekleme
  minOrderUsdCents: number; // 1000 = 10 USD
}
export const DEFAULT_ORDER_PARAMS: OrderParams = { slippageBps: 100, timeLimitMs: 3000, unansweredGraceMs: 1000, minOrderUsdCents: 1000 };

export type CustomerStatus = "BLOKE" | "TESLİM BEKLİYOR" | "TESLİM EDİLDİ" | "ÖDENDİ" | "İPTAL" | "BEKLİYOR";
/** STOK: stoktan alış / satış (03, 04) · BÜYÜK_ALIŞ: 07 (önce mint) · BÜYÜK_SATIŞ: 08 (fazlayı burn). */
export type OrderFlow = "STOK" | "BÜYÜK_ALIŞ" | "BÜYÜK_SATIŞ";
export interface CustomerOrder {
  id: string; // = client_order_id
  ts: string;
  customer_ref: string;
  side: "BUY" | "SELL"; // müşteri alır = BUY (biz rafineriden alırız)
  qty_mg: number;
  ccy: Ccy;
  quote_seq: number;
  refinery_quote_px: string; // emir anındaki ask / bid
  limit_px: string;
  client_px: string; // müşteri fiyatı (marj gömülü)
  client_amount_cents: number;
  commission_cents: number;
  client_total_cents: number; // alışta bedel + komisyon, satışta bedel − komisyon
  status: "SENT" | "FILLED" | "REJECTED" | "CANCELLED" | "UNANSWERED" | "LATE_FILL" | "ERROR";
  customer_status: CustomerStatus;
  refinery: OrderResponse | null;
  reject_reason?: string;
  error?: string;
  margin_cents?: number; // gerçekleşen marj: (müşteri fiyatı − fill) × gram
  match?: "EŞİT" | "RECONCILE";
  decision?: "CLOSE" | "CARRY";
  decision_order_id?: string;
  /** Hangi akış: stoktan (03, 04) ya da büyük alış / satış (07, 08). */
  flow?: OrderFlow;
  /** 07 / 08 zincirinin kasa talimatı referansı. */
  vault_ref?: string;
  /** 07: kasa girişi istenen eksik gram · 08: burn edilen fazla gram. */
  chain_mg?: number;
  timeline: { ts: string; text: string }[];
}

const toCents = (px: string) => Math.round(Number(px) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);
const amountCents = (pxCents: number, qtyMg: number) => Math.round((pxCents * qtyMg) / 1000);
const fmtG = (mg: number) => (mg / 1000).toFixed(3);

export function limitPx(side: "BUY" | "SELL", refineryPx: string, slippageBps: number): string {
  const c = toCents(refineryPx);
  return fromCents(side === "BUY" ? Math.ceil((c * (10_000 + slippageBps)) / 10_000) : Math.floor((c * (10_000 - slippageBps)) / 10_000));
}

export interface DeskDeps {
  amr: AmrClient;
  priceState: () => PriceClientState;
  tradingOpen: () => { open: boolean; reason: string };
  pricing: () => PricingParams;
  params: () => OrderParams;
  record: () => KzRecord;
  onChange: () => void; // kalıcılık + canlı akış
  notify: (type: string, title: string, body?: string) => void;
  /** Stok tabanı / tavanı / hedefi ve mint politikası (07, 08). */
  stock: () => StockParams;
  /** Kasa talimatları masası: büyük alışta kasa girişi, büyük satışta kasa çıkışı. */
  vault: () => VaultDesk;
}

export class OrderDesk {
  orders: CustomerOrder[] = [];
  constructor(private d: DeskDeps, initial: CustomerOrder[] = []) { this.orders = initial; }

  list(limit = 200) { return this.orders.slice(0, limit); }
  get(id: string) { return this.orders.find((o) => o.id === id); }
  unanswered() { return this.orders.filter((o) => o.status === "UNANSWERED"); }
  lateFills() { return this.orders.filter((o) => o.status === "LATE_FILL" && !o.decision); }

  /** Müşteri emri: fiyat, bloke, rafineri emri, sonuç. Hata fırlatmaz; sonuç emir kaydında. */
  async place(input: { side: "BUY" | "SELL"; qty_mg: number; ccy: Ccy; customer_ref?: string }): Promise<CustomerOrder> {
    const t = this.d.tradingOpen();
    if (!t.open) throw new Error(`müşteri işlemleri kapalı: ${t.reason}`);
    const ps = this.d.priceState();
    const level = ps.lastPrices?.find((p) => p.ccy === input.ccy);
    if (!level || !ps.seq) throw new Error("fiyat yok");
    if (!Number.isInteger(input.qty_mg) || input.qty_mg < 1) throw new Error("miktar 0,001 g katı ve en az 0,001 g olmalı");
    // satışta müşteri elindeki tokenden fazlasını satamaz: C = A − S − E
    if (input.side === "SELL") {
      const rec = this.d.record();
      const customerMg = rec.stock.a_mg - rec.stock.s_mg - (rec.stock.e_mg ?? 0);
      if (input.qty_mg > customerMg) throw new Error(`müşteride ${fmtG(customerMg)} g AGOLD var, ${fmtG(input.qty_mg)} g satılamaz`);
    }
    const params = this.d.params();
    const q = quote(level, this.d.pricing());
    const clientPx = input.side === "BUY" ? q.clientBuy : q.clientSell;
    const clientAmount = amountCents(toCents(clientPx), input.qty_mg);
    const commission = Math.round((clientAmount * q.commissionBps) / 10_000);
    if (input.ccy === "USD" && clientAmount < params.minOrderUsdCents) throw new Error(`emir minimumu ${fromCents(params.minOrderUsdCents)} USD`);
    const refineryPx = input.side === "BUY" ? level.ask : level.bid;
    const ts = new Date().toISOString();
    const o: CustomerOrder = {
      id: `kz-${randomUUID().slice(0, 8)}`, ts, customer_ref: input.customer_ref ?? "musteri-demo", side: input.side, qty_mg: input.qty_mg, ccy: input.ccy,
      quote_seq: ps.seq, refinery_quote_px: refineryPx, limit_px: limitPx(input.side, refineryPx, params.slippageBps),
      client_px: clientPx, client_amount_cents: clientAmount, commission_cents: commission,
      client_total_cents: input.side === "BUY" ? clientAmount + commission : clientAmount - commission,
      status: "SENT", customer_status: "BLOKE", refinery: null,
      timeline: [{ ts, text: input.side === "BUY" ? `müşteri hesabında ${fromCents(clientAmount + commission)} ${input.ccy} bloke` : `${(input.qty_mg / 1000).toFixed(3)} AGOLD bloke` }],
    };
    this.orders.unshift(o);
    if (this.orders.length > 1000) this.orders.pop();
    this.d.onChange();

    const req: OrderRequest = { client_order_id: o.id, side: o.side, qty_mg: o.qty_mg, ccy: o.ccy, quote_seq: o.quote_seq, limit_px: o.limit_px, tif: "FOK", time_limit_ms: params.timeLimitMs };
    this.log(o, `rafineriye ${o.side === "BUY" ? "ALIŞ" : "SATIŞ"} ${(o.qty_mg / 1000).toFixed(3)} g · quote_seq ${o.quote_seq} · limit ${o.limit_px} · FOK · ${params.timeLimitMs} ms`);
    try {
      const r = await this.d.amr.placeOrder(req, params.timeLimitMs);
      await this.onResponse(o, r);
    } catch (e) {
      if (e instanceof AmrTimeout) {
        o.status = "UNANSWERED";
        this.log(o, `zaman sınırı içinde cevap yok (${params.timeLimitMs} ms) → ${params.unansweredGraceMs} ms sonra durum sorgusu`);
        this.d.notify("order.unanswered", "Cevapsız emir", `${o.id} · ${o.side} ${(o.qty_mg / 1000).toFixed(3)} g`);
        setTimeout(() => void this.resolveUnanswered(o), params.unansweredGraceMs);
      } else {
        o.status = "ERROR"; o.customer_status = "İPTAL"; o.error = e instanceof AmrHttpError ? `HTTP ${e.status} ${JSON.stringify(e.body)}` : (e as Error).message;
        this.log(o, `hata: ${o.error} → bloke çözüldü, müşteriye iptal`);
        this.d.notify("order.error", "Emir hatası", `${o.id}: ${o.error}`);
      }
      this.d.onChange();
    }
    return o;
  }

  /** Cevapsız emir: durum sorgusu → açıksa iptal. Kesin cevaba kadar tekrar dener. */
  async resolveUnanswered(o: CustomerOrder, attempt = 1): Promise<void> {
    if (o.status !== "UNANSWERED") return;
    try {
      const st = await this.d.amr.orderStatus(o.id);
      if (st.status === "RECEIVED" || st.status === "CANCEL_REQUESTED") {
        this.log(o, `durum sorgusu: ${st.status} → iptal talebi`);
        const c = await this.d.amr.cancelOrder(o.id);
        await this.onResponse(o, c, true);
      } else {
        this.log(o, `durum sorgusu: ${st.status}`);
        await this.onResponse(o, st, true);
      }
    } catch (e) {
      const msg = e instanceof AmrHttpError && e.status === 404 ? "rafineri emri tanımıyor" : (e as Error).message;
      if (e instanceof AmrHttpError && e.status === 404) {
        // rafineriye hiç ulaşmamış: müşteriye iptal, pozisyon yok
        o.status = "CANCELLED"; o.customer_status = "İPTAL"; this.log(o, `${msg} → emir rafineriye ulaşmamış, bloke çözüldü`); this.d.onChange(); return;
      }
      this.log(o, `durum sorgusu başarısız (${attempt}): ${msg}`);
      if (attempt < 30) setTimeout(() => void this.resolveUnanswered(o, attempt + 1), 2000);
      else this.d.notify("order.unanswered_stuck", "Cevapsız emir çözülemedi", `${o.id}: elle bakılmalı`);
    }
    this.d.onChange();
  }

  /** Rafineri cevabı (anında ya da geç). */
  async onResponse(o: CustomerOrder, r: OrderResponse, late = false) {
    o.refinery = r;
    if (r.status === "FILLED" && r.fill) {
      const fillC = toCents(r.fill.px); const clientC = toCents(o.client_px);
      o.margin_cents = Math.round(((o.side === "BUY" ? clientC - fillC : fillC - clientC) * o.qty_mg) / 1000);
      const rec = this.d.record();
      if (late) {
        // müşteriye teslim / ödeme yok (iptal edildi); rafineri bacağı bağlayıcı → pozisyon
        o.status = "LATE_FILL"; o.customer_status = "İPTAL";
        applyFill(rec, o.side, o.qty_mg, o.ccy, r.fill.amount_cents, { deliver: false }); // teslim yok: stok değişmez
        this.log(o, `GEÇ FILL @ ${r.fill.px} · müşteriye teslim yok · pozisyon kararı bekliyor (kapat / taşı)`);
        this.d.notify("order.late_fill", "Geç fill: pozisyon kararı gerekli", `${o.id} · ${o.side} ${(o.qty_mg / 1000).toFixed(3)} g @ ${r.fill.px}`);
      } else {
        o.status = "FILLED";
        const sp = this.d.stock();
        const stockBefore = rec.stock.s_mg;
        // 07: teslim sonrası stok tabanın altına inecek mi? Eksik kadar (ya da emrin tamamı) yeni ihraç gerekir.
        const shortfall = o.side === "BUY" && stockBefore - o.qty_mg < sp.floorMg
          ? (sp.mintPolicy === "FULL_ORDER" ? o.qty_mg : o.qty_mg - (stockBefore - sp.floorMg))
          : 0;

        applyFill(rec, o.side, o.qty_mg, o.ccy, r.fill.amount_cents, { deliver: shortfall === 0 });
        this.log(o, `FILLED @ ${r.fill.px} ${o.ccy} · bedel ${fromCents(r.fill.amount_cents)}${r.allocation_certificate ? ` · Tahsis Belgesi ${r.allocation_certificate.doc_id}` : ""}`);
        if (r.account) await this.reconcile(o, r.account);

        if (shortfall > 0) await this.bigBuy(o, shortfall, stockBefore, sp);
        else if (o.side === "BUY") {
          o.flow = "STOK"; o.customer_status = "TESLİM EDİLDİ";
          this.log(o, `${fmtG(o.qty_mg)} AGOLD hazine → müşteri cüzdanı (önce teslim) · tahsilat müşteri hs → şirket hs ${fromCents(o.client_total_cents)} ${o.ccy}`);
        } else {
          o.customer_status = "ÖDENDİ";
          this.log(o, `önce ödeme: şirket hs → müşteri hs ${fromCents(o.client_total_cents)} ${o.ccy} · ${fmtG(o.qty_mg)} AGOLD hazineye`);
          await this.bigSell(o, sp); // 08: stok tavanı aşıldıysa fazlayı burn et ve kasa çıkışı iste
        }
        this.d.onChange();
        return;
      }
      if (r.account) await this.reconcile(o, r.account);
    } else if (r.status === "REJECTED") {
      o.status = "REJECTED"; o.customer_status = "İPTAL"; o.reject_reason = r.reject_reason;
      this.log(o, `REJECTED: ${r.reject_reason} → bloke çözüldü, müşteriye iptal`);
      if (r.reject_reason === "CURRENT_ACCOUNT_LIMIT") this.d.notify("order.rejected_limit", "Rafineri emri reddetti: cari hesap limiti", `${o.id}; mahsuplaşma çağrılmalı`);
      else if (r.reject_reason === "INTERNAL_ERROR") this.d.notify("order.internal_error", "Rafineri INTERNAL_ERROR döndü", `${o.id}: işlemler durdurulmalı, elle bakılmalı`);
    } else if (r.status === "CANCELLED") {
      o.status = "CANCELLED"; o.customer_status = "İPTAL";
      this.log(o, `CANCELLED (kesin cevap) → bloke çözüldü, müşteriye iptal`);
    } else {
      this.log(o, `durum ${r.status}`);
    }
    this.d.onChange();
  }

  /**
   * 07 Büyük alış: fiyat fill'de kilitlendi, teslim mint'ten sonra. Eksik kadar kasa girişi istenir;
   * mint tamamlanınca `deliverPending` tek seferde teslim eder. Kısmi teslim yoktur.
   */
  private async bigBuy(o: CustomerOrder, shortfallMg: number, stockBefore: number, sp: StockParams) {
    o.flow = "BÜYÜK_ALIŞ";
    o.customer_status = "TESLİM BEKLİYOR";
    o.chain_mg = shortfallMg;
    this.log(o, `stok tabanı: S ${fmtG(stockBefore)} − emir ${fmtG(o.qty_mg)} < taban ${fmtG(sp.floorMg)} → eksik ${fmtG(shortfallMg)} g (${sp.mintPolicy})`);
    this.log(o, `müşteriye: fiyat kilitlendi, teslim hazırlanıyor · ifşa "emriniz yeni ihraçla karşılandı"`);
    this.d.notify("order.big_buy", "Büyük alış: yeni ihraç gerekiyor", `${o.id} · emir ${fmtG(o.qty_mg)} g · kasa girişi ${fmtG(shortfallMg)} g`);
    try {
      const inst = await this.d.vault().requestIn(shortfallMg, "BIG_BUY", { relatedId: o.id });
      o.vault_ref = inst.ref;
      this.log(o, `kasa girişi talebi ${inst.ref} · ${fmtG(shortfallMg)} g · durum ${inst.status}`);
      if (inst.minted) this.deliverPending(inst); // otomatik kabul: zincir aynı anda kapandı
    } catch (e) {
      this.log(o, `kasa girişi talebi kurulamadı: ${(e as Error).message} · teslim bekliyor`);
      this.d.notify("order.big_buy_error", "Büyük alışta kasa girişi kurulamadı", `${o.id}: ${(e as Error).message}`);
    }
  }

  /** 08 Büyük satış: tokenler stoğa döndü; tavan aşıldıysa fazla (S − hedef) burn edilir ve kasa çıkışı istenir. */
  private async bigSell(o: CustomerOrder, sp: StockParams) {
    const rec = this.d.record();
    if (rec.stock.s_mg <= sp.ceilingMg) { o.flow = "STOK"; return; }
    const excess = rec.stock.s_mg - sp.targetMg;
    o.flow = "BÜYÜK_SATIŞ";
    o.chain_mg = excess;
    this.log(o, `stok tavanı: S ${fmtG(rec.stock.s_mg)} > tavan ${fmtG(sp.ceilingMg)} → fazla ${fmtG(excess)} g (hedef ${fmtG(sp.targetMg)})`);
    this.d.notify("order.big_sell", "Büyük satış: stok tavanı aşıldı", `${o.id} · fazla ${fmtG(excess)} g burn edilip kasa çıkışı istenecek`);
    try {
      const inst = await this.d.vault().requestOut(excess, "BIG_SELL", { relatedId: o.id });
      o.vault_ref = inst.ref;
      this.log(o, `burn ${fmtG(excess)} g · kasa çıkışı talebi ${inst.ref} · durum ${inst.status}`);
    } catch (e) {
      this.log(o, `kasa çıkışı talebi kurulamadı: ${(e as Error).message}`);
      this.d.notify("order.big_sell_error", "Büyük satışta kasa çıkışı kurulamadı", `${o.id}: ${(e as Error).message}`);
    }
  }

  /**
   * Mint tamamlandı: büyük alışın teslim adımı. Tek seferde teslim, sonra tahsilat.
   * Kasa talimatları masası mint'ten sonra çağırır (elle kabulde olay geldiğinde).
   */
  deliverPending(inst: VaultInstruction) {
    const o = inst.related_id ? this.get(inst.related_id) : undefined;
    if (!o || o.flow !== "BÜYÜK_ALIŞ" || o.customer_status !== "TESLİM BEKLİYOR") return;
    applyDelivery(this.d.record(), "BUY", o.qty_mg);
    o.customer_status = "TESLİM EDİLDİ";
    this.log(o, `mint tamam (${inst.ref}) · TEK SEFERDE teslim ${fmtG(o.qty_mg)} AGOLD → müşteri cüzdanı · S ${fmtG(this.d.record().stock.s_mg)}`);
    this.log(o, `tahsilat müşteri hs → şirket hs ${fromCents(o.client_total_cents)} ${o.ccy} · DELIVERED`);
    this.d.notify("order.big_buy_delivered", "Büyük alış teslim edildi", `${o.id} · ${fmtG(o.qty_mg)} g`);
    this.d.onChange();
  }

  /** Teslim bekleyen büyük alışlar (mint bloke ya da rafineri kabulü bekleniyor). */
  awaitingDelivery() { return this.orders.filter((o) => o.customer_status === "TESLİM BEKLİYOR"); }

  /** Eşleşme kuralı: KZ kaydı == bakiye bilgisi. seq boşluğunda anlık fotoğraf. */
  private async reconcile(o: CustomerOrder, acc: Account) {
    const rec = this.d.record();
    const res = compare(rec, acc);
    o.match = rec.match === "EŞİT" ? "EŞİT" : "RECONCILE";
    if (res.seqGap) {
      this.log(o, `seq boşluğu (KZ ${rec.seq} → AMR ${acc.seq}) → anlık fotoğraf istendi`);
      try { const snap = await this.d.amr.account(); compare(rec, snap); o.match = rec.match === "EŞİT" ? "EŞİT" : "RECONCILE"; } catch (e) { this.log(o, `fotoğraf alınamadı: ${(e as Error).message}`); }
    }
    if (rec.match === "RECONCILE") {
      this.log(o, `KZ kaydı ≠ bakiye bilgisi: ${rec.diffs.map((d) => `${d.field} KZ ${d.kz} / AMR ${d.amr}`).join(", ")} → RECONCILE, mint ve kasa çıkışı bloke`);
      this.d.notify("account.reconcile", "Eşleşme uyuşmazlığı (RECONCILE)", `${o.id}: ${rec.diffs.length} fark satırı; mint ve kasa çıkışı bloke`);
    } else this.log(o, `bakiye bilgisi ile KZ kaydı EŞİT (seq ${acc.seq})`);
  }

  /** Geç fill pozisyon kararı: CLOSE = ters emirle kapat · CARRY = envanterde taşı (K hedefi kadar artar / azalır). */
  async decide(id: string, decision: "CLOSE" | "CARRY"): Promise<CustomerOrder> {
    const o = this.get(id);
    if (!o || o.status !== "LATE_FILL" || o.decision) throw new Error("karar bekleyen geç fill yok");
    const rec = this.d.record();
    if (decision === "CARRY") {
      rec.stock.k_mg += o.side === "BUY" ? o.qty_mg : -o.qty_mg;
      o.decision = "CARRY"; this.log(o, `karar: taşı · envanter hedefi K ${o.side === "BUY" ? "+" : "−"}${(o.qty_mg / 1000).toFixed(3)} g`);
      this.d.onChange();
      return o;
    }
    // CLOSE: ters yönde hazine emri (müşteri yok), stok değişmez
    const ps = this.d.priceState();
    const level = ps.lastPrices?.find((p) => p.ccy === o.ccy);
    if (!level) throw new Error("fiyat yok");
    const side = o.side === "BUY" ? "SELL" : "BUY";
    const px = side === "BUY" ? level.ask : level.bid;
    const req: OrderRequest = { client_order_id: `kz-close-${o.id.slice(3)}`, side, qty_mg: o.qty_mg, ccy: o.ccy, quote_seq: ps.seq, limit_px: limitPx(side, px, this.d.params().slippageBps), tif: "FOK", time_limit_ms: this.d.params().timeLimitMs };
    const r = await this.d.amr.placeOrder(req, this.d.params().timeLimitMs + 2000);
    if (r.status === "FILLED" && r.fill) {
      applyFill(rec, side, o.qty_mg, o.ccy, r.fill.amount_cents, { deliver: false }); // hazine emri: müşteri yok, stok değişmez
      if (r.account) compare(rec, r.account);
      o.decision = "CLOSE"; o.decision_order_id = r.order_id;
      const pnl = (o.side === "BUY" ? toCents(r.fill.px) - toCents(o.refinery!.fill!.px) : toCents(o.refinery!.fill!.px) - toCents(r.fill.px)) * o.qty_mg / 1000;
      this.log(o, `karar: kapat · ters emir ${side} @ ${r.fill.px} (${r.order_id}) · sonuç ${fromCents(Math.round(pnl))} ${o.ccy}`);
    } else {
      this.log(o, `kapatma emri sonuçsuz: ${r.status} ${r.reject_reason ?? ""}`);
      throw new Error(`kapatma emri ${r.status} ${r.reject_reason ?? ""}`);
    }
    this.d.onChange();
    return o;
  }

  private log(o: CustomerOrder, text: string) { o.timeline.push({ ts: new Date().toISOString(), text }); }
}
