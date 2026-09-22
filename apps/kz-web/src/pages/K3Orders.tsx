import { useEffect, useState } from "react";
import { api, fmtDT, fmtG, fmtMoney, fmtTime, FLOW_TR, ORDER_TR, REJECT_TR, type Ccy, type CustomerOrder, type useLive } from "../api.ts";
import { Pager, usePager } from "../components/Pager.tsx";

type Live = ReturnType<typeof useLive>;
const today = () => new Date().toISOString().slice(0, 10);
const sameDay = (iso: string, day: string) => !day || iso.slice(0, 10) === day;

/**
 * K3 Emirler: rafineri tarafındaki R3'ün karşılığı, aynı düzen.
 * Üstte günün özeti, sonra süzgeçli ve sayfalı liste, altta bekleyen işler (cevapsız / geç fill) ve deneme emri.
 * Müşteri emri ile rafineri emri birebir eşlenir (müşteri emri numarası iki tarafta aynıdır).
 */
export function K3Orders({ live }: { live: Live }) {
  const s = live.status;
  const [data, setData] = useState<{ items: CustomerOrder[]; unanswered: CustomerOrder[]; lateFills: CustomerOrder[] } | null>(null);
  const [sel, setSel] = useState<CustomerOrder | null>(null);
  const [day, setDay] = useState(today());
  const [sideF, setSideF] = useState("");
  const [statusF, setStatusF] = useState("");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [grams, setGrams] = useState("70,104");
  const [ccy, setCcy] = useState<Ccy>("USD");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = () => api.orders(300).then((d) => { setData(d); if (sel) setSel(d.items.find((o) => o.id === sel.id) ?? sel); }).catch(console.warn);
  useEffect(() => { load(); }, [live.version]);

  const qtyMg = Math.round(Number(grams.replace(",", ".")) * 1000);
  const q = s?.quotes.find((x) => x.ccy === ccy);
  const preview = q && qtyMg > 0 ? (() => {
    const px = side === "BUY" ? q.clientBuy : q.clientSell;
    const amount = Math.round(Math.round(Number(px) * 100) * qtyMg / 1000);
    const commission = Math.round(amount * q.commissionBps / 10_000);
    return { px, amount, commission, total: side === "BUY" ? amount + commission : amount - commission };
  })() : null;

  const place = async () => {
    setBusy(true); setMsg("");
    try { const o = await api.placeOrder({ side, qty_mg: qtyMg, ccy, customer_ref: "musteri-demo" }); setMsg(`${o.id}: ${ORDER_TR[o.status] ?? o.status}`); await load(); setSel(o); }
    catch (e) { setMsg(`Hata: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };
  const decide = async (id: string, d: "CLOSE" | "CARRY") => { setBusy(true); try { await api.decide(id, d); await load(); } catch (e) { setMsg(`Hata: ${(e as Error).message}`); } finally { setBusy(false); } };

  const all = data?.items ?? [];
  const todays = all.filter((o) => sameDay(o.ts, today()));
  const count = (st: string, sd?: string) => todays.filter((o) => o.status === st && (!sd || o.side === sd)).length;
  const list = all.filter((o) => sameDay(o.ts, day) && (!sideF || o.side === sideF) && (!statusF || o.status === statusF));
  const filled = list.filter((o) => o.status === "FILLED");
  const sumMg = (sd: "BUY" | "SELL") => filled.filter((o) => o.side === sd).reduce((a, o) => a + o.qty_mg, 0);
  const p = usePager(list, 20, `${day}|${sideF}|${statusF}`);
  const waiting = (data?.unanswered.length ?? 0) + (data?.lateFills.length ?? 0);

  return (
    <div>
      <span className="tag">K3</span>
      <h1>Emirler</h1>
      <p className="sub">Müşteri emri ile rafineri emri birebir eşlenir (müşteri emri numarası iki tarafta aynıdır). Stoktan alış: bloke → rafineride alış → teslim → tahsilat. Stoktan satış: AGOLD bloke → rafineride satış → önce ödeme → token stoğa. Zaman sınırında cevap yoksa durum sorgusu, açıksa iptal; geç fill pozisyon kararı ister.</p>

      <div className="grid c3" style={{ marginBottom: 14 }}>
        <div className="card"><h2>Bugün</h2><div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{todays.length} emir</div><div className="small">gerçekleşen alış {count("FILLED", "BUY")} · satış {count("FILLED", "SELL")} · red {count("REJECTED")}{waiting ? ` · bekleyen ${waiting}` : ""}</div></div>
        <div className="card"><h2>Listedeki alışlar</h2><div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{fmtG(sumMg("BUY"))} g</div><div className="small">müşteri AGOLD aldı → rafineriden alındı, T artar, P azalır (rafineriye borçluyuz)</div></div>
        <div className="card"><h2>Listedeki satışlar</h2><div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{fmtG(sumMg("SELL"))} g</div><div className="small">müşteri AGOLD sattı → rafineriye satıldı, T azalır, P artar (rafineri borçlu)</div></div>
      </div>

      <section className="card">
        <h2>Emir listesi</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <label className="small">Gün <input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></label>
          <label className="small">Yön <select value={sideF} onChange={(e) => setSideF(e.target.value)}><option value="">hepsi</option><option value="BUY">alış</option><option value="SELL">satış</option></select></label>
          <label className="small">Durum <select value={statusF} onChange={(e) => setStatusF(e.target.value)}><option value="">hepsi</option><option value="FILLED">gerçekleşti</option><option value="REJECTED">reddedildi</option><option value="CANCELLED">iptal</option><option value="UNANSWERED">cevapsız</option><option value="LATE_FILL">geç fill</option><option value="SENT">gönderildi (bekliyor)</option></select></label>
          <button className="ghost" onClick={() => { setDay(""); setSideF(""); setStatusF(""); }}>Temizle</button>
          <span className="small" style={{ marginLeft: "auto" }}>{list.length} kayıt</span>
        </div>
        <table>
          <thead><tr><th>Zaman</th><th>Müşteri emri no</th><th>Yön</th><th className="num">Gram</th><th>Kur</th><th className="num">Müşteri fiyatı</th><th className="num">Müşteri toplamı</th><th className="num">Gerçekleşme</th><th className="num">Marj</th><th>Akış</th><th>Rafineri</th><th>Müşteri</th><th>Eşleşme</th></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={13} className="small">Kayıt yok</td></tr>}
            {p.slice.map((o) => (
              <tr key={o.id} onClick={() => setSel(o)} style={{ cursor: "pointer", background: sel?.id === o.id ? "var(--sel)" : undefined }}>
                <td className="mono">{fmtTime(o.ts)}</td>
                <td className="mono">{o.id}</td>
                <td>{o.side === "BUY" ? <span className="pill ok">ALIŞ</span> : <span className="pill warn">SATIŞ</span>}</td>
                <td className="num">{fmtG(o.qty_mg)}</td>
                <td>{o.ccy}</td>
                <td className="num">{o.client_px}</td>
                <td className="num">{fmtMoney(o.client_total_cents)}</td>
                <td className="num">{o.refinery?.fill?.px ?? ""}</td>
                <td className="num">{o.margin_cents !== undefined ? fmtMoney(o.margin_cents) : ""}</td>
                <td className="small">{o.flow ? FLOW_TR[o.flow] ?? o.flow : ""}{o.chain_mg ? <><br /><span className="mono small">{fmtG(o.chain_mg)} g</span></> : null}</td>
                <td><Pill o={o} /></td>
                <td className="small">{o.customer_status}</td>
                <td>{o.match ? <span className={`pill ${o.match === "EŞİT" ? "ok" : "bad"}`}>{o.match}</span> : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager p={p} label="Emirler" />
      </section>

      <div className="grid c2" style={{ marginTop: 14 }}>
        <section className="card">
          <h2>Cevapsız emirler ve geç fill kararları</h2>
          {(data?.unanswered.length ?? 0) === 0 && (data?.lateFills.length ?? 0) === 0 && <div className="small">Bekleyen yok</div>}
          {data?.unanswered.map((o) => (
            <div key={o.id} className="row small" style={{ marginBottom: 6 }}><span className="pill warn">cevapsız</span><span className="mono">{o.id}</span> {o.side === "BUY" ? "ALIŞ" : "SATIŞ"} {fmtG(o.qty_mg)} g <button className="ghost" disabled={busy} onClick={async () => { await api.resolve(o.id); await load(); }}>Sorgula / iptal et</button></div>
          ))}
          {data?.lateFills.map((o) => (
            <div key={o.id} className="row small" style={{ marginBottom: 6 }}>
              <span className="pill bad">geç fill</span><span className="mono">{o.id}</span> {o.side === "BUY" ? "ALIŞ" : "SATIŞ"} {fmtG(o.qty_mg)} g @ {o.refinery?.fill?.px}
              <button disabled={busy} onClick={() => decide(o.id, "CLOSE")}>Ters emirle kapat</button>
              <button disabled={busy} onClick={() => decide(o.id, "CARRY")}>Envanterde taşı</button>
            </div>
          ))}
          <p className="small" style={{ marginTop: 8 }}>Kapat: aynı gramı ters yönde rafineriye satar / alır, fark kâr zarar. Taşı: gram envanterde kalır, hedef K o kadar değişir.</p>
        </section>
        <section className="card">
          <h2>Deneme emri (müşteri ekranı yerine)</h2>
          <div className="row">
            <select value={side} onChange={(e) => setSide(e.target.value as "BUY" | "SELL")}><option value="BUY">Müşteri AGOLD alır (stoktan alış)</option><option value="SELL">Müşteri AGOLD satar (stoktan satış)</option></select>
            <input style={{ width: 110 }} value={grams} onChange={(e) => setGrams(e.target.value)} /> <span className="small">g</span>
            <select value={ccy} onChange={(e) => setCcy(e.target.value as Ccy)}><option>USD</option><option>EUR</option><option>AED</option></select>
            <button className="primary" disabled={busy || !s?.trading.open || !preview} onClick={place}>Emri gönder</button>
          </div>
          <div className="small" style={{ marginTop: 8 }}>
            {!s?.trading.open ? `müşteri işlemleri kapalı: ${s?.trading.reason ?? ""}` : preview ? `müşteri fiyatı ${preview.px} ${ccy} · bedel ${fmtMoney(preview.amount)} · komisyon ${fmtMoney(preview.commission)} · ${side === "BUY" ? "bloke" : "ödenecek"} ${fmtMoney(preview.total)} ${ccy} · rafineri ${side === "BUY" ? "satış" : "alış"} fiyatı ${side === "BUY" ? q?.refineryAsk : q?.refineryBid} · kayma payı %${((s?.orderParams.slippageBps ?? 100) / 100).toFixed(2)} · zaman sınırı ${s?.orderParams.timeLimitMs ?? 3000} ms` : "miktar gir"}
          </div>
          {msg && <div className="small" style={{ marginTop: 6 }}>{msg}</div>}
        </section>
      </div>

      {sel && (
        <section className="card" style={{ marginTop: 14 }}>
          <div className="row"><h2 style={{ margin: 0 }}>Emir detayı · {sel.id}</h2><button className="ghost" style={{ marginLeft: "auto" }} onClick={() => setSel(null)}>Kapat</button></div>
          <div className="grid c2" style={{ marginTop: 10 }}>
            <div>
              <div className="kv">
                <span className="k">Müşteri</span><span>{sel.customer_ref} · {sel.side === "BUY" ? "AGOLD alır" : "AGOLD satar"} · {fmtG(sel.qty_mg)} g · {sel.ccy}</span>
                <span className="k">Müşteri fiyatı</span><span className="mono">{sel.client_px} (marj gömülü) · bedel {fmtMoney(sel.client_amount_cents)} · komisyon {fmtMoney(sel.commission_cents)} · toplam {fmtMoney(sel.client_total_cents)}</span>
                <span className="k">Rafineri emri</span><span className="mono">fiyat sırası {sel.quote_seq} · rafineri {sel.side === "BUY" ? "satış" : "alış"} fiyatı {sel.refinery_quote_px} · limit {sel.limit_px} · ya hep ya hiç</span>
                <span className="k">Sonuç</span><span><Pill o={sel} /> {sel.reject_reason ? REJECT_TR[sel.reject_reason] ?? sel.reject_reason : ""}{sel.error ?? ""}{sel.refinery?.fill ? ` · fill ${sel.refinery.fill.px} · bedel ${fmtMoney(sel.refinery.fill.amount_cents)} ${sel.ccy}` : ""}</span>
                {sel.margin_cents !== undefined && (<><span className="k">Gerçekleşen marj</span><span className="mono">{fmtMoney(sel.margin_cents)} {sel.ccy}</span></>)}
                {sel.refinery?.allocation_certificate && (<><span className="k">Tahsis Belgesi</span><span className="mono">{sel.refinery.allocation_certificate.doc_id}</span></>)}
                {sel.decision && (<><span className="k">Pozisyon kararı</span><span>{sel.decision === "CLOSE" ? `ters emirle kapatıldı (${sel.decision_order_id})` : "envanterde taşındı"}</span></>)}
              </div>
            </div>
            <div>
              <h2>Zaman çizelgesi</h2>
              {sel.timeline.map((t, i) => <div key={i} className="small" style={{ marginBottom: 3 }}><span className="mono">{fmtDT(t.ts).slice(11)}</span> · {t.text}</div>)}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function Pill({ o }: { o: CustomerOrder }) {
  const cls = o.status === "FILLED" ? "ok" : o.status === "REJECTED" || o.status === "ERROR" || o.status === "LATE_FILL" ? "bad" : o.status === "CANCELLED" ? "neut" : "warn";
  return <span className={`pill ${cls}`}>{ORDER_TR[o.status] ?? o.status}</span>;
}
