import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { api, ageSec, fmtG, fmtMoney, useLive, type Notice, type Status } from "./api.ts";
import { K1Connection } from "./pages/K1Connection.tsx";
import { Placeholder } from "./pages/Placeholder.tsx";

const SCREENS = [
  { code: "K1", path: "/", title: "Bağlantı ve fiyat", sprint: 1 },
  { code: "K2", path: "/hesaplar", title: "Rafineri hesapları", sprint: 2 },
  { code: "K3", path: "/emirler", title: "Emir günlüğü", sprint: 2 },
  { code: "K4", path: "/kasa", title: "Kasa talimatları", sprint: 3 },
  { code: "K5", path: "/hazine", title: "Hazine alım satımı", sprint: 3 },
  { code: "K6", path: "/teslimat", title: "Fiziksel teslimat", sprint: 4 },
  { code: "K7", path: "/rafinasyon", title: "Rafinasyon", sprint: 4 },
  { code: "K8", path: "/mahsuplasma", title: "Mahsuplaşma", sprint: 5 },
  { code: "K9", path: "/parametreler", title: "Parametreler", sprint: 5 },
];

export function App() {
  const live = useLive();
  return (
    <div className="layout">
      <div className="brand"><span>Kanzasset</span><b>·</b><span className="small" style={{ color: "#c9ced6" }}>Hazine → Rafineri</span></div>
      <nav className="nav">
        {SCREENS.map((s) => (
          <NavLink key={s.code} to={s.path} end={s.path === "/"}>
            <span className="code">{s.code}</span><span>{s.title}</span>
            {s.sprint > 1 && <span className="sprint">Sprint {s.sprint}</span>}
          </NavLink>
        ))}
      </nav>
      <TopBar s={live.status} sse={live.connected} refresh={live.refresh} />
      <main className="main">
        <Routes>
          <Route path="/" element={<K1Connection live={live} />} />
          <Route path="/hesaplar" element={<Placeholder code="K2" title="Rafineri hesapları" sprint={2} text="Kasa hesabı alt kalemleri (kasada, kasaya konuluyor, sevkiyatta) ve cari hesap (altın, kur bazında para): KZ kaydı ile rafineriden gelen bakiye bilgisinin eşleşmesi (EŞİT / RECONCILE), fark satırları, anlık fotoğraf iste, RECONCILE çöz." />} />
          <Route path="/emirler" element={<Placeholder code="K3" title="Emir günlüğü" sprint={2} text="Müşteri emri ↔ rafineri emri (client_order_id), fill fiyatı ve müşteri fiyatı, cevapsız emir kuyruğu (durum sorgusu, iptal), geç fill kararı." />} />
          <Route path="/kasa" element={<Placeholder code="K4" title="Kasa talimatları" sprint={3} text="Giriş / çıkış talepleri ve durumları (talep, kabul, kasaya konuluyor, kasaya konuldu, red), Kasa Giriş / Çıkış Fişleri, mint / burn eşlemesi (BitGo), T+3 sayacı." />} />
          <Route path="/hazine" element={<Placeholder code="K5" title="Hazine alım satımı" sprint={3} text="Maker-checker: talep oluştur, onay matrisi, son onaycı canlı fiyatla gönderir; sonuç zinciri fill → kasa girişi / çıkışı → mint / burn." />} />
          <Route path="/teslimat" element={<Placeholder code="K6" title="Fiziksel teslimat" sprint={4} text="Müşteri itfa talebi → rafineriye talep → lojistik teklifi onayı → hazırlık, sevkiyat, takip no, teslim; DELIVERED olayında burn." />} />
          <Route path="/rafinasyon" element={<Placeholder code="K7" title="Rafinasyon" sprint={4} text="Rafineri kataloğu, müşteri seçimi, rafineri teklifi (ürün bedeli + lojistik), müşteriye marj + komisyon dahil fiyat, onay, üretim ve teslimat takibi." />} />
          <Route path="/mahsuplasma" element={<Placeholder code="K8" title="Mahsuplaşma" sprint={5} text="Pencereler (kesim saati otomatik, talep iki yönlü), KZ ekstresi ↔ AMR ekstresi karşılaştırma, mutabakat onayı, altın bacağı izleme, ödeme talimatı ve bildirimi." />} />
          <Route path="/parametreler" element={<Placeholder code="K9" title="Parametreler" sprint={5} text="Taban / tavan / hedef, mint politikası, slippage aralığı, emir zaman sınırı, bayatlık eşiği, cari hesap limitleri, pencere sayısı, burn anı, onay matrisi." />} />
        </Routes>
      </main>
    </div>
  );
}

