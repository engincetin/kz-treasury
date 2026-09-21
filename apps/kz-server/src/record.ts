/**
 * KZ kaydı ve Eşleşme kuralı (Akışlar 02, Kontrol · Düzenli kontroller).
 *
 * Kanzasset her hareketi kendi kaydına işler; rafineriden gelen bakiye bilgisi (account) ile birebir eşit olmalıdır.
 *   eşit değil → RECONCILE: hareket geçerli kalır, iki tarafa bildirim, mint ve kasa çıkışı talebi bloke (çözülene kadar)
 *   seq atladı → anlık fotoğraf istenir (GET /v1/account), eşitse seq alınır
 * KZ tarafı büyüklükleri: S (hazine stoku, token) · K (envanter hedefi) · A (arz) · C = A − S (müşteride).
 * Kontroller: K1 A ≤ V · K2 S + T = K.
 * İşaret: T artı = aldık (kasaya konmadı), P eksi = Kanzasset borçlu.
 */
import { CCYS, type Account, type Ccy } from "@amr/contract";

export interface Diff { field: string; kz: number; amr: number }
export interface KzRecord {
  seq: number;
  vault: { in_vault_mg: number; placing_mg: number; shipping_mg: number };
  current_account: { gold_mg: number; money: { ccy: Ccy; cents: number }[] };
  stock: { s_mg: number; k_mg: number; a_mg: number; e_mg: number };
  match: "EŞİT" | "RECONCILE" | "BEKLİYOR";
  diffs: Diff[];
  blocked: { mint: boolean; vault_out: boolean };
  lastAccount: Account | null;
  lastCompareTs: string | null;
  corrections: { ts: string; explanation: string; before: unknown; after: unknown }[];
}

export function emptyRecord(openingMg = 0): KzRecord {
  return {
    seq: openingMg > 0 ? 1 : 0, // açılış devri rafineride seq 1'dir
    vault: { in_vault_mg: openingMg, placing_mg: 0, shipping_mg: 0 },
    current_account: { gold_mg: 0, money: CCYS.map((ccy) => ({ ccy, cents: 0 })) },
    stock: { s_mg: openingMg, k_mg: openingMg, a_mg: openingMg, e_mg: 0 },
    match: "BEKLİYOR", diffs: [], blocked: { mint: false, vault_out: false }, lastAccount: null, lastCompareTs: null, corrections: [],
  };
}

/**
 * Fill'i KZ kaydına işler (rafineri bacağı + hazine stoku).
 * `deliver = false`: müşteriye teslim / stoğa dönüş bu anda olmaz, yalnız rafineri bacağı (T ve P) işlenir.
 * Büyük alışta (07) teslim mint'ten sonradır, geç fill'de teslim hiç olmaz, hazine emrinde (09) müşteri yoktur.
 */
export function applyFill(r: KzRecord, side: "BUY" | "SELL", qtyMg: number, ccy: Ccy, amountCents: number, opts: { deliver?: boolean } = {}) {
  const sign = side === "BUY" ? 1 : -1;
  r.current_account.gold_mg += sign * qtyMg;
  const m = r.current_account.money.find((x) => x.ccy === ccy)!;
  m.cents += -sign * amountCents;
  if (opts.deliver ?? true) applyDelivery(r, side, qtyMg);
}

/** Müşteri bacağı: alışta stoktan teslim (S −x), satışta stoğa dönüş (S +x). */
export function applyDelivery(r: KzRecord, side: "BUY" | "SELL", qtyMg: number) {
  r.stock.s_mg -= side === "BUY" ? qtyMg : -qtyMg;
}

// ---------- kasa talimatı bacağı (05, 06) · rafineriye görünmeyen mint / burn ----------

/** Kasa girişi kabulü (Kasa Giriş Fişi geldi): T −q, kasaya konuluyor +q. */
export function applyVaultInAccepted(r: KzRecord, qtyMg: number) {
  r.current_account.gold_mg -= qtyMg;
  r.vault.placing_mg += qtyMg;
}
/** Kasaya konuldu: kasaya konuluyor −q, kasada +q (V toplamı değişmez). */
export function applyVaultPlaced(r: KzRecord, qtyMg: number) {
  r.vault.placing_mg -= qtyMg;
  r.vault.in_vault_mg += qtyMg;
}
/** Kasa çıkışı kabulü (Kasa Çıkış Fişi geldi): kasada −b, T +b. */
export function applyVaultOutAccepted(r: KzRecord, qtyMg: number) {
  r.vault.in_vault_mg -= qtyMg;
  r.current_account.gold_mg += qtyMg;
}
/** Mint: yalnız Kasa Giriş Fişi'ne karşı (K4). A +q, S +q. Rafineriye görünmez. */
export function mint(r: KzRecord, qtyMg: number) {
  r.stock.a_mg += qtyMg;
  r.stock.s_mg += qtyMg;
}
/** Burn: kasa çıkışı talebinden önce (K1: A ≤ V hiç bozulmaz). A −b, S −b. Rafineriye görünmez. */
export function burn(r: KzRecord, qtyMg: number) {
  r.stock.a_mg -= qtyMg;
  r.stock.s_mg -= qtyMg;
}
/** Envanter hedefi K yalnız hazine alım satımıyla değişir (09). */
export function shiftTarget(r: KzRecord, deltaMg: number) {
  r.stock.k_mg += deltaMg;
}

