/**
 * Fiziksel teslimat (Akışlar 10) ve rafinasyon (Akışlar 11) · Kanzasset tarafı, ekranlar K6 ve K7.
 *
 * Müşteri itfa ya da ürün talebi → rafineriye talep → rafineri teklifi → (müşteri onayından sonra) onay →
 * üretim ve sevkiyat adımları izlenir → teslimde burn.
 *
 * KZ kaydı etkisi:
 *   talep      E +x, C −x   tokenler burn cüzdanına geçer, henüz yakılmadı; arz değişmez
 *   onay       P[kur] −bedel (lojistik ya da ürün bedeli + lojistik)
 *   hazır      kasada −x, sevkiyatta +x
 *   teslim     sevkiyatta −x, BURN: A −x, E −x   → A ≤ V korunur (V ve A aynı anda düşer)
 *   iptal      emanet çözülür; hazırdan iptalde külçe kasaya döner
 *
 * Burn anı parametredir: DELIVERED (varsayılan) ya da SHIPPED.
 * Kanzasset'in marjı ve komisyonu müşteri tarafındadır; rafineriye yalnız bedel öder.
 */
import { randomUUID } from "node:crypto";
import type { Account, Catalog, Delivery, Refining } from "@amr/contract";
import { AmrClient } from "./amrClient.ts";
import { applyFee, applyShipDelivered, applyShipReady, applyShipReturn, burnEscrow, compare, escrowIn, escrowRelease, type KzRecord } from "./record.ts";

export type BurnMoment = "DELIVERED" | "SHIPPED";

export interface FulfilmentParams { burnMoment: BurnMoment }
export const DEFAULT_FULFILMENT: FulfilmentParams = { burnMoment: "DELIVERED" };

export interface KzDelivery {
  id: string; // KZ referansı (rafineride tekil)
  kind: "DELIVERY";
  customer_ref: string;
  qty_mg: number;
  address_ref: string;
  insured_party_ref: string;
  delivery_id?: string; // rafineri talep numarası
  status: string;
  quote?: { quote_id: string; carrier: string; amount_cents: number; ccy: string; valid_until: string; doc_id?: string };
  customer_price_cents?: number; // müşteriye yansıtılan masraf (aynen)
  /** Rafineri belgelerinin numaraları: kendi kaydımızda dursun, belge kopyası bunlarla çekilir (K12). */
  shipping_doc_id?: string;
  pod_doc_id?: string;
  tracking_no?: string;
  burned: boolean;
  burn_tx?: string;
  escrowed: boolean;
  created_ts: string;
  timeline: { ts: string; text: string }[];
}

export interface KzRefining {
  id: string;
  kind: "REFINING";
  customer_ref: string;
  items: { item_id: string; name: string; qty: number; weight_mg: number }[];
  total_mg: number;
  address_ref: string;
  insured_party_ref: string;
  refining_id?: string;
  status: string;
  quote?: { quote_id: string; product_cents: number; logistics_cents: number; ccy: string; lead_time_days: number; valid_until: string; doc_id?: string };
  customer_price_cents?: number; // marj + komisyon dahil müşteri fiyatı
  shipping_doc_id?: string;
  pod_doc_id?: string;
  tracking_no?: string;
  burned: boolean;
  burn_tx?: string;
  escrowed: boolean;
  created_ts: string;
  timeline: { ts: string; text: string }[];
}

export interface FulfilmentDeps {
  amr: AmrClient;
  record: () => KzRecord;
  params: () => FulfilmentParams;
  pricing: () => { marginBps: number; marginCapBps: number; commissionBps: number };
  notify: (type: string, title: string, body?: string) => void;
  onChange: () => void;
}

const g = (mg: number) => (mg / 1000).toFixed(3);
const money = (c: number) => (c / 100).toFixed(2);

export class FulfilmentDesk {
  deliveries: KzDelivery[] = [];
  refinings: KzRefining[] = [];
  catalog: Catalog | null = null;
  private counter = 0;

