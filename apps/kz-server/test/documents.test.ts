/**
 * K12 Belgeler: rafineri belgesinin Kanzasset kopyası.
 * İki taraf da kendi kaydını tutar; kopya alınırken özet yeniden hesaplanır, anahtar varsa imza doğrulanır.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import type { Document, EventEnvelope } from "@amr/contract";
import { DocumentDesk, canonical, docIdsIn, verifyDocument, type KzDocument } from "../src/documents.ts";

const KEY = "amr-doc-dev-key";
function makeDoc(id: string, content: Record<string, unknown>, key = KEY): Document {
  const hash = createHash("sha256").update(canonical(content)).digest("hex");
  const signature = createHmac("sha256", key).update(hash).digest("hex");
  return { meta: { doc_id: id, type: "ALLOCATION_CERTIFICATE", related_id: "ORD-1", hash, signature, created_ts: "2026-09-22T10:00:00.000Z" }, content } as Document;
}

test("docIdsIn: olay verisindeki belge numaralarını iç içe alanlardan toplar, tekrarı ayıklar", () => {
  const ids = docIdsIn({
    order_id: "ORD-20260922-0001-AB12", // belge değil: ön ek 3 harf ama alan adı doc_id değil
    allocation_certificate: { doc_id: "TB-20260922-0001-A1B2", hash: "x" },
    quote: { doc_id: "LT-20260922-0002-C3D4" },
    shipping_doc_id: "SF-20260922-0003-E5F6",
    pod_doc_id: "SF-20260922-0003-E5F6",
    note: "TB-20260922-0009-ZZZZ", // alan adı belge alanı değil: alınmaz
  });
  assert.deepEqual(ids.sort(), ["LT-20260922-0002-C3D4", "SF-20260922-0003-E5F6", "TB-20260922-0001-A1B2"]);
});

test("verifyDocument: özet her zaman, imza yalnız anahtar verilmişse bakılır", () => {
  const doc = makeDoc("TB-20260922-0001-A1B2", { qty_mg: 70104, ccy: "USD" });
  assert.deepEqual(verifyDocument(doc, KEY), { hash_ok: true, signature_ok: true });
  assert.deepEqual(verifyDocument(doc, null), { hash_ok: true, signature_ok: null });
  assert.deepEqual(verifyDocument(doc, "baska-anahtar"), { hash_ok: true, signature_ok: false });
  const tampered = { ...doc, content: { ...doc.content, qty_mg: 70105 } } as Document;
  assert.equal(verifyDocument(tampered, KEY).hash_ok, false, "içerik değişirse özet tutmaz");
});

test("DocumentDesk: olaydaki belge çekilir, doğrulanır, saklanır; ikinci kez çekilmez; bozuk özet bildirim düşürür", async () => {
  const calls: string[] = [];
  const notices: string[] = [];
  const good = makeDoc("TB-20260922-0001-A1B2", { qty_mg: 70104 });
  const bad = { ...makeDoc("KG-20260922-0002-B2C3", { qty_mg: 1 }), content: { qty_mg: 2 } } as Document;
  const amr = { document: async (id: string) => { calls.push(id); return id === good.meta.doc_id ? good : bad; } };
  const state = { documents: [] as KzDocument[] };
  const desk = new DocumentDesk(state, { amr: amr as never, docKey: KEY, save: () => {}, notify: (t) => notices.push(t) });

  const ev = { event_id: "e1", type: "order.filled", ts: "", data: { allocation_certificate: { doc_id: good.meta.doc_id } } } as unknown as EventEnvelope;
  assert.equal(await desk.collect(ev), 1);
  assert.equal(await desk.collect(ev), 0, "aynı belge ikinci kez çekilmez");
  assert.deepEqual(calls, [good.meta.doc_id]);
  const row = desk.get(good.meta.doc_id)!;
  assert.equal(row.hash_ok, true); assert.equal(row.signature_ok, true); assert.equal(row.source, "order.filled");
  assert.deepEqual(row.content, good.content, "içerik kendi kaydımızda durur");

  await desk.fetch(bad.meta.doc_id, "test");
  assert.equal(desk.get(bad.meta.doc_id)!.hash_ok, false);
  assert.ok(notices.includes("document.tampered"), "özet tutmayan belge bildirim düşürür");
  assert.equal(desk.list().length, 2);
  assert.ok(!("content" in desk.list()[0]), "liste künyedir, içerik ayrı çekilir");
  assert.equal(desk.list({ type: "ALLOCATION_CERTIFICATE", text: "tb-2026" }).length, 1, "tip ve metin süzgeci");

  const r = await desk.sync([good.meta.doc_id, "ORD-1", "TB-20260922-0009-ZZZZ"]);
  assert.equal(r.fetched, 1, "eşitleme yalnız eksik ve belge numarasına benzeyenleri çeker");
});