function TopBar({ s, sse, refresh }: { s: Status | null; sse: boolean; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notice[]>([]);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (open) api.notifications().then((r) => setItems(r.items)); }, [open, s?.unread]);
  const usd = s?.socket.lastPrices?.find((p) => p.ccy === "USD");
  const q = s?.quotes.find((x) => x.ccy === "USD");
  return (
    <header className="topbar">
      <div className="chip">
        <span className="l">Müşteri işlemleri</span>
        <span className="v"><span className={`dot ${s?.trading.open ? "ok" : "bad"}`} />{s ? (s.trading.open ? "Açık" : "Durdu") : "…"}</span>
        <span className="s">{s?.trading.open ? "fiyat veriliyor" : s?.trading.reason}</span>
      </div>
      <div className="chip">
        <span className="l">Rafineri fiyatı</span>
        <span className="v mono">{usd ? `USD ${usd.bid} / ${usd.ask}` : "yok"}</span>
        <span className="s">{s?.socket.lastTickTs ? `seq ${s.socket.seq} · ${ageSec(s.socket.lastMsgTs)} sn önce${s.socket.stale ? " · BAYAT" : ""}` : "tick yok"}</span>
      </div>
      <div className="chip">
        <span className="l">Müşteri fiyatı (USD)</span>
        <span className="v mono">{q ? `${q.clientSell} / ${q.clientBuy}` : "yok"}</span>
        <span className="s">{s ? `marj %${(s.pricing.marginBps / 100).toFixed(2)} gömülü · komisyon %${(s.pricing.commissionBps / 100).toFixed(2)} ayrı` : ""}</span>
      </div>
      <div className="chip">
        <span className="l">Kasa hesabı (KZ kaydı)</span>
        <span className="v mono">{s ? fmtG(s.record.vault.in_vault_mg + s.record.vault.placing_mg + s.record.vault.shipping_mg) : "…"} g</span>
        <span className="s">eşleşme {s?.record.match ?? ""}</span>
      </div>
      <div className="chip">
        <span className="l">Cari hesap (KZ kaydı)</span>
        <span className="v mono">{s ? `${s.record.current_account.gold_mg >= 0 ? "+" : ""}${fmtG(s.record.current_account.gold_mg)} g` : "…"}</span>
        <span className="s">{s?.record.current_account.money.map((m) => `${m.ccy} ${fmtMoney(m.cents)}`).join(" · ")}</span>
      </div>
      <button className="bell" onClick={() => setOpen((v) => !v)}>🔔 Bildirimler {s && s.unread > 0 && <span className="n">{s.unread}</span>}</button>
      {open && (
        <div className="drawer">
          {items.length === 0 && <div className="item">Bildirim yok</div>}
          {items.map((n) => (
            <div key={n.id} className={`item ${n.read ? "" : "unread"}`}>
              <div style={{ flex: 1 }}><div><b>{n.title}</b></div>{n.body && <div className="small">{n.body}</div>}<div className="t">{new Date(n.ts).toLocaleString("tr-TR")}</div></div>
              {!n.read && <button className="ghost" onClick={async () => { await api.markRead(n.id); setItems((await api.notifications()).items); refresh(); }}>Okundu</button>}
            </div>
          ))}
        </div>
      )}
      <span className="small" style={{ alignSelf: "center" }}>canlı akış {sse ? "açık" : "kapalı"}</span>
    </header>
  );
}
