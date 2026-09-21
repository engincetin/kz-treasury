/**
 * AMR fiyat soketi istemcisi (Akışlar 01, KZ tarafı kuralları):
 *  - bağlan → auth (HMAC) → subscribed → snapshot → tick / heartbeat / halt / resume
 *  - 10 sn hiçbir mesaj yok → fiyat bayat → müşteri tarafı durur
 *  - seq atladı → yeniden abone ol (bağlantıyı yenile), snapshot bekle
 *  - kopma → üstel bekleme ile yeniden bağlan (1, 2, 4, 8, 16, 30 sn)
 *  - her emirde kullanılan tick'in seq'i quote_seq olur (emirler Sprint 2)
 */
import WebSocket from "ws";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { PRICE_SOCKET, signingString, type PriceLevel, type WsServerMessage } from "@amr/contract";

export interface PriceClientState {
  url: string;
  connection: "DISCONNECTED" | "CONNECTING" | "AUTHENTICATING" | "SUBSCRIBED";
  tradable: boolean; // rafineri yayın bayrağı
  haltReason: string | null;
  stale: boolean; // 10 sn mesaj yok
  seq: number;
  lastMsgTs: string | null;
  lastTickTs: string | null;
  lastPrices: PriceLevel[] | null;
  reconnectAttempt: number;
  gaps: number; // tespit edilen seq boşluğu sayısı
  lastError: string | null;
}

export class PriceClient extends EventEmitter {
  state: PriceClientState;
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(private url: string, private apiKey: string, private secret: string) {
    super();
    this.state = {
      url, connection: "DISCONNECTED", tradable: false, haltReason: null, stale: false, seq: 0,
      lastMsgTs: null, lastTickTs: null, lastPrices: null, reconnectAttempt: 0, gaps: 0, lastError: null,
    };
  }

  start() {
    this.stopped = false;
    this.open();
    this.staleTimer = setInterval(() => this.checkStale(), 500);
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.ws?.close();
  }

  private set(patch: Partial<PriceClientState>) {
    Object.assign(this.state, patch);
    this.emit("state", { ...this.state });
  }

  private open() {
    if (this.stopped) return;
    this.set({ connection: "CONNECTING" });
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on("open", () => {
      const ts = new Date().toISOString();
      const sig = createHmac("sha256", this.secret).update(signingString(ts, "GET", PRICE_SOCKET.path)).digest("hex");
      ws.send(JSON.stringify({ type: "auth", api_key: this.apiKey, ts, sig }));
      this.set({ connection: "AUTHENTICATING" });
    });
    ws.on("message", (raw) => this.onMessage(JSON.parse(raw.toString()) as WsServerMessage));
    ws.on("error", (e) => this.set({ lastError: e.message }));
    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const wasLive = this.state.connection === "SUBSCRIBED" || this.state.connection === "AUTHENTICATING";
      this.set({ connection: "DISCONNECTED", tradable: false, lastError: `kapandı (${code} ${reason.toString()})` });
      // Bildirim yalnız canlı bağlantı koptuğunda; başarısız yeniden deneme başına bildirim üretilmez
      if (wasLive) this.emit("notice", { type: "socket.closed", title: "Rafineri fiyat soketi kapandı", body: `${code} ${reason.toString()}` });
      this.scheduleReconnect();
    });
  }

  private onMessage(m: WsServerMessage) {
    const now = new Date().toISOString();
    this.state.lastMsgTs = now;
    if (this.state.stale) this.set({ stale: false });
    switch (m.type) {
      case "subscribed":
        this.set({ connection: "SUBSCRIBED", reconnectAttempt: 0, lastError: null });
        this.emit("notice", { type: "socket.subscribed", title: "Rafineri fiyat soketine abone olundu" });
        break;
      case "snapshot":
        this.set({ seq: m.seq, tradable: m.tradable, lastPrices: m.prices, lastTickTs: m.ts, haltReason: m.tradable ? null : this.state.haltReason });
        this.emit("prices", m);
        break;
      case "tick": {
        if (this.state.seq > 0 && m.seq !== this.state.seq + 1 && m.seq > this.state.seq) {
          // seq boşluğu: yeniden abone ol, snapshot gelir
          this.set({ gaps: this.state.gaps + 1 });
          this.emit("notice", { type: "socket.gap", title: "Fiyat akışında boşluk", body: `beklenen ${this.state.seq + 1}, gelen ${m.seq}; yeniden abone olunuyor` });
          this.resubscribe();
          return;
        }
        this.set({ seq: m.seq, tradable: m.tradable, lastPrices: m.prices, lastTickTs: m.ts });
        this.emit("prices", m);
        break;
      }
      case "heartbeat":
        this.set({ seq: Math.max(this.state.seq, m.seq), tradable: m.tradable });
        break;
      case "halt":
        this.set({ tradable: false, haltReason: m.reason });
        this.emit("notice", { type: "price.halt", title: "Rafineri yayını durdu", body: m.reason });
        break;
      case "resume":
        this.set({ haltReason: null });
        this.emit("notice", { type: "price.resume", title: "Rafineri yayını yeniden açıldı" });
        break;
      case "error":
        this.set({ lastError: `${m.code}: ${m.message}` });
        break;
    }
  }

  private resubscribe() {
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "resubscribe");
    this.open();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const attempt = ++this.state.reconnectAttempt;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
    this.set({ reconnectAttempt: attempt });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), delay);
  }

  private checkStale() {
    if (this.state.connection !== "SUBSCRIBED" || !this.state.lastMsgTs) return;
    const stale = Date.now() - Date.parse(this.state.lastMsgTs) > PRICE_SOCKET.staleMs;
    if (stale !== this.state.stale) {
      this.set({ stale });
      if (stale) this.emit("notice", { type: "price.stale", title: "Rafineri fiyatı bayat", body: "10 sn mesaj yok; müşteri işlemleri durdu" });
    }
  }

  /** Müşteri tarafı fiyat verebilir mi? (elle durdurma ayrı: MarketState) */
  get priceOk(): boolean {
    return this.state.connection === "SUBSCRIBED" && !this.state.stale && this.state.tradable && !!this.state.lastPrices;
  }
}
