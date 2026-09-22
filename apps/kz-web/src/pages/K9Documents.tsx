import { useEffect, useState } from "react";
import { api, fmtDT, DOC_TYPE_TR, type DocumentsView, type KzDocumentRow, type Doc, type useLive } from "../api.ts";
import { Pager, usePager } from "../components/Pager.tsx";
import { DocModal } from "./shared.tsx";

type Live = ReturnType<typeof useLive>;

/**
 * K9 Belgeler: rafineri tarafındaki R9'un karşılığı.
 * Rafinerinin ürettiği her belgenin Kanzasset kopyası: olayla numara gelir, belge çekilir,
 * özeti yeniden hesaplanır, saklanır. İki taraf aynı belgenin kendi kopyasına sahiptir.
 */
export function K9Documents({ live }: { live: Live }) {
  const [rows, setRows] = useState<KzDocumentRow[]>([]);
  const [info, setInfo] = useState<DocumentsView | null>(null);
  const [q, setQ] = useState({ type: "", text: "" });
  const [doc, setDoc] = useState<Doc | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.documents().then((d) => { setRows(d.items); setInfo(d); }).catch((e) => setMsg(`Hata: ${(e as Error).message}`));
  useEffect(() => { void load(); }, [live.version]);

  const types = [...new Set(rows.map((r) => r.type))];
  const shown = rows.filter((r) => (!q.type || r.type === q.type) && (!q.text || r.doc_id.toLowerCase().includes(q.text.toLowerCase()) || r.related_id.toLowerCase().includes(q.text.toLowerCase())));
  const p = usePager(shown, 20, `${q.type}|${q.text}`);
  const bad = rows.filter((r) => !r.hash_ok).length;

  return (
    <div>
      <span className="tag">K9</span>
      <h1>Belgeler</h1>
      <p className="sub">Rafinerinin ürettiği belgelerin Kanzasset'teki kopyası: Tahsis Belgesi, Kasa Giriş ve Çıkış Fişi, Lojistik ve Rafinasyon Teklifi, Sevkiyat Fişi, Teslimat Kaydı, ekstreler. Belge numarası olayla gelir, belge çekilir, özeti yeniden hesaplanıp karşılaştırılır ve burada saklanır. Denetimde tek tarafa güvenmek gerekmez.</p>

      <div className="grid c3" style={{ marginBottom: 14 }}>
        <div className="card kpi"><h2>Saklanan belge</h2><div className="n">{rows.length}</div><div className="small">rafineriden alınan kopya</div></div>
        <div className="card kpi"><h2>Özet doğrulaması</h2><div className="n" style={{ color: bad > 0 ? "var(--bad)" : "var(--ok)" }}>{bad === 0 ? "tümü tutuyor" : `${bad} tutmuyor`}</div><div className="small">sha256(içerik) = belge özeti{info ? ` · ${info.signature_checked ? "imza da doğrulanıyor" : "imza anahtarı verilmedi"}` : ""}</div></div>
        <div className="card">
          <h2>Eşitleme</h2>
          <p className="small">Belge numarası olayla gelince kopya kendiliğinden çekilir. Ayrıca {info?.auto_sync_minutes ? `${info.auto_sync_minutes} dakikada bir` : "düzenli olarak"} bütün kayıtlar taranır, eksik kalan varsa alınır. Son eşitleme: {info?.last_sync_ts ? fmtDT(info.last_sync_ts) : "henüz yapılmadı"}.</p>
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

      {doc && <DocModal doc={doc} onClose={() => setDoc(null)} />}
    </div>
  );
}
