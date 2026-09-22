/**
 * Mahsuplaşma (Akışlar 12) · Kanzasset tarafı, ekran K8.
 *
 * Pencere iki taraftan da açılabilir; kesim saatinde rafineri kendiliğinden açar ve olayla bildirir.
 * Mutabakat: rafinerinin ekstresi KZ kaydıyla karşılaştırılır. Eşitse rafinerinin ekstre özeti onaylanır,
 * değilse kendi toplamlarımız gönderilir ve pencere MISMATCH olur; fark insan tarafından çözülür.
 *
 * Altın bacağı: T > 0 → kasa girişi + mint · T < 0 → burn + kasa çıkışı (kasa talimatları masası yürütür).
 * Para bacağı: kur bazında net. Borçlu Kanzasset ise ödeme YALNIZ şirket banka hesabından yapılır (K5);
 * alacaklı isek rafinerinin ödeme bildirimini "ödeme alındı" ile kapatırız.
 */
import { randomUUID } from "node:crypto";
import type { Settlement } from "@amr/contract";
import { AmrClient } from "./amrClient.ts";
import { applyFee, type KzRecord } from "./record.ts";
import type { VaultDesk } from "./vault.ts";

export interface KzSettlement {
  settlement_id: string;
  trigger: string;
  status: string;
  window_from: string;
  window_to: string;
  amr_gold_mg?: number;
  amr_money?: { ccy: string; cents: number }[];
  kz_gold_mg?: number;
  kz_money?: { ccy: string; cents: number }[];
  diffs?: { field: string; amr: string; kz: string }[];
  scope?: string[];
  gold_leg?: { direction: string; qty_mg: number; vault_ref?: string; done: boolean; proposed_ts?: string; approved_ts?: string };
  money_leg: { ccy: string; net_cents: number; direction: string; paid: boolean; bank_ref?: string }[];
  doc_id?: string;
  created_ts: string;
  timeline: { ts: string; text: string }[];
}

export interface SettlementDeps {
  amr: AmrClient;
  record: () => KzRecord;
  vault: () => VaultDesk;
  notify: (type: string, title: string, body?: string) => void;
  onChange: () => void;
}

const g = (mg: number) => (mg / 1000).toFixed(3);
const money = (c: number) => (c / 100).toFixed(2);

export class KzSettlementDesk {
  windows: KzSettlement[] = [];
  constructor(private d: SettlementDeps, initial: KzSettlement[] = []) { this.windows = initial; }

  list(limit = 100) { return this.windows.slice(0, limit); }
  get(id: string) { return this.windows.find((w) => w.settlement_id === id); }
  open() { return this.windows.find((w) => w.status !== "SETTLED"); }

  /**
   * Mahsuplaşma talep et (K8) ya da rafinerinin açtığı pencereyi al.
   * Kapsam verilmezse bütün bacaklar (altın + üç kur) kapanır; gün içi talepte tek bacak seçilebilir.
   */
  async request(trigger = "REQUEST_KZ", reason?: string, scope?: string[]): Promise<KzSettlement> {
    const s = await this.d.amr.settlementOpen(trigger, reason, scope);
    return this.absorb(s, `pencere açıldı (${trigger})${scope?.length ? ` · kapsam ${scope.join(" + ")}` : ""}${reason ? ` · ${reason}` : ""}`);
  }

  /**
   * Rafineri "kasaya koyalım mı" diye teklif etti: onaylarız ve ardından kasa girişi talebini göndeririz.
   * Onaydan önce kasa girişi talebi gitmez; fiş kesilmeden mint de olmaz.
   */
  async approveGold(id: string): Promise<KzSettlement> {
    const s = await this.d.amr.settlementApproveGold(id);
    const w = this.absorb(s, "altın teklifi onaylandı: kasaya konsun");
    await this.goldLeg(id);
    return this.get(id) ?? w;
  }

