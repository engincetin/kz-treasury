/**
 * Belgeler (K9): rafinerinin ürettiği belgelerin Kanzasset'teki kopyası.
 *
 * Rafineri her belgeyi (Tahsis Belgesi, Kasa Giriş / Çıkış Fişi, teklifler, Sevkiyat Fişi,
 * Teslimat Kaydı, ekstreler) kendinde tutar ve olayla belge numarasını gönderir. Kanzasset
 * numarayı görür görmez belgeyi çeker, özetini yeniden hesaplayıp karşılaştırır ve kendi
 * kaydında saklar. Böylece iki taraf da aynı belgenin kendi kopyasına sahip olur: mutabakat
 * ve denetimde tek tarafa güvenmek gerekmez.
 *
 * Doğrulama:
 *   hash_ok       sha256(kanonik içerik) == meta.hash  (her zaman bakılır)
 *   signature_ok  HMAC-SHA256(belge anahtarı, hash) == meta.signature  (anahtar verilmişse: AMR_DOC_KEY)
 */
import { createHash, createHmac } from "node:crypto";
import type { Document, EventEnvelope } from "@amr/contract";
import type { AmrClient } from "./amrClient.ts";

export interface KzDocument {
  doc_id: string;
  type: string;
  related_id: string;
  hash: string;
  signature: string;
  created_ts: string;
  received_ts: string;
  /** Hangi olay ya da işlemle geldi. */
  source: string;
  hash_ok: boolean;
  signature_ok: boolean | null;
  content: Record<string, unknown>;
}

export interface DocumentState { documents: KzDocument[] }

/** Rafinerideki kanonik biçimle aynı: anahtarlar sıralı JSON. */
export function canonical(obj: unknown): string { return JSON.stringify(sortKeys(obj)); }
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

export function verifyDocument(doc: Document, docKey?: string | null): { hash_ok: boolean; signature_ok: boolean | null } {
  const hash = createHash("sha256").update(canonical(doc.content)).digest("hex");
  const hash_ok = hash === doc.meta.hash;
  const signature_ok = docKey ? createHmac("sha256", docKey).update(doc.meta.hash).digest("hex") === doc.meta.signature : null;
  return { hash_ok, signature_ok };
}

/** Olay verisinde belge numarası taşıyan alanlar. */
const DOC_FIELDS = ["doc_id", "shipping_doc_id", "pod_doc_id", "quote_doc_id", "statement_doc_id"];
const DOC_ID = "[A-Z]{2,3}-\\d{8}-\\d{4}-[A-Z0-9]{4}";
const looksLikeDocId = (v: unknown): v is string => typeof v === "string" && new RegExp(`^${DOC_ID}$`).test(v);

/**
 * Belge numaralarını toplar.
 *
 * Varsayılan: yalnız belge alanları (olay gövdesinde `doc_id`, `shipping_doc_id`, ...). Canlı
 * toplama bunu kullanır, rastgele metne bakmaz.
 *
 * `scanText` ile metin içindeki numaralar da alınır: geriye dönük eşitlemede, belge numarası
 * yalnız zaman çizelgesi satırında kalmış eski kayıtlar da bulunsun diye.
 */
export function docIdsIn(data: unknown, opt: { scanText?: boolean } = {}): string[] {
  const out: string[] = [];
  const inText = new RegExp(DOC_ID, "g");
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== "object" || depth > 8) return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") {
        if (DOC_FIELDS.includes(k) && looksLikeDocId(val)) out.push(val);
        else if (opt.scanText) out.push(...(val.match(inText) ?? []));
      } else if (val && typeof val === "object") walk(val, depth + 1);
    }
  };
  walk(data, 0);
  return [...new Set(out)];
}

export class DocumentDesk {
  constructor(
    private s: DocumentState,
    private d: { amr: AmrClient; docKey: string | null; save: () => void; notify: (type: string, title: string, body?: string) => void },
  ) {}

  list(q: { type?: string; text?: string; limit?: number } = {}): Omit<KzDocument, "content">[] {
    let rows = this.s.documents;
    if (q.type) rows = rows.filter((x) => x.type === q.type);
    if (q.text) { const t = q.text.toLowerCase(); rows = rows.filter((x) => x.doc_id.toLowerCase().includes(t) || x.related_id.toLowerCase().includes(t)); }
    return rows.slice(0, Math.min(1000, q.limit ?? 500)).map(({ content: _c, ...rest }) => rest);
  }
  get(docId: string): KzDocument | undefined { return this.s.documents.find((x) => x.doc_id === docId); }
  count() { return this.s.documents.length; }

  /** Belgeyi rafineriden çeker, doğrular, saklar. Zaten varsa dokunmaz. */
  async fetch(docId: string, source: string): Promise<KzDocument | null> {
    const existing = this.get(docId);
    if (existing) return existing;
    const doc = await this.d.amr.document(docId);
    const v = verifyDocument(doc, this.d.docKey);
    const row: KzDocument = {
      doc_id: doc.meta.doc_id, type: doc.meta.type, related_id: doc.meta.related_id,
      hash: doc.meta.hash, signature: doc.meta.signature, created_ts: doc.meta.created_ts,
      received_ts: new Date().toISOString(), source, ...v, content: doc.content,
    };
    this.s.documents.unshift(row);
    if (this.s.documents.length > 5000) this.s.documents.length = 5000;
    this.d.save();
    if (!v.hash_ok) this.d.notify("document.tampered", "Belge özeti tutmuyor", `${docId}: içerik ile sha256 özeti farklı`);
    return row;
  }

  /** Olaydaki bütün belge numaralarını toplar; çekme hataları olayı durdurmaz. */
  async collect(ev: EventEnvelope): Promise<number> {
    const ids = docIdsIn(ev.data);
    let n = 0;
    for (const id of ids) {
      try { if (!this.get(id)) { await this.fetch(id, ev.type); n++; } }
      catch (e) { this.d.notify("document.fetch_failed", "Belge çekilemedi", `${id}: ${(e as Error).message}`); }
    }
    return n;
  }

  /** Geriye dönük eşitleme: durumdaki bilinen bütün belge numaralarını tarar, eksikleri çeker. */
  async sync(knownIds: string[]): Promise<{ fetched: number; failed: string[] }> {
    let fetched = 0; const failed: string[] = [];
    for (const id of new Set(knownIds.filter(looksLikeDocId))) {
      if (this.get(id)) continue;
      try { await this.fetch(id, "eşitleme"); fetched++; } catch { failed.push(id); }
    }
    return { fetched, failed };
  }
}
