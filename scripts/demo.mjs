#!/usr/bin/env node
/**
 * KZ simülatörü: S0'dan S9'a demo senaryoları (teslim paketi, Sprint 6).
 *
 * İki sunucu ayakta olmalı: rafineri (4000) ve Kanzasset (5000). Başka portta çalışıyorlarsa AMR_URL / KZ_URL ile verilir
 * (ör. KZ_URL=http://localhost:5050 npm run demo).
 *   npm run demo            tüm senaryolar, aralarında 3 sn
 *   npm run demo -- S3 S7   yalnız seçilenler
 *   DEMO_GAP_MS=1000 npm run demo   bekleme süresini değiştir
 *
 * Her adımda ne olduğu Türkçe yazılır; ekranlar gerçek veriyle dolar.
 * Rafineri tarafında elle yapılan işler (kasa talebi kabulü, lojistik fiyatı,
 * teklif, sevkiyat, teslim) simülatör tarafından da yapılır; DEMO_MANUAL=1 ile
 * bu adımlar bırakılır ve ekrandan elle yapılması beklenir.
 */
const AMR = process.env.AMR_URL ?? "http://localhost:4000";
const KZ = process.env.KZ_URL ?? "http://localhost:5000";
const GAP = Number(process.env.DEMO_GAP_MS ?? 3000);
const MANUAL = process.env.DEMO_MANUAL === "1";

