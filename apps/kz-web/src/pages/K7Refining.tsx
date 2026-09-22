import { useEffect, useState } from "react";
import { api, fmtDT, fmtG, fmtMoney, FUL_STATUS_TR, type Doc, type FulfilmentView, type KzRefining, type useLive } from "../api.ts";
import { Pager, usePager } from "../components/Pager.tsx";
import { DocButtons, DocModal } from "./shared.tsx";

type Live = ReturnType<typeof useLive>;

/**
 * K7 Rafinasyon (Akışlar 11).
 * Rafineri kataloğundan müşteri seçimi → talep (emanet) → rafineri teklifi (ürün bedeli + lojistik) →
 * müşteri onayından sonra onay → üretim ve teslimat takibi → teslimde burn.
 * Müşteriye gösterilen fiyat marj ve komisyon dahildir; rafineriye yalnız bedel ödenir.
 */
export function K7Refining({ live }: { live: Live }) {
  const [v, setV] = useState<FulfilmentView | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [sel, setSel] = useState<KzRefining | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});

  const load = () => api.fulfilment().then(setV).catch((e) => setMsg(`Hata: ${e.message}`));
  useEffect(() => { load(); }, [live.version]);

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key); setMsg("");
    try { await fn(); setMsg(done); await load(); live.refresh(); }
    catch (e) { setMsg(`Hata: ${(e as Error).message}`); }
    finally { setBusy(""); }
  };

  const cat = v?.catalog;
  const lines = Object.entries(cart).filter(([, q]) => q > 0);
  const totalMg = lines.reduce((a, [id, q]) => a + q * (cat?.items.find((i) => i.item_id === id)?.weight_mg ?? 0), 0);
  const tariff = lines.reduce((a, [id, q]) => a + q * (cat?.items.find((i) => i.item_id === id)?.unit_price_cents ?? 0), 0);

  const pItems = usePager(v?.refinings ?? [], 20);
  return (
    <div>
      <span className="tag">K7</span>
      <h1>Rafinasyon</h1>
      <p className="sub">Müşteri, tokenlerine karşılık katalogdan ürün seçer. Katalog rafineriden gelir ve değiştiğinde kendiliğinden yenilenir. Talep anında tokenler emanete alınır; rafineri ürün bedeli ve lojistik için teklif verir, müşteri onayından sonra biz onaylarız. Müşteriye gösterilen fiyat marj ve komisyon dahildir, rafineriye yalnız bedel ödenir. Teslimde burn yapılır.</p>

      <div className="grid c3" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>Katalog</h2>
          <div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>sürüm {cat?.version ?? 0}</div>
          <div className="small">{cat?.items.filter((i) => i.active).length ?? 0} aktif ürün</div>
          <button className="ghost" style={{ marginTop: 8 }} onClick={() => act("cat", () => api.catalogRefresh(), "Katalog yenilendi.")}>Kataloğu yenile</button>
        </div>
        <div className="card">
          <h2>Emanet (E)</h2>
          <div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>{fmtG(v?.escrow_mg ?? 0)} g</div>
          <div className="small">Teslimat ve rafinasyon taleplerinde bekleyen tokenler.</div>
        </div>
        <div className="card">
          <h2>Seçim</h2>
          <div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{fmtG(totalMg)} g</div>
          <div className="small">katalog tarifesi {fmtMoney(tariff)} USD (rafineri teklifi bağlayıcıdır)</div>
        </div>
      </div>

      {msg && <div className="note" style={{ marginBottom: 12 }}>{msg}</div>}

      <section className="card" style={{ marginBottom: 14 }}>
        <h2>Müşteri seçimi (demo kutusu)</h2>
        <table>
          <thead><tr><th>Ürün</th><th className="num">Gramaj</th><th>Ayar</th><th className="num">Tarife</th><th className="num">Üretim</th><th className="num">Adet</th></tr></thead>
          <tbody>
            {cat?.items.filter((i) => i.active).map((i) => (
              <tr key={i.item_id}>
                <td>{i.name}</td>
                <td className="num mono">{fmtG(i.weight_mg)} g</td>
                <td className="mono">{i.fineness}</td>
                <td className="num mono">{fmtMoney(i.unit_price_cents)} {i.ccy}</td>
                <td className="num">{i.lead_time_days} gün</td>
                <td className="num"><input style={{ width: 70 }} value={cart[i.item_id] ?? ""} onChange={(e) => setCart({ ...cart, [i.item_id]: Number(e.target.value) || 0 })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" disabled={lines.length === 0 || busy === "new"} onClick={() => act("new", async () => {
            await api.refiningCreate({ items: lines.map(([item_id, qty]) => ({ item_id, qty })) });
            setCart({});
          }, "Rafinasyon talebi rafineriye gönderildi, teklif bekleniyor.")}>Talebi gönder</button>
          <button className="ghost" onClick={() => setCart({})}>Seçimi temizle</button>
        </div>
      </section>

      <section className="card">
        <h2>Talepler</h2>
        <table>
          <thead><tr><th>Zaman</th><th>Talep</th><th>Kalemler</th><th className="num">Saf gram</th><th>Durum</th><th>Teklif</th><th className="num">Müşteri fiyatı</th><th>Burn</th><th>Belgeler</th><th>Aksiyon</th></tr></thead>
          <tbody>
            {(v?.refinings.length ?? 0) === 0 && <tr><td colSpan={10} className="small">Rafinasyon talebi yok</td></tr>}
            {pItems.slice.map((r) => (
              <tr key={r.id}>
                <td className="mono">{fmtDT(r.created_ts)}</td>
                <td className="mono small">{r.id}</td>
                <td className="small">{r.items.map((l) => `${l.qty} × ${l.name}`).join(", ")}</td>
                <td className="num mono">{fmtG(r.total_mg)}</td>
                <td><span className={`pill ${r.status === "DELIVERED" ? "ok" : r.status === "CANCELLED" || r.status === "FAILED" || r.status === "HATA" ? "bad" : r.status === "QUOTED" ? "warn" : ""}`}>{FUL_STATUS_TR[r.status] ?? r.status}</span></td>
                <td className="small">{r.quote ? `${fmtMoney(r.quote.product_cents)} + ${fmtMoney(r.quote.logistics_cents)} ${r.quote.ccy} · ${r.quote.lead_time_days} gün` : ""}</td>
                <td className="num mono">{r.customer_price_cents ? fmtMoney(r.customer_price_cents) : ""}</td>
                <td className="mono small">{r.burned ? r.burn_tx : r.escrowed ? "emanette" : ""}</td>
                <td className="mono small">
                  <DocButtons ids={[["Teklif", r.quote?.doc_id], ["Sevkiyat", r.shipping_doc_id], ["Teslimat", r.pod_doc_id]]} open={setDoc} />
                </td>
                <td>
                  <div className="row">
                    {r.status === "QUOTED" && <button className="primary" disabled={busy === r.id} onClick={() => act(r.id, () => api.refiningApprove(r.id), `${r.id}: teklif onaylandı.`)}>Teklifi onayla</button>}
                    {!["DELIVERED", "CANCELLED", "SHIPPED", "IN_PRODUCTION", "READY", "FAILED", "HATA"].includes(r.status) && <button className="ghost" disabled={busy === r.id} onClick={() => act(r.id, () => api.refiningCancel(r.id, "müşteri vazgeçti"), `${r.id}: iptal edildi.`)}>İptal</button>}
                    <button className="ghost" onClick={() => setSel(sel?.id === r.id ? null : r)}>Zincir</button>
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
