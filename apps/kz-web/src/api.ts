import { useEffect, useRef, useState } from "react";

/** Demoda aktif kullanıcı üst şeritten seçilir ve her istekte X-User ile gider (denetim günlüğü ve ikinci onay için). */
export const KZ_USERS = ["hazineci", "operasyon", "yonetici", "denetci"] as const;
export const currentUser = { name: localStorage.getItem("kzUser") ?? "hazineci" };
export function setCurrentUser(u: string) { currentUser.name = u; localStorage.setItem("kzUser", u); }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", "x-user": currentUser.name, ...(init?.headers ?? {}) } });
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
  stock: { s_mg: number; k_mg: number; a_mg: number; e_mg?: number };
  match: "EŞİT" | "RECONCILE" | "BEKLİYOR";
  diffs: Diff[];
  blocked: { mint: boolean; vault_out: boolean };
  lastAccount: Account | null;
  lastCompareTs: string | null;
  corrections: { ts: string; explanation: string; before: unknown; after: unknown }[];
}
export interface Checks { k1: { ok: boolean; text: string }; k2: { ok: boolean; text: string }; c_mg: number; e_mg?: number; v_mg: number }
export interface Fill { px: string; qty_mg: number; amount_cents: number; ccy: string; trade_ts: string }
export interface RefineryOrder { order_id: string; client_order_id: string; status: string; fill?: Fill; reject_reason?: string; allocation_certificate?: { doc_id: string; url: string }; account?: Account; received_ts: string; decided_ts?: string; history?: { status: string; ts: string; note?: string }[] }
export interface CustomerOrder {
  id: string; ts: string; customer_ref: string; side: "BUY" | "SELL"; qty_mg: number; ccy: Ccy;
  quote_seq: number; refinery_quote_px: string; limit_px: string; client_px: string; client_amount_cents: number; commission_cents: number; client_total_cents: number;
  status: "SENT" | "FILLED" | "REJECTED" | "CANCELLED" | "UNANSWERED" | "LATE_FILL" | "ERROR";
  customer_status: string; refinery: RefineryOrder | null; reject_reason?: string; error?: string; margin_cents?: number; match?: string;
  decision?: "CLOSE" | "CARRY"; decision_order_id?: string;
  flow?: "STOK" | "BÜYÜK_ALIŞ" | "BÜYÜK_SATIŞ"; vault_ref?: string; chain_mg?: number;
  timeline: { ts: string; text: string }[];
}
export interface StockParams {
  targetMg: number; floorMg: number; ceilingMg: number;
  mintPolicy: "SHORTFALL" | "FULL_ORDER";
  placingCapMg: number;
  approvalMatrix: { upToMg: number; approvals: number }[];
  approvalsAbove: number;
}
export type VaultStatus = "HOLD" | "REQUESTED" | "ACCEPTED" | "PLACING" | "PLACED" | "OVERDUE" | "REJECTED" | "ERROR";
export type VaultTrigger = "BIG_BUY" | "BIG_SELL" | "TREASURY_BUY" | "TREASURY_SELL" | "SETTLEMENT" | "MANUAL";
export interface VaultInstruction {
  ref: string; type: "IN" | "OUT"; qty_mg: number; trigger: VaultTrigger; status: VaultStatus;
  request_id?: string; doc_id?: string; mint_tx?: string; burn_tx?: string; minted: boolean; burned: boolean;
  hold_reason?: string; reject_reason?: string; related_id?: string; due_ts?: string; created_ts: string;
  timeline: { ts: string; text: string }[];
}
export interface VaultView {
  items: VaultInstruction[]; placing_mg: number; in_flight_mg: number; committed_placing_mg: number; placing_cap_mg: number;
  awaiting_mint: VaultInstruction[]; holds: VaultInstruction[]; mint_block: string | null; vault_out_block: string | null;
  record: KzRecord; checks: Checks;
}
export type TreasuryStatus = "ONAY_BEKLİYOR" | "GÖNDERİLDİ" | "ZİNCİR_SÜRÜYOR" | "TAMAM" | "REDDEDİLDİ" | "İPTAL" | "HATA";
export interface TreasuryRequest {
  id: string; side: "BUY" | "SELL"; qty_mg: number; ccy: Ccy; maker: string;
  required_approvals: number; approvals: { by: string; ts: string }[]; status: TreasuryStatus;
  quoted_px: string; quoted_amount_cents: number;
  order_id?: string; fill_px?: string; fill_amount_cents?: number; reject_reason?: string; vault_ref?: string;
  target_before_mg: number; target_after_mg?: number; error?: string; created_ts: string; sent_ts?: string;
  timeline: { ts: string; text: string }[];
}
export interface CatalogItem { item_id: string; name: string; weight_mg: number; fineness: string; unit_price_cents: number; ccy: string; lead_time_days: number; active: boolean }
export interface Catalog { version: number; items: CatalogItem[]; updated_ts: string }
export interface KzDelivery {
  id: string; kind: "DELIVERY"; customer_ref: string; qty_mg: number; address_ref: string; insured_party_ref: string;
  delivery_id?: string; status: string;
  quote?: { quote_id: string; carrier: string; amount_cents: number; ccy: string; valid_until: string; doc_id?: string };
  customer_price_cents?: number; tracking_no?: string; burned: boolean; burn_tx?: string; escrowed: boolean;
  created_ts: string; timeline: { ts: string; text: string }[];
}
export interface KzRefining {
  id: string; kind: "REFINING"; customer_ref: string; items: { item_id: string; name: string; qty: number; weight_mg: number }[];
  total_mg: number; address_ref: string; insured_party_ref: string; refining_id?: string; status: string;
  quote?: { quote_id: string; product_cents: number; logistics_cents: number; ccy: string; lead_time_days: number; valid_until: string; doc_id?: string };
  customer_price_cents?: number; tracking_no?: string; burned: boolean; burn_tx?: string; escrowed: boolean;
  created_ts: string; timeline: { ts: string; text: string }[];
}
export interface FulfilmentView {
  deliveries: KzDelivery[]; refinings: KzRefining[]; catalog: Catalog | null;
  awaiting_approval: number; burn_moment: "DELIVERED" | "SHIPPED"; escrow_mg: number; checks: Checks;
}
export interface KzSettlement {
  settlement_id: string; trigger: string; status: string; window_from: string; window_to: string;
  amr_gold_mg?: number; amr_money?: { ccy: string; cents: number }[];
  kz_gold_mg?: number; kz_money?: { ccy: string; cents: number }[];
  diffs?: { field: string; amr: string; kz: string }[];
  gold_leg?: { direction: string; qty_mg: number; vault_ref?: string; done: boolean };
  money_leg: { ccy: string; net_cents: number; direction: string; paid: boolean; bank_ref?: string }[];
  doc_id?: string; created_ts: string; timeline: { ts: string; text: string }[];
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
  stock: StockParams;
  vault: {
    placing_mg: number; in_flight_mg: number; committed_placing_mg: number; placing_cap_mg: number;
    awaiting_mint: number; holds: number; mint_block: string | null; vault_out_block: string | null; open: number;
  };
  treasury: { pending: number };
  awaitingDelivery: number;
  settlement: { open: string | null; status: string | null; windows: number };
  fulfilment: { deliveries_open: number; refinings_open: number; awaiting_approval: number; burn_moment: "DELIVERED" | "SHIPPED"; catalog_version: number };
  ts: string;
}
export interface EventLog { event_id: string; type: string; ts: string; received_ts: string; seq?: number; summary: string }
export interface Doc { meta: { doc_id: string; type: string; related_id: string; hash: string; signature: string; created_ts: string; sent_ts?: string; hash_ok?: boolean; signature_ok?: boolean | null }; content: Record<string, unknown> }
/** K12: belgenin Kanzasset kopyasının künyesi (içerik ayrı çekilir). */
export interface KzDocumentRow { doc_id: string; type: string; related_id: string; hash: string; signature: string; created_ts: string; received_ts: string; source: string; hash_ok: boolean; signature_ok: boolean | null }
export const DOC_TYPE_TR: Record<string, string> = { ALLOCATION_CERTIFICATE: "Tahsis Belgesi", VAULT_IN_SLIP: "Kasa Giriş Fişi", VAULT_OUT_SLIP: "Kasa Çıkış Fişi", LOGISTICS_QUOTE: "Lojistik Teklifi", REFINING_QUOTE: "Rafinasyon Teklifi", SHIPPING_SLIP: "Sevkiyat Fişi", DELIVERY_RECORD: "Teslimat Kaydı", VAULT_STATEMENT: "Günlük Kasa Ekstresi", CURRENT_ACCOUNT_STATEMENT: "Cari Hesap Ekstresi", SETTLEMENT_STATEMENT: "Mahsuplaşma Ekstresi" };

