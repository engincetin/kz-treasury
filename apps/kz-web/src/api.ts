import { useEffect, useRef, useState } from "react";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) { let msg = res.statusText; try { msg = (await res.json()).error ?? msg; } catch { /* yok */ } throw new Error(msg); }
  return res.json();
}

export interface PriceLevel { ccy: "USD" | "EUR" | "AED"; bid: string; ask: string }
export interface ClientQuote { ccy: string; refineryBid: string; refineryAsk: string; clientBuy: string; clientSell: string; commissionBps: number }
export interface Tick { seq: number; ts: string; tradable: boolean; prices: PriceLevel[]; quotes?: ClientQuote[] }
export interface Notice { id: number; type: string; title: string; body?: string; ts: string; read: boolean }
export interface Status {
  socket: { url: string; connection: "DISCONNECTED" | "CONNECTING" | "AUTHENTICATING" | "SUBSCRIBED"; tradable: boolean; haltReason: string | null; stale: boolean; seq: number; lastMsgTs: string | null; lastTickTs: string | null; lastPrices: PriceLevel[] | null; reconnectAttempt: number; gaps: number; lastError: string | null };
  trading: { open: boolean; reason: string; manualStop: boolean; manualReason: string | null };
  quotes: ClientQuote[];
  pricing: { marginBps: number; marginCapBps: number; commissionBps: number };
  unread: number;
  record: { vault: { in_vault_mg: number; placing_mg: number; shipping_mg: number }; current_account: { gold_mg: number; money: { ccy: string; cents: number }[] }; match: string };
  ts: string;
}

export const api = {
  status: () => req<Status>("/api/refinery/status"),
  ticks: (limit = 50) => req<Tick[]>(`/api/refinery/ticks?limit=${limit}`),
  stop: (reason: string) => req<Status>("/api/trading/stop", { method: "POST", body: JSON.stringify({ reason }) }),
  start: () => req<Status>("/api/trading/start", { method: "POST", body: "{}" }),
  notifications: () => req<{ unread: number; items: Notice[] }>("/api/notifications"),
  markRead: (id: number) => req(`/api/notifications/${id}/read`, { method: "POST", body: "{}" }),
  pricing: (p: Partial<Status["pricing"]>) => req("/api/pricing", { method: "PUT", body: JSON.stringify(p) }),
};

export function useLive() {
  const [status, setStatus] = useState<Status | null>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [connected, setConnected] = useState(false);
  const t = useRef<number | null>(null);
  const refresh = async () => { try { const [s, k] = await Promise.all([api.status(), api.ticks(50)]); setStatus(s); setTicks(k); } catch (e) { console.warn(e); } };
  useEffect(() => {
    refresh();
    const es = new EventSource("/api/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.kind === "status") setStatus(ev.status);
      else if (ev.kind === "tick") setTicks((prev) => [{ seq: ev.seq, ts: ev.ts, tradable: ev.tradable, prices: ev.prices, quotes: ev.quotes }, ...prev].slice(0, 50));
      else if (ev.kind === "notice") { if (t.current) window.clearTimeout(t.current); t.current = window.setTimeout(refresh, 200); }
    };
    return () => es.close();
  }, []);
  return { status, ticks, connected, refresh };
}

export const fmtG = (mg: number) => (mg / 1000).toLocaleString("tr-TR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
export const fmtMoney = (cents: number) => (cents / 100).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("tr-TR", { hour12: false }) : "");
export const ageSec = (iso: string | null | undefined) => (iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)) : null);
