/**
 * Kasa talimatları ve mint / burn eşlemesi (Akışlar 05 Kasa girişi, 06 Kasa çıkışı · ekran K4).
 *
 * Sıra kuraldır, tersi K1'i (A ≤ V) bozar:
 *   giriş: talep → rafineri kabulü (Kasa Giriş Fişi) → MINT           fiş önce, mint sonra
 *   çıkış: BURN → talep → rafineri kabulü (Kasa Çıkış Fişi)           burn önce, çıkış sonra
 *
 * Mint yalnız Kasa Giriş Fişi'ne karşı yapılır (K4). Mint bloke olabilir:
 *   eşleşme uyuşmazlığı (RECONCILE, 02) · kasaya koyma vadesi geçti (T+3, Kontroller)
 * Bloke sırasında fiş gelen giriş "mint bekliyor" durumunda durur; bloke kalkınca mint yapılır.
 * Kasa çıkışı talebi de RECONCILE'de bloke olur; burn yapılmadan talep gönderilmez.
 *
 * "Kasaya konuluyor" tavanı aşılacaksa yeni kasa girişi talebi durur (HOLD): alım devam eder,
 * gramlar cari hesapta (T) birikir, cari hesap limiti (K3) izler.
 *
 * Mint ve burn Kanzasset işidir, rafineriye görünmez: rafineriye giden taleplerde yalnız gram ve
 * Kanzasset referansı vardır. BitGo bacağı bu demoda işlem referansı metnidir.
 */
import { randomUUID } from "node:crypto";
import type { Account, VaultRequest } from "@amr/contract";
import { AmrClient } from "./amrClient.ts";
import { applyVaultInAccepted, applyVaultOutAccepted, applyVaultPlaced, burn, compare, mint, type KzRecord } from "./record.ts";

/** İş kuralı değerleri (K9 parametreleri; Akışlar · Parametreler). */
export interface StockParams {
  targetMg: number; // envanter hedefi K
  floorMg: number; // stok tabanı: altına inecekse büyük alış (07)
  ceilingMg: number; // stok tavanı: üstüne çıkacaksa büyük satış (08)
  mintPolicy: "SHORTFALL" | "FULL_ORDER"; // 07: eksik kısım ya da emrin tamamı
  placingCapMg: number; // "kasaya konuluyor" tavanı
  approvalMatrix: { upToMg: number; approvals: number }[]; // 09 onay matrisi
  approvalsAbove: number; // matrisin üstü
}
export const DEFAULT_STOCK_PARAMS: StockParams = {
  targetMg: 20_000_000,
  floorMg: 10_000_000,
  ceilingMg: 21_000_000,
  mintPolicy: "SHORTFALL",
  placingCapMg: 10_000_000,
  approvalMatrix: [{ upToMg: 5_000_000, approvals: 1 }, { upToMg: 15_000_000, approvals: 2 }],
  approvalsAbove: 3,
};

export type VaultTrigger = "BIG_BUY" | "BIG_SELL" | "TREASURY_BUY" | "TREASURY_SELL" | "SETTLEMENT" | "MANUAL";
export type VaultStatus = "HOLD" | "REQUESTED" | "ACCEPTED" | "PLACING" | "PLACED" | "OVERDUE" | "REJECTED" | "ERROR";

export interface VaultInstruction {
  ref: string; // Kanzasset referansı (rafineride tekil)
  type: "IN" | "OUT";
  qty_mg: number;
  trigger: VaultTrigger;
  status: VaultStatus;
  request_id?: string; // rafineri talep numarası
  doc_id?: string; // Kasa Giriş / Çıkış Fişi
  mint_tx?: string; // BitGo mint referansı (demo)
  burn_tx?: string; // BitGo burn referansı (demo)
  minted: boolean;
  burned: boolean;
  hold_reason?: string; // HOLD ya da mint beklemesi sebebi
  reject_reason?: string;
  related_id?: string; // tetikleyen müşteri emri ya da hazine talebi
  due_ts?: string; // kasaya koyma vadesi (T+3)
  created_ts: string;
  timeline: { ts: string; text: string }[];
}

export interface VaultDeps {
  amr: AmrClient;
  record: () => KzRecord;
  params: () => StockParams;
  notify: (type: string, title: string, body?: string) => void;
  onChange: () => void;
  /** Mint tamamlandı: büyük alışta (07) teslim bu adımdan sonra yapılır, hazine alımında (09) zincir kapanır. */
  onMinted?: (inst: VaultInstruction) => void;
  /** Kasa çıkışı kabul edildi: büyük satış (08) ve hazine satışı (09) zinciri kapanır. */
  onOutAccepted?: (inst: VaultInstruction) => void;
}