// ---------- emanet (E) ve hizmet bedelleri · fiziksel teslimat ve rafinasyon (10, 11) ----------

/** Talep anında müşteri tokenleri burn cüzdanına geçer: E +x, C −x. Henüz yakılmadı, arz değişmez. */
export function escrowIn(r: KzRecord, qtyMg: number) {
  r.stock.e_mg = (r.stock.e_mg ?? 0) + qtyMg;
}
/** Talep iptalinde emanet çözülür: tokenler müşteriye döner. */
export function escrowRelease(r: KzRecord, qtyMg: number) {
  r.stock.e_mg = Math.max(0, (r.stock.e_mg ?? 0) - qtyMg);
}
/** Teslimde emanetteki tokenler yakılır: A −x, E −x. Hazine stoku (S) etkilenmez, K2 korunur. */
export function burnEscrow(r: KzRecord, qtyMg: number) {
  r.stock.a_mg -= qtyMg;
  r.stock.e_mg = Math.max(0, (r.stock.e_mg ?? 0) - qtyMg);
}
/** Kasa hareketi: hazır olunca kasadan sevkiyata, teslimde sevkiyattan çıkış. */
export function applyShipReady(r: KzRecord, qtyMg: number) {
  r.vault.in_vault_mg -= qtyMg;
  r.vault.shipping_mg += qtyMg;
}
export function applyShipReturn(r: KzRecord, qtyMg: number) {
  r.vault.shipping_mg -= qtyMg;
  r.vault.in_vault_mg += qtyMg;
}
export function applyShipDelivered(r: KzRecord, qtyMg: number) {
  r.vault.shipping_mg -= qtyMg;
}
/** Onaylanan lojistik ve rafinasyon bedeli cari hesabın para tarafına kalem olur (Kanzasset borçlu). */
export function applyFee(r: KzRecord, ccy: Ccy, cents: number) {
  const m = r.current_account.money.find((x) => x.ccy === ccy)!;
  m.cents -= cents;
}

/** Bakiye bilgisi ile karşılaştırma. Dönüş: eşit mi, seq boşluğu var mı. */
export function compare(r: KzRecord, acc: Account): { equal: boolean; seqGap: boolean } {
  const diffs: Diff[] = [];
  const chk = (field: string, kz: number, amr: number) => { if (kz !== amr) diffs.push({ field, kz, amr }); };
  chk("vault.in_vault_mg", r.vault.in_vault_mg, acc.vault.in_vault_mg);
  chk("vault.placing_mg", r.vault.placing_mg, acc.vault.placing_mg);
  chk("vault.shipping_mg", r.vault.shipping_mg, acc.vault.shipping_mg);
  chk("current_account.gold_mg", r.current_account.gold_mg, acc.current_account.gold_mg);
  for (const ccy of CCYS) chk(`current_account.money.${ccy}`, r.current_account.money.find((m) => m.ccy === ccy)?.cents ?? 0, acc.current_account.money.find((m) => m.ccy === ccy)?.cents ?? 0);
  const seqGap = acc.seq > r.seq + 1;
  r.lastAccount = acc;
  r.lastCompareTs = new Date().toISOString();
  r.diffs = diffs;
  if (diffs.length === 0) {
    r.match = "EŞİT";
    r.seq = Math.max(r.seq, acc.seq);
    r.blocked = { mint: false, vault_out: false };
  } else {
    r.match = "RECONCILE";
    r.blocked = { mint: true, vault_out: true };
  }
  return { equal: diffs.length === 0, seqGap };
}

/** RECONCILE çözümü: açıklama ile rafineri fotoğrafı KZ kaydına alınır (düzeltme kaydı tutulur). */
export function resolveWithSnapshot(r: KzRecord, acc: Account, explanation: string) {
  const before = { vault: { ...r.vault }, current_account: { gold_mg: r.current_account.gold_mg, money: r.current_account.money.map((m) => ({ ...m })) } };
  r.vault = { ...acc.vault };
  r.current_account = { gold_mg: acc.current_account.gold_mg, money: CCYS.map((ccy) => ({ ccy, cents: acc.current_account.money.find((m) => m.ccy === ccy)?.cents ?? 0 })) };
  r.corrections.unshift({ ts: new Date().toISOString(), explanation, before, after: { vault: { ...acc.vault }, current_account: acc.current_account } });
  compare(r, acc);
}

export function checks(r: KzRecord) {
  const v = r.vault.in_vault_mg + r.vault.placing_mg + r.vault.shipping_mg;
  const e = r.stock.e_mg ?? 0;
  const k1 = r.stock.a_mg <= v;
  const k2 = r.stock.s_mg + r.current_account.gold_mg === r.stock.k_mg;
  return {
    k1: { ok: k1, text: `A ${fmtG(r.stock.a_mg)} ≤ V ${fmtG(v)}` },
    k2: { ok: k2, text: `S ${fmtG(r.stock.s_mg)} + T ${fmtG(r.current_account.gold_mg)} = K ${fmtG(r.stock.k_mg)}` },
    // A = S + C + E · müşteride dolaşan: arzdan hazine stoku ve emanet düşülür
    c_mg: r.stock.a_mg - r.stock.s_mg - e,
    e_mg: e,
    v_mg: v,
  };
}
const fmtG = (mg: number) => (mg / 1000).toLocaleString("tr-TR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
