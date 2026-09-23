import { useEffect, useState } from "react";
import { api, fmtDT, fmtG, VAULT_STATUS_TR, VAULT_TRIGGER_TR, type VaultInstruction, type VaultStatementDoc, type VaultView, type useLive } from "../api.ts";
import { Pager, usePager } from "../components/Pager.tsx";

type Live = ReturnType<typeof useLive>;

/**
 * K4 Kasa talimatları (Akışlar 05, 06).
 * Sıra kuraldır: girişte fiş önce mint sonra, çıkışta burn önce talep sonra. Böylece A ≤ V hiç bozulmaz.
 * Mint yalnız Kasa Giriş Fişi'ne karşı yapılır; RECONCILE ve T+3 gecikmesi mint'i bloke eder.
 */
export function K4Vault({ live }: { live: Live }) {
  const [v, setV] = useState<VaultView | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState<VaultInstruction | null>(null);
  const [stmt, setStmt] = useState<VaultStatementDoc | null>(null);
  const [form, setForm] = useState({ type: "IN" as "IN" | "OUT", qty: "", reason: "" });

  const load = () => api.vault(300).then(setV).catch((e) => setMsg(`Hata: ${e.message}`));
  useEffect(() => { load(); }, [live.version]);

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key); setMsg("");
    try { const r = await fn(); setMsg(typeof r === "string" ? r : done); await load(); live.refresh(); }
    catch (e) { setMsg(`Hata: ${(e as Error).message}`); }
    finally { setBusy(""); }
  };

  const capPct = v && v.placing_cap_mg > 0 ? v.committed_placing_mg / v.placing_cap_mg : 0;

  const pItems = usePager(v?.items ?? [], 10);
  return (
    <div>
      <span className="tag">K4</span>
      <h1>Kasa hesabı</h1>
      <p className="sub">Kasa hesabına gram girişi ve çıkışı yalnız bu taleplerle olur. Girişte önce rafinerinin Kasa Giriş Fişi gelir, sonra mint yapılır; çıkışta önce burn yapılır, sonra talep gönderilir. Bu sıra sayesinde arz hiçbir an kasadaki gramı aşmaz (K1). Mint yalnız fişe karşıdır (K4); eşleşme uyuşmazlığında ve kasaya koyma vadesi geçtiğinde mint bloke olur. Talepler 07, 08, 09 ve 12'den kendiliğinden gelir; elle talimat yalnız yönetici işidir ve gerekçe ister.</p>

      <div className="grid c3" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>Mint durumu</h2>
          <div className="status"><span className={`dot ${v?.mint_block ? "bad" : "ok"}`} />{v?.mint_block ? "Bloke" : "Açık"}</div>
          <div className="small" style={{ marginTop: 6 }}>{v?.mint_block ?? "mint yalnız Kasa Giriş Fişi'ne karşı yapılır"}</div>
          {(v?.awaiting_mint.length ?? 0) > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="small"><b>{v!.awaiting_mint.length}</b> fiş mint bekliyor: {v!.awaiting_mint.map((i) => `${i.ref} (${fmtG(i.qty_mg)} g)`).join(", ")}</div>
              <button className="primary" style={{ marginTop: 6 }} disabled={!!v?.mint_block || busy === "flush"} onClick={() => act("flush", () => api.flushMints(), "Bekleyen mint'ler işlendi.")}>Bekleyen mint'leri işle</button>
            </div>
          )}
        </div>
        <div className="card">
          <h2>Kasa çıkışı</h2>
          <div className="status"><span className={`dot ${v?.vault_out_block ? "bad" : "ok"}`} />{v?.vault_out_block ? "Bloke" : "Açık"}</div>
          <div className="small" style={{ marginTop: 6 }}>{v?.vault_out_block ?? "burn kasa çıkışı talebinden önce yapılır"}</div>
        </div>
        <div className="card">
          <h2>Kasaya konuluyor tavanı</h2>
          <div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{fmtG(v?.committed_placing_mg ?? 0)} / {fmtG(v?.placing_cap_mg ?? 0)} g</div>
          <Bar pct={capPct} text={`yerleşmiş ${fmtG(v?.placing_mg ?? 0)} g · yolda ${fmtG(v?.in_flight_mg ?? 0)} g`} />
          <div className="small" style={{ marginTop: 6 }}>Tavan aşılacaksa yeni kasa girişi talebi durur; alım devam eder, gramlar cari hesapta birikir ve cari hesap limiti (K3) izler.</div>
        </div>
      </div>

      {msg && <div className="note" style={{ marginBottom: 12 }}>{msg}</div>}

      {(v?.holds.length ?? 0) > 0 && (
        <section className="card" style={{ marginBottom: 14 }}>
          <h2>Duran talepler</h2>
          <table className="wide">
            <thead><tr><th>Referans</th><th>Tür</th><th className="num">Gram</th><th>Sebep</th><th>Aksiyon</th></tr></thead>
            <tbody>
              {v?.holds.map((i) => (
                <tr key={i.ref}>
                  <td className="mono small">{i.ref}</td>
                  <td>{i.type === "IN" ? "Giriş" : "Çıkış"}</td>
                  <td className="num mono">{fmtG(i.qty_mg)}</td>
                  <td className="small">{i.hold_reason}</td>
                  <td>{i.type === "IN" && <button className="primary" disabled={busy === i.ref} onClick={() => act(i.ref, () => api.vaultRetry(i.ref), `${i.ref}: yeniden gönderildi.`)}>Yeniden dene</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card" style={{ marginBottom: 14 }}>
        <h2>Talimatlar</h2>
        <table className="wide">
          <thead><tr><th>Zaman</th><th>Referans</th><th>Tür</th><th className="num">Gram</th><th>Tetik</th><th>Durum</th><th>Fiş</th><th>Mint / burn</th><th></th></tr></thead>
          <tbody>
            {(v?.items.length ?? 0) === 0 && <tr><td colSpan={9} className="small">Talimat yok</td></tr>}
            {pItems.slice.map((i) => (
              <tr key={i.ref}>
                <td className="mono">{fmtDT(i.created_ts)}</td>
                <td className="mono small">{i.ref}</td>
                <td>{i.type === "IN" ? "Giriş" : "Çıkış"}</td>
                <td className="num mono">{fmtG(i.qty_mg)}</td>
                <td className="small">{VAULT_TRIGGER_TR[i.trigger] ?? i.trigger}</td>
                <td>
                  <span className={`pill ${i.status === "PLACED" || i.status === "ACCEPTED" ? "ok" : i.status === "REJECTED" || i.status === "OVERDUE" || i.status === "ERROR" ? "bad" : ""}`}>{VAULT_STATUS_TR[i.status] ?? i.status}</span>
                  {(i.reject_reason ?? i.hold_reason) && <div className="small" style={{ marginTop: 4, opacity: .8 }}>{i.reject_reason ?? i.hold_reason}</div>}
                </td>
                <td className="mono small">{i.doc_id ?? ""}</td>
                <td className="mono small">{i.minted ? `mint ${i.mint_tx}` : i.burned ? `burn ${i.burn_tx}` : i.doc_id && i.type === "IN" ? "mint bekliyor" : ""}</td>
                <td><button className="ghost" onClick={() => setOpen(i)}>Zincir</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager p={pItems} label="Talimatlar" />
      </section>

      <div className="grid c2">
        <section className="card">
          <h2>Elle kasa talimatı</h2>
          <p className="small">Yalnız yönetici; gerekçe zorunlu ve denetim izinde kalır. Olağan talepler büyük alış / satış, hazine alım satımı ve mahsuplaşma zincirlerinden kendiliğinden gelir.</p>
          <p className="small">Kural: <b>kasa girişi</b> cari hesap altınından (T) büyük olamaz, şu an {fmtG(v?.record.current_account.gold_mg ?? 0)} g. <b>Kasa çıkışı</b> yalnız "kasada" duran gramdan yapılır ({fmtG(v?.record.vault.in_vault_mg ?? 0)} g), "kasaya konuluyor" sayılmaz ve önce token yakılır.</p>
          <div className="row">
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as "IN" | "OUT" })}>
              <option value="IN">Kasa girişi</option>
              <option value="OUT">Kasa çıkışı (önce burn)</option>
            </select>
            <input placeholder="gram (ör. 5947.640)" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <input className="wide" placeholder="gerekçe (zorunlu)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            <button className="primary" disabled={!form.qty || !form.reason.trim() || busy === "manual"} onClick={() => act("manual", async () => {
              const mg = Math.round(Number(form.qty.replace(",", ".")) * 1000);
              if (!Number.isFinite(mg) || mg < 1) throw new Error("gram geçersiz");
              const r = await api.vaultManual(form.type, mg, form.reason.trim());
              // rafineri talebi reddedebilir ya da istek hiç gitmeyebilir: sonucu ve sebebini söyle
              const why = r.reject_reason ?? r.hold_reason;
              if (r.status === "ERROR" || r.status === "REJECTED") throw new Error(`talep ${r.status === "ERROR" ? "gönderilemedi" : "reddedildi"}${why ? `: ${why}` : ""}`);
              setForm({ ...form, qty: "", reason: "" });
              return r.status === "HOLD" ? `Talep beklemede (${why ?? "kasaya konuluyor tavanı dolu"}); tavan boşalınca kendiliğinden gönderilir.` : undefined;
            }, "Kasa talimatı gönderildi.")}>Gönder</button>
          </div>
        </section>

        <section className="card">
          <h2>Günlük kasa ekstresi (rafineriden)</h2>
          <p className="small">Rezerv kanıtı: rafinerinin kasa ekstresi ile arzımız karşılaştırılır (V ≥ A). Fark çıkarsa işlem durur ve acil mahsuplaşma çağrılır.</p>
          <button className="primary" onClick={() => act("stmt", async () => setStmt(await api.vaultStatement()), "Ekstre alındı.")}>Bugünün ekstresini çek</button>
          {stmt && (
            <div className="kv" style={{ marginTop: 10 }}>
              <span className="k">Tarih</span><span className="mono">{stmt.date}</span>
              <span className="k">Kasada</span><span className="mono">{fmtG(stmt.closing.in_vault_mg)} g</span>
              <span className="k">Kasaya konuluyor</span><span className="mono">{fmtG(stmt.closing.placing_mg)} g</span>
              <span className="k">Sevkiyatta</span><span className="mono">{fmtG(stmt.closing.shipping_mg)} g</span>
              <span className="k">Toplam V</span><span className="mono">{fmtG(stmt.total_mg)} g</span>
              <span className="k">Arz A</span><span className="mono">{fmtG(v?.record.stock.a_mg ?? 0)} g</span>
              <span className="k">V ≥ A</span><span><span className={`pill ${stmt.total_mg >= (v?.record.stock.a_mg ?? 0) ? "ok" : "bad"}`}>{stmt.total_mg >= (v?.record.stock.a_mg ?? 0) ? "EVET" : "HAYIR"}</span></span>
              <span className="k">Fişler</span><span className="mono small">{stmt.slips.map((x) => x.doc_id).join(", ") || "yok"}</span>
            </div>
          )}
        </section>
      </div>

      {open && (
        <div className="modal-bg" onClick={() => setOpen(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{open.ref} · {open.type === "IN" ? "Kasa girişi" : "Kasa çıkışı"} {fmtG(open.qty_mg)} g</h3>
            <div className="kv">
              <span className="k">Tetik</span><span>{VAULT_TRIGGER_TR[open.trigger] ?? open.trigger}</span>
              <span className="k">Durum</span><span>{VAULT_STATUS_TR[open.status] ?? open.status}</span>
              <span className="k">Rafineri talep no</span><span className="mono small">{open.request_id ?? "yok"}</span>
              <span className="k">Fiş</span><span className="mono small">{open.doc_id ?? "yok"}</span>
              <span className="k">Mint</span><span className="mono small">{open.mint_tx ?? (open.type === "IN" ? "yapılmadı" : "yok")}</span>
              <span className="k">Burn</span><span className="mono small">{open.burn_tx ?? (open.type === "OUT" ? "yapılmadı" : "yok")}</span>
              <span className="k">Vade (T+3)</span><span className="mono small">{open.due_ts ? fmtDT(open.due_ts) : "yok"}</span>
              <span className="k">İlgili</span><span className="mono small">{open.related_id ?? "yok"}</span>
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

function Bar({ pct, text }: { pct: number; text: string }) {
  const p = Math.min(100, Math.round(pct * 1000) / 10);
  const color = pct >= 1 ? "var(--bad)" : pct >= 0.8 ? "var(--warn)" : "var(--ok)";
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ height: 6, background: "var(--soft2)", borderRadius: 99 }}><div style={{ width: `${p}%`, height: 6, background: color, borderRadius: 99 }} /></div>
      <div className="small" style={{ marginTop: 4 }}>{text}</div>
    </div>
  );
}
