import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { needsApproval, api, fmtDT, fmtG, fmtMoney, STL_STATUS_TR, STL_TRIGGER_TR, type KzSettlement, type useLive } from "../api.ts";
import { legs, reconciliation, scopeText, summary, type Leg } from "../settlementFlow.ts";
import { ApprovalBox } from "../components/ApprovalBox.tsx";

type Live = ReturnType<typeof useLive>;
const LEG_CHOICES: { key: string; label: string; scope: string[] }[] = [
  { key: "ALL", label: "Tümü (altın + üç kur)", scope: [] },
  { key: "GOLD", label: "Yalnız altın", scope: ["GOLD"] },
  { key: "MONEY", label: "Yalnız para (üç kur)", scope: ["USD", "EUR", "AED"] },
  { key: "USD", label: "Yalnız USD", scope: ["USD"] },
  { key: "EUR", label: "Yalnız EUR", scope: ["EUR"] },
  { key: "AED", label: "Yalnız AED", scope: ["AED"] },
];

/**
 * K8 Mahsuplaşma (Akışlar 12) · rafineri tarafındaki R8'in karşılığı, aynı düzen.
 *
 * Kapatılacak her kalem bir bacaktır (altın, USD, EUR, AED). Her satırda ne kadar, kim borçlu,
 * hangi hâlde ve o an yapılacak tek iş yazar. Üstte tek cümlelik özet, altında mutabakat satırı.
 */