/** Kritik uçlarda ikinci onay: ilk istekte boş, onayda numara ve onaylayan. */
export interface Approval { approval_id?: number; approver?: string }

export const api = {
  status: () => req<Status>("/api/refinery/status"),
  ticks: (limit = 50) => req<Tick[]>(`/api/refinery/ticks?limit=${limit}`),
  stop: (reason: string) => req<Status>("/api/trading/stop", { method: "POST", body: JSON.stringify({ reason }) }),
  start: () => req<Status>("/api/trading/start", { method: "POST", body: "{}" }),
  notifications: () => req<{ unread: number; items: Notice[] }>("/api/notifications"),
  markRead: (id: number) => req(`/api/notifications/${id}/read`, { method: "POST", body: "{}" }),
  pricing: (p: Partial<Status["pricing"]> & Approval) => req<unknown>("/api/pricing", { method: "PUT", body: JSON.stringify(p) }),
  orderParams: (p: Partial<Status["orderParams"]> & Approval) => req<unknown>("/api/order-params", { method: "PUT", body: JSON.stringify(p) }),
  orders: (limit = 200) => req<{ items: CustomerOrder[]; unanswered: CustomerOrder[]; lateFills: CustomerOrder[] }>(`/api/orders?limit=${limit}`),
  order: (id: string) => req<CustomerOrder>(`/api/orders/${encodeURIComponent(id)}`),
  placeOrder: (o: { side: "BUY" | "SELL"; qty_mg: number; ccy: Ccy; customer_ref?: string }) => req<CustomerOrder>("/api/orders", { method: "POST", body: JSON.stringify(o) }),
  decide: (id: string, decision: "CLOSE" | "CARRY") => req<CustomerOrder>(`/api/orders/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify({ decision }) }),
  resolve: (id: string) => req<CustomerOrder>(`/api/orders/${encodeURIComponent(id)}/resolve`, { method: "POST", body: "{}" }),
  record: () => req<{ record: KzRecord; checks: Checks }>("/api/record"),
  snapshot: () => req<{ account: Account; match: string; diffs: Diff[]; seqGap: boolean }>("/api/record/snapshot", { method: "POST", body: "{}" }),
  resolveRecord: (explanation: string, approval?: { approval_id: number; approver: string }) =>
    req<{ record: KzRecord } | NeedsApproval>("/api/record/resolve", { method: "POST", body: JSON.stringify({ explanation, ...(approval ?? {}) }) }),
  events: () => req<EventLog[]>("/api/events"),
  document: (id: string) => req<Doc>(`/api/documents/${encodeURIComponent(id)}`),
  // K12 belgeler: kendi kopyamız
  documents: (q: { type?: string; text?: string } = {}) => req<{ count: number; signature_checked: boolean; items: KzDocumentRow[] }>(`/api/documents?${new URLSearchParams(Object.fromEntries(Object.entries({ type: q.type, q: q.text }).filter(([, v]) => v)) as Record<string, string>)}`).then((r) => r.items),
  syncDocuments: () => req<{ fetched: number; failed: string[]; count: number }>("/api/documents/sync", { method: "POST", body: "{}" }),
  // K4 kasa talimatları
  vault: (limit = 200) => req<VaultView>(`/api/vault?limit=${limit}`),
  vaultManual: (type: "IN" | "OUT", qty_mg: number, reason: string) => req<VaultInstruction>("/api/vault", { method: "POST", body: JSON.stringify({ type, qty_mg, reason }) }),
  vaultRetry: (ref: string) => req<VaultInstruction>(`/api/vault/${encodeURIComponent(ref)}/retry`, { method: "POST", body: "{}" }),
  flushMints: () => req<{ ok: boolean; awaiting: number; block: string | null }>("/api/vault/flush-mints", { method: "POST", body: "{}" }),
  vaultStatement: (date?: string) => req<VaultStatementDoc>(`/api/vault/statement${date ? `?date=${date}` : ""}`),
  // K5 hazine alım satımı
  treasury: () => req<{ items: TreasuryRequest[]; pending: TreasuryRequest[]; stock: StockParams; record: KzRecord }>("/api/treasury"),
  treasuryCreate: (b: { side: "BUY" | "SELL"; qty_mg: number; ccy: Ccy; maker: string }) => req<TreasuryRequest>("/api/treasury", { method: "POST", body: JSON.stringify(b) }),
  treasuryApprove: (id: string, approver: string) => req<TreasuryRequest>(`/api/treasury/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify({ approver }) }),
  treasuryCancel: (id: string, actor: string) => req<TreasuryRequest>(`/api/treasury/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ actor }) }),
  stockParams: (p: Partial<StockParams> & Approval) => req<StockParams | NeedsApproval>("/api/stock-params", { method: "PUT", body: JSON.stringify(p) }),
  // K6 teslimat, K7 rafinasyon
  fulfilment: () => req<FulfilmentView>("/api/fulfilment"),
  catalogRefresh: () => req<Catalog>("/api/catalog"),
  deliveryCreate: (b: { qty_mg: number; address_ref?: string; insured_party_ref?: string }) => req<KzDelivery>("/api/deliveries", { method: "POST", body: JSON.stringify(b) }),
  deliveryApprove: (id: string) => req<KzDelivery>(`/api/deliveries/${encodeURIComponent(id)}/approve`, { method: "POST", body: "{}" }),
  deliveryCancel: (id: string, reason: string) => req<KzDelivery>(`/api/deliveries/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }),
  refiningCreate: (b: { items: { item_id: string; qty: number }[]; address_ref?: string; insured_party_ref?: string }) => req<KzRefining>("/api/refining", { method: "POST", body: JSON.stringify(b) }),
  refiningApprove: (id: string) => req<KzRefining>(`/api/refining/${encodeURIComponent(id)}/approve`, { method: "POST", body: "{}" }),
  refiningCancel: (id: string, reason: string) => req<KzRefining>(`/api/refining/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }),
  fulfilmentParams: (p: { burnMoment: "DELIVERED" | "SHIPPED" } & Approval) => req<unknown>("/api/fulfilment-params", { method: "PUT", body: JSON.stringify(p) }),
  // K8 mahsuplaşma
  settlements: () => req<{ items: KzSettlement[]; open: KzSettlement | null; record: KzRecord }>("/api/settlements"),
  settlementRequest: (reason?: string) => req<KzSettlement>("/api/settlements", { method: "POST", body: JSON.stringify({ trigger: "REQUEST_KZ", reason }) }),
  settlementReconcile: (id: string) => req<KzSettlement>(`/api/settlements/${encodeURIComponent(id)}/reconcile`, { method: "POST", body: "{}" }),
  settlementGoldLeg: (id: string) => req<KzSettlement>(`/api/settlements/${encodeURIComponent(id)}/gold-leg`, { method: "POST", body: "{}" }),
  settlementPay: (id: string, ccy: string, approval?: { approval_id: number; approver: string }) =>
    req<KzSettlement | NeedsApproval>(`/api/settlements/${encodeURIComponent(id)}/pay`, { method: "POST", body: JSON.stringify({ ccy, ...(approval ?? {}) }) }),
  // K9 denetim günlüğü ve ikinci onay
  audit: (limit = 100) => req<{ items: AuditEntry[]; second_approval: Record<string, string> }>(`/api/audit?limit=${limit}`),
  approvals: () => req<{ pending: ApprovalRequest[]; items: ApprovalRequest[] }>("/api/approvals"),
  approve: (id: number, approver: string) => req<ApprovalRequest>(`/api/approvals/${id}/approve`, { method: "POST", body: JSON.stringify({ approver }) }),
  rejectApproval: (id: number) => req<ApprovalRequest>(`/api/approvals/${id}/reject`, { method: "POST", body: "{}" }),
  /** İstek günlüğü (VARA kanıtı): rafineriye giden ve rafineriden gelen çağrılar. */
  requests: (q: { limit?: number; direction?: string; errors?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (q.limit) p.set("limit", String(q.limit));
    if (q.direction) p.set("direction", q.direction);
    if (q.errors) p.set("errors", "1");
    return req<{ summary: RequestSummary; items: RequestLogRow[] }>(`/api/requests${p.size ? `?${p}` : ""}`);
  },
  logParams: (p: { retentionDays?: number; maxRows?: number } & Approval) => req<unknown>("/api/log-params", { method: "PUT", body: JSON.stringify(p) }),
};

/** Kritik aksiyonun ilk adımı: sunucu 202 ile onay numarası döner, uygulama ikinci onayla olur. */
export interface NeedsApproval { needs_approval: true; approval_id: number; requested_by: string; message: string; values: unknown }
export const needsApproval = (r: unknown): r is NeedsApproval => !!r && typeof r === "object" && (r as NeedsApproval).needs_approval === true;
export interface AuditEntry { id: number; ts: string; actor: string; action: string; summary: string; before?: unknown; after?: unknown }
export interface ApprovalRequest {
  id: number; action: string; summary: string; payload: unknown;
  requested_by: string; requested_ts: string; decided_by: string | null; decided_ts: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED"; consumed?: boolean;
}

export interface VaultStatementDoc {
  date: string;
  opening: { in_vault_mg: number; placing_mg: number; shipping_mg: number };
  closing: { in_vault_mg: number; placing_mg: number; shipping_mg: number };
  total_mg: number;
  movements: { seq: number; type: string; in_vault_mg: number; placing_mg: number; shipping_mg: number; related_id?: string; doc_id?: string; ts: string }[];
  slips: { doc_id: string; type: string; related_id: string; created_ts: string }[];
  hash: string; signature: string;
}

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
export const VAULT_STATUS_TR: Record<string, string> = { HOLD: "durdu", REQUESTED: "talep edildi", ACCEPTED: "kabul edildi", PLACING: "kasaya konuluyor", PLACED: "kasaya konuldu", OVERDUE: "vade geçti (T+3)", REJECTED: "reddedildi", ERROR: "hata" };
export const VAULT_TRIGGER_TR: Record<string, string> = { BIG_BUY: "büyük alış (07)", BIG_SELL: "büyük satış (08)", TREASURY_BUY: "hazine alımı (09)", TREASURY_SELL: "hazine satışı (09)", SETTLEMENT: "mahsuplaşma (12)", MANUAL: "elle" };
export const TREASURY_STATUS_TR: Record<string, string> = { "ONAY_BEKLİYOR": "onay bekliyor", "GÖNDERİLDİ": "gönderildi", "ZİNCİR_SÜRÜYOR": "zincir sürüyor", TAMAM: "tamam", "REDDEDİLDİ": "reddedildi", "İPTAL": "iptal", HATA: "hata" };
export const FLOW_TR: Record<string, string> = { STOK: "stoktan", "BÜYÜK_ALIŞ": "büyük alış (07)", "BÜYÜK_SATIŞ": "büyük satış (08)" };
export const STL_STATUS_TR: Record<string, string> = { REQUESTED: "talep edildi", OPEN: "pencere açık", DRAFT: "ekstre taslağı", RECONCILED: "mutabakat sağlandı", MISMATCH: "fark var", PAYMENT_PENDING: "ödeme bekliyor", SETTLED: "kapandı" };
export const STL_TRIGGER_TR: Record<string, string> = { CUTOFF: "kesim saati", REQUEST_KZ: "Kanzasset talebi", REQUEST_AMR: "rafineri talebi", LIMIT: "cari hesap limiti" };
export const FUL_STATUS_TR: Record<string, string> = { TALEP: "talep hazırlandı", REQUESTED: "rafineride", QUOTED: "teklif geldi", APPROVED: "onaylandı", PREPARING: "hazırlanıyor", IN_PRODUCTION: "üretimde", READY: "hazır", SHIPPED: "taşıyıcıda", DELIVERED: "teslim edildi", CANCELLED: "iptal", FAILED: "teslim edilemedi", HATA: "hata" };
export const FIELD_TR: Record<string, string> = { "vault.in_vault_mg": "kasada", "vault.placing_mg": "kasaya konuluyor", "vault.shipping_mg": "sevkiyatta", "current_account.gold_mg": "cari hesap altın (T)", "current_account.money.USD": "cari hesap USD", "current_account.money.EUR": "cari hesap EUR", "current_account.money.AED": "cari hesap AED" };

export interface RequestLogRow {
  id: number; ts: string; direction: "GİDEN" | "GELEN"; method: string; path: string;
  status: number; duration_ms: number; actor: string | null; body_sha256: string | null; bytes: number; error: string | null;
}
export interface RequestSummary {
  last_24h: number; errors_24h: number; avg_ms: number; outgoing_24h: number; incoming_24h: number;
  total: number; oldest_ts: string | null; retention_days: number; max_rows: number;
}