  constructor(private d: FulfilmentDeps, initial: { deliveries?: KzDelivery[]; refinings?: KzRefining[]; catalog?: Catalog | null } = {}) {
    this.deliveries = initial.deliveries ?? [];
    this.refinings = initial.refinings ?? [];
    this.catalog = initial.catalog ?? null;
    this.counter = this.deliveries.length + this.refinings.length;
  }

  getDelivery(id: string) { return this.deliveries.find((x) => x.id === id || x.delivery_id === id); }
  getRefining(id: string) { return this.refinings.find((x) => x.id === id || x.refining_id === id); }
  openDeliveries() { return this.deliveries.filter((x) => !["DELIVERED", "CANCELLED", "FAILED"].includes(x.status)); }
  openRefinings() { return this.refinings.filter((x) => !["DELIVERED", "CANCELLED", "FAILED"].includes(x.status)); }
  /** Rafineri teklifi gelmiş, müşteri onayından sonra onaylanacak talepler. */
  awaitingApproval() {
    return [...this.deliveries.filter((x) => x.status === "QUOTED"), ...this.refinings.filter((x) => x.status === "QUOTED")];
  }

  // ---------- katalog ----------

  /** Rafineri kataloğunu çeker (catalog.updated olayında da yenilenir). */
  async refreshCatalog(): Promise<Catalog> {
    this.catalog = await this.d.amr.catalog();
    this.d.onChange();
    return this.catalog;
  }

  /** Müşteriye gösterilen fiyat: rafineri bedeli + marj, komisyon ayrı satır (fiyat zinciri 01). */
  customerPrice(baseCents: number) {
    const p = this.d.pricing();
    const bps = Math.min(p.marginBps, p.marginCapBps);
    const withMargin = Math.ceil((baseCents * (10_000 + bps)) / 10_000);
    const commission = Math.round((withMargin * p.commissionBps) / 10_000);
    return { base_cents: baseCents, margin_cents: withMargin - baseCents, commission_cents: commission, total_cents: withMargin + commission };
  }

  // ---------- 10 fiziksel teslimat ----------

  /** Müşteri itfa talebi: tokenler burn cüzdanına (emanet), rafineriye talep gider. */
  async requestDelivery(input: { qty_mg: number; address_ref: string; insured_party_ref: string; customer_ref?: string }): Promise<KzDelivery> {
    if (!Number.isInteger(input.qty_mg) || input.qty_mg < 1) throw new Error("miktar 0,001 g katı ve en az 0,001 g olmalı");
    const rec = this.d.record();
    const available = rec.stock.a_mg - rec.stock.s_mg - (rec.stock.e_mg ?? 0);
    if (input.qty_mg > available) throw new Error(`müşteride dolaşan token yetersiz: ${g(available)} g`);
    const ts = new Date().toISOString();
    const item: KzDelivery = {
      id: `KZ-DL-${String(++this.counter).padStart(4, "0")}-${randomUUID().slice(0, 4).toUpperCase()}`,
      kind: "DELIVERY", customer_ref: input.customer_ref ?? "musteri-demo", qty_mg: input.qty_mg,
      address_ref: input.address_ref, insured_party_ref: input.insured_party_ref,
      status: "TALEP", burned: false, escrowed: false, created_ts: ts, timeline: [],
    };
    this.deliveries.unshift(item);
    escrowIn(rec, input.qty_mg);
    item.escrowed = true;
    this.log(item, `${g(input.qty_mg)} AGOLD burn cüzdanına alındı (emanet) · müşteri tokenleri dolaşımdan çıktı, henüz yakılmadı`);
    try {
      const r = await this.d.amr.deliveryCreate({ qty_mg: input.qty_mg, address_ref: input.address_ref, insured_party_ref: input.insured_party_ref, ref: item.id });
      item.delivery_id = r.delivery_id;
      item.status = r.status;
      this.log(item, `rafineriye teslimat talebi gönderildi · ${r.delivery_id} · lojistik teklifi bekleniyor`);
    } catch (e) {
      escrowRelease(rec, input.qty_mg);
      item.escrowed = false;
      item.status = "HATA";
      this.log(item, `talep gönderilemedi: ${(e as Error).message} · emanet çözüldü`);
      this.d.notify("delivery.error", "Teslimat talebi gönderilemedi", (e as Error).message);
    }
    this.d.onChange();
    return item;
  }

