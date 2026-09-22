/**
 * Sağlık ucu (GET /health).
 *
 * Rafineri tarafındaki karşılığıyla aynı biçimi kullanır: alt sistemler ayrı ayrı,
 * her biri tek cümlelik açıklamayla. Kanzasset'e özgü olanlar: KZ kaydının eşleşme durumu,
 * K1 ve K2 kontrolleri, mint ve kasa çıkışı blokeleri.
 *
 * Genel durum:
 *   ok        her şey yerinde
 *   degraded  çalışıyor ama ilgilenilmesi gereken bir şey var (soket kopuk, işlemler durdu, RECONCILE)
 *   down      iş göremez: kalıcı durum yazılamıyor ya da bir kontrol (K1, K2) bozuk
 *
 * HTTP kodu yalnız `down` durumunda 503'tür.
 */
import type { PriceClientState } from "./priceClient.ts";
import { checks, type KzRecord } from "./record.ts";

type Level = "ok" | "degraded" | "down";
interface Check { status: Level; detail: string; [k: string]: unknown }

export interface HealthDeps {
  socket: () => PriceClientState;
  record: () => KzRecord;
  trading: () => { open: boolean; reason: string };
  store: () => { path: string; ok: boolean; error: string | null };
  counts: () => { orders: number; open_orders: number; unanswered: number; late_fills: number; events: number; last_event_ts: string | null; notices_unread: number };
  vault: () => { open: number; holds: number; awaiting_mint: number; mint_block: string | null; vault_out_block: string | null };
  settlement: () => { open_id: string | null; open_status: string | null };
  amrUrl: string;
}

const STARTED = Date.now();
const worst = (a: Level, b: Level): Level => (a === "down" || b === "down" ? "down" : a === "degraded" || b === "degraded" ? "degraded" : "ok");
const ageS = (ts: string | null | undefined) => (ts ? Math.round((Date.now() - Date.parse(ts)) / 1000) : null);

export function healthSnapshot(d: HealthDeps) {
  const checksOut: Record<string, Check> = {};

  // 1. Kalıcı durum: KZ kaydı, emirler ve olaylar burada durur; yazılamıyorsa iş yapılamaz.
  const st = d.store();
  checksOut.store = { status: st.ok ? "ok" : "down", detail: st.ok ? `yazılıyor: ${st.path}` : `yazılamıyor: ${st.error ?? "bilinmeyen hata"}`, path: st.path };

  // 2. Rafineri fiyat soketi: kopuk ya da bayatsa müşteri işlemleri kendiliğinden durur.
  const s = d.socket();
  const socketOk = s.connection === "SUBSCRIBED" && !s.stale;
  checksOut.socket = {
    status: socketOk ? "ok" : "degraded",
    detail: socketOk ? `abone, seq ${s.seq}, son mesaj ${ageS(s.lastMsgTs) ?? "?"} sn önce` : s.stale ? "fiyat bayat (10 sn mesaj yok)" : `bağlı değil (${s.connection})${s.lastError ? ": " + s.lastError : ""}`,
    connection: s.connection, url: s.url, stale: s.stale, tradable: s.tradable, halt_reason: s.haltReason,
    seq: s.seq, last_msg_age_s: ageS(s.lastMsgTs), gaps: s.gaps, reconnect_attempt: s.reconnectAttempt, last_error: s.lastError,
  };

  // 3. Müşteri işlemleri: açık mı, değilse neden.
  const t = d.trading();
  checksOut.trading = { status: t.open ? "ok" : "degraded", detail: t.open ? "açık" : `durdu: ${t.reason}`, open: t.open, reason: t.reason || null };

  // 4. KZ kaydı: rafineriden gelen bakiye bilgisiyle eşleşiyor mu (02).
  const r = d.record();
  checksOut.record = {
    status: r.match === "RECONCILE" ? "degraded" : "ok",
    detail: r.match === "RECONCILE" ? `uyuşmazlık: ${r.diffs.map((x) => x.field).join(", ")}` : r.match === "BEKLİYOR" ? "ilk karşılaştırma yapılmadı" : `eşit, seq ${r.seq}`,
    match: r.match, seq: r.seq, diffs: r.diffs, last_compare_age_s: ageS(r.lastCompareTs),
    blocked_mint: r.blocked.mint, blocked_vault_out: r.blocked.vault_out,
  };

  // 5. Kontroller: K1 A ≤ V ve K2 S + T = K. Bozuksa işlem yapılmaz.
  const c = checks(r);
  const ctrlOk = c.k1.ok && c.k2.ok;
  checksOut.controls = {
    status: ctrlOk ? "ok" : "down",
    detail: ctrlOk ? `K1 ${c.k1.text} · K2 ${c.k2.text}` : `bozuk kontrol: ${[!c.k1.ok ? "K1 " + c.k1.text : "", !c.k2.ok ? "K2 " + c.k2.text : ""].filter(Boolean).join(" · ")}`,
    k1: c.k1, k2: c.k2, c_mg: c.c_mg, e_mg: c.e_mg, v_mg: c.v_mg,
  };

  // 6. Kasa talimatları: mint ya da kasa çıkışı bloke mi, tavan yüzünden duran talep var mı.
  const v = d.vault();
  const vaultBad = !!v.mint_block || !!v.vault_out_block;
  checksOut.vault = {
    status: vaultBad ? "degraded" : "ok",
    detail: v.mint_block ? `mint bloke: ${v.mint_block}` : v.vault_out_block ? `kasa çıkışı bloke: ${v.vault_out_block}` : `${v.open} açık talep, ${v.holds} tavanda bekliyor`,
    ...v,
  };

  // 7. Emirler ve rafineri olayları: cevapsız emir ve geç fill karar bekler.
  const n = d.counts();
  const ordersBad = n.unanswered > 0 || n.late_fills > 0;
  checksOut.orders = {
    status: ordersBad ? "degraded" : "ok",
    detail: ordersBad ? `${n.unanswered} cevapsız emir, ${n.late_fills} geç fill karar bekliyor` : `${n.orders} emir, ${n.open_orders} açık`,
    ...n,
  };
  checksOut.events = {
    status: "ok",
    detail: n.events > 0 ? `${n.events} olay alındı, sonuncusu ${ageS(n.last_event_ts) ?? "?"} sn önce` : "henüz olay alınmadı",
    received: n.events, last_event_age_s: ageS(n.last_event_ts), refinery: d.amrUrl,
  };

  const w = d.settlement();
  checksOut.settlement = { status: "ok", detail: w.open_id ? `açık pencere ${w.open_id} (${w.open_status})` : "açık pencere yok", open_id: w.open_id, open_status: w.open_status };

  const status = Object.values(checksOut).reduce<Level>((acc, x) => worst(acc, x.status), "ok");
  return { status, ts: new Date().toISOString(), uptime_s: Math.round((Date.now() - STARTED) / 1000), refinery: d.amrUrl, checks: checksOut };
}
