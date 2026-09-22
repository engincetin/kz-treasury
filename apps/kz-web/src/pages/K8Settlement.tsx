import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { needsApproval, api, fmtDT, fmtG, fmtMoney, STL_STATUS_TR, STL_TRIGGER_TR, type KzSettlement, type useLive } from "../api.ts";
import { nextAction, openMoneyLegs, steps } from "../settlementFlow.ts";

type Live = ReturnType<typeof useLive>;

/**
 * K8 Mahsuplaşma (Akışlar 12).
 *
 * Ekran tek soruya cevap verir: "şimdi ne olacak". Üstte beş adımlık durum şeridi,
 * altında o an yapılacak tek aksiyon. Rakamlar ve geçmiş "Ayrıntılar" altındadır.
 * Akış değişmedi: rafineri ekstresi → mutabakat → altın bacağı (kasa talimatı) → para bacağı → kapanış.
 */
export function K8Settlement({ live }: { live: Live }) {
  const [items, setItems] = useState<KzSettlement[]>([]);
  const [open, setOpen] = useState<KzSettlement | null>(null);
  const [sel, setSel] = useState<KzSettlement | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [reason, setReason] = useState("");

  const load = () => api.settlements().then((r) => { setItems(r.items); setOpen(r.open); if (sel) setSel(r.items.find((x) => x.settlement_id === sel.settlement_id) ?? null); }).catch((e) => setMsg(`Hata: ${e.message}`));
  useEffect(() => { load(); }, [live.version]);

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key); setMsg("");
    try {
      const r = await fn();
      // kritik aksiyon: sunucu uygulamadı, ikinci onay bekliyor (K9'dan onaylanır)
      setMsg(needsApproval(r) ? `${r.message}. Onay K9 Parametreler ekranından verilir (onay ${r.approval_id}).` : done);
      await load(); live.refresh();
    }
    catch (e) { setMsg(`Hata: ${(e as Error).message}`); }
    finally { setBusy(""); }
  };

  const w = sel ?? open;
  /** Açık pencere yoksa şerit son pencereyi gösterir: ekran boş kalmasın, gün nasıl kapandı görünsün. */
  const shown = w ?? items[0] ?? null;
  const rec = live.status?.record;
  const flow = steps(shown);
  const next = nextAction(w);
  const leg = next.ccy && w ? w.money_leg.find((m) => m.ccy === next.ccy)! : null;

  return (
    <div>
      <span className="tag">K8</span>
      <h1>Mahsuplaşma</h1>
      <p className="sub">Gün içinde biriken karşılıklı alacak ve borç tek seferde kapanır. Pencere kesim saatinde kendiliğinden açılır, iki taraf da talep edebilir. Adımlar sırayla ilerler; her an yapılacak tek iş aşağıdaki kutuda yazar.</p>

      {/* ---- durum şeridi ---- */}
      {!w && shown && <div className="small" style={{ marginBottom: 6 }}>Son pencere: {shown.settlement_id} · {fmtDT(shown.created_ts)}</div>}
      <div className="steps" style={{ marginBottom: 14 }}>
        {flow.map((s) => (
          <div key={s.n} className={`step ${s.state === "bad" ? "now" : s.state}`}>
            <div className="n">ADIM {s.n}{s.state === "done" ? " ✓" : ""}</div>
            <div className="t" style={s.state === "bad" ? { color: "var(--bad)" } : undefined}>{s.title}</div>
            <div className="d">{s.detail}</div>
          </div>
        ))}
      </div>

      {/* ---- sıradaki adım ---- */}
      <div className="next" style={{ marginBottom: 14 }}>
        <div>
          <div className="q">{next.title}</div>
          <div className="w">{next.body}</div>
        </div>
        <div className="sp" />
        <div className="row">
          {next.action === "request" && (
            <>
              <input placeholder="gerekçe" value={reason} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 200 }} />
              <button className="primary" disabled={busy === "req"} onClick={() => act("req", () => api.settlementRequest(reason.trim() || "Kanzasset talebi"), "Pencere açıldı, rafineriye bildirim gitti.")}>Şimdi netleşelim</button>
            </>
          )}
          {next.action === "reconcile" && (
            <button className="primary" disabled={busy === "rec"} onClick={() => act("rec", () => api.settlementReconcile(w!.settlement_id), "Mutabakat çalıştırıldı.")}>Mutabakatı çalıştır</button>
          )}
          {next.action === "gold" && (
            <button className="primary" disabled={busy === "gold"} onClick={() => act("gold", () => api.settlementGoldLeg(w!.settlement_id), "Altın bacağı için kasa talimatı gönderildi.")}>Kasa talimatını gönder</button>
          )}
          {(next.action === "pay-out" || next.action === "pay-in") && leg && (
            <button className="primary" disabled={busy === leg.ccy} onClick={() => act(leg.ccy, () => api.settlementPay(w!.settlement_id, leg.ccy), `${leg.ccy} bacağı kapandı.`)}>
              {next.action === "pay-out" ? "Şirket hesabından öde" : "Ödeme alındı"}
            </button>
          )}
          {next.action === "done" && w?.doc_id && (
            <a className="pill accent" href={`/api/documents/${w.doc_id}`} target="_blank" rel="noreferrer" style={{ padding: "8px 13px" }}>Mahsuplaşma Ekstresi</a>
          )}
          {next.action === null && w?.gold_leg?.vault_ref && <Link to="/kasa"><button>K4 Kasa talimatlarına git</button></Link>}
        </div>
      </div>

      {msg && <div className="note" style={{ marginBottom: 12 }}>{msg}</div>}

      {/* ---- mutabakat farkları ---- */}
      {w?.diffs && w.diffs.length > 0 && (
        <section className="card" style={{ marginBottom: 14, borderColor: "var(--bad)" }}>
          <h2>Mutabakat farkları</h2>
          <p className="small">Fark varsa mint ve kasa çıkışı bloke kalır, ödeme bekler. Fark insan tarafından çözülür: K2 ekranından anlık fotoğraf alınır ve açıklamayla kapatılır.</p>
          <table>
            <thead><tr><th>Alan</th><th className="num">Rafineri</th><th className="num">KZ kaydı</th></tr></thead>
            <tbody>{w.diffs.map((d, i) => <tr key={i}><td>{d.field}</td><td className="num mono">{d.amr}</td><td className="num mono">{d.kz}</td></tr>)}</tbody>
          </table>
          <div className="row" style={{ marginTop: 10 }}><Link to="/hesaplar"><button>K2 Rafineri hesaplarına git</button></Link></div>
        </section>
      )}

      {/* ---- ayrıntılar ---- */}
      {shown && (
        <details className="card" style={{ marginBottom: 14 }}>
          <summary>Ayrıntılar · {shown.settlement_id} · {STL_STATUS_TR[shown.status] ?? shown.status}</summary>
          <div className="grid c2" style={{ marginTop: 12 }}>
            <div>
              <h2>Pencere ve toplamlar</h2>
              <div className="kv">
                <span className="k">Tetik</span><span>{STL_TRIGGER_TR[shown.trigger] ?? shown.trigger}</span>
                <span className="k">Aralık</span><span className="mono small">{fmtDT(shown.window_from)} → {fmtDT(shown.window_to)}</span>
                <span className="k">Rafineri ekstresi</span><span className="mono small">T {shown.amr_gold_mg !== undefined ? fmtG(shown.amr_gold_mg) : "?"} g · {shown.amr_money?.map((m) => `${m.ccy} ${fmtMoney(m.cents)}`).join(" · ")}</span>
                <span className="k">KZ kaydı</span><span className="mono small">T {shown.kz_gold_mg !== undefined ? fmtG(shown.kz_gold_mg) : "?"} g · {shown.kz_money?.map((m) => `${m.ccy} ${fmtMoney(m.cents)}`).join(" · ")}</span>
                <span className="k">Cari hesap (şu an)</span><span className="mono small">{(rec?.current_account.gold_mg ?? 0) >= 0 ? "+" : ""}{fmtG(rec?.current_account.gold_mg ?? 0)} g · {rec?.current_account.money.map((m) => `${m.ccy} ${fmtMoney(m.cents)}`).join(" · ")}</span>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button disabled={busy === "rec"} onClick={() => act("rec", () => api.settlementReconcile(shown.settlement_id), "Mutabakat yeniden çalıştırıldı.")}>Mutabakatı yeniden çalıştır</button>
                {shown.doc_id && <a href={`/api/documents/${shown.doc_id}`} target="_blank" rel="noreferrer" className="pill">Ekstre belgesi</a>}
              </div>
            </div>
            <div>
              <h2>Altın bacağı</h2>
              {shown.gold_leg ? (
                <div className="kv">
                  <span className="k">Yön</span><span>{shown.gold_leg.direction === "VAULT_IN" ? "kasa girişi + mint" : shown.gold_leg.direction === "VAULT_OUT" ? "burn + kasa çıkışı" : "işlem yok"}</span>
                  <span className="k">Miktar</span><span className="mono">{fmtG(shown.gold_leg.qty_mg)} g</span>
                  <span className="k">Kasa talimatı</span><span className="mono small">{shown.gold_leg.vault_ref ?? "henüz yok"}</span>
                  <span className="k">Durum</span><span><span className={`pill ${shown.gold_leg.done ? "ok" : "warn"}`}>{shown.gold_leg.done ? "kapandı (T = 0)" : "rafineri kabulü bekliyor"}</span></span>
                </div>
              ) : <div className="small">Mutabakat sonrası belirir.</div>}
              <h2 style={{ marginTop: 14 }}>Para bacağı</h2>
              <table>
                <thead><tr><th>Kur</th><th className="num">Net</th><th>Yön</th><th>Durum</th></tr></thead>
                <tbody>
                  {shown.money_leg.map((m) => (
                    <tr key={m.ccy}>
                      <td>{m.ccy}</td>
                      <td className="num mono">{m.net_cents > 0 ? "+" : ""}{fmtMoney(m.net_cents)}</td>
                      <td className="small">{m.direction === "KZ_TO_AMR" ? "biz öderiz" : m.direction === "AMR_TO_KZ" ? "rafineri öder" : "yok"}</td>
                      <td><span className={`pill ${m.paid ? "ok" : m.net_cents === 0 ? "neut" : "warn"}`}>{m.paid ? "kapandı" : m.net_cents === 0 ? "yok" : "bekliyor"}</span>{m.bank_ref ? <div className="mono small">{m.bank_ref}</div> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="small" style={{ marginTop: 6 }}>Ödeme yalnız şirket banka hesabından yapılır; müşteri hesabı asla ödemez (K5).</div>
            </div>
          </div>
          <h2 style={{ marginTop: 14 }}>Zaman çizelgesi</h2>
          <table><tbody>{shown.timeline.map((t, i) => <tr key={i}><td className="mono small" style={{ whiteSpace: "nowrap" }}>{fmtDT(t.ts)}</td><td className="small">{t.text}</td></tr>)}</tbody></table>
        </details>
      )}

      <section className="card">
        <h2>Pencereler</h2>
        <table>
          <thead><tr><th>Açılış</th><th>Pencere</th><th>Tetik</th><th>Durum</th><th>Para</th></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={5} className="small">Pencere yok</td></tr>}
            {items.map((x) => (
              <tr key={x.settlement_id} onClick={() => setSel(x.settlement_id === sel?.settlement_id ? null : x)} style={{ cursor: "pointer", background: sel?.settlement_id === x.settlement_id ? "var(--soft)" : undefined }}>
                <td className="mono">{fmtDT(x.created_ts)}</td>
                <td className="mono small">{x.settlement_id}</td>
                <td className="small">{STL_TRIGGER_TR[x.trigger] ?? x.trigger}</td>
                <td><span className={`pill ${x.status === "SETTLED" ? "ok" : x.status === "MISMATCH" ? "bad" : "warn"}`}>{STL_STATUS_TR[x.status] ?? x.status}</span></td>
                <td className="small">{x.money_leg.filter((m) => m.net_cents !== 0).map((m) => `${m.ccy} ${fmtMoney(m.net_cents)}`).join(" · ") || "yok"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="small" style={{ marginTop: 6 }}>Satıra tıklayınca o pencerenin adımları yukarıda görünür; tekrar tıklayınca açık pencereye döner.</div>
      </section>
    </div>
  );
}
