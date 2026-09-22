import { useEffect, useState } from "react";
import { api, currentUser, needsApproval, type ApprovalRequest, type AuditEntry, type StockParams, type useLive } from "../api.ts";

type Live = ReturnType<typeof useLive>;

/**
 * K9 Parametreler.
 * İş kurallarının değerleri: stok bandı ve hedef, mint politikası, kasaya konuluyor tavanı,
 * onay matrisi, slippage, emir zaman sınırı, fiyatlama, burn anı.
 * Değişiklik ikinci onay ister ve günlüğe yazılır. Kural sunucudadır: istek 202 ile onay
 * numarası döner, onay farklı bir kullanıcıdan gelmezse değişiklik uygulanmaz.
 */
export function K9Params({ live }: { live: Live }) {
  const s = live.status;
  const [stock, setStock] = useState<StockParams | null>(null);
  const [pricing, setPricing] = useState({ marginBps: 30, marginCapBps: 100, commissionBps: 15 });
  const [orderP, setOrderP] = useState({ slippageBps: 100, timeLimitMs: 3000, unansweredGraceMs: 1000, minOrderUsdCents: 1000 });
  const [msg, setMsg] = useState("");
  const [approver, setApprover] = useState("yonetici");
  const [log, setLog] = useState<AuditEntry[]>([]);
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  /** Onay numarası → o isteği açan çağrı: onaylanınca aynı çağrı numarayla tekrarlanır. */
  const [apply, setApply] = useState<Record<number, (a: { approval_id: number; approver: string }) => Promise<unknown>>>({});

  useEffect(() => {
    if (!s) return;
    setStock(s.stock);
    setPricing(s.pricing);
    setOrderP(s.orderParams);
  }, [s?.ts]);

  const reload = async () => {
    try {
      setLog((await api.audit(60)).items);
      setPending((await api.approvals()).pending);
    } catch (e) { setMsg(`Günlük okunamadı: ${(e as Error).message}`); }
  };
  useEffect(() => { void reload(); }, [s?.ts]);

  /**
   * Kritik değişiklik iki adımdır. İlk çağrı sunucuda onay isteği açar (202);
   * ikinci çağrı onay numarası ve onaylayanla gelir ve değişiklik o zaman uygulanır.
   */
  const ask = async (what: string, call: (a: { approval_id?: number; approver?: string }) => Promise<unknown>) => {
    try {
      const r = await call({});
      if (needsApproval(r)) {
        setApply((m) => ({ ...m, [r.approval_id]: (a) => call(a) }));
        setMsg(`"${what}" ikinci onay bekliyor (onay ${r.approval_id}). İsteyen ${r.requested_by}; onaylayan farklı olmalı.`);
      } else setMsg(`"${what}" uygulandı.`);
      await reload();
      live.refresh();
    } catch (e) { setMsg(`Hata: ${(e as Error).message}`); }
  };

  const confirm = async (a: ApprovalRequest) => {
    const call = apply[a.id];
    try {
      if (call) await call({ approval_id: a.id, approver: approver.trim() });
      else await api.approve(a.id, approver.trim()); // başka oturumda açılmış istek: yalnız onaylanır
      setMsg(`"${a.summary}" onaylandı ve günlüğe yazıldı (isteyen ${a.requested_by}, onaylayan ${approver.trim()}).`);
      await reload();
      live.refresh();
    } catch (e) { setMsg(`Hata: ${(e as Error).message}`); }
  };

  const reject = async (a: ApprovalRequest) => {
    try { await api.rejectApproval(a.id); setMsg(`"${a.summary}" reddedildi.`); await reload(); }
    catch (e) { setMsg(`Hata: ${(e as Error).message}`); }
  };

  const num = (v: string) => Number(String(v).replace(",", "."));

  return (
    <div>
      <span className="tag">K9</span>
      <h1>Parametreler</h1>
      <p className="sub">İş kuralları koda gömülü değildir, buradan girilir. Stok bandı büyük alış ve satışı tetikler; envanter hedefi yalnız hazine alım satımıyla değişir. Onay matrisi hazine emirlerinde kaç onay gerektiğini belirler. Her değişiklik ikinci onay ister ve günlüğe yazılır.</p>

      {msg && <div className="note" style={{ marginBottom: 12 }}>{msg}</div>}

      {pending.length > 0 && (
        <section className="card" style={{ marginBottom: 14, borderColor: "var(--warn)" }}>
          <h2>İkinci onay bekleyenler</h2>
          <p className="small">Kural sunucudadır: isteyen kendi isteğini onaylayamaz, onay bir kez kullanılır.</p>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="small">Onaylayan kullanıcı:</span>
            <input value={approver} onChange={(e) => setApprover(e.target.value)} />
            <span className="small">aktif kullanıcı: <b>{currentUser.name}</b> (üst şeritten değişir)</span>
          </div>
          <table>
            <thead><tr><th>No</th><th>Ne</th><th>İsteyen</th><th>Zaman</th><th /></tr></thead>
            <tbody>
              {pending.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.id}</td>
                  <td>{a.summary}</td>
                  <td className="small">{a.requested_by}</td>
                  <td className="mono small">{new Date(a.requested_ts).toLocaleString("tr-TR")}</td>
                  <td className="row" style={{ justifyContent: "flex-end" }}>
                    <button className="primary" disabled={approver.trim() === a.requested_by} title={approver.trim() === a.requested_by ? "isteyen kendi isteğini onaylayamaz" : ""} onClick={() => confirm(a)}>Onayla ve uygula</button>
                    <button className="ghost" onClick={() => reject(a)}>Reddet</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
            <button className="primary" disabled={!stock} onClick={() => ask("stok bandı ve envanter parametreleri", (a) => api.stockParams({ ...stock!, ...a }))}>Kaydet</button>
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
            <button className="primary" disabled={!stock} onClick={() => ask("onay matrisi", (a) => api.stockParams({ ...stock!, ...a }))}>Kaydet</button>
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
            <button className="primary" onClick={() => ask("fiyatlama parametreleri", (a) => api.pricing({ ...pricing, ...a }))}>Kaydet</button>
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
            <button className="primary" onClick={() => ask("emir parametreleri", (a) => api.orderParams({ ...orderP, ...a }))}>Kaydet</button>
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
          <h2>Denetim günlüğü</h2>
          <p className="small">Sunucuda tutulur, sayfa yenilenince kaybolmaz. Elle yapılan her aksiyon ve her onay adımı buradadır.</p>
          <table>
            <thead><tr><th>Zaman</th><th>Kim</th><th>Ne</th></tr></thead>
            <tbody>
              {log.length === 0 && <tr><td colSpan={3} className="small">Günlük boş</td></tr>}
              {log.map((l) => (
                <tr key={l.id}>
                  <td className="mono small">{new Date(l.ts).toLocaleString("tr-TR")}</td>
                  <td className="small">{l.actor}</td>
                  <td className="small">{l.summary}<div className="mono" style={{ fontSize: 11, opacity: .6 }}>{l.action}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
