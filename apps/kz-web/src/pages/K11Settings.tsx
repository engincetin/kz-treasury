import { useEffect, useState } from "react";
import { api, currentUser, needsApproval, type ApprovalRequest, type AuditEntry, type RequestLogRow, type RequestSummary, type StockParams, type useLive } from "../api.ts";

type Live = ReturnType<typeof useLive>;

/**
 * K11 Ayarlar: rafineri tarafındaki R10'un karşılığı.
 * Bağlantı (rafineri soketi ve REST adresi) burada görünür; iş kurallarının değerleri: stok bandı ve hedef, mint politikası, kasaya konuluyor tavanı,
 * onay matrisi, kayma payı, emir zaman sınırı, fiyatlama, burn anı.
 * Değişiklik ikinci onay ister ve günlüğe yazılır. Kural sunucudadır: istek 202 ile onay
 * numarası döner, onay farklı bir kullanıcıdan gelmezse değişiklik uygulanmaz.
 */
export function K11Settings({ live }: { live: Live }) {
  const s = live.status;
  const [stock, setStock] = useState<StockParams | null>(null);
  const [pricing, setPricing] = useState({ marginBps: 30, marginCapBps: 100, commissionBps: 15 });
  const [orderP, setOrderP] = useState({ slippageBps: 100, timeLimitMs: 3000, unansweredGraceMs: 1000, minOrderUsdCents: 1000 });
  const [msg, setMsg] = useState("");
  const [approver, setApprover] = useState("yonetici");
  const [log, setLog] = useState<AuditEntry[]>([]);
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const [reqs, setReqs] = useState<RequestLogRow[]>([]);
  const [reqSum, setReqSum] = useState<RequestSummary | null>(null);
  const [reqQ, setReqQ] = useState({ direction: "", errors: false });
  const [retention, setRetention] = useState(90);

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
      const r = await api.requests({ limit: 100, direction: reqQ.direction || undefined, errors: reqQ.errors });
      setReqs(r.items); setReqSum(r.summary); setRetention(r.summary.retention_days);
    } catch (e) { setMsg(`Günlük okunamadı: ${(e as Error).message}`); }
  };
  useEffect(() => { void reload(); }, [s?.ts, reqQ.direction, reqQ.errors]);

  /**
   * Kritik değişiklik iki adımdır. İlk çağrı sunucuda onay isteği açar (202);
   * ikinci çağrı onay numarası ve onaylayanla gelir ve değişiklik o zaman uygulanır.
   */
  const ask = async (what: string, call: (a: { approval_id?: number; approver?: string }) => Promise<unknown>) => {
    try {
      const r = await call({});
      if (needsApproval(r)) setMsg(`"${what}" ikinci onay bekliyor (onay ${r.approval_id}). İsteyen ${r.requested_by}; aşağıdaki listeden farklı bir kullanıcı onaylayınca uygulanır.`);
      else setMsg(`"${what}" uygulandı.`);
      await reload();
      live.refresh();
    } catch (e) { setMsg(`Hata: ${(e as Error).message}`); }
  };

  const confirm = async (a: ApprovalRequest) => {
    try {
      // onay sunucuda uygulanır: hangi ekrandan açıldığı fark etmez
      const r = await api.approve(a.id, approver.trim()) as { applied?: string };
      setMsg(`"${a.summary}" onaylandı ve uygulandı (isteyen ${a.requested_by}, onaylayan ${approver.trim()})${r.applied && r.applied !== "uygulandı" ? ` · ${r.applied}` : ""}.`);
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
      <span className="tag">K11</span>
      <h1>Ayarlar</h1>
      <p className="sub">Bağlantı, iş kuralları ve günlükler tek yerde. İş kuralları koda gömülü değildir, buradan girilir. Stok bandı büyük alış ve satışı tetikler; envanter hedefi yalnız hazine alım satımıyla değişir. Onay matrisi hazine emirlerinde kaç onay gerektiğini belirler. Her değişiklik ikinci onay ister ve günlüğe yazılır.</p>

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

      <section className="card" style={{ marginBottom: 14 }}>
        <h2>Bağlantı (rafineri)</h2>
        <div className="grid c2">
          <div className="kv">
            <span className="k">Fiyat soketi</span><span className="mono small">{s?.socket.url ?? "…"}</span>
            <span className="k">Durum</span>
            <span className="status"><span className={`dot ${s?.socket.connection === "SUBSCRIBED" ? (s.socket.stale ? "warn" : "ok") : s?.socket.connection === "DISCONNECTED" ? "bad" : "warn"}`} />{s?.socket.connection === "SUBSCRIBED" ? (s.socket.stale ? "Abone, fiyat bayat" : "Abone, fiyat akıyor") : s?.socket.connection === "AUTHENTICATING" ? "Kimlik doğrulanıyor" : s?.socket.connection === "CONNECTING" ? `Bağlanıyor${s.socket.reconnectAttempt ? ` (deneme ${s.socket.reconnectAttempt})` : ""}` : "Bağlı değil"}</span>
            <span className="k">Son mesaj</span><span className="mono small">{s?.socket.lastMsgTs ? new Date(s.socket.lastMsgTs).toLocaleTimeString("tr-TR") : "yok"} · sıra {s?.socket.seq ?? 0} · atlanan {s?.socket.gaps ?? 0}</span>
            {s?.socket.lastError && (<><span className="k">Son hata</span><span className="small">{s.socket.lastError}</span></>)}
          </div>
          <div className="kv">
            <span className="k">REST adresi</span><span className="mono small">{s?.rest.url ?? "…"}</span>
            <span className="k">Gelen olaylar</span><span className="mono small">{s?.rest.events_received ?? 0} · son {s?.rest.last_event_ts ? new Date(s.rest.last_event_ts).toLocaleTimeString("tr-TR") : "yok"}</span>
            <span className="k">Yeniden bağlanma</span><span className="small">kopunca kendiliğinden, artan bekleme ile; elle müdahale gerekmez</span>
          </div>
        </div>
        <p className="small" style={{ marginTop: 10 }}>Adres ve kimlik bilgileri sunucu ortam değişkenleridir (AMR_WS_URL, AMR_HTTP_URL, KZ_API_KEY, KZ_API_SECRET); çalışırken değişmez. Soket kopuk, fiyat bayat ya da rafineri yayını durduysa müşteri işlemleri kendiliğinden durur; durdur / başlat Fiyat ekranındadır.</p>
      </section>

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
            <label className="k" style={{ alignSelf: "center" }}>Kayma payı (bps)</label>
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

      <section className="card" style={{ marginBottom: 14 }}>
        <h2>İstek günlüğü (VARA kanıtı) <span className="pill">{reqSum?.total ?? 0}</span></h2>
        <p className="small">Rafineriye giden her REST çağrısı ve rafineriden gelen her olay burada. Gövdenin kendisi saklanmaz; imzalanan gövdenin sha256 özeti saklanır, böylece "bu istek bu gövdeyle gitti" sonradan kanıtlanır. Saklama süresi ve satır tavanı ikinci onayla değişir.</p>
        {reqSum && (
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="pill">son 24 saat: {reqSum.last_24h}</span>
            <span className="pill">giden {reqSum.outgoing_24h} · gelen {reqSum.incoming_24h}</span>
            <span className={`pill ${reqSum.errors_24h > 0 ? "warn" : "ok"}`}>hata: {reqSum.errors_24h}</span>
            <span className="pill">ortalama {reqSum.avg_ms} ms</span>
            <span className="small">tavan {reqSum.max_rows} satır</span>
          </div>
        )}
        <div className="row" style={{ marginBottom: 8 }}>
          <select value={reqQ.direction} onChange={(e) => setReqQ({ ...reqQ, direction: e.target.value })}>
            <option value="">iki yön</option>
            <option value="GİDEN">giden (rafineriye)</option>
            <option value="GELEN">gelen (olay ve panel)</option>
          </select>
          <label className="small"><input type="checkbox" checked={reqQ.errors} onChange={(e) => setReqQ({ ...reqQ, errors: e.target.checked })} /> yalnız hatalar</label>
          <span className="small">Saklama (gün):</span>
          <input className="mono" style={{ width: 80 }} value={String(retention)} onChange={(e) => setRetention(Number(e.target.value) || 0)} />
          <button className="ghost" onClick={() => ask("istek günlüğü saklama parametreleri", (a) => api.logParams({ retentionDays: retention, ...a }))}>Kaydet</button>
        </div>
        <table>
          <thead><tr><th>Zaman</th><th>Yön</th><th>İstek</th><th className="num">Sonuç</th><th className="num">Süre</th><th>Kim</th><th>Gövde özeti</th></tr></thead>
          <tbody>
            {reqs.length === 0 && <tr><td colSpan={7} className="small">Kayıt yok</td></tr>}
            {reqs.map((r) => (
              <tr key={r.id}>
                <td className="mono small">{new Date(r.ts).toLocaleString("tr-TR")}</td>
                <td className="small">{r.direction}</td>
                <td className="mono small">{r.method} {r.path}</td>
                <td className="num"><span className={`pill ${r.status >= 400 || r.status === 0 ? "bad" : "ok"}`}>{r.status || "hata"}</span></td>
                <td className="num mono small">{r.duration_ms} ms</td>
                <td className="small">{r.actor ?? ""}</td>
                <td className="mono small" title={r.body_sha256 ?? ""}>{r.body_sha256 ? r.body_sha256.slice(0, 12) + "…" : ""}{r.error ? <div style={{ opacity: .7 }}>{r.error}</div> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

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
