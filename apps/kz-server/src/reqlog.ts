/**
 * İstek günlüğü (VARA kanıtı) · Kanzasset tarafı.
 *
 * İki yönü de yazar:
 *   GİDEN  rafineriye yapılan her REST çağrısı (emir, hesap, kasa talimatı, mahsuplaşma)
 *   GELEN  rafineriden gelen olaylar (webhook) ve paneldeki her değiştirici istek
 *
 * Gövdenin kendisi saklanmaz, imzalanan gövdenin `sha256` özeti saklanır: "bu istek bu
 * gövdeyle gitti / geldi" sonradan kanıtlanır ama kayıt şişmez.
 *
 * Saklama süresi ve satır sayısı parametredir (`log.retention_days`, `log.max_rows`);
 * her yazmada süresi geçenler atılır. Okuma ekranı: K9 · uç `GET /api/requests`.
 */
import { createHash } from "node:crypto";

export type RequestDirection = "GİDEN" | "GELEN";

export interface RequestLogRow {
  id: number;
  ts: string;
  direction: RequestDirection;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  actor: string | null;
  body_sha256: string | null;
  bytes: number;
  error: string | null;
}

export interface RequestLogParams { retentionDays: number; maxRows: number }
export const DEFAULT_LOG_PARAMS: RequestLogParams = { retentionDays: 90, maxRows: 5000 };

export interface RequestLogState { requests: RequestLogRow[]; requestId: number; log: RequestLogParams }

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Yalnız kanıt değeri olan istekler yazılır: olaylar ve panelin değiştiricileri. */
export function shouldLogIncoming(method: string, url: string): boolean {
  const path = url.split("?")[0];
  if (path === "/api/stream") return false; // canlı akış: açık kalır, istek değildir
  if (path === "/api/events") return true; // rafineri olayı: her zaman kanıt
  if (!path.startsWith("/api")) return false;
  return method !== "GET"; // ekran yenilemeleri gürültüdür, değişiklikler kanıttır
}

/** Hata: 4xx, 5xx ya da hiç cevap alınamamış çağrı (status 0). */
const failed = (r: RequestLogRow) => r.status === 0 || r.status >= 400;

export class RequestLog {
  constructor(private s: RequestLogState, private save: () => void) {}

  params(): RequestLogParams { return this.s.log; }

  add(row: Omit<RequestLogRow, "id">) {
    this.s.requests.unshift({ id: ++this.s.requestId, ...row });
    this.prune();
    this.save();
  }

  /** Giden çağrı: rafineri REST'i. `body` verilirse özeti alınır. */
  outgoing(method: string, path: string, status: number, durationMs: number, body?: string, error?: string) {
    this.add({
      ts: new Date().toISOString(), direction: "GİDEN", method, path: path.split("?")[0], status,
      duration_ms: Math.round(durationMs), actor: null,
      body_sha256: body ? sha(body) : null, bytes: body ? Buffer.byteLength(body) : 0, error: error ?? null,
    });
  }

  /** Gelen istek: olay ya da panel aksiyonu. */
  incoming(method: string, path: string, status: number, durationMs: number, actor?: string | null, body?: string) {
    this.add({
      ts: new Date().toISOString(), direction: "GELEN", method, path: path.split("?")[0], status,
      duration_ms: Math.round(durationMs), actor: actor ?? null,
      body_sha256: body ? sha(body) : null, bytes: body ? Buffer.byteLength(body) : 0,
      error: status >= 400 ? String(status) : null,
    });
  }

  list(q: { limit?: number; direction?: string; path?: string; onlyErrors?: boolean } = {}): RequestLogRow[] {
    let rows = this.s.requests;
    if (q.direction) rows = rows.filter((r) => r.direction === q.direction);
    if (q.path) rows = rows.filter((r) => r.path.includes(q.path!));
    if (q.onlyErrors) rows = rows.filter(failed);
    return rows.slice(0, Math.min(1000, q.limit ?? 200));
  }

  summary() {
    const since = Date.now() - 86_400_000;
    const last = this.s.requests.filter((r) => Date.parse(r.ts) >= since);
    const ms = last.reduce((a, r) => a + r.duration_ms, 0);
    return {
      last_24h: last.length,
      errors_24h: last.filter(failed).length,
      avg_ms: last.length ? Math.round(ms / last.length) : 0,
      outgoing_24h: last.filter((r) => r.direction === "GİDEN").length,
      incoming_24h: last.filter((r) => r.direction === "GELEN").length,
      total: this.s.requests.length,
      oldest_ts: this.s.requests.at(-1)?.ts ?? null,
      retention_days: this.s.log.retentionDays,
      max_rows: this.s.log.maxRows,
    };
  }

  /** Süresi geçenler ve tavanı aşanlar atılır. */
  prune() {
    const { retentionDays, maxRows } = this.s.log;
    if (retentionDays > 0) {
      const cutoff = Date.now() - retentionDays * 86_400_000;
      const keep = this.s.requests.findIndex((r) => Date.parse(r.ts) < cutoff);
      if (keep >= 0) this.s.requests.length = keep;
    }
    if (maxRows > 0 && this.s.requests.length > maxRows) this.s.requests.length = maxRows;
  }
}
