import { useEffect, useState } from "react";
import { api, ageSec, fmtTime, type useLive } from "../api.ts";

type Live = ReturnType<typeof useLive>;

export function K1Connection({ live }: { live: Live }) {
  const s = live.status;
  const sock = s?.socket;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await live.refresh(); } finally { setBusy(false); } };

  const conn = sock?.connection;
  const connDot = conn === "SUBSCRIBED" ? (sock?.stale ? "warn" : "ok") : conn === "DISCONNECTED" ? "bad" : "warn";
  const connText = conn === "SUBSCRIBED" ? (sock?.stale ? "Abone, fiyat bayat" : "Abone, fiyat akıyor") : conn === "AUTHENTICATING" ? "Kimlik doğrulanıyor" : conn === "CONNECTING" ? `Bağlanıyor${sock?.reconnectAttempt ? ` (deneme ${sock.reconnectAttempt})` : ""}` : "Bağlı değil";

  return (
    <div>
      <span className="tag">K1</span>
      <h1>Bağlantı ve fiyat</h1>
      <p className="sub">Rafineri fiyat soketinin ve bağlantının sağlığı. Kural: 10 sn mesaj yoksa fiyat bayat, rafineri yayını durduysa (tradable=false) ya da soket kopuksa müşteri işlemleri otomatik durur. Elle de durdurulabilir.</p>

      <div className="grid c2">
        <section className="card">
          <h2>Rafineri fiyat soketi</h2>
          <div className="kv">
            <span className="k">Durum</span><span className="status"><span className={`dot ${connDot}`} />{connText}</span>
            <span className="k">Adres</span><span className="mono">{sock?.url}</span>
            <span className="k">Son mesaj</span><span>{sock?.lastMsgTs ? `${fmtTime(sock.lastMsgTs)} (${ageSec(sock.lastMsgTs)} sn önce)` : "yok"}</span>
            <span className="k">Son tick</span><span>{sock?.lastTickTs ? `seq ${sock.seq} · ${fmtTime(sock.lastTickTs)}` : "yok"}</span>
            <span className="k">Rafineri yayını</span><span>{sock?.tradable ? <span className="pill ok">yayında</span> : <span className="pill bad">durdu{sock?.haltReason ? `: ${sock.haltReason}` : ""}</span>}</span>
            <span className="k">Bayatlık</span><span>{sock?.stale ? <span className="pill warn">bayat (10 sn kuralı)</span> : <span className="pill ok">taze</span>}</span>
            <span className="k">seq boşluğu</span><span>{sock?.gaps ?? 0} kez yeniden abone olundu</span>
            {sock?.lastError && (<><span className="k">Son hata</span><span className="small">{sock.lastError}</span></>)}
          </div>
          <p className="small" style={{ marginTop: 10 }}>Kopma → 1, 2, 4, 8, 16, 30 sn bekleyip yeniden bağlanır. seq atlarsa yeniden abone olur ve fotoğraf ister. Kimlik: API anahtarı + HMAC imza.</p>
        </section>

        <section className="card">
          <h2>Müşteri işlemleri</h2>
          <div className="kv">
            <span className="k">Durum</span><span className="status"><span className={`dot ${s?.trading.open ? "ok" : "bad"}`} />{s?.trading.open ? "Açık: fiyat veriliyor" : "Durdu"}</span>
            <span className="k">Sebep</span><span>{s?.trading.open ? "" : s?.trading.reason}</span>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            {s?.trading.manualStop
              ? <button className="primary" disabled={busy} onClick={() => run(() => api.start())}>Müşteri işlemlerini başlat</button>
              : (<>
                <input className="wide" placeholder="gerekçe (zorunlu)" value={reason} onChange={(e) => setReason(e.target.value)} />
                <button className="danger" disabled={busy || !reason.trim()} onClick={() => run(async () => { await api.stop(reason.trim()); setReason(""); })}>Durdur</button>
              </>)}
          </div>
          <p className="small" style={{ marginTop: 10 }}>Otomatik durma sebepleri: soket kopuk, fiyat bayat, rafineri yayını durdu. Elle durdurma bunlardan bağımsızdır ve gerekçe ister.</p>
        </section>
      </div>

      <section className="card" style={{ marginTop: 14 }}>
        <h2>Fiyat zinciri (rafineri fiyatı → müşteri fiyatı)</h2>
        <p className="small">Marj fiyata gömülü (hedef %{s ? (s.pricing.marginBps / 100).toFixed(2) : "0,30"}, tavan %{s ? (s.pricing.marginCapBps / 100).toFixed(2) : "1,00"}), komisyon %{s ? (s.pricing.commissionBps / 100).toFixed(2) : "0,15"} ayrı satır. Müşteri rafineri fiyatını ve marjı görmez; bu tablo yalnız hazine içindir.</p>
        <table>
          <thead><tr><th>Kur</th><th className="num">Rafineri bid</th><th className="num">Rafineri ask</th><th className="num">Müşteri satar (bid)</th><th className="num">Müşteri alır (ask)</th><th className="num">Komisyon</th></tr></thead>
          <tbody>
            {(s?.quotes ?? []).length === 0 && <tr><td colSpan={6} className="small">Fiyat yok</td></tr>}
            {(s?.quotes ?? []).map((q) => (
              <tr key={q.ccy}><td><b>{q.ccy}</b></td><td className="num">{q.refineryBid}</td><td className="num">{q.refineryAsk}</td><td className="num">{q.clientSell}</td><td className="num">{q.clientBuy}</td><td className="num">%{(q.commissionBps / 100).toFixed(2)}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <h2>Son tick'ler (rafineriden)</h2>
        <table>
          <thead><tr><th className="num">seq</th><th>Zaman</th><th className="num">USD bid / ask</th><th className="num">EUR bid / ask</th><th className="num">AED bid / ask</th><th>tradable</th></tr></thead>
          <tbody>
            {live.ticks.map((t) => {
              const g = (c: string) => t.prices.find((p) => p.ccy === c);
              return (
                <tr key={t.seq}>
                  <td className="num">{t.seq}</td><td className="mono">{fmtTime(t.ts)}</td>
                  <td className="num">{g("USD")?.bid} / {g("USD")?.ask}</td><td className="num">{g("EUR")?.bid} / {g("EUR")?.ask}</td><td className="num">{g("AED")?.bid} / {g("AED")?.ask}</td>
                  <td><span className={`pill ${t.tradable ? "ok" : "bad"}`}>{t.tradable ? "evet" : "hayır"}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
