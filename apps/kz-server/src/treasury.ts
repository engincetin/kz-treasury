/**
 * Hazine alım satımı (Akışlar 09 · ekran K5).
 *
 * Hazine, müşteri emrinden bağımsız olarak envanter hedefini (K) değiştirmek için rafineriyle kendi alım satımını yapar.
 * Maker-checker: talebi hazineci açar, onaycılar onaylar, **son onaycı canlı fiyatla gönderir** (gönderim anındaki fiyat bağlayıcı).
 * Onay matrisi gram bazındadır: ≤5 kg 1 · ≤15 kg 2 · üstü 3 (K9 parametresi).
 *
 * Zincir:
 *   alım  ALIŞ emri → T +q, K +q → kasa girişi (05) → mint q → S +q, A +q      K artar
 *   satım SATIŞ emri → T −b, K −b → burn b (hazine stoku) → kasa çıkışı (06)   K azalır
 *
 * Alım sermayeden ödenir, müşteri parası asla (K5); bedel mahsuplaşmada netleşir (12).
 * Satımda yalnız hazine stokundaki tokenler yakılır, müşteri tokenlerine dokunulmaz: `qty ≤ S` aranır.
 */
import { randomUUID } from "node:crypto";
import type { Ccy, OrderRequest } from "@amr/contract";
import { AmrClient } from "./amrClient.ts";
import { applyFill, compare, shiftTarget, type KzRecord } from "./record.ts";
import { limitPx, type OrderParams } from "./orders.ts";
import type { PriceClientState } from "./priceClient.ts";
import type { StockParams, VaultDesk, VaultInstruction } from "./vault.ts";

export type TreasuryStatus = "ONAY_BEKLİYOR" | "GÖNDERİLDİ" | "ZİNCİR_SÜRÜYOR" | "TAMAM" | "REDDEDİLDİ" | "İPTAL" | "HATA";

export interface TreasuryRequest {
  id: string;
  side: "BUY" | "SELL";
  qty_mg: number;
  ccy: Ccy;
  maker: string;
  required_approvals: number;
  approvals: { by: string; ts: string }[];
  status: TreasuryStatus;
  /** Talep anındaki fiyat ve tutar (bilgi); bağlayıcı olan gönderim anındaki fiyattır. */
  quoted_px: string;
  quoted_amount_cents: number;
  order_id?: string;
  fill_px?: string;
  fill_amount_cents?: number;
  reject_reason?: string;
  vault_ref?: string;
  target_before_mg: number;
  target_after_mg?: number;
  error?: string;
  created_ts: string;
  sent_ts?: string;
  timeline: { ts: string; text: string }[];
}

export interface TreasuryDeps {
  amr: AmrClient;
  priceState: () => PriceClientState;
  tradingOpen: () => { open: boolean; reason: string };
  record: () => KzRecord;
  stock: () => StockParams;
  orderParams: () => OrderParams;
  vault: () => VaultDesk;
  notify: (type: string, title: string, body?: string) => void;
  onChange: () => void;
}

const toCents = (px: string) => Math.round(Number(px) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);
const amountCents = (pxCents: number, qtyMg: number) => Math.round((pxCents * qtyMg) / 1000);
const fmtG = (mg: number) => (mg / 1000).toFixed(3);

/** Onay matrisi: gram arttıkça gereken onay sayısı artar (≤5 kg 1 · ≤15 kg 2 · üstü 3). */
export function requiredApprovals(qtyMg: number, p: StockParams): number {
  for (const row of [...p.approvalMatrix].sort((a, b) => a.upToMg - b.upToMg)) if (qtyMg <= row.upToMg) return row.approvals;
  return p.approvalsAbove;
}

export class TreasuryDesk {
  requests: TreasuryRequest[] = [];
  constructor(private d: TreasuryDeps, initial: TreasuryRequest[] = []) { this.requests = initial; }

  list(limit = 200) { return this.requests.slice(0, limit); }
  get(id: string) { return this.requests.find((r) => r.id === id); }
  pending() { return this.requests.filter((r) => r.status === "ONAY_BEKLİYOR"); }

