/**
 * Mahsuplaşma akışının ekran karşılığı (K8, K1).
 *
 * Pencerenin durumu beş adıma indirgenir ve her an için tek bir "sıradaki adım" cümlesi üretilir.
 * Rafineri tarafındaki karşılığıyla aynı adımlar, Kanzasset'in yapacağı işlerle.
 * İş kuralları sunucudadır; burada yalnız sunum vardır.
 */
import type { KzSettlement } from "./api.ts";

export type StepState = "done" | "now" | "wait" | "bad";
export interface Step { n: number; title: string; detail: string; state: StepState }

const g = (mg: number) => (mg / 1000).toLocaleString("tr-TR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const money = (c: number) => (c / 100).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const openMoneyLegs = (w: KzSettlement) => w.money_leg.filter((m) => m.net_cents !== 0 && !m.paid);
export const goldPending = (w: KzSettlement) => !!w.gold_leg && w.gold_leg.direction !== "NONE" && !w.gold_leg.done;

export function steps(w: KzSettlement | null): Step[] {
  const st = w?.status;
  const drafted = !!w && st !== "REQUESTED" && st !== "OPEN";
  const reconciled = !!w && (st === "RECONCILED" || st === "PAYMENT_PENDING" || st === "SETTLED");
  const mismatch = st === "MISMATCH";
  const goldDone = !!w && (!w.gold_leg || w.gold_leg.direction === "NONE" || w.gold_leg.done);
  const moneyDone = !!w && openMoneyLegs(w).length === 0;
  const settled = st === "SETTLED";

  return [
    { n: 1, title: "Pencere", detail: w ? w.settlement_id : "açık pencere yok", state: w ? "done" : "wait" },
    { n: 2, title: "Rafineri ekstresi", detail: drafted ? "ekstre geldi" : "rafineriden bekleniyor", state: drafted ? "done" : w ? "now" : "wait" },
    {
      n: 3, title: "Mutabakat",
      detail: mismatch ? `${w!.diffs?.length ?? 0} fark var` : reconciled ? "KZ kaydıyla birebir eşit" : drafted ? "karşılaştırılıyor" : "ekstre bekleniyor",
      state: mismatch ? "bad" : reconciled ? "done" : drafted ? "now" : "wait",
    },
    {
      n: 4, title: "Altın bacağı",
      detail: !w?.gold_leg ? "mutabakattan sonra belirir"
        : w.gold_leg.direction === "NONE" ? "gram farkı yok"
        : `${w.gold_leg.direction === "VAULT_IN" ? "kasa girişi" : "kasa çıkışı"} ${g(w.gold_leg.qty_mg)} g${w.gold_leg.done ? " · kapandı" : w.gold_leg.vault_ref ? " · rafineri kabulü bekleniyor" : " · talimat gönderilecek"}`,
      state: goldDone && reconciled ? "done" : reconciled ? "now" : "wait",
    },
    {
      n: 5, title: "Para bacağı",
      detail: !w ? "mutabakattan sonra belirir"
        : moneyDone ? (settled ? "kapandı" : "kapanacak kalem yok")
        : openMoneyLegs(w).map((m) => `${m.ccy} ${money(Math.abs(m.net_cents))}`).join(" · "),
      state: settled ? "done" : reconciled && goldDone ? (moneyDone ? "done" : "now") : "wait",
    },
  ];
}

export interface NextAction {
  title: string;
  body: string;
  action: "request" | "reconcile" | "gold" | "pay-out" | "pay-in" | "done" | null;
  ccy?: string;
}

/** Kanzasset tarafının "şimdi ne yapmalıyım" cümlesi. */
export function nextAction(w: KzSettlement | null): NextAction {
  if (!w) return {
    title: "Açık pencere yok",
    body: "Rafineri kesim saatinde pencereyi kendiliğinden açar. Erken netleşmek isterseniz siz de talep edebilirsiniz.",
    action: "request",
  };
  switch (w.status) {
    case "REQUESTED":
    case "OPEN":
      return { title: "Rafinerinin ekstresi bekleniyor", body: "Pencere açık. Rafineri gün içindeki hareketlerden ekstre çıkarıp gönderecek; geldiğinde mutabakat kendiliğinden çalışır.", action: null };
    case "DRAFT":
      return { title: "Mutabakat çalışıyor", body: "Rafineri ekstresi geldi, KZ kaydıyla karşılaştırılıyor. Kendiliğinden ilerlemezse elle çalıştırabilirsiniz.", action: "reconcile" };
    case "MISMATCH":
      return { title: "İki ekstre tutmadı", body: "Kendi toplamlarımız rafineriye gönderildi. Farklar aşağıda; rafineri düzeltip ekstreyi yeniden çıkarınca mutabakat tekrar çalışır. Fark kapanmadan ödeme yapılmaz.", action: "reconcile" };
    case "RECONCILED":
    case "PAYMENT_PENDING": {
      if (goldPending(w)) {
        return w.gold_leg!.vault_ref
          ? { title: "Kasa talimatı rafineri kabulünü bekliyor", body: `${w.gold_leg!.vault_ref} gönderildi. Rafineri kabul edip fişi kesince cari hesaptaki gram sıfırlanır ve bu adım kapanır.`, action: null }
          : { title: "Altın bacağını gönderin", body: `Cari hesaptaki ${g(w.gold_leg!.qty_mg)} g için ${w.gold_leg!.direction === "VAULT_IN" ? "kasa girişi" : "kasa çıkışı"} talimatı hazır. Talimat kasa talimatları masasına düşer, sıra kuralı orada korunur.`, action: "gold" };
      }
      const open = openMoneyLegs(w);
      if (open.length === 0) return { title: "Kapanış bekleniyor", body: "İki bacak da kapandı, pencere birazdan SETTLED olacak.", action: null };
      const first = open[0];
      return first.direction === "KZ_TO_AMR"
        ? { title: `${first.ccy} ${money(Math.abs(first.net_cents))} ödemesi bizden`, body: "Ödeme YALNIZ şirket banka hesabından yapılır (K5); müşteri hesabı asla ödemez. Ödeme talimatı kritik aksiyondur: farklı bir kullanıcının ikinci onayı gerekir.", action: "pay-out", ccy: first.ccy }
        : { title: `${first.ccy} ${money(Math.abs(first.net_cents))} ödemesi rafineriden`, body: "Rafineri ödeyecek. Para şirket hesabına geçtiğinde \"Ödeme alındı\" deyin; cari hesabın o kur bacağı kapanır.", action: "pay-in", ccy: first.ccy };
    }
    case "SETTLED":
      return { title: "Pencere kapandı", body: "Altın ve para bacağı kapandı, cari hesap sıfırlandı. Mahsuplaşma Ekstresi belgesi rafineriden indirilebilir.", action: "done" };
    default:
      return { title: w.status, body: "", action: null };
  }
}
