import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { api, ageSec, currentUser, fmtG, fmtMoney, KZ_USERS, setCurrentUser, useLive, type Notice, type Status } from "./api.ts";
import { Icon, useSidebar, useTheme } from "./ui.tsx";
import { LogsPage } from "./pages/Logs.tsx";
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
  { code: "K10", path: "/kayitlar", title: "Kayıtlar", sprint: 6, done: true },
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
        <SideStatus />
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
          <Route path="/kayitlar" element={<LogsPage endpoint="/api/logs" tag="K10" title="Kayıtlar" />} />
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
  // Esc ile kapanır; dışarı tıklamak da kapatır (arka perde).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const usd = s?.socket.lastPrices?.find((p) => p.ccy === "USD");
  const waiting = s ? s.unanswered + s.lateFills + s.awaitingDelivery + s.treasury.pending : 0;

  return (
    <header className="topbar">
      <button className="hamburger" onClick={onMenu} title="Menü" aria-label="Menü">{Icon.menu}</button>

      {/* üst şeritte yalnız iki canlı değer: işlem durumu ve rafineri fiyatı. Ayrıntı ilgili ekranda. */}
      <span className={`state ${s?.trading.open ? "ok" : "bad"}`} title={s?.trading.open ? "fiyat veriliyor" : s?.trading.reason}>
        <span className={`dot ${s?.trading.open ? "ok" : "bad"}`} />
        {s ? (s.trading.open ? "Müşteri işlemleri açık" : "Müşteri işlemleri durdu") : "…"}
      </span>
      <span className="price" title={s?.socket.lastTickTs ? `seq ${s.socket.seq} · ${ageSec(s.socket.lastMsgTs)} sn önce` : "tick yok"}>
        <span className="k">RAFİNERİ</span>
        <span className="mono v">{usd ? `${usd.bid} / ${usd.ask}` : "yok"}</span>
        <span className="k">USD/g</span>
      </span>

      <div className="tspace" />

      <ThemeButton />
      <button className="bell" onClick={() => setOpen((v) => !v)} title="Bildirimler" aria-label="Bildirimler">
        {Icon.bellIcon}
        {s && s.unread > 0 && <span className="n">{s.unread}</span>}
        {waiting > 0 && <span className="n warn" title="cevapsız / geç fill · teslim bekleyen · onay bekleyen">{waiting}</span>}
      </button>
      <UserPicker />

      {open && (
        <>
          <div className="drawer-backdrop" onClick={() => setOpen(false)} />
          <div className="drawer">
            <div className="dhead">
              <b>Bildirimler</b>
              <span className="sp" />
              <button className="ghost" onClick={async () => { await Promise.all(items.filter((n) => !n.read).map((n) => api.markRead(n.id))); setItems((await api.notifications()).items); refresh(); }}>Tümünü okundu</button>
              <button className="ghost" onClick={() => setOpen(false)} aria-label="Kapat">✕</button>
            </div>
            {items.length === 0 && <div className="item">Bildirim yok</div>}
            {items.map((n) => {
              const to = noticeRoute(n.type);
              return (
                <div key={n.id} className={`item ${n.read ? "" : "unread"}`}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div><b>{n.title}</b></div>
                    {n.body && <div className="small">{n.body}</div>}
                    <div className="t">{new Date(n.ts).toLocaleString("tr-TR")}</div>
                    <div className="row" style={{ marginTop: 6 }}>
                      {to && <Link to={to.path} onClick={async () => { if (!n.read) { await api.markRead(n.id); refresh(); } setOpen(false); }}><button className="primary">{to.label}</button></Link>}
                      {!n.read && <button className="ghost" onClick={async () => { await api.markRead(n.id); setItems((await api.notifications()).items); refresh(); }}>Okundu</button>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      <span className="sse-hidden" hidden>{sse ? "" : ""}</span>
    </header>
  );
}

/** Bildirimi ilgili ekrana bağlar: "okundu" demek yerine işi yapılacak yere götürür. */
function noticeRoute(type: string): { path: string; label: string } | null {
  if (type.startsWith("approval")) return { path: "/parametreler", label: "Onaya git (K9)" };
  if (type.startsWith("account") || type.startsWith("debug")) return { path: "/hesaplar", label: "Hesaplara git (K2)" };
  if (type.startsWith("mint") || type.startsWith("vault") || type.startsWith("burn")) return { path: "/kasa", label: "Kasa talimatlarına git (K4)" };
  if (type.startsWith("settlement")) return { path: "/mahsuplasma", label: "Mahsuplaşmaya git (K8)" };
  if (type.startsWith("delivery")) return { path: "/teslimat", label: "Teslimata git (K6)" };
  if (type.startsWith("refining") || type.startsWith("catalog")) return { path: "/rafinasyon", label: "Rafinasyona git (K7)" };
  if (type.startsWith("treasury")) return { path: "/hazine", label: "Hazine alım satımına git (K5)" };
  if (type.startsWith("order")) return { path: "/emirler", label: "Emir günlüğüne git (K3)" };
  if (type.startsWith("trading") || type.startsWith("socket") || type.startsWith("price")) return { path: "/", label: "Bağlantı ve fiyata git (K1)" };
  return null;
}

function UserPicker() {
  const [u, setU] = useState(currentUser.name);
  const initials = u.slice(0, 2).toUpperCase();
  return (
    <label className="user" title="Aktif kullanıcı: aksiyonlar bu adla günlüğe yazılır">
      <span className="avatar">{initials}</span>
      <select value={u} onChange={(e) => { setCurrentUser(e.target.value); setU(e.target.value); }}>
        {KZ_USERS.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
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

/**
 * Yan menünün altındaki sabit durum satırları.
 *
 * Bağlantı ve kontroller üst şeritte değil burada durur: her ekranda görünür, yer kaplamaz
 * ve üst şerit gerçekten günlük işe (fiyat, işlem durumu, bildirim, kullanıcı) kalır.
 */
function SideStatus() {
  const live = useLive();
  const s = live.status;
  const sock = s?.socket;
  const ok = sock?.connection === "SUBSCRIBED" && !sock?.stale;
  const match = s?.record.match;
  return (
    <div className="side-status">
      <div className="srow" title={sock?.url}>
        <span className={`dot ${ok ? "ok" : sock?.connection === "DISCONNECTED" ? "bad" : "warn"}`} />
        <span className="label">{ok ? "Rafineri soketi bağlı" : sock?.stale ? "Fiyat bayat" : "Rafineri soketi kopuk"}</span>
      </div>
      <div className="srow" title="KZ kaydı ile rafineri bakiye bilgisinin eşleşmesi ve kontroller">
        <span className={`dot ${match === "EŞİT" ? "ok" : match === "RECONCILE" ? "bad" : "warn"}`} />
        <span className="label">Eşleşme {match ?? "…"} · K1 {s?.checks.k1.ok ? "✓" : "✗"} · K2 {s?.checks.k2.ok ? "✓" : "✗"}</span>
      </div>
      <div className="srow" title="sunucudan canlı akış (SSE)">
        <span className={`dot ${live.connected ? "ok" : "warn"}`} />
        <span className="label">Canlı akış {live.connected ? "açık" : "kapalı"}</span>
      </div>
    </div>
  );
}
