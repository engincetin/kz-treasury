import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { api, ageSec, currentUser, fmtG, fmtMoney, KZ_USERS, setCurrentUser, useLive, type Notice, type Status } from "./api.ts";
import { Icon, useSidebar, useTheme } from "./ui.tsx";
import { K1Connection } from "./pages/K1Connection.tsx";
import { Placeholder } from "./pages/Placeholder.tsx";
import { K2Accounts } from "./pages/K2Accounts.tsx";
import { K3Orders } from "./pages/K3Orders.tsx";
import { K4Vault } from "./pages/K4Vault.tsx";
import { K5Treasury } from "./pages/K5Treasury.tsx";
import { K6Delivery } from "./pages/K6Delivery.tsx";
import { K7Refining } from "./pages/K7Refining.tsx";
import { K8Settlement } from "./pages/K8Settlement.tsx";
import { K9Params } from "./pages/K9Params.tsx";

const SCREENS = [
  { code: "K1", path: "/", title: "Bağlantı ve fiyat", sprint: 1 },
  { code: "K2", path: "/hesaplar", title: "Rafineri hesapları", sprint: 2, done: true },
  { code: "K3", path: "/emirler", title: "Emir günlüğü", sprint: 2, done: true },
  { code: "K4", path: "/kasa", title: "Kasa talimatları", sprint: 3, done: true },
  { code: "K5", path: "/hazine", title: "Hazine alım satımı", sprint: 3, done: true },
  { code: "K6", path: "/teslimat", title: "Fiziksel teslimat", sprint: 4, done: true },
  { code: "K7", path: "/rafinasyon", title: "Rafinasyon", sprint: 4, done: true },
  { code: "K8", path: "/mahsuplasma", title: "Mahsuplaşma", sprint: 5, done: true },
  { code: "K9", path: "/parametreler", title: "Parametreler", sprint: 5, done: true },
];

export function App() {
  const live = useLive();
  const side = useSidebar();
  return (
    <div className={`layout${side.collapsed ? " collapsed" : ""}${side.mobileOpen ? " nav-open" : ""}`}>
      {side.mobileOpen && <div className="nav-backdrop" onClick={side.closeMobile} />}
      <aside className="side">
        <button className="side-toggle" onClick={side.toggle} title={side.collapsed ? "Menüyü genişlet" : "Menüyü daralt"} aria-label="Menüyü daralt">{Icon.chevronLeft}</button>
        <div className="brand">
          <img src="/kanzasset-mark.png" alt="Kanzasset" />
          <span className="bt">Kanzasset</span>
          <span className="badge">BO</span>
        </div>
        <nav className="nav" onClick={() => side.isMobile && side.closeMobile()}>
          {SCREENS.map((s) => (
            <NavLink key={s.code} to={s.path} end={s.path === "/"} title={s.title}>
              <span className="code">{s.code}</span><span className="label">{s.title}</span>
              {s.sprint > 1 && !(s as any).done && <span className="sprint">Sprint {s.sprint}</span>}
            </NavLink>
          ))}
        </nav>
      </aside>
      <TopBar s={live.status} sse={live.connected} refresh={live.refresh} onMenu={side.openMobile} />
      <main className="main">
        <Routes>
          <Route path="/" element={<K1Connection live={live} />} />
          <Route path="/hesaplar" element={<K2Accounts live={live} />} />
          <Route path="/emirler" element={<K3Orders live={live} />} />
          <Route path="/kasa" element={<K4Vault live={live} />} />
          <Route path="/hazine" element={<K5Treasury live={live} />} />
          <Route path="/teslimat" element={<K6Delivery live={live} />} />
          <Route path="/rafinasyon" element={<K7Refining live={live} />} />
          <Route path="/mahsuplasma" element={<K8Settlement live={live} />} />
          <Route path="/parametreler" element={<K9Params live={live} />} />
        </Routes>
      </main>
    </div>
  );
}

function TopBar({ s, sse, refresh, onMenu }: { s: Status | null; sse: boolean; refresh: () => void; onMenu: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notice[]>([]);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (open) api.notifications().then((r) => setItems(r.items)); }, [open, s?.unread]);
  const usd = s?.socket.lastPrices?.find((p) => p.ccy === "USD");
  const q = s?.quotes.find((x) => x.ccy === "USD");
  return (
    <header className="topbar">
      <button className="hamburger" onClick={onMenu} title="Menü" aria-label="Menü">{Icon.menu}</button>
      <div className="chips">
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
        <span className="s">
          eşleşme <span className={`pill ${s?.record.match === "EŞİT" ? "ok" : s?.record.match === "RECONCILE" ? "bad" : "warn"}`}>{s?.record.match ?? ""}</span> · K1 {s?.checks.k1.ok ? "✓" : "✗"} · K2 {s?.checks.k2.ok ? "✓" : "✗"}
          {s?.vault && (s.vault.mint_block ? " · mint BLOKE" : s.vault.open > 0 ? ` · ${s.vault.open} kasa talimatı açık` : "")}
        </span>
      </div>
      <div className="chip">
        <span className="l">Cari hesap (KZ kaydı)</span>
        <span className="v mono">{s ? `${s.record.current_account.gold_mg >= 0 ? "+" : ""}${fmtG(s.record.current_account.gold_mg)} g` : "…"}</span>
        <span className="s">{s?.record.current_account.money.map((m) => `${m.ccy} ${fmtMoney(m.cents)}`).join(" · ")}</span>
      </div>
      </div>
      <button className="bell" onClick={() => setOpen((v) => !v)}>🔔 <span className="label">Bildirimler</span> {s && s.unread > 0 && <span className="n">{s.unread}</span>}{s && (s.unanswered + s.lateFills + s.awaitingDelivery + s.treasury.pending) > 0 && <span className="n" style={{ background: "var(--warn)" }} title="cevapsız / geç fill · teslim bekleyen · onay bekleyen">{s.unanswered + s.lateFills + s.awaitingDelivery + s.treasury.pending}</span>}</button>
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
      <UserPicker />
      <ThemeButton />
      <span className="small sse" style={{ alignSelf: "center" }}>canlı akış {sse ? "açık" : "kapalı"}</span>
    </header>
  );
}

/**
 * Aktif kullanıcı. Demoda oturum açma yoktur: seçilen ad her istekte X-User ile gider,
 * denetim günlüğüne yazılır ve ikinci onayda "isteyen ile onaylayan aynı olamaz" kuralını besler.
 */
function UserPicker() {
  const [u, setU] = useState(currentUser.name);
  return (
    <label className="chip" style={{ minWidth: 0 }}>
      <span className="l">Kullanıcı</span>
      <select
        value={u}
        onChange={(e) => { setCurrentUser(e.target.value); setU(e.target.value); }}
        style={{ border: 0, background: "transparent", font: "inherit", fontWeight: 600, padding: 0 }}
      >
        {KZ_USERS.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
      <span className="s">aksiyonlar bu adla günlüğe yazılır</span>
    </label>
  );
}

/** Tema düğmesi: açık → koyu → sistem. Seçim tarayıcıda saklanır. */
function ThemeButton() {
  const theme = useTheme();
  const label = theme.mode === "light" ? "Açık tema" : theme.mode === "dark" ? "Koyu tema" : "Sistem teması";
  return (
    <button className="theme-btn" onClick={theme.cycle} title={`${label} (değiştirmek için tıklayın)`} aria-label={label}>
      {theme.mode === "light" ? Icon.sun : theme.mode === "dark" ? Icon.moon : Icon.auto}
    </button>
  );
}