export function K8Settlement({ live }: { live: Live }) {
  const [items, setItems] = useState<KzSettlement[]>([]);
  const [open, setOpen] = useState<KzSettlement | null>(null);
  const [sel, setSel] = useState<KzSettlement | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState("ALL");
  /** Kritik aksiyon 202 dönünce onay kutusu açılır; onaylanınca sunucu uygular. */
  const [pending, setPending] = useState<{ id: number; requestedBy: string; summary: string } | null>(null);

  const load = () => api.settlements().then((r) => { setItems(r.items); setOpen(r.open); if (sel) setSel(r.items.find((x) => x.settlement_id === sel.settlement_id) ?? null); }).catch((e) => setMsg(`Hata: ${e.message}`));
  useEffect(() => { load(); }, [live.version]);

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key); setMsg("");
    try {
      const r = await fn();
      if (needsApproval(r)) {
        setPending({ id: r.approval_id, requestedBy: r.requested_by, summary: String((r as { message: string }).message).split(":")[0] });
        setMsg("");
      } else { setPending(null); setMsg(done); }
      await load(); live.refresh();
    }
    catch (e) { setMsg(`Hata: ${(e as Error).message}`); }
    finally { setBusy(""); }
  };

  const w = sel ?? open;
  const shown = w ?? items[0] ?? null;
  const rec = reconciliation(w);
  const rows = legs(w);
  const record = live.status?.record;

  return (
    <div>
      <span className="tag">K8</span>
      <h1>Mahsuplaşma</h1>
      <p className="sub">Gün içinde biriken karşılıklı alacak ve borç kapatılır. Kapatılacak her kalem bir bacaktır: altın ve her kur ayrı. Pencere kesim saatinde kendiliğinden açılır; gün içinde iki taraf da talep edebilir ve isterse tek bacak seçebilir (ör. yalnız USD). Bacakların hepsi kapanınca pencere kapanır.</p>

      {/* ---- tek cümlelik özet ---- */}
      <div className="next" style={{ marginBottom: 14 }}>
        <div>
          <div className="q">{summary(w)}</div>
          <div className="w">{w ? `${w.settlement_id} · ${STL_TRIGGER_TR[w.trigger] ?? w.trigger} · kapsam ${scopeText(w)}` : shown ? `son pencere ${shown.settlement_id} · ${fmtDT(shown.created_ts)}` : "kesim saatinde rafineri açar"}</div>
        </div>
        <div className="sp" />
        {!w && (
          <div className="row">
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              {LEG_CHOICES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            <input placeholder="gerekçe" value={reason} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 180 }} />
            <button className="primary" disabled={busy === "open"} onClick={() => act("open", () => api.settlementRequest(reason.trim() || "Kanzasset talebi", LEG_CHOICES.find((c) => c.key === scope)!.scope), "Pencere açıldı, rafineri ekstresi alınıyor.")}>Mahsuplaşma talep et</button>
          </div>
        )}
        {w && rec.canReconcile && (
          <button className="primary" disabled={busy === "rec"} onClick={() => act("rec", () => api.settlementReconcile(w.settlement_id), "Mutabakat çalıştırıldı.")}>{rec.state === "fark" ? "Yeniden karşılaştır" : "Rafineri ekstresini karşılaştır"}</button>
        )}
        {w?.status === "SETTLED" && w.doc_id && (
          <a className="pill accent" href={`/api/documents/${encodeURIComponent(w.doc_id)}/pdf`} target="_blank" rel="noreferrer" style={{ padding: "8px 13px" }}>Mahsuplaşma Ekstresi (PDF)</a>
        )}
      </div>

      {msg && <div className="note" style={{ marginBottom: 12 }}>{msg}</div>}
      {pending && (
        <div style={{ marginBottom: 12 }}>
          <ApprovalBox id={pending.id} requestedBy={pending.requestedBy} summary={pending.summary}
            onDone={async (m) => { setPending(null); setMsg(m); await load(); live.refresh(); }} />
        </div>
      )}

      {/* ---- mutabakat ---- */}
      {w && (
        <section className="card" style={{ marginBottom: 14, borderColor: rec.state === "fark" ? "var(--bad)" : undefined }}>
          <div className="row">
            <h2 style={{ margin: 0 }}>Mutabakat</h2>
            <span className={`pill ${rec.state === "eşit" ? "ok" : rec.state === "fark" ? "bad" : "warn"}`}>{rec.state === "eşit" ? "eşit" : rec.state === "fark" ? "fark var" : rec.state === "bekliyor" ? "karşılaştırılıyor" : "ekstre bekleniyor"}</span>
            <span className="small">{rec.text}</span>
          </div>
          <div className="small" style={{ marginTop: 8 }}>
            KZ kaydı: altın {record ? fmtG(record.current_account.gold_mg) : "…"} g · {record?.current_account.money.map((m) => `${m.ccy} ${fmtMoney(m.cents)}`).join(" · ")}
            {w.amr_gold_mg !== undefined && <> · rafineri ekstresi: altın {fmtG(w.amr_gold_mg)} g · {(w.amr_money ?? []).map((m) => `${m.ccy} ${fmtMoney(m.cents)}`).join(" · ")}</>}
          </div>
          {w.diffs && w.diffs.length > 0 && (
            <table style={{ marginTop: 10 }}>
              <thead><tr><th>Alan</th><th className="num">Rafineri</th><th className="num">KZ kaydı</th></tr></thead>
              <tbody>{w.diffs.map((d, i) => <tr key={i}><td>{d.field}</td><td className="num mono">{d.amr}</td><td className="num mono">{d.kz}</td></tr>)}</tbody>
            </table>
          )}
          <p className="small" style={{ marginTop: 8 }}>İki ekstre tutmadan hiçbir bacak kapanmaz, ödeme yapılmaz.</p>
        </section>
      )}

      {/* ---- bacaklar ---- */}
      {w && (
        <section className="card" style={{ marginBottom: 14 }}>
          <h2>Bacaklar</h2>
          <table>
            <thead><tr><th>Bacak</th><th className="num">Tutar</th><th>Kim borçlu</th><th>Durum</th><th>Şu an</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="small">Rafineri ekstresi gelince bacaklar belirir.</td></tr>}
              {rows.map((l) => (
                <tr key={l.key}>
                  <td><b>{l.label}</b></td>
                  <td className="num mono">{l.amount}</td>
                  <td className="small">{l.who}</td>
                  <td><StatePill l={l} /></td>
                  <td className="small">{l.note}</td>
                  <td>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      {l.action === "gold-approve" && (
                        <button className="primary" disabled={busy === "ga"} onClick={() => act("ga", () => api.settlementApproveGold(w.settlement_id), "Teklif onaylandı, kasa girişi talebi gönderildi. Fiş gelince mint edilir.")}>{l.actionLabel}</button>
                      )}
                      {l.action === "gold-send" && (
                        <button className="primary" disabled={busy === "gs"} onClick={() => act("gs", () => api.settlementGoldLeg(w.settlement_id), "Kasa talimatı gönderildi.")}>{l.actionLabel}</button>
                      )}
                      {l.action === "gold-info" && <Link to="/kasa"><button className="ghost">{l.actionLabel}</button></Link>}
                      {l.action === "pay" && (
                        <button className="primary" disabled={busy === `pay${l.ccy}`} onClick={() => act(`pay${l.ccy}`, () => api.settlementPay(w.settlement_id, l.ccy!), `${l.ccy} bacağı kapandı.`)}>{l.actionLabel}</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small" style={{ marginTop: 8 }}>
            Altın bacağının sırası sabittir. Rafineri gram borçluysa teklifini onaylarız, kasa girişi talebi gider, Kasa Giriş Fişi gelince mint ederiz: fiş olmadan token basılmaz. Biz borçluysak önce token yakılır, sonra kasa çıkışı talebi gider: rafineri bizim talebimiz olmadan kasadan gram çıkaramaz, yani karşılıksız token oluşmaz.
          </p>
        </section>
      )}

      {/* ---- ayrıntılar ---- */}
      {shown && (
        <details className="card" style={{ marginBottom: 14 }}>
          <summary>Ayrıntılar · {shown.settlement_id} · {STL_STATUS_TR[shown.status] ?? shown.status}</summary>
          <div className="grid c2" style={{ marginTop: 12 }}>
            <div>
              <h2>Pencere</h2>
              <div className="kv">
                <span className="k">Tetik</span><span>{STL_TRIGGER_TR[shown.trigger] ?? shown.trigger}</span>
                <span className="k">Kapsam</span><span>{scopeText(shown)}</span>
                <span className="k">Aralık</span><span className="mono small">{fmtDT(shown.window_from)} → {fmtDT(shown.window_to)}</span>
                <span className="k">Rafineri ekstresi</span><span className="mono small">{shown.amr_gold_mg !== undefined ? `altın ${fmtG(shown.amr_gold_mg)} g` : "gelmedi"}</span>
                <span className="k">KZ kaydı</span><span className="mono small">{shown.kz_gold_mg !== undefined ? `altın ${fmtG(shown.kz_gold_mg)} g` : ""}</span>
              </div>
            </div>
            <div>
              <h2>Altın bacağı</h2>
              {shown.gold_leg ? (
                <div className="kv">
                  <span className="k">Yön</span><span>{shown.gold_leg.direction === "VAULT_IN" ? "kasa girişi (rafineri borçlu)" : shown.gold_leg.direction === "VAULT_OUT" ? "kasa çıkışı (Kanzasset borçlu)" : "yok"}</span>
                  <span className="k">Miktar</span><span className="mono">{fmtG(shown.gold_leg.qty_mg)} g</span>
                  <span className="k">Rafineri teklifi</span><span className="mono small">{shown.gold_leg.proposed_ts ? fmtDT(shown.gold_leg.proposed_ts) : "yok"}</span>
                  <span className="k">Onayımız</span><span className="mono small">{shown.gold_leg.approved_ts ? fmtDT(shown.gold_leg.approved_ts) : "bekliyor"}</span>
                  <span className="k">Kasa talimatı</span><span className="mono small">{shown.gold_leg.vault_ref ?? "gönderilmedi"}</span>
                </div>
              ) : <div className="small">Mutabakattan sonra belirir.</div>}
              <h2 style={{ marginTop: 14 }}>Para bacağı</h2>
              <table>
                <thead><tr><th>Kur</th><th className="num">Net</th><th>Yön</th><th>Durum</th><th>Banka ref</th></tr></thead>
                <tbody>
                  {shown.money_leg.map((m) => (
                    <tr key={m.ccy}>
                      <td>{m.ccy}</td>
                      <td className="num mono">{m.net_cents > 0 ? "+" : ""}{fmtMoney(m.net_cents)}</td>
                      <td className="small">{m.direction === "KZ_TO_AMR" ? "Kanzasset öder" : m.direction === "AMR_TO_KZ" ? "rafineri öder" : "yok"}</td>
                      <td><span className={`pill ${m.paid ? "ok" : m.net_cents === 0 ? "neut" : "warn"}`}>{m.paid ? "kapandı" : m.net_cents === 0 ? "yok" : "bekliyor"}</span></td>
                      <td className="mono small">{m.bank_ref ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <h2 style={{ marginTop: 14 }}>Zaman çizelgesi</h2>
          <table><tbody>{shown.timeline.map((t, i) => <tr key={i}><td className="mono small" style={{ whiteSpace: "nowrap" }}>{fmtDT(t.ts)}</td><td className="small">{t.text}</td></tr>)}</tbody></table>
        </details>
      )}

      <section className="card">
        <h2>Pencereler</h2>
        <table>
          <thead><tr><th>Açılış</th><th>Pencere</th><th>Tetik</th><th>Kapsam</th><th>Durum</th><th className="num">Altın</th><th>Para</th></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={7} className="small">Pencere yok</td></tr>}
            {items.map((x) => (
              <tr key={x.settlement_id} onClick={() => setSel(x.settlement_id === sel?.settlement_id ? null : x)} style={{ cursor: "pointer", background: sel?.settlement_id === x.settlement_id ? "var(--sel)" : undefined }}>
                <td className="mono">{fmtDT(x.created_ts)}</td>
                <td className="mono small">{x.settlement_id}</td>
                <td className="small">{STL_TRIGGER_TR[x.trigger] ?? x.trigger}</td>
                <td className="small">{scopeText(x)}</td>
                <td><span className={`pill ${x.status === "SETTLED" ? "ok" : x.status === "MISMATCH" ? "bad" : "warn"}`}>{STL_STATUS_TR[x.status] ?? x.status}</span></td>
                <td className="num mono">{x.gold_leg ? `${fmtG(x.gold_leg.qty_mg)} g` : ""}</td>
                <td className="small">{x.money_leg.filter((m) => m.net_cents !== 0).map((m) => `${m.ccy} ${fmtMoney(m.net_cents)}`).join(" · ") || "yok"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="small" style={{ marginTop: 6 }}>Satıra tıklayınca o pencerenin bacakları yukarıda görünür; tekrar tıklayınca açık pencereye dönülür.</div>
      </section>
    </div>
  );
}

function StatePill({ l }: { l: Leg }) {
  const cls = l.state === "kapandı" ? "ok" : l.state === "sizde" ? "warn" : l.state === "karşıda" ? "" : "neut";
  const text = l.state === "sizde" ? "sizde" : l.state === "karşıda" ? "rafineride" : l.state;
  return <span className={`pill ${cls}`}>{text}</span>;
}
