/**
 * Denetim günlüğü ve ikinci onay (Sistem 09 · ekran K9).
 *
 * İki ayrı iş yapar:
 *   1. Günlük: her elle aksiyon kim, ne zaman, ne yaptı diye kalıcı olarak yazılır (öncesi ve sonrasıyla).
 *      Sayfa yenilenince kaybolmaz; kalıcı durumun içindedir.
 *   2. İkinci onay: kritik aksiyonlar (parametre değişikliği, ödeme talimatı, uyuşmazlık düzeltmesi)
 *      tek kişiyle geçmez. İsteyen açar, başka biri onaylar, ancak o zaman uygulanır.
 *      İsteyen kendi isteğini onaylayamaz: kural sunucuda, ekranda değil.
 *
 * Aktör `X-User` başlığından gelir (demoda üst şeritten seçilir, gerçek kurulumda oturumdan).
 */

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  summary: string;
  before?: unknown;
  after?: unknown;
}

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface ApprovalRequest {
  id: number;
  action: string;
  summary: string;
  payload: unknown;
  requested_by: string;
  requested_ts: string;
  decided_by: string | null;
  decided_ts: string | null;
  status: ApprovalStatus;
  /** Onay bir kez kullanılır: aynı onayla ikinci değişiklik geçmez. */
  consumed?: boolean;
}

/** Kritik aksiyonlar: ikinci onay ister. Anahtar `action`, değer ekranda görünen ad. */
export const SECOND_APPROVAL: Record<string, string> = {
  "pricing.update": "fiyatlama parametreleri",
  "order-params.update": "emir parametreleri",
  "stock-params.update": "stok bandı ve onay matrisi",
  "fulfilment-params.update": "burn anı",
  "settlement.pay": "ödeme talimatı (şirket banka hesabından)",
  "record.resolve": "uyuşmazlık düzeltmesi",
};

export interface AuditState {
  audit: AuditEntry[];
  auditId: number;
  approvals: ApprovalRequest[];
  approvalId: number;
}

export class ApprovalError extends Error {}

const MAX_LOG = 1000;

export class AuditDesk {
  constructor(
    private s: AuditState,
    private d: { save: () => void; notify: (type: string, title: string, body?: string) => void },
  ) {}

  /** Günlüğe yazar. `summary` tek cümledir: denetçi JSON okumak zorunda kalmasın. */
  log(actor: string, action: string, summary: string, before?: unknown, after?: unknown): AuditEntry {
    const e: AuditEntry = { id: ++this.s.auditId, ts: new Date().toISOString(), actor: actor || "bilinmiyor", action, summary, before, after };
    this.s.audit.unshift(e);
    if (this.s.audit.length > MAX_LOG) this.s.audit.length = MAX_LOG;
    this.d.save();
    return e;
  }

  list(limit = 100): AuditEntry[] { return this.s.audit.slice(0, Math.min(MAX_LOG, limit)); }

  /** Kritik aksiyonun ilk adımı: istek açılır, uygulanmaz. */
  request(action: string, payload: unknown, requestedBy: string, summary?: string): ApprovalRequest {
    const r: ApprovalRequest = {
      id: ++this.s.approvalId,
      action,
      summary: summary ?? SECOND_APPROVAL[action] ?? action,
      payload,
      requested_by: requestedBy || "bilinmiyor",
      requested_ts: new Date().toISOString(),
      decided_by: null, decided_ts: null, status: "PENDING",
    };
    this.s.approvals.unshift(r);
    if (this.s.approvals.length > MAX_LOG) this.s.approvals.length = MAX_LOG;
    this.log(r.requested_by, `approval.request:${action}`, `${r.summary} için ikinci onay istendi`, undefined, payload);
    this.d.notify("approval.requested", "İkinci onay bekleniyor", `${r.summary} · isteyen ${r.requested_by}`);
    return r;
  }

  pending(): ApprovalRequest[] { return this.s.approvals.filter((a) => a.status === "PENDING"); }
  get(id: number): ApprovalRequest | undefined { return this.s.approvals.find((a) => a.id === id); }
  listApprovals(limit = 50): ApprovalRequest[] { return this.s.approvals.slice(0, limit); }

  /** İkinci adım: onaylayan isteyenden farklı olmalı. Kural burada, ekranda değil. */
  approve(id: number, approver: string): ApprovalRequest {
    const a = this.get(id);
    if (!a) throw new ApprovalError(`onay isteği yok: ${id}`);
    if (a.status !== "PENDING") throw new ApprovalError(`onay isteği ${id} zaten ${a.status === "APPROVED" ? "onaylanmış" : "reddedilmiş"}`);
    if (!approver?.trim()) throw new ApprovalError("onaylayan kullanıcı belirtilmeli");
    if (a.requested_by === approver.trim()) throw new ApprovalError("ikinci onay farklı bir kullanıcıdan gelmeli");
    a.status = "APPROVED"; a.decided_by = approver.trim(); a.decided_ts = new Date().toISOString();
    this.log(a.decided_by, `approval.approve:${a.action}`, `${a.summary} onaylandı (isteyen ${a.requested_by})`, undefined, a.payload);
    this.d.save();
    return a;
  }

  reject(id: number, actor: string): ApprovalRequest {
    const a = this.get(id);
    if (!a) throw new ApprovalError(`onay isteği yok: ${id}`);
    if (a.status !== "PENDING") throw new ApprovalError(`onay isteği ${id} zaten karara bağlanmış`);
    a.status = "REJECTED"; a.decided_by = actor || "bilinmiyor"; a.decided_ts = new Date().toISOString();
    this.log(a.decided_by, `approval.reject:${a.action}`, `${a.summary} reddedildi (isteyen ${a.requested_by})`);
    this.d.save();
    return a;
  }

  /**
   * Kritik aksiyonun iki adımını tek yerde toplar.
   * `approvalId` yoksa istek açılır ve `pending` döner; varsa onay tüketilir ve `payload` döner.
   * Onay bir kez tüketilir: aynı onayla ikinci istek gelirse reddedilir.
   */
  gate<T>(action: string, payload: T, actor: string, approvalId?: number, approver?: string): { pending: ApprovalRequest } | { payload: T } {
    if (!approvalId) return { pending: this.request(action, payload, actor) };
    const a = this.get(Number(approvalId));
    if (!a) throw new ApprovalError(`onay isteği yok: ${approvalId}`);
    if (a.action !== action) throw new ApprovalError(`onay isteği ${approvalId} başka bir aksiyon için açıldı (${a.action})`);
    if (a.status === "APPROVED") {
      if (a.consumed) throw new ApprovalError(`onay isteği ${approvalId} zaten kullanıldı`);
      a.consumed = true; this.d.save();
      return { payload: a.payload as T };
    }
    const approved = this.approve(Number(approvalId), approver ?? actor);
    approved.consumed = true; this.d.save();
    return { payload: approved.payload as T };
  }
}
