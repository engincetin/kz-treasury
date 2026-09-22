import { api, DOC_TYPE_TR, fmtDT, type Doc } from "../api.ts";

/**
 * Belge penceresi: rafineri belgesinin Kanzasset'teki kopyası.
 * K6, K7 ve K12 aynı pencereyi kullanır (rafineri tarafındaki DocModal'ın karşılığı).
 */
export function DocModal({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const ok = doc.meta.hash_ok;
  const sig = doc.meta.signature_ok;
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{DOC_TYPE_TR[doc.meta.type] ?? doc.meta.type} · {doc.meta.doc_id}</h3>
        <div className="kv">
          <span className="k">İlgili kayıt</span><span className="mono small">{doc.meta.related_id}</span>
          <span className="k">Rafineri tarihi</span><span className="mono small">{fmtDT(doc.meta.created_ts)}</span>
          {ok !== undefined && (<><span className="k">Doğrulama</span><span className="row">
            <span className={`pill ${ok ? "ok" : "bad"}`}>{ok ? "özet tutuyor" : "özet tutmuyor"}</span>
            <span className={`pill ${sig === true ? "ok" : sig === false ? "bad" : ""}`}>{sig === true ? "imza geçerli" : sig === false ? "imza geçersiz" : "imza bakılmadı"}</span>
          </span></>)}
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
          <button onClick={onClose}>Kapat</button>
        </div>
      </div>
    </div>
  );
}

/** Kayıt satırındaki belge düğmeleri: numarası olan belgeyi kendi kopyamızdan açar. */
export function DocButtons({ ids, open }: { ids: [string, string | undefined][]; open: (d: Doc) => void }) {
  const shown = ids.filter(([, id]) => id);
  if (shown.length === 0) return <span className="small">yok</span>;
  return (
    <div className="row">
      {shown.map(([label, id]) => (
        <button key={label} className="ghost" title={id} onClick={async () => open(await api.document(id!))}>{label}</button>
      ))}
    </div>
  );
}