  /** Lojistik teklifini onayla (müşteri onayından sonra): bedel cari hesaba, masraf müşteriden aynen alınır. */
  async approveDelivery(id: string): Promise<KzDelivery> {
    const item = this.getDelivery(id);
    if (!item) throw new Error("teslimat talebi yok");
    if (item.status !== "QUOTED" || !item.quote) throw new Error(`talep ${item.status} durumunda, onaylanamaz`);
    const r = await this.d.amr.deliveryApprove(item.delivery_id!, item.quote.quote_id);
    item.status = r.status;
    applyFee(this.d.record(), item.quote.ccy as any, item.quote.amount_cents);
    item.customer_price_cents = item.quote.amount_cents; // komisyon yok, aynen yansıtılır
    this.log(item, `teklif onaylandı · lojistik ${money(item.quote.amount_cents)} ${item.quote.ccy} cari hesaba · müşteriden aynen alınır (komisyon yok)`);
    // bakiye bilgisi delivery.approved olayıyla gelir ve orada karşılaştırılır (02)
    this.d.onChange();
    return item;
  }

  async cancelDelivery(id: string, reason: string): Promise<KzDelivery> {
    const item = this.getDelivery(id);
    if (!item) throw new Error("teslimat talebi yok");
    if (["DELIVERED", "CANCELLED", "SHIPPED"].includes(item.status)) throw new Error(`talep ${item.status} durumunda, iptal edilemez`);
    const r = await this.d.amr.deliveryCancel(item.delivery_id!, reason);
    item.status = r.status;
    if (item.escrowed && !item.burned) { escrowRelease(this.d.record(), item.qty_mg); item.escrowed = false; }
    this.log(item, `iptal: ${reason} · emanet çözüldü, tokenler müşteriye döndü`);
    this.d.onChange();
    return item;
  }

  // ---------- 11 rafinasyon ----------

  async requestRefining(input: { items: { item_id: string; qty: number }[]; address_ref: string; insured_party_ref: string; customer_ref?: string }): Promise<KzRefining> {
    const cat = this.catalog ?? (await this.refreshCatalog());
    const lines = input.items.map((it) => {
      const ci = cat.items.find((c) => c.item_id === it.item_id);
      if (!ci) throw new Error(`katalogda yok: ${it.item_id}`);
      if (!ci.active) throw new Error(`ürün pasif: ${it.item_id}`);
      return { item_id: ci.item_id, name: ci.name, qty: it.qty, weight_mg: ci.weight_mg };
    });
    const total = lines.reduce((a, l) => a + l.qty * l.weight_mg, 0);
    const rec = this.d.record();
    const available = rec.stock.a_mg - rec.stock.s_mg - (rec.stock.e_mg ?? 0);
    if (total > available) throw new Error(`müşteride dolaşan token yetersiz: ${g(available)} g`);
    const ts = new Date().toISOString();
    const item: KzRefining = {
      id: `KZ-RF-${String(++this.counter).padStart(4, "0")}-${randomUUID().slice(0, 4).toUpperCase()}`,
      kind: "REFINING", customer_ref: input.customer_ref ?? "musteri-demo", items: lines, total_mg: total,
      address_ref: input.address_ref, insured_party_ref: input.insured_party_ref,
      status: "TALEP", burned: false, escrowed: false, created_ts: ts, timeline: [],
    };
    this.refinings.unshift(item);
    escrowIn(rec, total);
    item.escrowed = true;
    this.log(item, `${lines.map((l) => `${l.qty} × ${l.name}`).join(", ")} · toplam ${g(total)} g emanete alındı`);
    try {
      const r = await this.d.amr.refiningCreate({ items: input.items, address_ref: input.address_ref, insured_party_ref: input.insured_party_ref, ref: item.id });
      item.refining_id = r.refining_id;
      item.status = r.status;
      this.log(item, `rafineriye rafinasyon talebi gönderildi · ${r.refining_id} · teklif bekleniyor`);
    } catch (e) {
      escrowRelease(rec, total);
      item.escrowed = false;
      item.status = "HATA";
      this.log(item, `talep gönderilemedi: ${(e as Error).message} · emanet çözüldü`);
      this.d.notify("refining.error", "Rafinasyon talebi gönderilemedi", (e as Error).message);
    }
    this.d.onChange();
    return item;
  }

