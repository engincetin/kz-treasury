import { useEffect, useState } from "react";
import { api, fmtDT, DOC_TYPE_TR, type KzDocumentRow, type Doc, type useLive } from "../api.ts";
import { Pager, usePager } from "../components/Pager.tsx";

type Live = ReturnType<typeof useLive>;

/**
 * K12 Belgeler: rafineri tarafındaki R9'un karşılığı.
 * Rafinerinin ürettiği her belgenin Kanzasset kopyası: olayla numara gelir, belge çekilir,
 * özeti yeniden hesaplanır, saklanır. İki taraf aynı belgenin kendi kopyasına sahiptir.
 */
export function K12Documents({ live }: { live: Live }) {
  const [rows, setRows] = useState<KzDocumentRow[]>([]);
  const [q, setQ] = useState({ type: "", text: "" });
  const [doc, setDoc] = useState<Doc | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.documents().then(setRows).catch((e) => setMsg(`Hata: ${(e as Error).message}`));
  useEffect(() => { void load(); }, [live.version]);

  const types = [...new Set(rows.map((r) => r.type))];
  const shown = rows.filter((r) => (!q.type || r.type === q.type) && (!q.text || r.doc_id.toLowerCase().includes(q.text.toLowerCase()) || r.related_id.toLowerCase().includes(q.text.toLowerCase())));
  const p = usePager(shown, 20, `${q.type}|${q.text}`);
  const bad = rows.filter((r) => !r.hash_ok).length;

  return (
    <div>
      <span className="tag">K12</span>
      <h1>Belgeler</h1>
      <p className="sub">Rafinerinin ürettiği belgelerin Kanzasset'teki kopyası: Tahsis Belgesi, Kasa Giriş ve Çıkış Fişi, Lojistik ve Rafinasyon Teklifi, Sevkiyat Fişi, Teslimat Kaydı, ekstreler. Belge numarası olayla gelir, belge çekilir, özeti yeniden hesaplanıp karşılaştırılır ve burada saklanır. Denetimde tek tarafa güvenmek gerekmez.</p>

      <div className="grid c3" style={{ marginBottom: 14 }}>
        <div className="card kpi"><h2>Saklanan belge</h2><div className="n">{rows.length}</div><div className="small">rafineriden alınan kopya</div></div>
        <div className="card kpi"><h2>Özet doğrulaması</h2><div className="n" style={{ color: bad > 0 ? "var(--bad)" : "var(--ok)" }}>{bad === 0 ? "tümü tutuyor" : `${bad} tutmuyor`}</div><div className="small">sha256(içerik) = belge özeti</div></div>
        <div className="card">
          <h2>Eşitle</h2>
          <p className="small">Emir, kasa, teslimat, rafinasyon ve mahsuplaşma kayıtlarındaki bütün belge numaraları taranır, eksik kopyalar rafineriden çekilir.</p>
          <button className="primary" disabled={busy} onClick={async () => { setBusy(true); try { const r = await api.syncDocuments(); setMsg(`${r.fetched} belge çekildi${r.failed.length ? `, ${r.failed.length} çekilemedi` : ""}.`); await load(); } catch (e) { setMsg(`Hata: ${(e as Error).message}`); } finally { setBusy(false); } }}>Belgeleri eşitle</button>
        </div>
      </div>

      {msg && <div className="note" style={{ marginBottom: 12 }}>{msg}</div>}

      <section className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <select value={q.type} onChange={(e) => setQ({ ...q, type: e.target.value })}>
            <option value="">tüm tipler</option>
            {types.map((t) => <option key={t} value={t}>{DOC_TYPE_TR[t] ?? t}</option>)}
          </select>
          <input className="wide" placeholder="belge no ya da ilgili kayıt" value={q.text} onChange={(e) => setQ({ ...q, text: e.target.value })} />
          <button className="ghost" onClick={load}>Yenile</button>
        </div>
        <table>
          <thead><tr><th>Belge no</th><th>Tip</th><th>İlgili kayıt</th><th>Rafineri tarihi</th><th>Alınma</th><th>Kaynak</th><th>Doğrulama</th><th>Aksiyon</th></tr></thead>
          <tbody>
            {p.slice.length === 0 && <tr><td colSpan={8} className="small">Belge yok. Belgeler olaylarla kendiliğinden gelir; eskileri "Belgeleri eşitle" ile çekebilirsiniz.</td></tr>}
            {p.slice.map((r) => (
              <tr key={r.doc_id}>
                <td className="mono small">{r.doc_id}</td>
                <td>{DOC_TYPE_TR[r.type] ?? r.type}</td>
                <td className="mono small">{r.related_id}</td>
                <td className="mono small">{fmtDT(r.created_ts)}</td>
                <td className="mono small">{fmtDT(r.received_ts)}</td>
                <td className="small">{r.source}</td>
                <td>
                  <span className={`pill ${r.hash_ok ? "ok" : "bad"}`}>{r.hash_ok ? "özet tutuyor" : "özet tutmuyor"}</span>{" "}
                  {r.signature_ok === null ? <span className="pill neut" title="rafineri belge anahtarı verilmedi (AMR_DOC_KEY)">imza: anahtar yok</span> : <span className={`pill ${r.signature_ok ? "ok" : "bad"}`}>{r.signature_ok ? "imza geçerli" : "imza geçersiz"}</span>}
                </td>
                <td>
                  <div className="row">
                    <button className="ghost" onClick={async () => setDoc(await api.document(r.doc_id))}>Görüntüle</button>
                    <a className="pill" href={`/api/documents/${encodeURIComponent(r.doc_id)}/pdf`} target="_blank" rel="noreferrer">PDF</a>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager p={p} label="Belgeler" />
      </section>

      {doc && (
        <div className="modal-bg" onClick={() => setDoc(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{DOC_TYPE_TR[doc.meta.type] ?? doc.meta.type} · {doc.meta.doc_id}</h3>
            <div className="kv">
              <span className="k">İlgili kayıt</span><span className="mono small">{doc.meta.related_id}</span>
              <span className="k">Rafineri tarihi</span><span className="mono small">{fmtDT(doc.meta.created_ts)}</span>
              <span className="k">Özet (sha256)</span><span className="mono small" style={{ wordBreak: "break-all" }}>{doc.meta.hash}</span>
              <span className="k">İmza</span><span className="mono small" style={{ wordBreak: "break-all" }}>{doc.meta.signature}</span>
            </div>
            <h2 style={{ marginTop: 12 }}>İçerik</h2>
            <table>
              <tbody>
                {Object.entries(doc.content).map(([k, v]) => (
                  <tr key={k}><td className="small" style={{ width: 160 }}>{k}</td><td className="mono small" style={{ wordBreak: "break-all" }}>{typeof v === "object" ? JSON.stringify(v) : String(v)}</td></tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
              <a className="pill accent" href={`/api/documents/${encodeURIComponent(doc.meta.doc_id)}/pdf`} target="_blank" rel="noreferrer" style={{ padding: "8px 13px" }}>PDF</a>
              <button onClick={() => setDoc(null)}>Kapat</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