  /** Maker: talebi açar. O anki fiyat ve tutar gösterilir; bağlayıcı fiyat gönderim anındakidir. */
  create(input: { side: "BUY" | "SELL"; qty_mg: number; ccy: Ccy; maker: string }): TreasuryRequest {
    if (!Number.isInteger(input.qty_mg) || input.qty_mg < 1) throw new Error("miktar 0,001 g katı ve en az 0,001 g olmalı");
    if (!input.maker?.trim()) throw new Error("hazineci (maker) zorunlu");
    const ps = this.d.priceState();
    const level = ps.lastPrices?.find((p) => p.ccy === input.ccy);
    if (!level) throw new Error("fiyat yok: rafineri yayını gelmeden hazine talebi açılamaz");
    const rec = this.d.record();
    if (input.side === "SELL" && input.qty_mg > rec.stock.s_mg) throw new Error(`hazine stoku yetersiz: ${fmtG(rec.stock.s_mg)} g (yalnız hazine stokundaki tokenler yakılır)`);

    const px = input.side === "BUY" ? level.ask : level.bid;
    const ts = new Date().toISOString();
    const req: TreasuryRequest = {
      id: `tr-${randomUUID().slice(0, 8)}`,
      side: input.side, qty_mg: input.qty_mg, ccy: input.ccy, maker: input.maker.trim(),
      required_approvals: requiredApprovals(input.qty_mg, this.d.stock()),
      approvals: [], status: "ONAY_BEKLİYOR",
      quoted_px: px, quoted_amount_cents: amountCents(toCents(px), input.qty_mg),
      target_before_mg: rec.stock.k_mg, created_ts: ts, timeline: [],
    };
    this.requests.unshift(req);
    if (this.requests.length > 500) this.requests.pop();
    this.log(req, `${input.side === "BUY" ? "hazine alımı" : "hazine satışı"} ${fmtG(input.qty_mg)} g · o anki fiyat ${px} ${input.ccy} · tutar ${fromCents(req.quoted_amount_cents)} · ${req.required_approvals} onay gerekiyor`);
    this.log(req, input.side === "BUY" ? "bedel sermayeden ödenir, müşteri parası kullanılmaz (K5)" : "yalnız hazine stokundaki tokenler yakılır, müşteri tokenlerine dokunulmaz");
    this.d.notify("treasury.requested", `Hazine ${input.side === "BUY" ? "alımı" : "satışı"} onay bekliyor`, `${req.id} · ${fmtG(input.qty_mg)} g · ${req.required_approvals} onay`);
    this.d.onChange();
    return req;
  }

  /** Onaycı. Maker kendi talebini onaylayamaz, aynı kişi iki kez onaylayamaz. Son onayda canlı fiyatla gönderilir. */
  async approve(id: string, approver: string): Promise<TreasuryRequest> {
    const req = this.get(id);
    if (!req) throw new Error("talep yok");
    if (req.status !== "ONAY_BEKLİYOR") throw new Error(`talep ${req.status} durumunda`);
    const by = approver?.trim();
    if (!by) throw new Error("onaycı zorunlu");
    if (by === req.maker) throw new Error("maker-checker: hazineci kendi talebini onaylayamaz");
    if (req.approvals.some((a) => a.by === by)) throw new Error(`${by} bu talebi zaten onayladı`);

    req.approvals.push({ by, ts: new Date().toISOString() });
    this.log(req, `onay ${req.approvals.length}/${req.required_approvals}: ${by}`);
    if (req.approvals.length < req.required_approvals) { this.d.onChange(); return req; }

    this.log(req, `son onaycı: canlı fiyatla onayla ve gönder`);
    return this.send(req);
  }

  cancel(id: string, actor: string): TreasuryRequest {
    const req = this.get(id);
    if (!req) throw new Error("talep yok");
    if (req.status !== "ONAY_BEKLİYOR") throw new Error(`talep ${req.status} durumunda, iptal edilemez`);
    req.status = "İPTAL";
    this.log(req, `iptal: ${actor}`);
    this.d.onChange();
    return req;
  }

  /** Mint tamamlandı (alım zinciri): K zaten fill'de kaydı, burada zincir kapanır. */
  onMinted(inst: VaultInstruction) {
    const req = inst.related_id ? this.get(inst.related_id) : undefined;
    if (!req || req.side !== "BUY") return;
    req.status = "TAMAM";
    const rec = this.d.record();
    this.log(req, `mint ${fmtG(inst.qty_mg)} AGOLD (${inst.ref}) · S ${fmtG(rec.stock.s_mg)} · A ${fmtG(rec.stock.a_mg)} · K ${fmtG(rec.stock.k_mg)} · bedel mahsuplaşmada (12)`);
    this.d.notify("treasury.done", "Hazine alımı tamamlandı", `${req.id} · envanter hedefi ${fmtG(req.target_before_mg)} → ${fmtG(rec.stock.k_mg)} g`);
    this.d.onChange();
  }

  /** Kasa çıkışı kabul edildi (satım zinciri): burn zaten yapılmıştı, zincir kapanır. */
  onOutAccepted(inst: VaultInstruction) {
    const req = inst.related_id ? this.get(inst.related_id) : undefined;
    if (!req || req.side !== "SELL") return;
    req.status = "TAMAM";
    const rec = this.d.record();
    this.log(req, `kasa çıkışı kabul edildi (${inst.ref}) · V −${fmtG(inst.qty_mg)} · T ${fmtG(rec.current_account.gold_mg)} · K ${fmtG(rec.stock.k_mg)} · bedel mahsuplaşmada rafineri borcu`);
    this.d.notify("treasury.done", "Hazine satışı tamamlandı", `${req.id} · envanter hedefi ${fmtG(req.target_before_mg)} → ${fmtG(rec.stock.k_mg)} g`);
    this.d.onChange();
  }

