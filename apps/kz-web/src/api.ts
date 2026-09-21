import { useEffect, useRef, useState } from "react";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) { let msg = res.statusText; try { msg = (await res.json()).error ?? msg; } catch { /* yok */ } throw new Error(msg); }
  return res.json();
}

export type Ccy = "USD" | "EUR" | "AED";
export interface PriceLevel { ccy: Ccy; bid: string; ask: string }
export interface ClientQuote { ccy: string; refineryBid: string; refineryAsk: string; clientBuy: string; clientSell: string; commissionBps: number }
export interface Tick { seq: number; ts: string; tradable: boolean; prices: PriceLevel[]; quotes?: ClientQuote[] }
export interface Notice { id: number; type: string; title: string; body?: string; ts: string; read: boolean }
export interface Account { seq: number; vault: { in_vault_mg: number; placing_mg: number; shipping_mg: number }; current_account: { gold_mg: number; money: { ccy: Ccy; cents: number }[] }; status: string }
export interface Diff { field: string; kz: number; amr: number }
export interface KzRecord {
  seq: number;
  vault: { in_vault_mg: number; placing_mg: number; shipping_mg: number };
  current_account: { gold_mg: number; money: { ccy: Ccy; cents: number }[] };
  stock: { s_mg: number; k_mg: number; a_mg: number };
  match: "EŞİT" | "RECONCILE" | "BEKLİYOR";
  diffs: Diff[];
  blocked: { mint: boolean; vault_out: boolean };
  lastAccount: Account | null;
  lastCompareTs: string | null;
  corrections: { ts: string; explanation: string; before: unknown; after: unknown }[];
}
export interface Checks { k1: { ok: boolean; text: string }; k2: { ok: boolean; text: string }; c_mg: number; v_mg: number }
export interface Fill { px: string; qty_mg: number; amount_cents: number; ccy: string; trade_ts: string }
export interface RefineryOrder { order_id: string; client_order_id: string; status: string; fill?: Fill; reject_reason?: string; allocation_certificate?: { doc_id: string; url: string }; account?: Account; received_ts: string; decided_ts?: string; history?: { status: string; ts: string; note?: string }[] }
export interface CustomerOrder {
  id: string; ts: string; customer_ref: string; side: "BUY" | "SELL"; qty_mg: number; ccy: Ccy;
  quote_seq: number; refinery_quote_px: string; limit_px: string; client_px: string; client_amount_cents: number; commission_cents: number; client_total_cents: number;
  status: "SENT" | "FILLED" | "REJECTED" | "CANCELLED" | "UNANSWERED" | "LATE_FILL" | "ERROR";
  customer_status: string; refinery: RefineryOrder | null; reject_reason?: string; error?: string; margin_cents?: number; match?: string;
  decision?: "CLOSE" | "CARRY"; decision_order_id?: string; timeline: { ts: string; text: string }[];
}
export interface Status {
  socket: { url: string; connection: "DISCONNECTED" | "CONNECTING" | "AUTHENTICATING" | "SUBSCRIBED"; tradable: boolean; haltReason: string | null; stale: boolean; seq: number; lastMsgTs: string | null; lastTickTs: string | null; lastPrices: PriceLevel[] | null; reconnectAttempt: number; gaps: number; lastError: string | null };
  rest: { url: string; events_received: number; last_event_ts: string | null };
  trading: { open: boolean; reason: string; manualStop: boolean; manualReason: string | null };
  quotes: ClientQuote[];
  pricing: { marginBps: number; marginCapBps: number; commissionBps: number };
  orderParams: { slippageBps: number; timeLimitMs: number; unansweredGraceMs: number; minOrderUsdCents: number };
  unread: number;
  record: KzRecord;
  checks: Checks;
  unanswered: number;
  lateFills: number;
  ts: string;
}
export interface EventLog { event_id: string; type: string; ts: string; received_ts: string; seq?: number; summary: string }
export interface Doc { meta: { doc_id: string; type: string; related_id: string; hash: string; signature: string; created_ts: string; sent_ts?: string }; content: Record<string, unknown> }

