/**
 * AMR REST istemcisi (Sistem 05): X-API-Key, X-Timestamp, X-Signature = HMAC-SHA256(secret, ts + METHOD + path + body),
 * POST'ta Idempotency-Key. Gövde gönderildiği ham metinle imzalanır. Zaman aşımı çağıran belirler (emirde time_limit_ms).
 */
import { createHmac } from "node:crypto";
import { signingString, type Account, type CurrentAccountStatement, type Document, type OrderRequest, type OrderResponse, type SessionStatus } from "@amr/contract";

export class AmrTimeout extends Error { constructor(msg = "zaman aşımı") { super(msg); this.name = "AmrTimeout"; } }
export class AmrHttpError extends Error { constructor(public status: number, public body: unknown) { super(`HTTP ${status}`); this.name = "AmrHttpError"; } }

export class AmrClient {
  constructor(public baseUrl: string, private apiKey: string, private secret: string) {}

  headers(method: string, path: string, body = "", idempotencyKey?: string) {
    const ts = new Date().toISOString();
    const h: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "x-timestamp": ts,
      "x-signature": createHmac("sha256", this.secret).update(signingString(ts, method, path, body)).digest("hex"),
    };
    if (idempotencyKey) h["idempotency-key"] = idempotencyKey;
    return h;
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown, opts: { timeoutMs?: number; idempotencyKey?: string } = {}): Promise<T> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
    try {
      const res = await fetch(this.baseUrl + path, { method, headers: this.headers(method, path.split("?")[0], raw, opts.idempotencyKey), body: raw || undefined, signal: ctrl.signal });
      const text = await res.text();
      const json = text ? JSON.parse(text) : undefined;
      if (!res.ok) throw new AmrHttpError(res.status, json);
      return json as T;
    } catch (e) {
      if ((e as Error).name === "AbortError") throw new AmrTimeout();
      throw e;
    } finally { clearTimeout(t); }
  }

  sessionStatus() { return this.request<SessionStatus>("GET", "/v1/session/status"); }
  placeOrder(o: OrderRequest, timeoutMs: number) { return this.request<OrderResponse>("POST", "/v1/orders", o, { timeoutMs, idempotencyKey: o.client_order_id }); }
  orderStatus(id: string) { return this.request<OrderResponse>("GET", `/v1/orders/${encodeURIComponent(id)}`); }
  cancelOrder(id: string) { return this.request<OrderResponse>("POST", `/v1/orders/${encodeURIComponent(id)}/cancel`, {}, { idempotencyKey: `cancel-${id}` }); }
  account() { return this.request<Account>("GET", "/v1/account"); }
  statement(from?: string, to?: string) {
    const q = new URLSearchParams(); if (from) q.set("from", from); if (to) q.set("to", to);
    return this.request<CurrentAccountStatement>("GET", `/v1/current-account/statement${q.size ? `?${q}` : ""}`);
  }
  document(id: string) { return this.request<Document>("GET", `/v1/documents/${encodeURIComponent(id)}`); }
}