  // ---------- iç ----------

  /** Son onayda: canlı fiyatla FOK emir, sonra kasa talimatı zinciri. */
  private async send(req: TreasuryRequest): Promise<TreasuryRequest> {
    const t = this.d.tradingOpen();
    const ps = this.d.priceState();
    const level = ps.lastPrices?.find((p) => p.ccy === req.ccy);
    if (!level || !ps.seq) { req.status = "HATA"; req.error = "canlı fiyat yok"; this.log(req, "gönderilemedi: canlı fiyat yok"); this.d.onChange(); return req; }
    if (!t.open) this.log(req, `uyarı: müşteri işlemleri kapalı (${t.reason}); hazine emri rafineri yayınına bağlıdır`);

    const px = req.side === "BUY" ? level.ask : level.bid;
    const params = this.d.orderParams();
    const client_order_id = `kz-tr-${req.id.slice(3)}`;
    const order: OrderRequest = {
      client_order_id, side: req.side, qty_mg: req.qty_mg, ccy: req.ccy, quote_seq: ps.seq,
      limit_px: limitPx(req.side, px, params.slippageBps), tif: "FOK", time_limit_ms: params.timeLimitMs,
    };
    req.status = "GÖNDERİLDİ";
    req.order_id = client_order_id;
    req.sent_ts = new Date().toISOString();
    this.log(req, `rafineriye ${req.side === "BUY" ? "ALIŞ" : "SATIŞ"} ${fmtG(req.qty_mg)} g · canlı fiyat ${px} · quote_seq ${ps.seq} · limit ${order.limit_px} · FOK`);
    this.d.onChange();

    try {
      const r = await this.d.amr.placeOrder(order, params.timeLimitMs + 2000);
      if (r.status !== "FILLED" || !r.fill) {
        req.status = "REDDEDİLDİ";
        req.reject_reason = r.reject_reason ?? r.status;
        this.log(req, `emir ${r.status}${r.reject_reason ? `: ${r.reject_reason}` : ""} · zincir kurulmadı`);
        this.d.notify("treasury.rejected", "Hazine emri gerçekleşmedi", `${req.id}: ${req.reject_reason}`);
        this.d.onChange();
        return req;
      }
      req.fill_px = r.fill.px;
      req.fill_amount_cents = r.fill.amount_cents;
      const rec = this.d.record();
      // hazine emrinde müşteri yok: stok bacağı teslim / dönüş değil, zincirin mint ya da burn adımıdır
      applyFill(rec, req.side, req.qty_mg, req.ccy, r.fill.amount_cents, { deliver: false });
      // envanter hedefi yalnız hazine alım satımıyla değişir (K2)
      shiftTarget(rec, req.side === "BUY" ? req.qty_mg : -req.qty_mg);
      req.target_after_mg = rec.stock.k_mg;
      if (r.account) compare(rec, r.account);
      this.log(req, `FILLED @ ${r.fill.px} ${req.ccy} · bedel ${fromCents(r.fill.amount_cents)} · T ${fmtG(rec.current_account.gold_mg)} · envanter hedefi K ${fmtG(req.target_before_mg)} → ${fmtG(rec.stock.k_mg)} g`);
      req.status = "ZİNCİR_SÜRÜYOR";

      const inst = req.side === "BUY"
        ? await this.d.vault().requestIn(req.qty_mg, "TREASURY_BUY", { relatedId: req.id })
        : await this.d.vault().requestOut(req.qty_mg, "TREASURY_SELL", { relatedId: req.id });
      req.vault_ref = inst.ref;
      this.log(req, `${req.side === "BUY" ? "kasa girişi" : "burn + kasa çıkışı"} talebi ${inst.ref} · durum ${inst.status}`);
      // otomatik kabulde zincir aynı anda kapanmış olabilir
      if (req.side === "BUY" && inst.minted) this.onMinted(inst);
      else if (req.side === "SELL" && inst.status === "ACCEPTED") this.onOutAccepted(inst);
    } catch (e) {
      req.status = "HATA";
      req.error = (e as Error).message;
      this.log(req, `hata: ${req.error}`);
      this.d.notify("treasury.error", "Hazine emri hatası", `${req.id}: ${req.error}`);
    }
    this.d.onChange();
    return req;
  }

  private log(req: TreasuryRequest, text: string) { req.timeline.push({ ts: new Date().toISOString(), text }); }
}