export const api = {
  status: () => req<Status>("/api/refinery/status"),
  ticks: (limit = 50) => req<Tick[]>(`/api/refinery/ticks?limit=${limit}`),
  stop: (reason: string) => req<Status>("/api/trading/stop", { method: "POST", body: JSON.stringify({ reason }) }),
  start: () => req<Status>("/api/trading/start", { method: "POST", body: "{}" }),
  notifications: () => req<{ unread: number; items: Notice[] }>("/api/notifications"),
  markRead: (id: number) => req(`/api/notifications/${id}/read`, { method: "POST", body: "{}" }),
  pricing: (p: Partial<Status["pricing"]>) => req("/api/pricing", { method: "PUT", body: JSON.stringify(p) }),
  orderParams: (p: Partial<Status["orderParams"]>) => req("/api/order-params", { method: "PUT", body: JSON.stringify(p) }),
  orders: (limit = 200) => req<{ items: CustomerOrder[]; unanswered: CustomerOrder[]; lateFills: CustomerOrder[] }>(`/api/orders?limit=${limit}`),
  order: (id: string) => req<CustomerOrder>(`/api/orders/${encodeURIComponent(id)}`),
  placeOrder: (o: { side: "BUY" | "SELL"; qty_mg: number; ccy: Ccy; customer_ref?: string }) => req<CustomerOrder>("/api/orders", { method: "POST", body: JSON.stringify(o) }),
  decide: (id: string, decision: "CLOSE" | "CARRY") => req<CustomerOrder>(`/api/orders/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify({ decision }) }),
  resolve: (id: string) => req<CustomerOrder>(`/api/orders/${encodeURIComponent(id)}/resolve`, { method: "POST", body: "{}" }),
  record: () => req<{ record: KzRecord; checks: Checks }>("/api/record"),
  snapshot: () => req<{ account: Account; match: string; diffs: Diff[]; seqGap: boolean }>("/api/record/snapshot", { method: "POST", body: "{}" }),
  resolveRecord: (explanation: string) => req<{ record: KzRecord }>("/api/record/resolve", { method: "POST", body: JSON.stringify({ explanation }) }),
  events: () => req<EventLog[]>("/api/events"),
  document: (id: string) => req<Doc>(`/api/documents/${encodeURIComponent(id)}`),
};

export function useLive() {
  const [status, setStatus] = useState<Status | null>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState(0); // durum değişti sayacı (listeleri yenilemek için)
  const t = useRef<number | null>(null);
  const refresh = async () => { try { const [s, k] = await Promise.all([api.status(), api.ticks(50)]); setStatus(s); setTicks(k); } catch (e) { console.warn(e); } };
  useEffect(() => {
    refresh();
    const es = new EventSource("/api/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.kind === "status") { setStatus(ev.status); setVersion((v) => v + 1); }
      else if (ev.kind === "tick") setTicks((prev) => [{ seq: ev.seq, ts: ev.ts, tradable: ev.tradable, prices: ev.prices, quotes: ev.quotes }, ...prev].slice(0, 50));
      else if (ev.kind === "notice") { if (t.current) window.clearTimeout(t.current); t.current = window.setTimeout(refresh, 200); }
    };
    return () => es.close();
  }, []);
  return { status, ticks, connected, version, refresh };
}

export const fmtG = (mg: number) => (mg / 1000).toLocaleString("tr-TR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
export const fmtMoney = (cents: number) => (cents / 100).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("tr-TR", { hour12: false }) : "");
export const fmtDT = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("tr-TR", { hour12: false }) : "");
export const ageSec = (iso: string | null | undefined) => (iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)) : null);
export const ORDER_TR: Record<string, string> = { SENT: "gönderildi", FILLED: "gerçekleşti", REJECTED: "reddedildi", CANCELLED: "iptal", UNANSWERED: "cevapsız", LATE_FILL: "geç fill", ERROR: "hata" };
export const REJECT_TR: Record<string, string> = { PRICE_OUTSIDE_LIMIT: "fiyat limit dışı (slippage)", STALE_QUOTE: "bayat quote_seq", TRADING_HALTED: "rafineri yayını durdu", CURRENT_ACCOUNT_LIMIT: "cari hesap limiti", DUPLICATE_ORDER: "tekrar emir", INVALID_QTY: "geçersiz miktar", INSUFFICIENT_CURRENT_ACCOUNT: "cari hesap altını yetersiz", INSUFFICIENT_VAULT: "kasada yetersiz", QUOTE_EXPIRED: "teklif süresi doldu", INTERNAL_ERROR: "iç hata" };
export const FIELD_TR: Record<string, string> = { "vault.in_vault_mg": "kasada", "vault.placing_mg": "kasaya konuluyor", "vault.shipping_mg": "sevkiyatta", "current_account.gold_mg": "cari hesap altın (T)", "current_account.money.USD": "cari hesap USD", "current_account.money.EUR": "cari hesap EUR", "current_account.money.AED": "cari hesap AED" };
