import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtG, fmtMoney, STL_STATUS_TR, type CustomerOrder, type KzSettlement, type useLive } from "../api.ts";
import { nextAction, steps } from "../settlementFlow.ts";

type Live = ReturnType<typeof useLive>;

/**
 * K1 Genel bakış: rafineri tarafındaki R1'in karşılığı.
 * Günün durumu tek bakışta: müşteri işlemleri, rafineri ve müşteri fiyatı, iki hesabın KZ kaydı ve
 * eşleşmesi, bugünkü emirler, bekleyen işler, mahsuplaşma. Her kart ilgili ekrana götürür;
 * bu ekranda aksiyon yoktur, aksiyon ilgili ekrandadır.
 */
export function K1Overview({ live }: { live: Live }) {
  const s = live.status;
  const r = s?.record;
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [stl, setStl] = useState<KzSettlement | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [docs, setDocs] = useState(0);
  useEffect(() => {
    api.orders(300).then((d) => setOrders(d.items)).catch(() => {});
    api.settlements().then((x) => setStl(x.open)).catch(() => {});
    api.approvals().then((a) => setPendingApprovals(a.pending.length)).catch(() => {});
    api.documents().then((d) => setDocs(d.count)).catch(() => {});
  }, [live.version]);

  const today = new Date().toISOString().slice(0, 10);
  const todays = orders.filter((o) => o.ts.slice(0, 10) === today);
  const filled = todays.filter((o) => o.status === "FILLED");
  const mg = (side: "BUY" | "SELL") => filled.filter((o) => o.side === side).reduce((a, o) => a + o.qty_mg, 0);
  const usd = s?.quotes.find((q) => q.ccy === "USD");
  const waiting = (s?.unanswered ?? 0) + (s?.lateFills ?? 0) + (s?.awaitingDelivery ?? 0) + (s?.treasury.pending ?? 0) + (s?.vault.awaiting_mint ?? 0) + (s?.fulfilment.awaiting_approval ?? 0) + pendingApprovals;
  const v = r ? r.vault.in_vault_mg + r.vault.placing_mg + r.vault.shipping_mg : 0;

  return (
    <div>
      <span className="tag">K1</span>
      <h1>Genel bakış</h1>
      <p className="sub">Günün durumu tek bakışta: müşteri işlemleri, fiyat, iki hesabın Kanzasset kaydı ve rafineriyle eşleşmesi, bugünkü emirler, bekleyen işler ve mahsuplaşma. Kartlar ilgili ekrana götürür.</p>

      <div className="grid c3">
        <Link to="/fiyat" className="card">
          <h2>Müşteri işlemleri</h2>
          <div className="status"><span className={`dot ${s?.trading.open ? "ok" : "bad"}`} />{s ? (s.trading.open ? "Açık" : "Durdu") : "…"}</div>
          <div className="small" style={{ marginTop: 6 }}>{s?.trading.open ? "müşteriye fiyat veriliyor" : s?.trading.reason}</div>
          <div className="small">rafineri soketi {s?.socket.connection === "SUBSCRIBED" ? (s.socket.stale ? "bağlı, fiyat bayat" : "bağlı") : "kopuk"} · yayın {s?.socket.tradable ? "açık" : "durdu"}</div>
        </Link>

        <Link to="/fiyat" className="card kpi">
          <h2>Fiyat (USD, gram)</h2>
          <div className="n">{usd ? `${usd.refineryBid} / ${usd.refineryAsk}` : "…"}</div>
          <div className="small" style={{ marginTop: 6 }}>rafineri alış / satış · sıra {s?.socket.seq ?? 0}</div>
          <div className="small">müşteri satar {usd?.clientSell ?? "…"} · alır {usd?.clientBuy ?? "…"} · marj %{s ? (s.pricing.marginBps / 100).toFixed(2) : "…"} gömülü</div>
        </Link>

        <Link to="/cari" className="card kpi">
          <h2>Cari hesap (KZ kaydı)</h2>
          <div className="n">{fmtG(v)} g</div>
          <div className="small" style={{ marginTop: 6 }}>kasa hesabı · kasada {r ? fmtG(r.vault.in_vault_mg) : 0} · konuluyor {r ? fmtG(r.vault.placing_mg) : 0} · sevkiyatta {r ? fmtG(r.vault.shipping_mg) : 0}</div>
          <div className="small">cari hesap {r ? `${r.current_account.gold_mg >= 0 ? "+" : ""}${fmtG(r.current_account.gold_mg)} g` : "…"} · {r?.current_account.money.map((m) => `${m.ccy} ${fmtMoney(m.cents)}`).join(" · ")}</div>
          <div className="small" style={{ marginTop: 4 }}>
            eşleşme <span className={`pill ${r?.match === "EŞİT" ? "ok" : r?.match === "RECONCILE" ? "bad" : "warn"}`}>{r?.match ?? "…"}</span> · K1 {s?.checks.k1.ok ? "✓" : "✗"} · K2 {s?.checks.k2.ok ? "✓" : "✗"}
          </div>
        </Link>

        <Link to="/emirler" className="card kpi">
          <h2>Bugünkü emirler</h2>
          <div className="n">{todays.length}</div>
          <div className="small" style={{ marginTop: 6 }}>gerçekleşen alış {filled.filter((o) => o.side === "BUY").length} emir · {fmtG(mg("BUY"))} g · satış {filled.filter((o) => o.side === "SELL").length} emir · {fmtG(mg("SELL"))} g</div>
          <div className="small">reddedilen {todays.filter((o) => o.status === "REJECTED").length} · iptal {todays.filter((o) => o.status === "CANCELLED").length}</div>
        </Link>

        <Link to="/kasa" className="card kpi">
          <h2>Bekleyen işler</h2>
          <div className="n" style={{ color: waiting > 0 ? "var(--warn)" : undefined }}>{waiting}</div>
          <div className="small" style={{ marginTop: 6 }}>
            ikinci onay {pendingApprovals} · cevapsız emir {s?.unanswered ?? 0} · geç fill {s?.lateFills ?? 0} · teslim bekleyen {s?.awaitingDelivery ?? 0}
          </div>
          <div className="small">mint bekleyen {s?.vault.awaiting_mint ?? 0} · kasa talimatı açık {s?.vault.open ?? 0} · hazine onayı {s?.treasury.pending ?? 0} · teklif onayı {s?.fulfilment.awaiting_approval ?? 0}</div>
          {s?.vault.mint_block && <div className="small" style={{ color: "var(--bad)", marginTop: 4 }}>mint bloke: {s.vault.mint_block}</div>}
        </Link>

        <Link to="/mahsuplasma" className="card">
          <h2>Mahsuplaşma</h2>
          {stl ? (
            <>
              <div className="status"><span className={`dot ${stl.status === "MISMATCH" ? "bad" : stl.status === "SETTLED" ? "ok" : "warn"}`} />{STL_STATUS_TR[stl.status] ?? stl.status}</div>
              <div className="small" style={{ marginTop: 6 }}>adım {steps(stl).filter((x) => x.state === "done").length}/5 · {nextAction(stl).title}</div>
            </>
          ) : (
            <>
              <div className="status"><span className="dot" />Açık pencere yok</div>
              <div className="small" style={{ marginTop: 6 }}>Rafineri kesim saatinde açar; erken netleşmek için Mahsuplaşma ekranından talep edin.</div>
            </>
          )}
        </Link>

        <Link to="/belgeler" className="card kpi">
          <h2>Belgeler</h2>
          <div className="n">{docs}</div>
          <div className="small" style={{ marginTop: 6 }}>rafineriden alınan ve Kanzasset'te saklanan belge kopyası (fiş, teklif, ekstre, Tahsis Belgesi)</div>
        </Link>

        <Link to="/cari" className="card">
          <h2>Kontroller</h2>
          <div className="small"><b>K1</b> {s?.checks.k1.text} <span className={`pill ${s?.checks.k1.ok ? "ok" : "bad"}`}>{s?.checks.k1.ok ? "sağlanıyor" : "bozuk"}</span></div>
          <div className="small" style={{ marginTop: 4 }}><b>K2</b> {s?.checks.k2.text} <span className={`pill ${s?.checks.k2.ok ? "ok" : "bad"}`}>{s?.checks.k2.ok ? "sağlanıyor" : "bozuk"}</span></div>
          <div className="small" style={{ marginTop: 4 }}>müşteride dolaşan C {fmtG(s?.checks.c_mg ?? 0)} g · emanet E {fmtG(s?.checks.e_mg ?? 0)} g</div>
        </Link>
      </div>
    </div>
  );
}
