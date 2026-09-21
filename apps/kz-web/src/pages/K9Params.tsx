import { useEffect, useState } from "react";
import { api, fmtG, fmtMoney, type StockParams, type useLive } from "../api.ts";

type Live = ReturnType<typeof useLive>;

/**
 * K9 Parametreler.
 * İş kurallarının değerleri: stok bandı ve hedef, mint politikası, kasaya konuluyor tavanı,
 * onay matrisi, slippage, emir zaman sınırı, fiyatlama, burn anı.
 * Değişiklik ikinci onay ister ve günlüğe yazılır.
 */
export function K9Params({ live }: { live: Live }) {
  const s = live.status;
  const [stock, setStock] = useState<StockParams | null>(null);
  const [pricing, setPricing] = useState({ marginBps: 30, marginCapBps: 100, commissionBps: 15 });
  const [orderP, setOrderP] = useState({ slippageBps: 100, timeLimitMs: 3000, unansweredGraceMs: 1000, minOrderUsdCents: 1000 });
  const [msg, setMsg] = useState("");
  const [pending, setPending] = useState<{ what: string; apply: () => Promise<unknown> } | null>(null);
  const [maker, setMaker] = useState("hazineci");
  const [approver, setApprover] = useState("onaycı-1");
  const [log, setLog] = useState<{ ts: string; who: string; what: string }[]>([]);

  useEffect(() => {
    if (!s) return;
    setStock(s.stock);
    setPricing(s.pricing);
    setOrderP(s.orderParams);
  }, [s?.ts]);

  /** Kritik değişiklik: önce istenir, farklı bir kullanıcı onaylayınca uygulanır. */
  const ask = (what: string, apply: () => Promise<unknown>) => { setPending({ what, apply }); setMsg(`"${what}" ikinci onay bekliyor. Onaylayan, isteyenden farklı olmalı.`); };
  const confirm = async () => {
    if (!pending) return;
    if (approver.trim() === maker.trim()) { setMsg("İkinci onay farklı bir kullanıcıdan gelmeli."); return; }
    try {
      await pending.apply();
      setLog([{ ts: new Date().toISOString(), who: `${maker} → ${approver}`, what: pending.what }, ...log].slice(0, 50));
      setMsg(`"${pending.what}" uygulandı ve günlüğe yazıldı.`);
      setPending(null);
      live.refresh();
    } catch (e) { setMsg(`Hata: ${(e as Error).message}`); }
  };

  const num = (v: string) => Number(String(v).replace(",", "."));

  return (
    <div>
      <span className="tag">K9</span>
      <h1>Parametreler</h1>
      <p className="sub">İş kuralları koda gömülü değildir, buradan girilir. Stok bandı büyük alış ve satışı tetikler; envanter hedefi yalnız hazine alım satımıyla değişir. Onay matrisi hazine emirlerinde kaç onay gerektiğini belirler. Her değişiklik ikinci onay ister ve günlüğe yazılır.</p>

      {msg && <div className="note" style={{ marginBottom: 12 }}>{msg}</div>}

      {pending && (
        <section className="card" style={{ marginBottom: 14, borderColor: "var(--warn)" }}>
          <h2>İkinci onay bekleniyor</h2>
          <p className="small"><b>{pending.what}</b></p>
          <div className="row">
            <span className="small">İsteyen:</span><input value={maker} onChange={(e) => setMaker(e.target.value)} />
            <span className="small">Onaylayan:</span><input value={approver} onChange={(e) => setApprover(e.target.value)} />
            <button className="primary" onClick={confirm}>Onayla ve uygula</button>
            <button className="ghost" onClick={() => { setPending(null); setMsg("İstek geri alındı."); }}>Vazgeç</button>
          </div>
        </section>
      )}

      <div className="grid c2" style={{ marginBottom: 14 }}>
        <section className="card">
          <h2>Stok bandı ve envanter</h2>
          {stock && (
            <div className="kv" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <label className="k" style={{ alignSelf: "center" }}>Envanter hedefi K (g)</label>
              <input className="mono" value={(stock.targetMg / 1000).toString()} onChange={(e) => setStock({ ...stock, targetMg: Math.round(num(e.target.value) * 1000) })} />
              <label className="k" style={{ alignSelf: "center" }}>Stok tabanı (g)<div className="small">altına inecek alış büyük alıştır (07)</div></label>
              <input className="mono" value={(stock.floorMg / 1000).toString()} onChange={(e) => setStock({ ...stock, floorMg: Math.round(num(e.target.value) * 1000) })} />
              <label className="k" style={{ alignSelf: "center" }}>Stok tavanı (g)<div className="small">aşan satış büyük satıştır (08)</div></label>
              <input className="mono" value={(stock.ceilingMg / 1000).toString()} onChange={(e) => setStock({ ...stock, ceilingMg: Math.round(num(e.target.value) * 1000) })} />
              <label className="k" style={{ alignSelf: "center" }}>Mint politikası (07)</label>
              <select value={stock.mintPolicy} onChange={(e) => setStock({ ...stock, mintPolicy: e.target.value as "SHORTFALL" })}>
                <option value="SHORTFALL">eksik kısım</option>
                <option value="FULL_ORDER">emrin tamamı</option>
              </select>
              <label className="k" style={{ alignSelf: "center" }}>Kasaya konuluyor tavanı (g)</label>
              <input className="mono" value={(stock.placingCapMg / 1000).toString()} onChange={(e) => setStock({ ...stock, placingCapMg: Math.round(num(e.target.value) * 1000) })} />
              <label className="k" style={{ alignSelf: "center" }}>Matris üstü onay sayısı</label>
              <input className="mono" value={String(stock.approvalsAbove)} onChange={(e) => setStock({ ...stock, approvalsAbove: Number(e.target.value) || 1 })} />
            </div>
          )}
          <div className="row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
            <button className="primary" disabled={!stock} onClick={() => ask("stok bandı ve envanter parametreleri", () => api.stockParams(stock!))}>Kaydet</button>
          </div>
        </section>

        <section className="card">
          <h2>Onay matrisi (hazine alım satımı)</h2>
          <p className="small">Gram arttıkça gereken onay sayısı artar. Son onaycı canlı fiyatla gönderir.</p>
          <table>
            <thead><tr><th className="num">Üst sınır (g)</th><th className="num">Onay</th></tr></thead>
            <tbody>
              {stock?.approvalMatrix.map((r, i) => (
                <tr key={i}>
                  <td className="num"><input className="mono" style={{ width: 120 }} value={(r.upToMg / 1000).toString()} onChange={(e) => {
                    const m = [...stock.approvalMatrix]; m[i] = { ...m[i], upToMg: Math.round(num(e.target.value) * 1000) }; setStock({ ...stock, approvalMatrix: m });
                  }} /></td>
                  <td className="num"><input className="mono" style={{ width: 70 }} value={String(r.approvals)} onChange={(e) => {
                    const m = [...stock.approvalMatrix]; m[i] = { ...m[i], approvals: Number(e.target.value) || 1 }; setStock({ ...stock, approvalMatrix: m });
                  }} /></td>
                </tr>
              ))}
              <tr><td className="small">üstü</td><td className="num mono">{stock?.approvalsAbove}</td></tr>
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
            <button className="primary" disabled={!stock} onClick={() => ask("onay matrisi", () => api.stockParams(stock!))}>Kaydet</button>
          </div>
        </section>
      </div>

      <div className="grid c2" style={{ marginBottom: 14 }}>
        <section className="card">
          <h2>Fiyatlama</h2>
          <div className="kv" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <label className="k" style={{ alignSelf: "center" }}>Kâr marjı (bps)</label>
            <input className="mono" value={String(pricing.marginBps)} onChange={(e) => setPricing({ ...pricing, marginBps: Number(e.target.value) || 0 })} />
            <label className="k" style={{ alignSelf: "center" }}>Marj tavanı (bps)</label>
            <input className="mono" value={String(pricing.marginCapBps)} onChange={(e) => setPricing({ ...pricing, marginCapBps: Number(e.target.value) || 0 })} />
            <label className="k" style={{ alignSelf: "center" }}>İşlem komisyonu (bps)</label>
            <input className="mono" value={String(pricing.commissionBps)} onChange={(e) => setPricing({ ...pricing, commissionBps: Number(e.target.value) || 0 })} />
          </div>
          <div className="row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
            <button className="primary" onClick={() => ask("fiyatlama parametreleri", () => api.pricing(pricing))}>Kaydet</button>
          </div>
        </section>

        <section className="card">
          <h2>Emir parametreleri</h2>
          <div className="kv" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <label className="k" style={{ alignSelf: "center" }}>Slippage toleransı (bps)</label>
            <input className="mono" value={String(orderP.slippageBps)} onChange={(e) => setOrderP({ ...orderP, slippageBps: Number(e.target.value) || 0 })} />
            <label className="k" style={{ alignSelf: "center" }}>Emir zaman sınırı (ms)</label>
            <input className="mono" value={String(orderP.timeLimitMs)} onChange={(e) => setOrderP({ ...orderP, timeLimitMs: Number(e.target.value) || 0 })} />
            <label className="k" style={{ alignSelf: "center" }}>Cevapsız emir bekleme (ms)</label>
            <input className="mono" value={String(orderP.unansweredGraceMs)} onChange={(e) => setOrderP({ ...orderP, unansweredGraceMs: Number(e.target.value) || 0 })} />
            <label className="k" style={{ alignSelf: "center" }}>Emir minimumu (USD cent)</label>
            <input className="mono" value={String(orderP.minOrderUsdCents)} onChange={(e) => setOrderP({ ...orderP, minOrderUsdCents: Number(e.target.value) || 0 })} />
          </div>
          <div className="row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
            <button className="primary" onClick={() => ask("emir parametreleri", () => api.orderParams(orderP))}>Kaydet</button>
          </div>
        </section>
      </div>

      <div className="grid c2">
        <section className="card">
          <h2>Diğer</h2>
          <div className="kv">
            <span className="k">Fiyat bayatlık eşiği</span><span className="mono">10 sn (sözleşme sabiti)</span>
            <span className="k">Heartbeat</span><span className="mono">5 sn (sözleşme sabiti)</span>
            <span className="k">Burn anı</span><span className="mono">{s?.fulfilment.burn_moment === "SHIPPED" ? "taşıyıcıya verildiğinde" : "teslim edildiğinde"} <span className="small">(K6'dan değişir)</span></span>
            <span className="k">Cari hesap limiti</span><span className="small">rafineri tarafında R10'dan girilir; limitte emir reddedilir</span>
            <span className="k">Kesim saati</span><span className="small">rafineri tarafında R10'dan girilir; pencere kendiliğinden açılır</span>
          </div>
        </section>

        <section className="card">
          <h2>Değişiklik günlüğü</h2>
          <table>
            <thead><tr><th>Zaman</th><th>İsteyen → onaylayan</th><th>Ne</th></tr></thead>
            <tbody>
              {log.length === 0 && <tr><td colSpan={3} className="small">Bu oturumda değişiklik yok</td></tr>}
              {log.map((l, i) => <tr key={i}><td className="mono small">{new Date(l.ts).toLocaleString("tr-TR")}</td><td className="small">{l.who}</td><td className="small">{l.what}</td></tr>)}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