  /** Rafinerinin ekstresini çeker ve KZ kaydıyla karşılaştırır (mutabakat adımı). */
  async reconcile(id: string): Promise<KzSettlement> {
    const s = await this.d.amr.settlementGet(id);
    const w = this.absorb(s, "rafineri ekstresi alındı");
    const rec = this.d.record();
    const kzGold = rec.current_account.gold_mg;
    const kzMoney = rec.current_account.money.map((m) => ({ ccy: m.ccy, cents: m.cents }));
    w.kz_gold_mg = kzGold;
    w.kz_money = kzMoney;

    const amrGold = s.statement?.gold_mg ?? 0;
    const amrMoney = s.statement?.money ?? [];
    const diffs: { field: string; amr: string; kz: string }[] = [];
    if (amrGold !== kzGold) diffs.push({ field: "T (altın)", amr: g(amrGold), kz: g(kzGold) });
    for (const m of amrMoney) {
      const k = kzMoney.find((x) => x.ccy === m.ccy);
      if (k && k.cents !== m.cents) diffs.push({ field: `para ${m.ccy}`, amr: money(m.cents), kz: money(k.cents) });
    }

    if (diffs.length === 0) {
      const out = await this.d.amr.settlementConfirm(id, s.statement_hash!, kzGold, kzMoney);
      this.log(w, `mutabakat: KZ kaydı ile rafineri ekstresi birebir eşit · özet onaylandı`);
      return this.absorb(out, "RECONCILED");
    }
    const ownHash = `kz-${randomUUID().slice(0, 12)}`;
    const out = await this.d.amr.settlementConfirm(id, ownHash, kzGold, kzMoney);
    w.diffs = diffs;
    this.log(w, `mutabakat FARKLI: ${diffs.map((x) => `${x.field} AMR ${x.amr} / KZ ${x.kz}`).join(", ")} · ödeme bekler, insan çözer`);
    this.d.notify("settlement.mismatch", "Mahsuplaşmada fark var", `${id} · ${diffs.length} satır`);
    return this.absorb(out, "MISMATCH");
  }

  /**
   * Altın bacağını yürütür.
   *   T > 0: rafineri teklif etmiş ve biz onaylamışızdır; kasa girişi talebi gider, fiş gelince mint olur.
   *   T < 0: önce burn, sonra kasa çıkışı talebi (requestOut burn'ü kendi içinde yapar). Sıra bozulamaz.
   */
  async goldLeg(id: string): Promise<KzSettlement> {
    const w = this.get(id);
    if (!w) throw new Error("pencere yok");
    const t = this.d.record().current_account.gold_mg;
    if (t > 0 && w.gold_leg?.proposed_ts && !w.gold_leg.approved_ts) throw new Error("rafinerinin altın teklifi önce onaylanmalı");
    if (t === 0) {
      w.gold_leg = { direction: "NONE", qty_mg: 0, done: true };
      this.log(w, "altın bacağı: T zaten sıfır, işlem yok");
      this.d.onChange();
      return w;
    }
    const inst = t > 0
      ? await this.d.vault().requestIn(t, "SETTLEMENT", { relatedId: id })
      : await this.d.vault().requestOut(-t, "SETTLEMENT", { relatedId: id });
    w.gold_leg = { direction: t > 0 ? "VAULT_IN" : "VAULT_OUT", qty_mg: Math.abs(t), vault_ref: inst.ref, done: false };
    this.log(w, `altın bacağı: ${t > 0 ? "kasa girişi" : "burn + kasa çıkışı"} ${g(Math.abs(t))} g · ${inst.ref} · durum ${inst.status}`);
    this.d.onChange();
    return w;
  }

  /** Kasa talimatı kapanınca rafineriye bildirilir (altın bacağı işaretlenir). */
  async markGoldLegDone(id: string, vaultRef: string): Promise<void> {
    const w = this.get(id);
    if (!w) return;
    if (w.gold_leg) w.gold_leg.done = this.d.record().current_account.gold_mg === 0;
    this.log(w, `altın bacağı kasa talimatı kapandı: ${vaultRef} · T ${g(this.d.record().current_account.gold_mg)} g`);
    this.d.onChange();
  }

  /**
   * Para bacağı: borçluysak öde (şirket banka hesabından, K5), alacaklıysak ödemeyi onayla.
   * Ödeme cari hesabın para tarafını kapatır.
   */
  async pay(id: string, ccy: string): Promise<KzSettlement> {
    const w = this.get(id);
    if (!w) throw new Error("pencere yok");
    const leg = w.money_leg.find((l) => l.ccy === ccy);
    if (!leg) throw new Error(`kur yok: ${ccy}`);
    if (leg.paid || leg.net_cents === 0) return w;

    if (leg.direction === "KZ_TO_AMR") {
      const bankRef = `TR-${randomUUID().slice(0, 8).toUpperCase()}`;
      this.log(w, `ödeme talimatı: ŞİRKET banka hesabından rafineriye ${money(-leg.net_cents)} ${ccy} (K5: müşteri hesabı asla ödemez)`);
      const s1 = await this.d.amr.settlementPaymentNotice(id, ccy, Math.abs(leg.net_cents), "KZ_TO_AMR", bankRef);
      this.absorb(s1, `ödeme bildirimi gönderildi · banka ref ${bankRef}`);
      const s2 = await this.d.amr.settlementPaymentReceived(id, ccy, bankRef);
      applyFee(this.d.record(), ccy as any, leg.net_cents); // eksi borcu kapatır
      this.log(w, `rafineri ödemeyi aldı · ${ccy} kapandı`);
      return this.absorb(s2, "ödeme kapandı");
    }
    // rafineri bize borçlu: ödeme alındı diyoruz
    const s = await this.d.amr.settlementPaymentReceived(id, ccy, leg.bank_ref);
    applyFee(this.d.record(), ccy as any, leg.net_cents);
    this.log(w, `rafineriden ödeme alındı: ${money(leg.net_cents)} ${ccy}`);
    return this.absorb(s, "ödeme alındı");
  }