const g = (mg: number) => (mg / 1000).toLocaleString("tr-TR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

export class VaultDesk {
  instructions: VaultInstruction[] = [];
  private counter = 0;

  constructor(private d: VaultDeps, initial: VaultInstruction[] = []) {
    this.instructions = initial;
    this.counter = initial.length;
  }

  list(limit = 200) { return this.instructions.slice(0, limit); }
  get(ref: string) { return this.instructions.find((i) => i.ref === ref); }
  /** Rafineride "kasaya konuluyor" kaleminde duran gram: kabul edildi, henüz kasaya konmadı (T+3 izlenir). */
  placingMg() { return this.d.record().vault.placing_mg; }
  /** Gönderilmiş ama henüz cevaplanmamış giriş talepleri: kabul edilince "kasaya konuluyor" olacaklar. */
  inFlightMg() { return this.instructions.filter((i) => i.type === "IN" && i.status === "REQUESTED").reduce((a, i) => a + i.qty_mg, 0); }
  /** Tavan bu toplamla karşılaştırılır: yerleşmiş + yoldaki gram. */
  committedPlacingMg() { return this.placingMg() + this.inFlightMg(); }
  /** Fişi gelmiş ama mint'i bloke olan girişler. */
  awaitingMint() { return this.instructions.filter((i) => i.type === "IN" && i.doc_id && !i.minted && i.status !== "REJECTED"); }
  holds() { return this.instructions.filter((i) => i.status === "HOLD"); }

  /**
   * Mint bloke mi (K4)? İki sebep: eşleşme uyuşmazlığı (02) ve kasaya koyma vadesinin geçmesi (T+3).
   * Bloke sırasında fiş gelen girişler "mint bekliyor" olarak durur.
   */
  mintBlock(): string | null {
    const r = this.d.record();
    if (r.blocked.mint) return "eşleşme uyuşmazlığı (RECONCILE)";
    const overdue = this.instructions.filter((i) => i.status === "OVERDUE");
    if (overdue.length > 0) return `kasaya koyma vadesi geçti (T+3): ${overdue.map((i) => i.ref).join(", ")}`;
    return null;
  }
  /** Kasa çıkışı talebi RECONCILE'de bloke olur (02). */
  vaultOutBlock(): string | null {
    return this.d.record().blocked.vault_out ? "eşleşme uyuşmazlığı (RECONCILE)" : null;
  }

  // ---------- 05 · kasa girişi ----------

  /**
   * Kasa girişi talebi: gram cari hesaptan kasa hesabına geçer, fiş gelince mint yapılır.
   * "Kasaya konuluyor" tavanı aşılacaksa talep gönderilmez (HOLD), alım devam eder.
   */
  async requestIn(qtyMg: number, trigger: VaultTrigger, opts: { relatedId?: string } = {}): Promise<VaultInstruction> {
    const inst = this.create("IN", qtyMg, trigger, opts.relatedId);
    const cap = this.d.params().placingCapMg;
    const placing = this.committedPlacingMg();
    if (cap > 0 && placing + qtyMg > cap) {
      inst.status = "HOLD";
      inst.hold_reason = `kasaya konuluyor tavanı: ${g(placing)} + ${g(qtyMg)} > ${g(cap)} g`;
      this.log(inst, `talep durdu: ${inst.hold_reason} · alım devam eder, gramlar cari hesapta birikir (K3 izler)`);
      this.d.notify("vault.in_hold", "Kasa girişi talebi durdu: kasaya konuluyor tavanı", `${g(qtyMg)} g · ${inst.ref}`);
      this.d.onChange();
      return inst;
    }
    return this.send(inst);
  }

  /** HOLD'da bekleyen girişi yeniden dener (tavan boşalınca ya da elle). */
  async retry(ref: string): Promise<VaultInstruction> {
    const inst = this.get(ref);
    if (!inst || inst.status !== "HOLD") throw new Error("bekleyen talep yok");
    const cap = this.d.params().placingCapMg;
    if (cap > 0 && this.committedPlacingMg() + inst.qty_mg > cap) throw new Error(`kasaya konuluyor tavanı hâlâ dolu (${g(this.committedPlacingMg())} / ${g(cap)} g)`);
    return this.send(inst);
  }

  // ---------- 06 · kasa çıkışı ----------

  /**
   * Kasa çıkışı: önce burn (A −b, S −b), sonra talep. Burn önce olduğu için A ≤ V hiç bozulmaz.
   * Talep gönderilemezse burn yapılmış olur: bu bir istisnadır, bildirim düşer ve elle çözülür.
   */
  async requestOut(qtyMg: number, trigger: VaultTrigger, opts: { relatedId?: string } = {}): Promise<VaultInstruction> {
    const blocked = this.vaultOutBlock();
    const inst = this.create("OUT", qtyMg, trigger, opts.relatedId);
    if (blocked) {
      inst.status = "HOLD";
      inst.hold_reason = blocked;
      this.log(inst, `kasa çıkışı bloke: ${blocked} · burn yapılmadı`);
      this.d.notify("vault.out_blocked", "Kasa çıkışı bloke", `${g(qtyMg)} g · ${blocked}`);
      this.d.onChange();
      return inst;
    }
    const rec = this.d.record();
    burn(rec, qtyMg);
    inst.burned = true;
    inst.burn_tx = `bitgo-burn-${randomUUID().slice(0, 8)}`;
    this.log(inst, `BURN ${g(qtyMg)} AGOLD (hazine stokundan) · A −${g(qtyMg)} · S −${g(qtyMg)} · ${inst.burn_tx}`);
    return this.send(inst);
  }

  // ---------- rafineri cevabı ve olayları ----------

  /** Rafineriden gelen kasa talimatı olayı (vault.*). Tekrarlara ve sıra bozukluğuna dayanıklıdır. */
  onEvent(type: string, data: VaultRequest, account?: Account): string {
    const inst = this.get(data.ref) ?? this.adopt(data);
    inst.request_id = data.request_id;
    if (data.due_ts) inst.due_ts = data.due_ts;

    switch (type) {
      case "vault.in_accepted": {
        if (inst.status === "REQUESTED" || inst.status === "HOLD") {
          inst.status = "ACCEPTED";
          inst.doc_id = data.doc_id;
          applyVaultInAccepted(this.d.record(), inst.qty_mg);
          this.log(inst, `rafineri kabul etti · KASA GİRİŞ FİŞİ ${data.doc_id} · T −${g(inst.qty_mg)} · kasaya konuluyor +${g(inst.qty_mg)}`);
          this.tryMint(inst);
        }
        break;
      }
      case "vault.in_placing":
        if (inst.status === "ACCEPTED") { inst.status = "PLACING"; this.log(inst, "rafineri: kasaya konuluyor"); }
        break;
      case "vault.in_placed":
        if (inst.status !== "PLACED") {
          const was = inst.status;
          inst.status = "PLACED";
          if (was !== "REJECTED") applyVaultPlaced(this.d.record(), inst.qty_mg);
          this.log(inst, `rafineri: kasaya konuldu · kasaya konuluyor −${g(inst.qty_mg)} · kasada +${g(inst.qty_mg)}`);
          // vade geçmişse bloke bu girişle kalkar, bekleyen mint'ler yapılır
          this.flushMints();
        }
        break;
      case "vault.in_overdue":
        if (inst.status === "ACCEPTED" || inst.status === "PLACING") {
          inst.status = "OVERDUE";
          this.log(inst, "kasaya koyma vadesi (T+3) geçti · yeni mint bloke");
          this.d.notify("vault.in_overdue", "Kasaya koyma vadesi geçti (T+3)", `${g(inst.qty_mg)} g · ${inst.ref} · yeni mint bloke`);
        }
        break;
      case "vault.in_rejected": {
        inst.status = "REJECTED";
        inst.reject_reason = data.reject_reason;
        this.log(inst, `rafineri reddetti: ${data.reject_reason ?? ""} · gramlar cari hesapta kaldı`);
        this.d.notify("vault.in_rejected", "Rafineri kasa girişini reddetti", `${g(inst.qty_mg)} g · ${inst.ref}: ${data.reject_reason ?? ""}`);
        break;
      }
      case "vault.out_accepted": {
        if (inst.status === "REQUESTED") {
          inst.status = "ACCEPTED";
          inst.doc_id = data.doc_id;
          applyVaultOutAccepted(this.d.record(), inst.qty_mg);
          this.log(inst, `rafineri kabul etti · KASA ÇIKIŞ FİŞİ ${data.doc_id} · kasada −${g(inst.qty_mg)} · T +${g(inst.qty_mg)}`);
          this.d.onOutAccepted?.(inst);
        }
        break;
      }
      case "vault.out_rejected": {
        inst.status = "REJECTED";
        inst.reject_reason = data.reject_reason;
        // burn geri alınamaz: A ve S düştü, V düşmedi. A ≤ V korunur ama S + T = K bozulur.
        this.log(inst, `rafineri reddetti: ${data.reject_reason ?? ""} · BURN geri alınamaz, elle çözülmeli`);
        this.d.notify("vault.out_rejected", "Rafineri kasa çıkışını reddetti (burn yapılmıştı)", `${g(inst.qty_mg)} g · ${inst.ref}: ${data.reject_reason ?? ""} · S + T = K bozuldu, elle çözülmeli`);
        break;
      }
    }

    if (account) compare(this.d.record(), account);
    this.d.onChange();
    return `${inst.ref} ${type.replace("vault.", "")}${inst.minted ? " · mint yapıldı" : ""}`;
  }

  /** Bloke kalkınca fişi gelmiş ama mint'i bekleyen girişleri işler. */
  flushMints() {
    for (const inst of this.awaitingMint()) this.tryMint(inst);
  }

  // ---------- iç ----------

  /** Mint yalnız Kasa Giriş Fişi'ne karşı (K4) ve bloke yokken. */
  private tryMint(inst: VaultInstruction) {
    if (inst.minted || !inst.doc_id) return;
    const block = this.mintBlock();
    if (block) {
      inst.hold_reason = `mint bekliyor: ${block}`;
      this.log(inst, `MINT BLOKE: ${block} · fiş duruyor, bloke kalkınca mint yapılır`);
      this.d.notify("mint.blocked", "Mint bloke", `${g(inst.qty_mg)} g · ${inst.ref}: ${block}`);
      return;
    }
    mint(this.d.record(), inst.qty_mg);
    inst.minted = true;
    inst.mint_tx = `bitgo-mint-${randomUUID().slice(0, 8)}`;
    inst.hold_reason = undefined;
    this.log(inst, `MINT ${g(inst.qty_mg)} AGOLD → hazine (Kasa Giriş Fişi ${inst.doc_id} karşılığı) · A +${g(inst.qty_mg)} · S +${g(inst.qty_mg)} · ${inst.mint_tx}`);
    this.d.onMinted?.(inst);
  }

  /** Talebi rafineriye gönderir. Otomatik kabul açıksa cevap ACCEPTED gelir ve aynı anda işlenir. */
  private async send(inst: VaultInstruction): Promise<VaultInstruction> {
    inst.status = "REQUESTED";
    inst.hold_reason = undefined;
    this.log(inst, `rafineriye ${inst.type === "IN" ? "KASA GİRİŞİ" : "KASA ÇIKIŞI"} talebi ${g(inst.qty_mg)} g · ref ${inst.ref}`);
    try {
      const r = inst.type === "IN" ? await this.d.amr.vaultIn(inst.qty_mg, inst.ref) : await this.d.amr.vaultOut(inst.qty_mg, inst.ref);
      inst.request_id = r.request_id;
      if (r.status === "ACCEPTED") this.onEvent(inst.type === "IN" ? "vault.in_accepted" : "vault.out_accepted", r);
      else if (r.status === "REJECTED") this.onEvent(inst.type === "IN" ? "vault.in_rejected" : "vault.out_rejected", r);
    } catch (e) {
      inst.status = "ERROR";
      const msg = (e as Error).message;
      inst.hold_reason = msg;
      this.log(inst, `talep gönderilemedi: ${msg}${inst.burned ? " · BURN yapılmıştı, elle çözülmeli" : ""}`);
      this.d.notify("vault.error", `Kasa ${inst.type === "IN" ? "girişi" : "çıkışı"} talebi gönderilemedi`, `${g(inst.qty_mg)} g · ${inst.ref}: ${msg}`);
    }
    this.d.onChange();
    return inst;
  }

  private create(type: "IN" | "OUT", qtyMg: number, trigger: VaultTrigger, relatedId?: string): VaultInstruction {
    if (!Number.isInteger(qtyMg) || qtyMg < 1) throw new Error("miktar 0,001 g katı ve en az 0,001 g olmalı");
    const ts = new Date().toISOString();
    const inst: VaultInstruction = {
      ref: `KZ-${type === "IN" ? "VI" : "VO"}-${String(++this.counter).padStart(4, "0")}-${randomUUID().slice(0, 4).toUpperCase()}`,
      type, qty_mg: qtyMg, trigger, status: "HOLD", minted: false, burned: false,
      related_id: relatedId, created_ts: ts, timeline: [],
    };
    this.instructions.unshift(inst);
    if (this.instructions.length > 1000) this.instructions.pop();
    return inst;
  }

  /** Rafineriden bilmediğimiz bir ref ile olay gelirse (yeniden başlatma, kayıp durum) kaydı kurarız. */
  private adopt(data: VaultRequest): VaultInstruction {
    const inst: VaultInstruction = {
      ref: data.ref, type: data.type, qty_mg: data.qty_mg, trigger: "MANUAL", status: "REQUESTED",
      request_id: data.request_id, minted: false, burned: data.type === "OUT", created_ts: data.requested_ts, timeline: [],
    };
    this.log(inst, "rafineriden gelen olayla kayda alındı (KZ tarafında talep bulunamadı)");
    this.instructions.unshift(inst);
    return inst;
  }

  private log(inst: VaultInstruction, text: string) { inst.timeline.push({ ts: new Date().toISOString(), text }); }
}