  /** Rafinasyon teklifini onayla: bedel cari hesaba; müşteriye gösterilen fiyat marj + komisyon dahildir. */
  async approveRefining(id: string): Promise<KzRefining> {
    const item = this.getRefining(id);
    if (!item) throw new Error("rafinasyon talebi yok");
    if (item.status !== "QUOTED" || !item.quote) throw new Error(`talep ${item.status} durumunda, onaylanamaz`);
    const r = await this.d.amr.refiningApprove(item.refining_id!, item.quote.quote_id);
    item.status = r.status;
    const base = item.quote.product_cents + item.quote.logistics_cents;
    applyFee(this.d.record(), item.quote.ccy as any, base);
    const cp = this.customerPrice(base);
    item.customer_price_cents = cp.total_cents;
    this.log(item, `teklif onaylandı · rafineriye ${money(base)} ${item.quote.ccy} cari hesaba · müşteriye ${money(cp.total_cents)} (marj ${money(cp.margin_cents)} + komisyon ${money(cp.commission_cents)})`);
    // bakiye bilgisi refining.approved olayıyla gelir ve orada karşılaştırılır (02)
    this.d.onChange();
    return item;
  }

  async cancelRefining(id: string, reason: string): Promise<KzRefining> {
    const item = this.getRefining(id);
    if (!item) throw new Error("rafinasyon talebi yok");
    if (["DELIVERED", "CANCELLED", "SHIPPED", "IN_PRODUCTION", "READY", "FAILED"].includes(item.status)) throw new Error(`talep ${item.status} durumunda, iptal edilemez (rafinasyon iptali üretime kadar)`);
    const r = await this.d.amr.refiningCancel(item.refining_id!, reason);
    item.status = r.status;
    if (item.escrowed && !item.burned) { escrowRelease(this.d.record(), item.total_mg); item.escrowed = false; }
    this.log(item, `iptal: ${reason} · emanet çözüldü`);
    this.d.onChange();
    return item;
  }

  // ---------- rafineri olayları ----------

