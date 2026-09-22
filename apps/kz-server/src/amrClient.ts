/**
 * AMR REST istemcisi (Sistem 05): X-API-Key, X-Timestamp, X-Signature = HMAC-SHA256(secret, ts + METHOD + path + body),
 * POST'ta Idempotency-Key. Gövde gönderildiği ham metinle imzalanır. Zaman aşımı çağıran belirler (emirde time_limit_ms).
 */
import { createHmac } from "node:crypto";
import { signingString, type Account, type Catalog, type CurrentAccountStatement, type Delivery, type Document, type OrderRequest, type OrderResponse, type Refining, type SessionStatus, type Settlement, type VaultRequest, type VaultStatement } from "@amr/contract";

export class AmrTimeout extends Error { constructor(msg = "zaman aşımı") { super(msg); this.name = "AmrTimeout"; } }
export class AmrHttpError extends Error { constructor(public status: number, public body: unknown) { super(`HTTP ${status}`); this.name = "AmrHttpError"; } }

export class AmrClient {
  constructor(public baseUrl: string, private apiKey: string, private secret: string) {}

  /** Her çağrı burada bildirilir: istek günlüğü (VARA kanıtı) buraya bağlanır. */
  onCall: (c: { method: string; path: string; status: number; durationMs: number; body: string; error?: string }) => void = () => {};

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
    const started = Date.now();
    const note = (status: number, error?: string) => {
      try { this.onCall({ method, path, status, durationMs: Date.now() - started, body: raw, error }); } catch { /* günlük çağrıyı bozmaz */ }
    };
    try {
      const res = await fetch(this.baseUrl + path, { method, headers: this.headers(method, path.split("?")[0], raw, opts.idempotencyKey), body: raw || undefined, signal: ctrl.signal });
      const text = await res.text();
      const json = text ? JSON.parse(text) : undefined;
      note(res.status, res.ok ? undefined : `HTTP ${res.status}`);
      if (!res.ok) throw new AmrHttpError(res.status, json);
      return json as T;
    } catch (e) {
      if ((e as Error).name === "AbortError") { note(0, "zaman aşımı"); throw new AmrTimeout(); }
      if (!(e instanceof AmrHttpError)) note(0, (e as Error).message);
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
  /** Kasa talimatı (05, 06): `ref` Kanzasset referansıdır ve tekildir, aynı ref ile tekrar aynı talebi döner. */
  vaultIn(qty_mg: number, ref: string) { return this.request<VaultRequest>("POST", "/v1/vault/in", { qty_mg, ref }, { idempotencyKey: ref }); }
  vaultOut(qty_mg: number, ref: string) { return this.request<VaultRequest>("POST", "/v1/vault/out", { qty_mg, ref }, { idempotencyKey: ref }); }
  vaultRequest(id: string) { return this.request<VaultRequest>("GET", `/v1/vault/requests/${encodeURIComponent(id)}`); }
  vaultStatement(date?: string) { return this.request<VaultStatement>("GET", `/v1/vault/statement${date ? `?date=${date}` : ""}`); }
  /** Fiziksel teslimat (10) ve rafinasyon (11). */
  deliveryCreate(b: { qty_mg: number; address_ref: string; insured_party_ref: string; ref: string }) { return this.request<Delivery>("POST", "/v1/deliveries", b, { idempotencyKey: b.ref }); }
  deliveryGet(id: string) { return this.request<Delivery>("GET", `/v1/deliveries/${encodeURIComponent(id)}`); }
  deliveryApprove(id: string, quote_id: string) { return this.request<Delivery>("POST", `/v1/deliveries/${encodeURIComponent(id)}/approve`, { quote_id }, { idempotencyKey: `dlv-ap-${id}` }); }
  deliveryCancel(id: string, reason: string) { return this.request<Delivery>("POST", `/v1/deliveries/${encodeURIComponent(id)}/cancel`, { reason }, { idempotencyKey: `dlv-cx-${id}` }); }
  catalog() { return this.request<Catalog>("GET", "/v1/catalog"); }
  refiningCreate(b: { items: { item_id: string; qty: number }[]; address_ref: string; insured_party_ref: string; ref: string }) { return this.request<Refining>("POST", "/v1/refining", b, { idempotencyKey: b.ref }); }
  refiningGet(id: string) { return this.request<Refining>("GET", `/v1/refining/${encodeURIComponent(id)}`); }
  refiningApprove(id: string, quote_id: string) { return this.request<Refining>("POST", `/v1/refining/${encodeURIComponent(id)}/approve`, { quote_id }, { idempotencyKey: `rfn-ap-${id}` }); }
  refiningCancel(id: string, reason: string) { return this.request<Refining>("POST", `/v1/refining/${encodeURIComponent(id)}/cancel`, { reason }, { idempotencyKey: `rfn-cx-${id}` }); }
  /** Mahsuplaşma (12). */
  settlementOpen(trigger: string, reason?: string, scope?: string[]) { return this.request<Settlement>("POST", "/v1/settlements", { trigger, reason, scope }, { idempotencyKey: `stl-${trigger}-${Date.now()}` }); }
  /** Altın teklifini onayla: kasa girişi talebi bundan sonra gönderilir. */
  settlementApproveGold(id: string) { return this.request<Settlement>("POST", `/v1/settlements/${encodeURIComponent(id)}/gold/approve`, {}); }
  settlementGet(id: string) { return this.request<Settlement>("GET", `/v1/settlements/${encodeURIComponent(id)}`); }
  settlementConfirm(id: string, statement_hash: string, gold_mg: number, money: { ccy: string; cents: number }[]) {
    return this.request<Settlement>("POST", `/v1/settlements/${encodeURIComponent(id)}/confirm`, { statement_hash, gold_mg, money }, { idempotencyKey: `stl-cf-${id}` });
  }
  settlementPaymentNotice(id: string, ccy: string, amount_cents: number, direction: string, bank_ref: string) {
    return this.request<Settlement>("POST", `/v1/settlements/${encodeURIComponent(id)}/payment-notice`, { ccy, amount_cents, direction, bank_ref }, { idempotencyKey: `stl-pn-${id}-${ccy}` });
  }
  settlementPaymentReceived(id: string, ccy: string, bank_ref?: string) {
    return this.request<Settlement>("POST", `/v1/settlements/${encodeURIComponent(id)}/payment-received`, { ccy, bank_ref }, { idempotencyKey: `stl-pr-${id}-${ccy}` });
  }
  documentPdfUrl(id: string) { return `${this.baseUrl}/v1/documents/${encodeURIComponent(id)}/pdf`; }
}
