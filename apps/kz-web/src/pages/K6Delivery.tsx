import { useEffect, useState } from "react";
import { needsApproval, api, fmtDT, fmtG, fmtMoney, FUL_STATUS_TR, type Doc, type FulfilmentView, type KzDelivery, type useLive } from "../api.ts";
import { Pager, usePager } from "../components/Pager.tsx";
import { DocButtons, DocModal } from "./shared.tsx";

type Live = ReturnType<typeof useLive>;

/**
 * K6 Fiziksel teslimat (Akışlar 10).
 * Müşteri itfa talebi → tokenler burn cüzdanına (emanet) → rafineriye talep → lojistik teklifi →
 * müşteri onayından sonra onay (masraf aynen yansıtılır, komisyon yok) → sevkiyat takibi → teslimde burn.
 */
export function K6Delivery({ live }: { live: Live }) {
  const [v, setV] = useState<FulfilmentView | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [sel, setSel] = useState<KzDelivery | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [form, setForm] = useState({ qty: "", address_ref: "ADR-77", insured_party_ref: "SIG-77" });

  const load = () => api.fulfilment().then(setV).catch((e) => setMsg(`Hata: ${e.message}`));
  useEffect(() => { load(); }, [live.version]);

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key); setMsg("");
    try {
      const r = await fn();
      // kritik aksiyon: sunucu uygulamadı, ikinci onay bekliyor (K9'dan onaylanır)
      setMsg(needsApproval(r) ? `${r.message}. Onay K11 Ayarlar ekranından verilir (onay ${r.approval_id}).` : done);
      await load(); live.refresh();
    }
    catch (e) { setMsg(`Hata: ${(e as Error).message}`); }
    finally { setBusy(""); }
  };

  const s = live.status;

  const pItems = usePager(v?.deliveries ?? [], 20);
  return (
    <div>
      <span className="tag">K6</span>
      <h1>Fiziksel teslimat</h1>
      <p className="sub">Müşteri tokenlerine karşılık standart külçe ister. Talep anında tokenler burn cüzdanına geçer (emanet): dolaşımdan çıkar ama henüz yakılmaz. Rafineri lojistik fiyatını girer, müşteri onayından sonra biz onaylarız ve masraf cari hesaba kalem olur. Kanzasset bu akışta marj ve komisyon almaz, lojistik masrafı müşteriden aynen alınır. Burn, teslim anında yapılır: arz ve kasa hesabı aynı anda düşer, böylece arz kasadaki gramı hiç aşmaz.</p>

      <div className="grid c3" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>Emanet (E)</h2>
          <div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>{fmtG(v?.escrow_mg ?? 0)} g</div>
          <div className="small">Burn cüzdanında bekleyen, henüz yakılmamış tokenler. Teslim edilince yakılır.</div>
        </div>
        <div className="card">
          <h2>Burn anı</h2>
          <div className="row">
            <select value={v?.burn_moment ?? "DELIVERED"} onChange={(e) => act("burn", () => api.fulfilmentParams({ burnMoment: e.target.value as "DELIVERED" }), "Burn anı güncellendi.")}>
              <option value="DELIVERED">Teslim edildiğinde (varsayılan)</option>
              <option value="SHIPPED">Taşıyıcıya verildiğinde</option>
            </select>
          </div>
          <div className="small" style={{ marginTop: 6 }}>Parametre; iş kuralı değişmeden ayarlanır.</div>
        </div>
        <div className="card">
          <h2>Kontroller</h2>
          <div className="small">{s?.checks.k1.text} <b>{s?.checks.k1.ok ? "✓" : "✗"}</b></div>
          <div className="small">{s?.checks.k2.text} <b>{s?.checks.k2.ok ? "✓" : "✗"}</b></div>
          <div className="small" style={{ marginTop: 6 }}>Müşteride dolaşan C: {fmtG(s?.checks.c_mg ?? 0)} g</div>
        </div>
      </div>

      {msg && <div className="note" style={{ marginBottom: 12 }}>{msg}</div>}

      <section className="card" style={{ marginBottom: 14 }}>
        <h2>Müşteri itfa talebi (demo kutusu)</h2>
        <p className="small">Gerçek sistemde bu talep müşteri platformundan gelir. Adres ve sigorta lehtarı referansı rafineriye yalnız referans olarak gider; müşteri adı paylaşılmaz.</p>
        <div className="row">
          <input placeholder="gram (ör. 1000)" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
          <input placeholder="adres referansı" value={form.address_ref} onChange={(e) => setForm({ ...form, address_ref: e.target.value })} />
          <input placeholder="sigorta lehtarı referansı" value={form.insured_party_ref} onChange={(e) => setForm({ ...form, insured_party_ref: e.target.value })} />
          <button className="primary" disabled={!form.qty || busy === "new"} onClick={() => act("new", async () => {
            const mg = Math.round(Number(form.qty.replace(",", ".")) * 1000);
            if (!Number.isFinite(mg) || mg < 1) throw new Error("gram geçersiz");
            await api.deliveryCreate({ qty_mg: mg, address_ref: form.address_ref, insured_party_ref: form.insured_party_ref });
            setForm({ ...form, qty: "" });
          }, "Talep rafineriye gönderildi, lojistik teklifi bekleniyor.")}>Talebi gönder</button>
        </div>
      </section>

      <section className="card">
        <h2>Talepler</h2>
        <table>
          <thead><tr><th>Zaman</th><th>Talep</th><th className="num">Gram</th><th>Durum</th><th>Lojistik teklifi</th><th>Takip</th><th>Burn</th><th>Belgeler</th><th>Aksiyon</th></tr></thead>
          <tbody>
            {(v?.deliveries.length ?? 0) === 0 && <tr><td colSpan={9} className="small">Teslimat talebi yok</td></tr>}
            {pItems.slice.map((d) => (
              <tr key={d.id}>
                <td className="mono">{fmtDT(d.created_ts)}</td>
                <td className="mono small">{d.id}<br /><span className="small">adres {d.address_ref}</span></td>
                <td className="num mono">{fmtG(d.qty_mg)}</td>
                <td><span className={`pill ${d.status === "DELIVERED" ? "ok" : d.status === "CANCELLED" || d.status === "FAILED" || d.status === "HATA" ? "bad" : d.status === "QUOTED" ? "warn" : ""}`}>{FUL_STATUS_TR[d.status] ?? d.status}</span></td>
                <td className="small">{d.quote ? `${d.quote.carrier} · ${fmtMoney(d.quote.amount_cents)} ${d.quote.ccy}` : ""}{d.customer_price_cents ? <><br /><span className="small">müşteriye aynen {fmtMoney(d.customer_price_cents)}</span></> : null}</td>
                <td className="mono small">{d.tracking_no ?? ""}</td>
                <td className="mono small">{d.burned ? d.burn_tx : d.escrowed ? "emanette" : ""}</td>
                <td className="mono small">
                  <DocButtons ids={[["Teklif", d.quote?.doc_id], ["Sevkiyat", d.shipping_doc_id], ["Teslimat", d.pod_doc_id]]} open={setDoc} />
                </td>
                <td>
                  <div className="row">
                    {d.status === "QUOTED" && <button className="primary" disabled={busy === d.id} onClick={() => act(d.id, () => api.deliveryApprove(d.id), `${d.id}: teklif onaylandı, masraf cari hesaba yazıldı.`)}>Teklifi onayla</button>}
                    {!["DELIVERED", "CANCELLED", "SHIPPED", "FAILED", "HATA"].includes(d.status) && <button className="ghost" disabled={busy === d.id} onClick={() => act(d.id, () => api.deliveryCancel(d.id, "müşteri vazgeçti"), `${d.id}: iptal edildi.`)}>İptal</button>}
                    <button className="ghost" onClick={() => setSel(sel?.id === d.id ? null : d)}>Zincir</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager p={pItems} label="Talepler" />
      </section>

      {doc && <DocModal doc={doc} onClose={() => setDoc(null)} />}
      {sel && (
        <section className="card" style={{ marginTop: 14 }}>
          <h2>{sel.id} zaman çizelgesi</h2>
          <table><tbody>{sel.timeline.map((t, i) => <tr key={i}><td className="mono small" style={{ whiteSpace: "nowrap" }}>{fmtDT(t.ts)}</td><td className="small">{t.text}</td></tr>)}</tbody></table>
          <div className="row" style={{ marginTop: 8 }}><button className="ghost" onClick={() => setSel(null)}>Kapat</button></div>
        </section>
      )}
    </div>
  );
}
