import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ageSec, fmtTime, type useLive } from "../api.ts";

type Live = ReturnType<typeof useLive>;

/**
 * K11 Fiyat: rafineri tarafındaki R2'nin karşılığı.
 * Rafineri fiyatından müşteri fiyatına zincir, son tick'ler ve müşteri işlemlerini durdur / başlat.
 * Bağlantı ayarları (soket adresi, kimlik) Ayarlar ekranındadır; burada yalnız durum görünür.
 */
export function K11Price({ live }: { live: Live }) {
  const s = live.status;
  const sock = s?.socket;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await live.refresh(); } finally { setBusy(false); } };

  const conn = sock?.connection;
  const connDot = conn === "SUBSCRIBED" ? (sock?.stale ? "warn" : "ok") : conn === "DISCONNECTED" ? "bad" : "warn";
  const connText = conn === "SUBSCRIBED" ? (sock?.stale ? "Bağlı, fiyat bayat" : "Bağlı, fiyat akıyor") : conn === "AUTHENTICATING" ? "Kimlik doğrulanıyor" : conn === "CONNECTING" ? `Bağlanıyor${sock?.reconnectAttempt ? ` (deneme ${sock.reconnectAttempt})` : ""}` : "Bağlı değil";

  return (
    <div>
      <span className="tag">K11</span>
      <h1>Fiyat</h1>
      <p className="sub">Fiyat rafineriden soketle gelir; marj gömülerek müşteri fiyatı olur, komisyon ayrı satırdır. Kural: 10 saniye mesaj yoksa fiyat bayat, rafineri yayını durduysa ya da soket kopuksa müşteri işlemleri kendiliğinden durur. Elle de durdurulabilir.</p>

      <div className="grid c2">
        <section className="card">
          <h2>Müşteri işlemleri</h2>
          <div className="kv">
            <span className="k">Durum</span><span className="status"><span className={`dot ${s?.trading.open ? "ok" : "bad"}`} />{s?.trading.open ? "Açık: fiyat veriliyor" : "Durdu"}</span>
            {!s?.trading.open && <><span className="k">Sebep</span><span>{s?.trading.reason}</span></>}
            <span className="k">Rafineri yayını</span><span>{sock?.tradable ? <span className="pill ok">açık</span> : <span className="pill bad">durdu{sock?.haltReason ? `: ${sock.haltReason}` : ""}</span>}</span>
            <span className="k">Fiyat tazeliği</span><span>{sock?.stale ? <span className="pill warn">bayat (10 sn kuralı)</span> : <span className="pill ok">taze</span>}</span>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            {s?.trading.manualStop
              ? <button className="primary" disabled={busy} onClick={() => run(() => api.start())}>Müşteri işlemlerini başlat</button>
              : (<>
                <input className="wide" placeholder="gerekçe (zorunlu)" value={reason} onChange={(e) => setReason(e.target.value)} />
                <button className="danger" disabled={busy || !reason.trim()} onClick={() => run(async () => { await api.stop(reason.trim()); setReason(""); })}>Durdur</button>
              </>)}
          </div>
          <p className="small" style={{ marginTop: 10 }}>Kendiliğinden durma sebepleri: soket kopuk, fiyat bayat, rafineri yayını durdu. Elle durdurma bunlardan bağımsızdır, gerekçe ister ve elle başlatılana kadar açılmaz.</p>
        </section>

        <section className="card">
          <h2>Rafineri fiyat soketi</h2>
          <div className="kv">
            <span className="k">Durum</span><span className="status"><span className={`dot ${connDot}`} />{connText}</span>
            <span className="k">Son mesaj</span><span>{sock?.lastMsgTs ? `${fmtTime(sock.lastMsgTs)} (${ageSec(sock.lastMsgTs)} sn önce)` : "yok"}</span>
            <span className="k">Son tick</span><span>{sock?.lastTickTs ? `sıra ${sock.seq} · ${fmtTime(sock.lastTickTs)}` : "yok"}</span>
            <span className="k">Sıra boşluğu</span><span>{sock?.gaps ?? 0} kez yeniden abone olundu</span>
            {sock?.lastError && (<><span className="k">Son hata</span><span className="small">{sock.lastError}</span></>)}
          </div>
          <p className="small" style={{ marginTop: 10 }}>Adres, kimlik ve yeniden bağlanma kuralı <Link to="/ayarlar">Ayarlar</Link> ekranındadır.</p>
        </section>
      </div>

      <section className="card" style={{ marginTop: 14 }}>
        <h2>Fiyat zinciri (rafineri fiyatı → müşteri fiyatı)</h2>
        <p className="small">Marj fiyata gömülü (hedef %{s ? (s.pricing.marginBps / 100).toFixed(2) : "0,30"}, tavan %{s ? (s.pricing.marginCapBps / 100).toFixed(2) : "1,00"}), komisyon %{s ? (s.pricing.commissionBps / 100).toFixed(2) : "0,15"} ayrı satır. Müşteri rafineri fiyatını ve marjı görmez; bu tablo yalnız hazine içindir.</p>
        <table>
          <thead><tr><th>Kur</th><th className="num">Rafineri alış</th><th className="num">Rafineri satış</th><th className="num">Müşteri satar</th><th className="num">Müşteri alır</th><th className="num">Komisyon</th></tr></thead>
          <tbody>
            {(s?.quotes ?? []).length === 0 && <tr><td colSpan={6} className="small">Fiyat yok</td></tr>}
            {(s?.quotes ?? []).map((q) => (
              <tr key={q.ccy}><td><b>{q.ccy}</b></td><td className="num">{q.refineryBid}</td><td className="num">{q.refineryAsk}</td><td className="num">{q.clientSell}</td><td className="num">{q.clientBuy}</td><td className="num">%{(q.commissionBps / 100).toFixed(2)}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 style={{ margin: 0 }}>Son 50 tick</h2>
          <Link to="/kayitlar" className="small">tamamı ve geçmişi: Kayıtlar →</Link>
        </div>
        <table>
          <thead><tr><th className="num">Sıra</th><th>Zaman</th><th className="num">USD alış / satış</th><th className="num">EUR alış / satış</th><th className="num">AED alış / satış</th><th>İşlem</th></tr></thead>
          <tbody>
            {live.ticks.map((t) => {
              const g = (c: string) => t.prices.find((p) => p.ccy === c);
              return (
                <tr key={t.seq}>
                  <td className="num">{t.seq}</td><td className="mono">{fmtTime(t.ts)}</td>
                  <td className="num">{g("USD")?.bid} / {g("USD")?.ask}</td><td className="num">{g("EUR")?.bid} / {g("EUR")?.ask}</td><td className="num">{g("AED")?.bid} / {g("AED")?.ask}</td>
                  <td><span className={`pill ${t.tradable ? "ok" : "bad"}`}>{t.tradable ? "yapılabilir" : "durdu"}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