const g = (mg) => (mg / 1000).toLocaleString("tr-TR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const money = (c) => (c / 100).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let step = 0;
const title = (s) => console.log(`\n\x1b[1m\x1b[36m${s}\x1b[0m`);
const say = (s) => console.log(`  ${s}`);
const act = (s) => console.log(`  \x1b[33m→\x1b[0m ${s}`);
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[31m!\x1b[0m ${s}`);

async function call(base, path, opts = {}) {
  const res = await fetch(base + path, {
    method: opts.body ? "POST" : (opts.method ?? "GET"),
    headers: { "content-type": "application/json", ...(opts.user ? { "x-user": opts.user } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    ...(opts.method ? { method: opts.method } : {}),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const kz = (p, o) => call(KZ, p, o);
const amr = (p, o) => call(AMR, p, o);

/**
 * Kanzasset tarafında kritik aksiyon: tek kişiyle geçmez.
 * İsteyen açar (202 + onay numarası), farklı bir kullanıcı onaylar, ancak o zaman uygulanır.
 */
async function kzApproved(path, body, maker = "hazineci", approver = "yonetici") {
  const r = await kz(path, { body, user: maker });
  if (!r?.needs_approval) return r;
  say(`\x1b[2mikinci onay: isteyen ${maker}, onaylayan ${approver} (aynı kişi onaylayamaz)\x1b[0m`);
  return kz(path, { body: { ...body, approval_id: r.approval_id, approver }, user: maker });
}

async function status() { return kz("/api/refinery/status"); }

/** Durumu tek satırda yazar: iki defterin özeti ve kontroller. */
async function snapshot(note = "") {
  const s = await status();
  const r = s.record;
  say(`\x1b[2mdurum${note ? " (" + note + ")" : ""}: S ${g(r.stock.s_mg)} · T ${g(r.current_account.gold_mg)} · K ${g(r.stock.k_mg)} · A ${g(r.stock.a_mg)} · kasada ${g(r.vault.in_vault_mg)} · USD ${money(r.current_account.money.find((m) => m.ccy === "USD").cents)}\x1b[0m`);
  say(`\x1b[2m         eşleşme ${r.match} · K1 ${s.checks.k1.ok ? "✓" : "✗"} · K2 ${s.checks.k2.ok ? "✓" : "✗"}\x1b[0m`);
  return s;
}

/** Rafineride bekleyen kasa talebini kabul eder (demoda simülatör yapar). */
async function acceptVault(label) {
  if (MANUAL) { warn(`R4 ekranından kasa talebini elle kabul edin (${label})`); return null; }
  for (let i = 0; i < 20; i++) {
    const v = await amr("/admin/vault");
    if (v.pending.length) {
      const req = v.pending[0];
      const r = await amr(`/admin/vault/${req.request_id}/accept`, { body: {}, user: "kasa" });
      ok(`rafineri kabul etti: ${label} ${g(req.qty_mg)} g · ${r.doc_id}`);
      return r;
    }
    await sleep(400);
  }
  warn(`bekleyen kasa talebi bulunamadı (${label})`);
  return null;
}

/** Teklif olayının Kanzasset'e ulaşmasını bekler (webhook birkaç saniye sürebilir). */
async function waitQuoted(kind, id) {
  const ok = await waitFor(async () => {
    const f = await kz("/api/fulfilment");
    const list = kind === "DELIVERY" ? f.deliveries : f.refinings;
    return list.find((x) => x.id === id)?.status === "QUOTED";
  }, 12000);
  if (!ok) warn("teklif olayı Kanzasset'e ulaşmadı");
  return ok;
}

/** Olayların (webhook) iki tarafa yerleşmesi için kısa bekleme; anlık görüntü doğru olsun. */
async function settleEvents(ms = 1500) { await sleep(ms); }

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(300); }
  return false;
}

// ---------------- senaryolar ----------------

const SCENARIOS = {
  async S0() {
    title("S0 · Açılış devri: 20 kg kasada, 20.000 AGOLD karşılığı");
    const s = await status();
    say(`rafineri yayını: ${s.socket.connection}, müşteri işlemleri ${s.trading.open ? "açık" : "kapalı"}`);
    say(`açılış devri kasada duruyor; hazine stoku ve envanter hedefi eşit`);
    await snapshot("açılış");
    if (s.record.stock.s_mg !== s.record.stock.k_mg) warn("S ile K eşit değil: açılış devirleri (VAULT_OPENING_MG / KZ_OPENING_MG) aynı olmalı");
    // 15 kg büyük alışta T geçici olarak 15 kg'ı aşar; cari hesap limiti buna göre açılır (K9 Ayarlar)
    act("demo için cari hesap altın limiti 25.000 g yapılıyor (büyük alışta T geçici olarak 15 kg'ı aşar)");
    await setSetting({ "limit.current_account_gold_mg": String(25_000_000) });
    ok("limit ayarlandı; parametre değişikliği ikinci onaydan geçti (Yönetici ister, Masa onaylar)");
  },

  async S1() {
    title("S1 · Stoktan alış: müşteri 70,104 g AGOLD alıyor");
    say("sıra: bloke → rafineride alış emri → teslim → tahsilat");
    const o = await kz("/api/orders", { body: { side: "BUY", qty_mg: 70_104, ccy: "USD" } });
    ok(`emir ${o.id} · ${o.status} · rafineri fiyatı ${o.refinery?.fill?.px} · müşteri fiyatı ${o.client_px}`);
    say(`müşteri toplamı ${money(o.client_total_cents)} USD (komisyon ${money(o.commission_cents)} ayrı satır)`);
    say(`akış: ${o.flow} · müşteri durumu: ${o.customer_status}`);
    await snapshot();
  },

  async S2() {
    title("S2 · Stoktan satış: müşteri 50 g AGOLD satıyor");
    say("sıra: AGOLD bloke → satış emri → önce ödeme → token stoğa");
    const o = await kz("/api/orders", { body: { side: "SELL", qty_mg: 50_000, ccy: "USD" } });
    ok(`emir ${o.id} · ${o.status} · fill ${o.refinery?.fill?.px} · müşteriye ${money(o.client_total_cents)} USD`);
    await snapshot();
  },

  async S3() {
    title("S3 · Büyük alış: 15.000 g · stok tabanın altına inecek, yeni ihraç gerekiyor");
    const before = await status();
    say(`stok ${g(before.record.stock.s_mg)} g · taban ${g(before.stock.floorMg)} g`);
    const o = await kz("/api/orders", { body: { side: "BUY", qty_mg: 15_000_000, ccy: "USD" } });
    if (o.status !== "FILLED") { warn(`emir ${o.status}${o.reject_reason ? ` · ${o.reject_reason}` : ""} · zincir kurulmadı`); await snapshot(); return; }
    ok(`emir ${o.id} · fiyat fill'de kilitlendi (${o.refinery.fill.px}) · akış ${o.flow}`);
    if (o.chain_mg) say(`eksik ${g(o.chain_mg)} g için kasa girişi istendi · müşteri durumu: ${o.customer_status}`);
    await acceptVault("kasa girişi");
    const delivered = await waitFor(async () => (await kz(`/api/orders/${o.id}`)).customer_status === "TESLİM EDİLDİ");
    if (delivered) {
      ok(`mint tamamlandı, ${g(o.qty_mg)} g TEK SEFERDE teslim edildi (kısmi teslim yok)`);
      say(`müşteriye ifşa: "emriniz yeni ihraçla karşılandı"`);
    } else warn("teslim tamamlanmadı: mint bloke ya da kasa talebi kabul edilmedi");
    await settleEvents();
    await snapshot("stok tabana indi");
  },

  async S4() {
    title("S4 · Büyük satış: 10.000 g · stok tavanı aşılacak, fazla yakılacak");
    const before = await status();
    say(`stok ${g(before.record.stock.s_mg)} g · tavan ${g(before.stock.ceilingMg)} g · hedef ${g(before.stock.targetMg)} g`);
    // tavanı gerçekten aşacak kadar sat: stok + satış > tavan
    const needed = before.stock.ceilingMg - before.record.stock.s_mg + 500_000;
    const qty = Math.min(before.checks.c_mg, Math.max(10_000_000, needed));
    if (qty < 1_000) { warn("müşteride satacak token yok, büyük satış atlanıyor"); return; }
    say(`müşteride ${g(before.checks.c_mg)} g var; tavanı aşmak için ${g(qty)} g satılıyor`);
    const o = await kz("/api/orders", { body: { side: "SELL", qty_mg: qty, ccy: "USD" } });
    ok(`emir ${o.id} · ${o.status} · akış ${o.flow}`);
    if (o.chain_mg) say(`fazla ${g(o.chain_mg)} g burn edildi, kasa çıkışı istendi`);
    await acceptVault("kasa çıkışı");
    await settleEvents();
    await snapshot("stok hedefe döndü");
  },

  async S5() {
    title("S5 · Kasa talimatları: elle giriş ve çıkış");
    const s = await status();
    const t = s.record.current_account.gold_mg;
    if (t > 0) {
      act(`cari hesapta ${g(t)} g var: kasa girişi isteniyor`);
      const i = await kz("/api/vault", { body: { type: "IN", qty_mg: t, reason: "demo: cari hesabı kapat" } });
      say(`talimat ${i.ref} · durum ${i.status}`);
      await acceptVault("kasa girişi");
      say("fiş geldi → mint yapıldı (mint yalnız Kasa Giriş Fişi'ne karşı)");
    } else {
      act("cari hesap sıfır: 1.000 g kasa çıkışı isteniyor (burn önce)");
      const o = await kz("/api/vault", { body: { type: "OUT", qty_mg: 1_000_000, reason: "demo: kasa çıkışı" } });
      say(`burn yapıldı, sonra talimat ${o.ref} gönderildi · durum ${o.status}`);
      await acceptVault("kasa çıkışı");
    }
    await settleEvents();
    const v = await kz("/api/vault");
    say(`kasaya konuluyor ${g(v.placing_mg)} g · tavan ${g(v.placing_cap_mg)} g · mint ${v.mint_block ?? "açık"}`);
    await snapshot();
  },

  async S6() {
    title("S6 · Cevapsız emir ve geç fill");
    act("rafineride emir kararı 6 sn geciktiriliyor (debug.order_delay_ms)");
    await setSetting({ "debug.order_delay_ms": "6000" });
    say("Kanzasset zaman sınırında cevap alamayacak: durum sorgusu → iptal talebi (kesin cevap)");
    const o = await kz("/api/orders", { body: { side: "BUY", qty_mg: 25_000, ccy: "USD" } });
    say(`emir ${o.id} · ${o.status}`);
    await waitFor(async () => ["CANCELLED", "LATE_FILL", "FILLED"].includes((await kz(`/api/orders/${o.id}`)).status), 15000);
    const after = await kz(`/api/orders/${o.id}`);
    ok(`sonuç: ${after.status} · müşteri durumu ${after.customer_status}`);
    for (const t of after.timeline.slice(-4)) say(`  · ${t.text}`);
    if (after.status === "LATE_FILL") {
      act("geç fill: müşteriye teslim yok, hazine pozisyon kararı veriyor (ters emirle kapat)");
      try { await kz(`/api/orders/${after.id}/decision`, { body: { decision: "CLOSE" } }); ok("pozisyon ters emirle kapatıldı"); }
      catch (e) { warn(`kapatma yapılamadı: ${e.message}`); }
    }
    await setSetting({ "debug.order_delay_ms": "0" });
    say("gecikme kapatıldı");
    await snapshot();
  },

  async S7() {
    title("S7 · Fiziksel teslimat: müşteri külçe istiyor");
    const s = await status();
    const c = s.checks.c_mg;
    const qty = Math.min(1_000_000, Math.max(1_000, c));
    if (qty < 1_000) { warn("müşteride dolaşan token yok, teslimat atlanıyor"); return; }
    const d = await kz("/api/deliveries", { body: { qty_mg: qty, address_ref: "ADR-77", insured_party_ref: "SIG-77" } });
    ok(`talep ${d.id} · ${g(qty)} g emanete alındı (burn cüzdanı), henüz yakılmadı`);
    const rid = await waitForRefinery("/admin/deliveries", (x) => x.ref === d.id);
    if (!rid) { warn("rafineride talep görünmedi"); return; }
    if (MANUAL) { warn("R6 ekranından lojistik fiyatı girin ve adımları yürütün"); return; }
    act("rafineri lojistik fiyatını giriyor (taşıyıcıdan alınan)");
    const q = await amr(`/admin/deliveries/${rid}/quote`, { body: { carrier: "Brinks", amount: "450.00", ccy: "USD" }, user: "masa" });
    say(`Lojistik Teklifi ${q.quote.doc_id} · ${money(q.quote.amount_cents)} USD · 24 saat geçerli`);
    if (!(await waitQuoted("DELIVERY", d.id))) return;
    act("Kanzasset müşteri onayından sonra teklifi onaylıyor");
    await kz(`/api/deliveries/${d.id}/approve`, { body: {} });
    say("masraf cari hesaba kalem oldu; Kanzasset komisyon almaz, müşteriden aynen alınır");
    for (const [stepName, label] of [["preparing", "hazırlığa alındı"], ["ready", "hazır · Sevkiyat Fişi kesildi, külçe kasadan sevkiyata geçti"]]) {
      await amr(`/admin/deliveries/${rid}/${stepName}`, { body: {}, user: "kasa" });
      say(label);
      await sleep(400);
    }
    await amr(`/admin/deliveries/${rid}/shipped`, { body: { carrier: "Brinks", tracking_no: "TRK-4471" }, user: "kasa" });
    say("taşıyıcıya verildi · takip TRK-4471 · sigorta lehtarı müşteri");
    await sleep(400);
    await amr(`/admin/deliveries/${rid}/delivered`, { body: {}, user: "kasa" });
    ok("teslim edildi · Teslimat Kaydı kesildi · Kanzasset aynı anda burn yaptı");
    await sleep(1200);
    await snapshot("arz ve kasa hesabı aynı anda düştü");
  },

  async S8() {
    title("S8 · Rafinasyon: katalogdan ürün seçimi");
    const cat = await kz("/api/catalog");
    say(`katalog sürüm ${cat.version} · ${cat.items.filter((i) => i.active).length} aktif ürün`);
    const s = await status();
    if (s.checks.c_mg < 600_000) { warn("müşteride dolaşan token yetersiz, rafinasyon atlanıyor"); return; }
    const r = await kz("/api/refining", { body: { items: [{ item_id: "100g", qty: 5 }, { item_id: "10g", qty: 10 }], address_ref: "ADR-12", insured_party_ref: "SIG-12" } });
    ok(`talep ${r.id} · ${r.items.map((l) => `${l.qty} × ${l.name}`).join(", ")} · toplam ${g(r.total_mg)} g emanette`);
    const rid = await waitForRefinery("/admin/refining", (x) => x.ref === r.id);
    if (!rid) { warn("rafineride talep görünmedi"); return; }
    if (MANUAL) { warn("R7 ekranından teklif verin ve üretimi yürütün"); return; }
    act("rafineri teklif veriyor: ürün bedeli + lojistik + üretim süresi");
    const q = await amr(`/admin/refining/${rid}/quote`, { body: { product: "1900.00", logistics: "600.00", ccy: "USD", lead_time_days: 7 }, user: "uretim" });
    say(`Rafinasyon Teklifi ${q.quote.doc_id} · ürün ${money(q.quote.product_cents)} + lojistik ${money(q.quote.logistics_cents)} USD · ${q.quote.lead_time_days} gün`);
    if (!(await waitQuoted("REFINING", r.id))) return;
    const ap = await kz(`/api/refining/${r.id}/approve`, { body: {} });
    say(`onaylandı · rafineriye ${money(q.quote.product_cents + q.quote.logistics_cents)} USD · müşteriye ${money(ap.customer_price_cents)} USD (marj + komisyon dahil)`);
    for (const [stepName, label] of [["production", "üretime alındı"], ["ready", "hazır · Sevkiyat Fişi"]]) {
      await amr(`/admin/refining/${rid}/${stepName}`, { body: {}, user: "uretim" });
      say(label);
      await sleep(400);
    }
    await amr(`/admin/refining/${rid}/shipped`, { body: { carrier: "Brinks", tracking_no: "TRK-9902" }, user: "kasa" });
    await sleep(300);
    await amr(`/admin/refining/${rid}/delivered`, { body: {}, user: "kasa" });
    ok("teslim edildi · burn yapıldı");
    await sleep(1200);
    await snapshot();
  },

  async S9() {
    title("S9 · Mahsuplaşma: kesim, mutabakat, altın ve para bacağı");
    const before = await status();
    say(`kapanacak: T ${g(before.record.current_account.gold_mg)} g · USD ${money(before.record.current_account.money.find((m) => m.ccy === "USD").cents)}`);
    act("rafineride kesim elle tetikleniyor (normalde 17:00 Dubai'de kendiliğinden)");
    const w = await amr("/admin/settlements", { body: { trigger: "CUTOFF", reason: "demo: kesim" }, user: "masa" });
    ok(`pencere ${w.settlement_id} · ${w.status} · ekstre imzalandı`);
    say(`altın bacağı: ${w.gold_leg.direction} ${g(w.gold_leg.qty_mg)} g`);
    say(`para bacağı: ${w.money_leg.filter((m) => m.net_cents).map((m) => `${m.ccy} ${money(m.net_cents)} ${m.direction}`).join(" · ") || "yok"}`);
    await sleep(2000);
    const k1 = await kz("/api/settlements");
    if (k1.open) ok(`Kanzasset mutabakatı yaptı: ${k1.open.status}${k1.open.diffs?.length ? ` · ${k1.open.diffs.length} fark` : " · iki ekstre birebir eşit"}`);
    if (w.gold_leg.direction === "VAULT_IN") {
      // rafineri gram borçlu: önce "kasaya koyalım mı" teklifi, Kanzasset onaylayınca kasa girişi talebi gider
      act("altın bacağı: rafineri kasaya koymayı teklif etti, Kanzasset onaylıyor");
      await kz(`/api/settlements/${w.settlement_id}/gold/approve`, { body: {} });
      await acceptVault("mahsuplaşma altın bacağı (fiş kesilince mint)");
    } else if (w.gold_leg.direction === "VAULT_OUT") {
      // Kanzasset gram borçlu: önce token yakılır, sonra kasa çıkışı talebi gider
      act("altın bacağı: Kanzasset önce token yakıyor, sonra kasa çıkışı talebi gönderiyor");
      await kz(`/api/settlements/${w.settlement_id}/gold-leg`, { body: {} });
      await acceptVault("mahsuplaşma altın bacağı (burn önce, talep sonra)");
    }
    for (const m of w.money_leg.filter((x) => x.net_cents !== 0)) {
      act(`para bacağı ${m.ccy}: ${m.direction === "KZ_TO_AMR" ? "Kanzasset şirket hesabından öder" : "rafineri öder"}`);
      try { await kzApproved(`/api/settlements/${w.settlement_id}/pay`, { ccy: m.ccy }); ok(`${m.ccy} bacağı kapandı`); }
      catch (e) { warn(`${m.ccy}: ${e.message}`); }
    }
    await sleep(1500);
    const fin = await amr("/admin/settlements");
    const f = fin.items[0];
    ok(`pencere ${f.status}${f.doc_id ? ` · Mahsuplaşma Ekstresi ${f.doc_id}` : ""}`);
    await snapshot("limit sayaçları sıfırlandı");

    title("S9c · Gün içi tek bacak: yalnız USD mahsuplaşması");
    act("önce küçük bir stoktan alış: hem gram hem USD borcu birikiyor");
    const small = await kz("/api/orders", { body: { side: "BUY", qty_mg: 25_000, ccy: "USD" } });
    const st0 = await status();
    say(`emir ${small.id} · şimdi T ${g(st0.record.current_account.gold_mg)} g · USD ${money(st0.record.current_account.money.find((m) => m.ccy === "USD").cents)}`);
    act("Kanzasset yalnız USD bacağı için pencere açıyor (altın ve diğer kurlar dokunulmaz)");
    const one = await kz("/api/settlements", { body: { trigger: "REQUEST_KZ", reason: "demo: yalnız USD", scope: ["USD"] } });
    say(`kapsam ${one.scope ? one.scope.join(" + ") : "USD"} · bacak sayısı ${one.money_leg.length}${one.gold_leg && one.gold_leg.direction !== "NONE" ? " + altın" : " (altın kapsam dışı)"}`);
    await sleep(1500);
    const oneAmr = (await amr("/admin/settlements")).items[0];
    ok(`rafineri penceresi ${oneAmr.settlement_id} · kapsam ${(oneAmr.scope ?? []).join(" + ")} · ${oneAmr.status}`);
    for (const m of oneAmr.money_leg.filter((x) => x.net_cents !== 0)) {
      try { await kzApproved(`/api/settlements/${oneAmr.settlement_id}/pay`, { ccy: m.ccy }); ok(`${m.ccy} bacağı kapandı`); }
      catch (e) { warn(`${m.ccy}: ${e.message}`); }
    }
    await sleep(1200);
    const oneFin = (await amr("/admin/settlements")).items[0];
    const st1 = await status();
    ok(`tek bacaklı pencere ${oneFin.status} · USD ${money(st1.record.current_account.money.find((m) => m.ccy === "USD").cents)} · altın T ${g(st1.record.current_account.gold_mg)} g (dokunulmadı)`);

    title("S9b · Eşleşme uyuşmazlığı ve çözümü");
    act("KZ kaydı bilerek 1 g kaydırılıyor (demo ucu)");
    await kz("/api/debug/record-skew", { body: { gold_mg: 1000 } });
    const o = await kz("/api/orders", { body: { side: "BUY", qty_mg: 10_000, ccy: "USD" } });
    const after = await kz(`/api/orders/${o.id}`);
    if (after.match === "RECONCILE") {
      warn("eşleşme uyuşmazlığı: KZ kaydı ≠ bakiye bilgisi → RECONCILE, mint ve kasa çıkışı bloke");
      act("anlık fotoğraf alınıp açıklama ile çözülüyor");
      await kzApproved("/api/record/resolve", { explanation: "demo: kayıt kaydırma senaryosu, rafineri fotoğrafı esas alındı" });
      ok("RECONCILE çözüldü, bloke kalktı");
    } else say(`eşleşme: ${after.match ?? "?"}`);
    await snapshot("çözüm sonrası");
  },
};

async function setSetting(values) {
  // parametre değişikliği ikinci onay ister: iste, sonra farklı kullanıcıyla onayla
  const r = await amr("/admin/settings", { method: "PUT", body: values, user: "yonetici" });
  if (r?.needs_approval) await amr("/admin/settings", { method: "PUT", body: { ...values, approval_id: String(r.approval_id), approver: "masa" }, user: "yonetici" });
}

async function waitForRefinery(path, pred) {
  for (let i = 0; i < 20; i++) {
    const r = await amr(path);
    const hit = r.items.find(pred);
    if (hit) return hit.delivery_id ?? hit.refining_id;
    await sleep(400);
  }
  return null;
}

// ---------------- koşum ----------------

async function main() {
  const want = process.argv.slice(2).filter((a) => /^S\d$/i.test(a)).map((a) => a.toUpperCase());
  const names = want.length ? want : Object.keys(SCENARIOS);

  console.log("\x1b[1mKanzasset ↔ AMR · demo senaryoları\x1b[0m");
  console.log(`rafineri ${AMR} · Kanzasset ${KZ} · adımlar arası ${GAP} ms${MANUAL ? " · elle mod" : ""}`);

  // hangi tarafa ulaşılamadığı ayrı ayrı söylenir: en sık sebep Kanzasset'in başka portta olmasıdır (PORT=5050)
  const reach = async (name, url, fn, envVar) => {
    try { await fn("/health"); return null; }
    catch { return `  ${name.padEnd(10)} ${url} yanıt vermiyor · ${envVar}=<adres> ile değiştirebilirsiniz`; }
  };
  const down = (await Promise.all([reach("rafineri", AMR, amr, "AMR_URL"), reach("Kanzasset", KZ, kz, "KZ_URL")])).filter(Boolean);
  if (down.length) {
    console.error(`\n\x1b[31mSunuculara ulaşılamadı.\x1b[0m\n${down.join("\n")}\n\nÖnce iki tarafı başlatın:\n  amr-app:     npm run dev\n  kz-treasury: npm run dev   (başka portta ise: PORT=5050 npm run dev, demoyu KZ_URL=http://localhost:5050 npm run demo ile çalıştırın)\n`);
    process.exit(1);
  }

  // açılış devri olmadan senaryolar yürümez: kasada gram, karşılığında token yoktur
  const opening = await status().catch(() => null);
  if (opening && opening.record.vault.in_vault_mg === 0 && opening.record.stock.k_mg === 0) {
    console.error("\n\x1b[31mAçılış devri yok.\x1b[0m Kasada gram, karşılığında stok görünmüyor: senaryolar teslimat ve mahsuplaşma adımlarında takılır.\n" +
      "Defterler ilk kurulduğunda yazılır, o yüzden veriyi silip sunucuları açılış devriyle başlatın:\n" +
      "  amr-app:     rm -f apps/amr-server/data/amr.db* && VAULT_OPENING_MG=20000000 npm run dev\n" +
      "  kz-treasury: rm -rf apps/kz-server/data && KZ_OPENING_MG=20000000 npm run dev\n" +
      "İki taraftaki rakam aynı olmalı (20000000 mg = 20 kg), yoksa K2 tutmaz.\n");
    process.exit(1);
  }
  // iki defter baştan farklıysa mint bloke olur ve senaryolar teslimat adımında takılır:
  // en sık sebep bir tarafı sıfırlayıp diğerini eski veriyle bırakmaktır.
  // BEKLİYOR sorun değildir: temiz kurulumda henüz karşılaştırma yapılmamıştır, ilk harekette yapılır.
  if (opening && opening.record.match === "RECONCILE") {
    console.error(`\n\x1b[31mİki defter baştan farklı (${opening.record.match}).\x1b[0m KZ kaydı ile rafineri bakiye bilgisi tutmuyor: mint bloke olur, senaryolar teslimat adımında takılır.\n` +
      "İki tarafı birlikte sıfırlayın, önce ikisini de durdurup sonra silin:\n" +
      "  amr-app:     rm -f apps/amr-server/data/amr.db* && VAULT_OPENING_MG=20000000 npm run dev\n" +
      "  kz-treasury: rm -rf apps/kz-server/data && KZ_OPENING_MG=20000000 npm run dev\n" +
      "Sunucu ayaktayken silmek işe yaramaz: eski defter dosya açık olduğu için yaşamaya devam eder.\n");
    process.exit(1);
  }

  // rafineri olayları kayıtlı adrese gönderir: Kanzasset başka bir portta çalışıyorsa (ör. 5050)
  // olaylar boşluğa gider, fiş gelmez, mint olmaz ve senaryolar teslimat adımında takılır
  const clients = await amr("/admin/clients").catch(() => null);
  const target = clients?.find((c) => c.active && c.event_url)?.event_url;
  if (target) {
    const port = (u) => { try { const x = new URL(u); return x.port || (x.protocol === "https:" ? "443" : "80"); } catch { return null; } };
    if (port(target) !== port(KZ)) {
      console.error(`\n\x1b[31mRafineri olayları başka adrese gidiyor.\x1b[0m Kayıtlı olay adresi ${target}, Kanzasset ise ${KZ}.\n` +
        "Olaylar (fiş, kabul, mahsuplaşma) yerine ulaşmaz: mint olmaz, teslimat adımı \"token yetersiz\" der.\n" +
        `Rafineriyi olay adresiyle başlatın:\n  amr-app: KZ_EVENT_URL=${new URL("/api/events", KZ).href} VAULT_OPENING_MG=20000000 npm run dev\n`);
      process.exit(1);
    }
  }

  for (const name of names) {
    const fn = SCENARIOS[name];
    if (!fn) { console.log(`\n(${name} yok, atlandı)`); continue; }
    step++;
    try { await fn(); }
    catch (e) { warn(`${name} sırasında hata: ${e.message}`); }
    if (name !== names[names.length - 1]) await sleep(GAP);
  }

  title("Kapanış · kontroller");
  const s = await status();
  const r = s.record;
  console.log(`  S ${g(r.stock.s_mg)} g · T ${g(r.current_account.gold_mg)} g · K ${g(r.stock.k_mg)} g · A ${g(r.stock.a_mg)} g · E ${g(r.stock.e_mg ?? 0)} g`);
  console.log(`  kasada ${g(r.vault.in_vault_mg)} · kasaya konuluyor ${g(r.vault.placing_mg)} · sevkiyatta ${g(r.vault.shipping_mg)}`);
  console.log(`  para: ${r.current_account.money.map((m) => `${m.ccy} ${money(m.cents)}`).join(" · ")}`);
  console.log("");
  console.log(`  K1  ${s.checks.k1.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}  ${s.checks.k1.text}`);
  console.log(`  K2  ${s.checks.k2.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}  ${s.checks.k2.text}`);
  console.log(`  Eşleşme: ${r.match === "EŞİT" ? "\x1b[32mEŞİT\x1b[0m (KZ kaydı ile rafineri bakiye bilgisi birebir aynı)" : `\x1b[31m${r.match}\x1b[0m`}`);
  const good = s.checks.k1.ok && s.checks.k2.ok && r.match === "EŞİT";
  console.log(`\n${good ? "\x1b[32m\x1b[1mTüm kontroller tutuyor, iki defter eşit.\x1b[0m" : "\x1b[31m\x1b[1mDikkat: kontrollerden biri tutmuyor.\x1b[0m"}`);
  process.exit(good ? 0 : 1);
}

main().catch((e) => { console.error("demo hatası:", e); process.exit(1); });