  /** delivery.* ve refining.* olayları; kasa hareketleri ve burn burada işlenir. */
  onEvent(type: string, data: any, account?: Account): string {
    const isDelivery = type.startsWith("delivery.");
    const item = isDelivery ? this.getDelivery(data?.ref ?? data?.delivery_id) : this.getRefining(data?.ref ?? data?.refining_id);
    if (!item) {
      if (account) compare(this.d.record(), account);
      return `${type} (KZ tarafında talep bulunamadı)`;
    }
    const qty = isDelivery ? (item as KzDelivery).qty_mg : (item as KzRefining).total_mg;
    const rec = this.d.record();
    const step = type.split(".")[1];

    switch (step) {
      case "quoted": {
        item.status = "QUOTED";
        (item as any).quote = data.quote;
        if (isDelivery) this.log(item, `rafineri lojistik fiyatını girdi: ${data.quote?.carrier} · ${money(data.quote?.amount_cents ?? 0)} ${data.quote?.ccy} · onay bekliyor`);
        else this.log(item, `rafineri teklif verdi: ürün ${money(data.quote?.product_cents ?? 0)} + lojistik ${money(data.quote?.logistics_cents ?? 0)} ${data.quote?.ccy} · ${data.quote?.lead_time_days} gün · onay bekliyor`);
        this.d.notify(`${isDelivery ? "delivery" : "refining"}.quoted`, isDelivery ? "Lojistik teklifi geldi" : "Rafinasyon teklifi geldi", `${item.id} · müşteri onayından sonra onaylanmalı`);
        break;
      }
      case "approved": item.status = "APPROVED"; this.log(item, "rafineri onayı işledi"); break;
      case "preparing": item.status = "PREPARING"; this.log(item, "rafineri hazırlığa aldı"); break;
      case "in_production": item.status = "IN_PRODUCTION"; this.log(item, "üretime alındı"); break;
      case "ready": {
        if (item.status !== "READY") {
          item.status = "READY";
          applyShipReady(rec, qty);
          if (data.shipping_doc_id) item.shipping_doc_id = data.shipping_doc_id;
          this.log(item, `hazır · Sevkiyat Fişi ${data.shipping_doc_id ?? ""} · kasada −${g(qty)} · sevkiyatta +${g(qty)}`);
        }
        break;
      }
      case "shipped": {
        item.status = "SHIPPED";
        item.tracking_no = data.tracking_no;
        this.log(item, `taşıyıcıya verildi · ${data.carrier ?? ""} · takip ${data.tracking_no ?? ""}`);
        if (this.d.params().burnMoment === "SHIPPED") this.doBurn(item, qty, "sevkiyat anında (burn anı: SHIPPED)");
        break;
      }
      case "delivered": {
        if (item.status !== "DELIVERED") {
          item.status = "DELIVERED";
          applyShipDelivered(rec, qty);
          if (data.pod_doc_id) item.pod_doc_id = data.pod_doc_id;
          this.log(item, `teslim edildi · Teslimat Kaydı ${data.pod_doc_id ?? ""} · sevkiyatta −${g(qty)}`);
          if (!item.burned) this.doBurn(item, qty, "teslim anında (burn anı: DELIVERED)");
        }
        break;
      }
      case "cancelled": {
        const wasReady = item.status === "READY";
        item.status = "CANCELLED";
        if (wasReady) applyShipReturn(rec, qty);
        if (item.escrowed && !item.burned) { escrowRelease(rec, qty); item.escrowed = false; }
        this.log(item, `rafineri iptal etti${wasReady ? " · külçe kasaya döndü" : ""} · emanet çözüldü`);
        this.d.notify(`${isDelivery ? "delivery" : "refining"}.cancelled`, "Talep iptal edildi", item.id);
        break;
      }
      case "failed": {
        item.status = "FAILED";
        this.log(item, `teslim edilemedi: ${data.reject_reason ?? ""} · iade istisnası, elle bakılmalı`);
        this.d.notify(`${isDelivery ? "delivery" : "refining"}.failed`, "Teslimat başarısız", `${item.id}: ${data.reject_reason ?? ""}`);
        break;
      }
    }

    if (account) compare(rec, account);
    this.d.onChange();
    return `${item.id} ${step}`;
  }

  /** Emanetteki tokenleri yakar: A −x, E −x. Hazine stoku etkilenmez. */
  private doBurn(item: KzDelivery | KzRefining, qtyMg: number, note: string) {
    if (item.burned) return;
    burnEscrow(this.d.record(), qtyMg);
    item.burned = true;
    item.escrowed = false;
    item.burn_tx = `bitgo-burn-${randomUUID().slice(0, 8)}`;
    this.log(item, `BURN ${g(qtyMg)} AGOLD ${note} · A −${g(qtyMg)} · E −${g(qtyMg)} · ${item.burn_tx}`);
  }

  private log(item: KzDelivery | KzRefining, text: string) { item.timeline.push({ ts: new Date().toISOString(), text }); }
}
