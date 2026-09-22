import { useState } from "react";
import { api, currentUser } from "../api.ts";

/**
 * İkinci onay kutusu.
 *
 * Kritik aksiyon 202 dönünce ekranda bu kutu açılır: onay numarası, isteyen ve onaylayan alanı.
 * Onaylandığı anda sunucu işi uygular; ayrıca "bir daha gönder" gerekmez.
 * Aynı kişi onaylayamaz; kural sunucuda, buradaki kontrol yalnız kullanıcıyı uyarır.
 */
export function ApprovalBox({ id, requestedBy, summary, onDone }: { id: number; requestedBy: string; summary?: string; onDone: (msg: string) => void }) {
  const [approver, setApprover] = useState(currentUser.name === requestedBy ? "yonetici" : currentUser.name);
  const [busy, setBusy] = useState(false);
  const same = approver.trim() === requestedBy;

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); onDone(done); }
    catch (e) { onDone(`Hata: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ borderColor: "var(--warn)", background: "var(--warn-soft)", marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <b>İkinci onay bekleniyor{summary ? `: ${summary}` : ""}</b>
          <div className="small">Onay {id} · isteyen <b>{requestedBy}</b>. Onaylayan farklı bir kullanıcı olmalı; onaylandığı anda işlem uygulanır.</div>
        </div>
        <div className="row">
          <input value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="onaylayan" style={{ minWidth: 150 }} />
          <button className="primary" disabled={busy || same} title={same ? "isteyen kendi isteğini onaylayamaz" : ""}
            onClick={() => run(() => api.approve(id, approver.trim()), "Onaylandı ve uygulandı.")}>Onayla ve uygula</button>
          <button className="ghost" disabled={busy} onClick={() => run(() => api.rejectApproval(id), "Onay isteği reddedildi.")}>Reddet</button>
        </div>
      </div>
    </div>
  );
}