  /** Rafineri olayları (settlement.*). */
  onEvent(type: string, data: any): string {
    const id = data?.settlement_id ?? data?.id;
    if (type === "settlement.requested") {
      this.d.notify("settlement.requested", "Rafineri mahsuplaşma talep etti", data?.reason ?? "");
      return `mahsuplaşma talebi (${data?.trigger ?? ""})`;
    }
    if (type === "settlement.gold_proposed") {
      this.d.notify("settlement.gold_proposed", "Rafineri altını kasaya koymayı teklif etti", `${g(data?.qty_mg ?? 0)} g · onayınız bekleniyor`);
      const w = id ? this.get(id) : undefined;
      if (w) { w.gold_leg = { ...(w.gold_leg ?? { direction: "VAULT_IN", qty_mg: data?.qty_mg ?? 0, done: false }), direction: "VAULT_IN", qty_mg: data?.qty_mg ?? 0, proposed_ts: data?.proposed_ts }; this.log(w, `rafineri teklifi: ${g(data?.qty_mg ?? 0)} g kasaya konsun mu`); this.d.onChange(); }
      return `altın teklifi ${id ?? ""}`;
    }
    if (type === "settlement.opened") {
      this.d.notify("settlement.opened", "Mahsuplaşma penceresi açıldı", `${data?.trigger ?? ""}`);
      if (id) void this.reconcile(id).catch(() => {});
      return `pencere açıldı ${id ?? ""}`;
    }
    if (!id) return type;
    if (data.money_leg) this.absorb(data as Settlement, `olay: ${type.replace("settlement.", "")}`);
    if (type === "settlement.settled") this.d.notify("settlement.settled", "Mahsuplaşma kapandı", `${id} · limit sayaçları sıfırlandı`);
    if (type === "settlement.payment_notice") this.d.notify("settlement.payment_notice", "Rafineri ödeme bildirdi", `${data?.ccy ?? ""} ${money(data?.amount_cents ?? 0)}`);
    this.d.onChange();
    return `${id} ${type.replace("settlement.", "")}`;
  }

  /** Rafineriden gelen pencereyi KZ kaydına alır. */
  private absorb(s: Settlement, note: string): KzSettlement {
    let w = this.get(s.settlement_id);
    if (!w) {
      w = {
        settlement_id: s.settlement_id, trigger: s.trigger, status: s.status,
        window_from: s.window_from, window_to: s.window_to, money_leg: [], created_ts: s.opened_ts, timeline: [],
      };
      this.windows.unshift(w);
      if (this.windows.length > 200) this.windows.pop();
    }
    w.status = s.status;
    w.money_leg = s.money_leg.map((m) => ({ ccy: m.ccy, net_cents: m.net_cents, direction: m.direction, paid: m.paid, bank_ref: m.bank_ref }));
    if (s.statement) { w.amr_gold_mg = s.statement.gold_mg; w.amr_money = s.statement.money.map((m) => ({ ccy: m.ccy, cents: m.cents })); }
    if (s.diffs) w.diffs = s.diffs;
    if (s.doc_id) w.doc_id = s.doc_id;
    if (s.scope) w.scope = s.scope;
    if (s.gold_leg) {
      // birleştirilir, üzerine yazılmaz: geç gelen bir olay teklifi ya da onayı silmesin
      w.gold_leg = {
        direction: s.gold_leg.direction, qty_mg: s.gold_leg.qty_mg,
        vault_ref: w.gold_leg?.vault_ref, done: s.gold_leg.done || (w.gold_leg?.done ?? false),
        proposed_ts: s.gold_leg.proposed_ts ?? w.gold_leg?.proposed_ts,
        approved_ts: s.gold_leg.approved_ts ?? w.gold_leg?.approved_ts,
      };
    }
    this.log(w, note);
    this.d.onChange();
    return w;
  }

  private log(w: KzSettlement, text: string) { w.timeline.push({ ts: new Date().toISOString(), text }); }
}
