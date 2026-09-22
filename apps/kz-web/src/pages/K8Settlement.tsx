import { useEffect, useState } from "react";
import { needsApproval, api, fmtDT, fmtG, fmtMoney, STL_STATUS_TR, STL_TRIGGER_TR, type KzSettlement, type useLive } from "../api.ts";

type Live = ReturnType<typeof useLive>;

/**
 * K8 Mahsuplaşma (Akışlar 12).
 * Pencere iki taraftan da açılabilir; kesim saatinde rafineri kendiliğinden açar.
 * Mutabakat: rafinerinin ekstresi KZ kaydıyla karşılaştırılır. Altın bacağı kasa talimatıyla,
 * para bacağı banka ödemesiyle kapanır. Ödeme yalnız şirket hesabından yapılır (K5).
 */
export function K8Settlement({ live }: { live: Live }) {
  const [items, setItems] = useState<KzSettlement[]>([]);
  const [open, setOpen] = useState<KzSettlement | null>(null);
  const [sel, setSel] = useState<KzSettlement | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [reason, setReason] = useState("");

  const load = () => api.settlements().then((r) => { setItems(r.items); setOpen(r.open); }).catch((e) => setMsg(`Hata: ${e.message}`));
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
  const rec = live.status?.record;

  return (
    <div>
      <span className="tag">K8</span>
      <h1>Mahsuplaşma</h1>
      <p className="sub">Gün içinde biriken karşılıklı alacak ve borç tek seferde kapanır. Pencere kesim saatinde kendiliğinden açılır, iki taraf da talep edebilir. Mutabakatta rafinerinin ekstresi KZ kaydıyla birebir karşılaştırılır; fark varsa işlem durur ve insan çözer. Altın bacağı kasa talimatıyla kapanır (T artı ise kasa girişi ve mint, T eksi ise burn ve kasa çıkışı), para bacağında borçlu öder. Kanzasset tarafında ödeme yalnız şirket banka hesabından yapılır.</p>

      <div className="grid c3" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>Açık pencere</h2>
          {open ? (
            <>
              <div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{open.settlement_id}</div>
              <div className="small">{STL_TRIGGER_TR[open.trigger] ?? open.trigger} · <span className="pill">{STL_STATUS_TR[open.status] ?? open.status}</span></div>
            </>
          ) : <div className="small">Açık pencere yok</div>}
        </div>
        <div className="card">
          <h2>Cari hesap (KZ kaydı)</h2>
          <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{(rec?.current_account.gold_mg ?? 0) >= 0 ? "+" : ""}{fmtG(rec?.current_account.gold_mg ?? 0)} g</div>
          <div className="small">{rec?.current_account.money.map((m) => `${m.ccy} ${fmtMoney(m.cents)}`).join(" · ")}</div>
        </div>
        <div className="card">
          <h2>Mahsuplaşma talep et</h2>
          <div className="row"><input className="wide" placeholder="gerekçe" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy === "req"} onClick={() => act("req", () => api.settlementRequest(reason.trim() || "Kanzasset talebi"), "Pencere açıldı, rafineriye bildirim gitti.")}>Şimdi netleşelim</button>
          </div>
        </div>
      </div>

      {msg && <div className="note" style={{ marginBottom: 12 }}>{msg}</div>}

      {w && (
        <>
          <section className="card" style={{ marginBottom: 14 }}>
            <h2>{w.settlement_id} · <span className={`pill ${w.status === "SETTLED" ? "ok" : w.status === "MISMATCH" ? "bad" : ""}`}>{STL_STATUS_TR[w.status] ?? w.status}</span></h2>
            <div className="kv">
              <span className="k">Tetik</span><span>{STL_TRIGGER_TR[w.trigger] ?? w.trigger}</span>
              <span className="k">Pencere</span><span className="mono small">{fmtDT(w.window_from)} → {fmtDT(w.window_to)}</span>
              <span className="k">Rafineri ekstresi</span><span className="mono">T {w.amr_gold_mg !== undefined ? fmtG(w.amr_gold_mg) : "?"} g · {w.amr_money?.map((m) => `${m.ccy} ${fmtMoney(m.cents)}`).join(" · ")}</span>
              <span className="k">KZ kaydı</span><span className="mono">T {w.kz_gold_mg !== undefined ? fmtG(w.kz_gold_mg) : "?"} g · {w.kz_money?.map((m) => `${m.ccy} ${fmtMoney(m.cents)}`).join(" · ")}</span>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="ghost" disabled={busy === "rec"} onClick={() => act("rec", () => api.settlementReconcile(w.settlement_id), "Mutabakat yapıldı.")}>Ekstreyi al ve mutabakat yap</button>
              {w.status === "RECONCILED" && <button className="primary" disabled={busy === "gold"} onClick={() => act("gold", () => api.settlementGoldLeg(w.settlement_id), "Altın bacağı için kasa talimatı gönderildi.")}>Altın bacağını başlat</button>}
              {w.doc_id && <a className="ghost" href={`/api/documents/${w.doc_id}`} target="_blank" rel="noreferrer" style={{ textDecoration: "none", padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 6 }}>Mahsuplaşma Ekstresi</a>}
            </div>
          </section>

          {w.diffs && w.diffs.length > 0 && (
            <section className="card" style={{ marginBottom: 14 }}>
              <h2>Mutabakat farkları</h2>
              <p className="small">Fark varsa mint ve kasa çıkışı bloke kalır, ödeme bekler; fark insan tarafından çözülür (K2 ekranından anlık fotoğraf ve düzeltme).</p>
              <table>
                <thead><tr><th>Alan</th><th className="num">Rafineri</th><th className="num">KZ kaydı</th></tr></thead>
                <tbody>{w.diffs.map((d, i) => <tr key={i}><td>{d.field}</td><td className="num mono">{d.amr}</td><td className="num mono">{d.kz}</td></tr>)}</tbody>
              </table>
            </section>
          )}

          <div className="grid c2" style={{ marginBottom: 14 }}>
            <section className="card">
              <h2>Altın bacağı</h2>
              {w.gold_leg ? (
                <div className="kv">
                  <span className="k">Yön</span><span>{w.gold_leg.direction === "VAULT_IN" ? "kasa girişi + mint" : w.gold_leg.direction === "VAULT_OUT" ? "burn + kasa çıkışı" : "işlem yok"}</span>
                  <span className="k">Miktar</span><span className="mono">{fmtG(w.gold_leg.qty_mg)} g</span>
                  <span className="k">Kasa talimatı</span><span className="mono small">{w.gold_leg.vault_ref ?? "yok"}</span>
                  <span className="k">Durum</span><span><span className={`pill ${w.gold_leg.done ? "ok" : "warn"}`}>{w.gold_leg.done ? "kapandı (T = 0)" : "rafineri kabulü bekliyor"}</span></span>
                </div>
              ) : <div className="small">Mutabakat sonrası başlatılır.</div>}
            </section>

            <section className="card">
              <h2>Para bacağı</h2>
              <table>
                <thead><tr><th>Kur</th><th className="num">Net</th><th>Yön</th><th>Durum</th><th>Aksiyon</th></tr></thead>
                <tbody>
                  {w.money_leg.map((m) => (
                    <tr key={m.ccy}>
                      <td>{m.ccy}</td>
                      <td className="num mono">{m.net_cents > 0 ? "+" : ""}{fmtMoney(m.net_cents)}</td>
                      <td className="small">{m.direction === "KZ_TO_AMR" ? "biz öderiz" : m.direction === "AMR_TO_KZ" ? "rafineri öder" : "yok"}</td>
                      <td><span className={`pill ${m.paid ? "ok" : m.net_cents === 0 ? "" : "warn"}`}>{m.paid ? "kapandı" : m.net_cents === 0 ? "yok" : "bekliyor"}</span>{m.bank_ref ? <div className="mono small">{m.bank_ref}</div> : null}</td>
                      <td>{!m.paid && m.net_cents !== 0 && (
                        <button className="primary" disabled={busy === m.ccy} onClick={() => act(m.ccy, () => api.settlementPay(w.settlement_id, m.ccy), `${m.ccy} bacağı kapandı.`)}>
                          {m.direction === "KZ_TO_AMR" ? "Şirket hesabından öde" : "Ödeme alındı"}
                        </button>
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="small" style={{ marginTop: 6 }}>Ödeme talimatı yalnız şirket banka hesabından verilir; müşteri hesabı asla ödemez (K5).</div>
            </section>
          </div>

          <section className="card" style={{ marginBottom: 14 }}>
            <h2>Zaman çizelgesi</h2>
            <table><tbody>{w.timeline.map((t, i) => <tr key={i}><td className="mono small" style={{ whiteSpace: "nowrap" }}>{fmtDT(t.ts)}</td><td className="small">{t.text}</td></tr>)}</tbody></table>
          </section>
        </>
      )}

      <section className="card">
        <h2>Pencereler</h2>
        <table>
          <thead><tr><th>Açılış</th><th>Pencere</th><th>Tetik</th><th>Durum</th><th>Para</th></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={5} className="small">Pencere yok</td></tr>}
            {items.map((x) => (
              <tr key={x.settlement_id} onClick={() => setSel(x)} style={{ cursor: "pointer", background: sel?.settlement_id === x.settlement_id ? "#f4f5f7" : undefined }}>
                <td className="mono">{fmtDT(x.created_ts)}</td>
                <td className="mono small">{x.settlement_id}</td>
                <td className="small">{STL_TRIGGER_TR[x.trigger] ?? x.trigger}</td>
                <td><span className={`pill ${x.status === "SETTLED" ? "ok" : x.status === "MISMATCH" ? "bad" : ""}`}>{STL_STATUS_TR[x.status] ?? x.status}</span></td>
                <td className="small">{x.money_leg.filter((m) => m.net_cents !== 0).map((m) => `${m.ccy} ${fmtMoney(m.net_cents)}`).join(" · ") || "yok"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
