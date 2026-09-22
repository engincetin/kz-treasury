import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDT, fmtG, fmtMoney, TREASURY_STATUS_TR, type StockParams, type TreasuryRequest, type useLive } from "../api.ts";
import { Pager, usePager } from "../components/Pager.tsx";

type Live = ReturnType<typeof useLive>;

/**
 * K12 Hazine alım satımı (Akışlar 09).
 * Envanter hedefini (K) değiştirmek için rafineriyle kendi alım satımımız. Maker-checker: talebi hazineci açar,
 * onaycılar onaylar, son onaycı canlı fiyatla gönderir (bağlayıcı fiyat gönderim anındakidir).
 * Alım sermayeden ödenir, müşteri parası asla; satımda yalnız hazine stokundaki tokenler yakılır.
 */
export function K12Treasury({ live }: { live: Live }) {
  const [data, setData] = useState<{ items: TreasuryRequest[]; pending: TreasuryRequest[]; stock: StockParams } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState<TreasuryRequest | null>(null);
  const [form, setForm] = useState({ side: "BUY" as "BUY" | "SELL", qty: "", ccy: "USD" as "USD" | "EUR" | "AED", maker: "hazineci" });
  const [approver, setApprover] = useState("onaycı-1");

  const load = () => api.treasury().then(setData).catch((e) => setMsg(`Hata: ${e.message}`));
  useEffect(() => { load(); }, [live.version]);

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key); setMsg("");
    try { await fn(); setMsg(done); await load(); live.refresh(); }
    catch (e) { setMsg(`Hata: ${(e as Error).message}`); }
    finally { setBusy(""); }
  };

  const s = live.status;
  const rec = s?.record;
  const qtyMg = Math.round(Number((form.qty || "0").replace(",", ".")) * 1000);
  const needed = data ? requiredFor(qtyMg, data.stock) : 0;
  const q = s?.quotes.find((x) => x.ccy === form.ccy);
  const px = form.side === "BUY" ? q?.refineryAsk : q?.refineryBid;
  const amount = px ? Math.round((Math.round(Number(px) * 100) * qtyMg) / 1000) : 0;

  const pItems = usePager(data?.items ?? [], 20);
  return (
    <div>
      <span className="tag">K12</span>
      <h1>Hazine alım satımı</h1>
      <p className="sub">Müşteri emrinden bağımsız olarak envanter hedefini değiştiririz. Alım: alış emri, kasa girişi, mint; hedef artar. Satım: satış emri, burn, kasa çıkışı; hedef azalır. Onay matrisi grama göredir. Son onaycı canlı fiyatla gönderir: gönderim anındaki fiyat bağlayıcıdır. Bedel mahsuplaşmada netleşir. Müşteri emirleri buraya girmez: onlar kendiliğinden gider ve <Link to="/emirler">Emirler</Link> ekranında görünür.</p>

      <div className="grid c3" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>Envanter</h2>
          <div className="kv">
            <span className="k">Hedef K</span><span className="mono">{fmtG(rec?.stock.k_mg ?? 0)} g</span>
            <span className="k">Hazine stoku S</span><span className="mono">{fmtG(rec?.stock.s_mg ?? 0)} g</span>
            <span className="k">Arz A</span><span className="mono">{fmtG(rec?.stock.a_mg ?? 0)} g</span>
            <span className="k">Cari hesap T</span><span className="mono">{fmtG(rec?.current_account.gold_mg ?? 0)} g</span>
          </div>
          <div className="small" style={{ marginTop: 6 }}>{s?.checks.k2.text} {s?.checks.k2.ok ? "✓" : "✗"}</div>
        </div>
        <div className="card">
          <h2>Onay matrisi</h2>
          <div className="kv">
            {data?.stock.approvalMatrix.map((r) => (
              <span key={r.upToMg} style={{ display: "contents" }}><span className="k">≤ {fmtG(r.upToMg)} g</span><span>{r.approvals} onay</span></span>
            ))}
            <span className="k">üstü</span><span>{data?.stock.approvalsAbove ?? 3} onay</span>
          </div>
        </div>
        <div className="card">
          <h2>Stok bandı</h2>
          <div className="kv">
            <span className="k">Taban</span><span className="mono">{fmtG(data?.stock.floorMg ?? 0)} g</span>
            <span className="k">Tavan</span><span className="mono">{fmtG(data?.stock.ceilingMg ?? 0)} g</span>
            <span className="k">Mint politikası</span><span>{data?.stock.mintPolicy === "FULL_ORDER" ? "emrin tamamı" : "eksik kısım"}</span>
          </div>
          <div className="small" style={{ marginTop: 6 }}>Taban altına inen müşteri alışı büyük alıştır (07), tavanı aşan satış büyük satıştır (08).</div>
        </div>
      </div>

      {msg && <div className="note" style={{ marginBottom: 12 }}>{msg}</div>}

      <section className="card" style={{ marginBottom: 14 }}>
        <h2>Talep oluştur (maker)</h2>
        <div className="row">
          <select value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value as "BUY" | "SELL" })}>
            <option value="BUY">Hazine alımı (hedef artar)</option>
            <option value="SELL">Hazine satışı (hedef azalır)</option>
          </select>
          <input placeholder="gram (ör. 20000)" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
          <select value={form.ccy} onChange={(e) => setForm({ ...form, ccy: e.target.value as "USD" })}>
            <option>USD</option><option>EUR</option><option>AED</option>
          </select>
          <input placeholder="hazineci" value={form.maker} onChange={(e) => setForm({ ...form, maker: e.target.value })} />
          <button className="primary" disabled={!qtyMg || busy === "create"} onClick={() => act("create", async () => {
            await api.treasuryCreate({ side: form.side, qty_mg: qtyMg, ccy: form.ccy, maker: form.maker.trim() });
            setForm({ ...form, qty: "" });
          }, "Talep açıldı, onay bekliyor.")}>Talep oluştur</button>
        </div>
        {qtyMg > 0 && (
          <div className="small" style={{ marginTop: 8 }}>
            O anki fiyat {px ?? "yok"} {form.ccy} · tutar {fmtMoney(amount)} {form.ccy} · <b>{needed} onay</b> gerekiyor.
            {form.side === "BUY" ? " Bedel sermayeden ödenir, müşteri parası kullanılmaz." : " Yalnız hazine stokundaki tokenler yakılır."}
          </div>
        )}
      </section>

      <section className="card" style={{ marginBottom: 14 }}>
        <h2>Onay bekleyenler {(data?.pending.length ?? 0) > 0 && <span className="pill">{data!.pending.length}</span>}</h2>
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="small">Onaycı:</span>
          <input placeholder="onaycı adı" value={approver} onChange={(e) => setApprover(e.target.value)} />
          <span className="small">Hazineci kendi talebini onaylayamaz; aynı onaycı iki kez onaylayamaz.</span>
        </div>
        <table>
          <thead><tr><th>Zaman</th><th>Talep</th><th>Yön</th><th className="num">Gram</th><th className="num">Talep anı fiyatı</th><th>Onay</th><th>Aksiyon</th></tr></thead>
          <tbody>
            {(data?.pending.length ?? 0) === 0 && <tr><td colSpan={7} className="small">Onay bekleyen talep yok</td></tr>}
            {data?.pending.map((r) => (
              <tr key={r.id}>
                <td className="mono">{fmtDT(r.created_ts)}</td>
                <td className="mono small">{r.id}<br /><span className="small">maker {r.maker}</span></td>
                <td>{r.side === "BUY" ? "Alım" : "Satım"}</td>
                <td className="num mono">{fmtG(r.qty_mg)}</td>
                <td className="num mono">{r.quoted_px} · {fmtMoney(r.quoted_amount_cents)}</td>
                <td className="small">{r.approvals.length}/{r.required_approvals}<br />{r.approvals.map((a) => a.by).join(", ")}</td>
                <td>
                  <div className="row">
                    <button className="primary" disabled={busy === r.id || !approver.trim()} onClick={() => act(r.id, () => api.treasuryApprove(r.id, approver.trim()), r.approvals.length + 1 >= r.required_approvals ? "Son onay: canlı fiyatla gönderildi." : "Onaylandı.")}>
                      {r.approvals.length + 1 >= r.required_approvals ? "Canlı fiyatla onayla ve gönder" : "Onayla"}
                    </button>
                    <button className="ghost" disabled={busy === r.id} onClick={() => act(r.id, () => api.treasuryCancel(r.id, r.maker), "İptal edildi.")}>İptal</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Talepler</h2>
        <table>
          <thead><tr><th>Zaman</th><th>Talep</th><th>Yön</th><th className="num">Gram</th><th>Durum</th><th className="num">Gerçekleşme</th><th>Kasa talimatı</th><th>Hedef K</th><th></th></tr></thead>
          <tbody>
            {(data?.items.length ?? 0) === 0 && <tr><td colSpan={9} className="small">Talep yok</td></tr>}
            {pItems.slice.map((r) => (
              <tr key={r.id}>
                <td className="mono">{fmtDT(r.created_ts)}</td>
                <td className="mono small">{r.id}</td>
                <td>{r.side === "BUY" ? "Alım" : "Satım"}</td>
                <td className="num mono">{fmtG(r.qty_mg)}</td>
                <td><span className={`pill ${r.status === "TAMAM" ? "ok" : r.status === "REDDEDİLDİ" || r.status === "HATA" ? "bad" : ""}`}>{TREASURY_STATUS_TR[r.status] ?? r.status}</span></td>
                <td className="num mono">{r.fill_px ? `${r.fill_px} · ${fmtMoney(r.fill_amount_cents ?? 0)}` : r.reject_reason ?? ""}</td>
                <td className="mono small">{r.vault_ref ?? ""}</td>
                <td className="mono small">{r.target_after_mg !== undefined ? `${fmtG(r.target_before_mg)} → ${fmtG(r.target_after_mg)}` : fmtG(r.target_before_mg)}</td>
                <td><button className="ghost" onClick={() => setOpen(r)}>Zincir</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager p={pItems} label="Talepler" />
      </section>

      {open && (
        <div className="modal-bg" onClick={() => setOpen(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{open.id} · {open.side === "BUY" ? "Hazine alımı" : "Hazine satışı"} {fmtG(open.qty_mg)} g</h3>
            <div className="kv">
              <span className="k">Durum</span><span>{TREASURY_STATUS_TR[open.status] ?? open.status}</span>
              <span className="k">Hazineci (maker)</span><span>{open.maker}</span>
              <span className="k">Onaylar</span><span>{open.approvals.map((a) => `${a.by} (${fmtDT(a.ts)})`).join(" · ") || "yok"} / {open.required_approvals}</span>
              <span className="k">Talep anı fiyatı</span><span className="mono">{open.quoted_px} · {fmtMoney(open.quoted_amount_cents)} {open.ccy}</span>
              <span className="k">Gönderim (bağlayıcı)</span><span className="mono">{open.fill_px ? `${open.fill_px} · ${fmtMoney(open.fill_amount_cents ?? 0)} ${open.ccy}` : "gönderilmedi"}</span>
              <span className="k">Rafineri emri</span><span className="mono small">{open.order_id ?? "yok"}</span>
              <span className="k">Kasa talimatı</span><span className="mono small">{open.vault_ref ?? "yok"}</span>
              <span className="k">Envanter hedefi</span><span className="mono">{fmtG(open.target_before_mg)} → {open.target_after_mg !== undefined ? fmtG(open.target_after_mg) : "?"} g</span>
            </div>
            <h3 style={{ marginTop: 12 }}>Zaman çizelgesi</h3>
            <table>
              <tbody>
                {open.timeline.map((t, i) => <tr key={i}><td className="mono small" style={{ whiteSpace: "nowrap" }}>{fmtDT(t.ts)}</td><td className="small">{t.text}</td></tr>)}
              </tbody>
            </table>
            <div className="row" style={{ marginTop: 10 }}><button className="ghost" onClick={() => setOpen(null)}>Kapat</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function requiredFor(qtyMg: number, p: StockParams): number {
  for (const row of [...p.approvalMatrix].sort((a, b) => a.upToMg - b.upToMg)) if (qtyMg <= row.upToMg) return row.approvals;
  return p.approvalsAbove;
}
