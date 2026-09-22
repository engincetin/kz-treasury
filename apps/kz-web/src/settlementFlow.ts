/**
 * Mahsuplaşmanın ekran karşılığı (K8, K1).
 *
 * Rafineri tarafındaki karşılığıyla aynı: pencere tek bir listeye indirgenir, kapatılacak her kalem
 * bir "bacak"tır (altın, USD, EUR, AED). Her bacağın tek bir hâli ve o an yapılacak tek bir işi vardır.
 * İş kuralları sunucudadır; burada yalnız sunum.
 */
import type { KzSettlement } from "./api.ts";

const g = (mg: number) => (mg / 1000).toLocaleString("tr-TR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const money = (c: number) => (c / 100).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type LegState = "kapandı" | "sizde" | "karşıda" | "yok";
export type LegAction = "gold-approve" | "gold-send" | "gold-info" | "pay" | null;

export interface Leg {
  key: string;
  label: string;
  amount: string;
  who: string;
  state: LegState;
  note: string;
  action: LegAction;
  actionLabel?: string;
  ccy?: string;
}

/** Mutabakat adımının hâli: rafineri ekstresi geldi mi, KZ kaydıyla eşit mi. */
export function reconciliation(w: KzSettlement | null): { state: "yok" | "bekliyor" | "eşit" | "fark"; text: string; canReconcile: boolean } {
  if (!w) return { state: "yok", text: "açık pencere yok", canReconcile: false };
  if (w.status === "OPEN" || w.status === "REQUESTED") return { state: "yok", text: "rafinerinin ekstresi bekleniyor", canReconcile: true };
  if (w.status === "DRAFT") return { state: "bekliyor", text: "ekstre geldi, KZ kaydıyla karşılaştırılıyor", canReconcile: true };
  if (w.status === "MISMATCH") return { state: "fark", text: `${w.diffs?.length ?? 0} satırda fark var: kalemler düzeltilip yeniden karşılaştırılmalı`, canReconcile: true };
  return { state: "eşit", text: "KZ kaydı ile rafineri ekstresi birebir eşit, bacaklar kapatılabilir", canReconcile: false };
}

/** Kapsam metni: hangi bacaklar bu pencerede kapatılıyor. */
export function scopeText(w: KzSettlement | null): string {
  const s = w?.scope;
  if (!s || s.length === 0 || s.length >= 4) return "tümü (altın + USD + EUR + AED)";
  return s.map((x) => (x === "GOLD" ? "altın" : x)).join(" + ");
}

/**
 * Kanzasset tarafının bacak listesi.
 * Altın bacağında sıra sabittir: rafineri borçluysa teklifini onaylarız ve kasa girişi talebi gider
 * (fiş gelince mint). Biz borçluysak önce token yakılır, sonra kasa çıkışı talebi gider.
 */
export function legs(w: KzSettlement | null): Leg[] {
  if (!w) return [];
  const rec = reconciliation(w);
  const ready = rec.state === "eşit";
  const out: Leg[] = [];
  const inScope = (k: string) => !w.scope || w.scope.length === 0 || w.scope.includes(k);

  if (inScope("GOLD")) {
    const gl = w.gold_leg;
    if (!gl || gl.direction === "NONE") {
      out.push({ key: "GOLD", label: "Altın", amount: "0,000 g", who: "gram farkı yok", state: "yok", note: "cari hesapta kapanacak gram yok", action: null });
    } else if (gl.done) {
      out.push({ key: "GOLD", label: "Altın", amount: `${g(gl.qty_mg)} g`, who: gl.direction === "VAULT_IN" ? "rafineri borçluydu" : "Kanzasset borçluydu", state: "kapandı", note: `kasa talimatı kapandı${gl.vault_ref ? ` (${gl.vault_ref})` : ""}, T sıfırlandı`, action: null });
    } else if (gl.direction === "VAULT_IN") {
      if (!gl.proposed_ts) {
        out.push({ key: "GOLD", label: "Altın", amount: `${g(gl.qty_mg)} g`, who: "rafineri borçlu", state: "karşıda", note: "rafinerinin \"kasaya koyalım mı\" teklifi bekleniyor", action: null });
      } else if (!gl.approved_ts) {
        out.push({ key: "GOLD", label: "Altın", amount: `${g(gl.qty_mg)} g`, who: "rafineri borçlu", state: ready ? "sizde" : "karşıda", note: "rafineri teklif etti: onaylayın, kasa girişi talebi gitsin. Fiş gelince mint edilir", action: ready ? "gold-approve" : null, actionLabel: "Onayla: kasaya konsun" });
      } else if (!gl.vault_ref) {
        out.push({ key: "GOLD", label: "Altın", amount: `${g(gl.qty_mg)} g`, who: "rafineri borçlu", state: "sizde", note: "onaylandı; kasa girişi talebi gönderilecek", action: "gold-send", actionLabel: "Kasa girişi talebi gönder" });
      } else {
        out.push({ key: "GOLD", label: "Altın", amount: `${g(gl.qty_mg)} g`, who: "rafineri borçlu", state: "karşıda", note: `talep gönderildi (${gl.vault_ref}); rafinerinin kabulü ve Kasa Giriş Fişi bekleniyor, fiş gelince mint olur`, action: "gold-info", actionLabel: "K4 Kasa hesabı" });
      }
    } else {
      if (!gl.vault_ref) {
        out.push({ key: "GOLD", label: "Altın", amount: `${g(gl.qty_mg)} g`, who: "Kanzasset borçlu", state: ready ? "sizde" : "karşıda", note: "önce token yakılır, sonra kasa çıkışı talebi gider. Rafineri bizim talebimiz olmadan kasadan gram çıkaramaz", action: ready ? "gold-send" : null, actionLabel: "Yak ve kasa çıkışı talebi gönder" });
      } else {
        out.push({ key: "GOLD", label: "Altın", amount: `${g(gl.qty_mg)} g`, who: "Kanzasset borçlu", state: "karşıda", note: `token yakıldı, talep gönderildi (${gl.vault_ref}); rafinerinin kabulü bekleniyor`, action: "gold-info", actionLabel: "K4 Kasa hesabı" });
      }
    }
  }

  for (const m of w.money_leg) {
    if (m.net_cents === 0) {
      out.push({ key: m.ccy, label: m.ccy, amount: money(0), who: "kapanacak kalem yok", state: "yok", note: "bu kurda borç alacak yok", action: null, ccy: m.ccy });
      continue;
    }
    if (m.paid) {
      out.push({ key: m.ccy, label: m.ccy, amount: money(Math.abs(m.net_cents)), who: m.direction === "KZ_TO_AMR" ? "Kanzasset borçluydu" : "rafineri borçluydu", state: "kapandı", note: `ödeme kapandı${m.bank_ref ? ` · banka ref ${m.bank_ref}` : ""}`, action: null, ccy: m.ccy });
      continue;
    }
    if (m.direction === "KZ_TO_AMR") {
      out.push({ key: m.ccy, label: m.ccy, amount: money(Math.abs(m.net_cents)), who: "Kanzasset borçlu", state: ready ? "sizde" : "karşıda", note: ready ? "ödeme YALNIZ şirket banka hesabından yapılır (K5); ikinci onay ister" : "mutabakattan sonra ödenir", action: ready ? "pay" : null, actionLabel: "Öde (şirket hesabından)", ccy: m.ccy });
    } else {
      out.push({ key: m.ccy, label: m.ccy, amount: money(Math.abs(m.net_cents)), who: "rafineri borçlu", state: ready ? "sizde" : "karşıda", note: m.bank_ref ? `rafineri ödeme bildirdi (${m.bank_ref}); para geldiyse onaylayın` : "rafineri ödeyecek; para geldiğinde onaylayın", action: ready ? "pay" : null, actionLabel: "Ödeme alındı", ccy: m.ccy });
    }
  }
  return out;
}

/** Tek cümlelik özet: kaç bacak açık ve sıradaki iş kimde. */
export function summary(w: KzSettlement | null): string {
  if (!w) return "Açık pencere yok. Kesim saatinde rafineri kendiliğinden açar; erken kapatmak için talep edin.";
  if (w.status === "SETTLED") return "Pencere kapandı: bütün bacaklar sıfırlandı, Mahsuplaşma Ekstresi alındı.";
  const rec = reconciliation(w);
  if (rec.state !== "eşit") return `Mutabakat: ${rec.text}.`;
  const rows = legs(w).filter((l) => l.state === "sizde" || l.state === "karşıda");
  if (rows.length === 0) return "Bütün bacaklar kapandı, pencere birazdan kapanacak.";
  const mine = rows.filter((l) => l.state === "sizde");
  const head = `${rows.length} bacak açık`;
  return mine.length ? `${head} · sıradaki iş sizde: ${mine[0].label} ${mine[0].amount}` : `${head} · sıradaki iş rafineride: ${rows[0].label} ${rows[0].amount}`;
}
