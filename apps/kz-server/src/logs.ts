/**
 * Kayıtlar (K10): geriye dönük tek pencere.
 *
 * Beş kaynak aynı biçimde okunur, hepsi filtrelenir ve sayfalanır:
 *   requests      istek günlüğü (VARA kanıtı): rafineriye giden ve gelen çağrılar
 *   audit         denetim günlüğü: kim ne yaptı
 *   events        rafineriden alınan olaylar
 *   notifications bildirimler
 *   ticks         rafineriden gelen fiyat tick'leri
 *
 * Rafineri tarafındaki karşılığıyla aynı biçimi döner: satırlar + toplam sayı, `offset` ile sayfa.
 */
import type { AuditEntry } from "./audit.ts";
import type { RequestLogRow } from "./reqlog.ts";

export type LogSource = "requests" | "audit" | "events" | "notifications" | "ticks";

export interface LogRow {
  ts: string; source: LogSource; who: string; what: string; state: string;
  level: "ok" | "warn" | "bad" | "neut"; detail?: string;
}
export interface LogQuery { source?: string; q?: string; from?: string; to?: string; limit?: number; offset?: number }

export interface LogSources {
  requests: RequestLogRow[];
  audit: AuditEntry[];
  events: { event_id: string; type: string; ts: string; received_ts: string; seq?: number; summary: string }[];
  notifications: { id: number; type: string; title: string; body?: string; ts: string; read: boolean }[];
  ticks: { seq: number; ts: string; tradable: boolean; prices: unknown }[];
}

const inRange = (ts: string, from?: string | null, to?: string | null) =>
  (!from || ts >= from) && (!to || ts <= `${to}T23:59:59.999Z`);
const has = (hay: string, needle?: string | null) => !needle || hay.toLowerCase().includes(needle.toLowerCase());

export function queryLogs(src: LogSources, opt: LogQuery): { items: LogRow[]; total: number; source: LogSource } {
  const limit = Math.min(500, Math.max(1, opt.limit ?? 50));
  const offset = Math.max(0, opt.offset ?? 0);
  const q = opt.q?.trim() || null;
  const from = opt.from?.trim() || null;
  const to = opt.to?.trim() || null;
  const source = (["requests", "audit", "events", "notifications", "ticks"].includes(opt.source ?? "") ? opt.source : "requests") as LogSource;

  let all: LogRow[];
  if (source === "requests") {
    all = src.requests
      .filter((r) => inRange(r.ts, from, to) && has(`${r.method} ${r.path} ${r.actor ?? ""} ${r.direction}`, q))
      .map((r) => ({
        ts: r.ts, source, who: r.direction === "GİDEN" ? "rafineriye" : (r.actor ?? "gelen"),
        what: `${r.method} ${r.path}`, state: r.status ? String(r.status) : "hata",
        level: r.status === 0 || r.status >= 500 ? "bad" : r.status >= 400 ? "warn" : "ok",
        detail: [`${r.duration_ms} ms`, r.body_sha256 ? `gövde sha256 ${r.body_sha256}` : "", r.error ?? ""].filter(Boolean).join(" · "),
      }));
  } else if (source === "audit") {
    all = src.audit
      .filter((a) => inRange(a.ts, from, to) && has(`${a.actor} ${a.action} ${a.summary}`, q))
      .map((a) => ({
        ts: a.ts, source, who: a.actor, what: a.summary, state: a.action, level: "neut",
        detail: [a.before ? `öncesi: ${JSON.stringify(a.before).slice(0, 300)}` : "", a.after ? `sonrası: ${JSON.stringify(a.after).slice(0, 300)}` : ""].filter(Boolean).join(" · "),
      }));
  } else if (source === "events") {
    all = src.events
      .filter((e) => inRange(e.received_ts, from, to) && has(`${e.type} ${e.summary} ${e.event_id}`, q))
      .map((e) => ({
        ts: e.received_ts, source, who: "rafineriden", what: e.type, state: "alındı", level: "ok",
        detail: [`olay ${e.event_id}`, e.seq !== undefined ? `seq ${e.seq}` : "", e.summary].filter(Boolean).join(" · "),
      }));
  } else if (source === "notifications") {
    all = src.notifications
      .filter((n) => inRange(n.ts, from, to) && has(`${n.type} ${n.title} ${n.body ?? ""}`, q))
      .map((n) => ({
        ts: n.ts, source, who: n.type, what: n.title, state: n.read ? "okundu" : "yeni",
        level: n.read ? "neut" : "warn", detail: n.body,
      }));
  } else {
    all = src.ticks
      .filter((t) => inRange(t.ts, from, to) && has(JSON.stringify(t.prices), q))
      .map((t) => ({
        ts: t.ts, source, who: `seq ${t.seq}`,
        what: (t.prices as { ccy: string; bid: string; ask: string }[]).map((p) => `${p.ccy} ${p.bid} / ${p.ask}`).join(" · "),
        state: t.tradable ? "yayında" : "durdu", level: t.tradable ? "ok" : "warn",
      }));
  }
  return { source, total: all.length, items: all.slice(offset, offset + limit) };
}
