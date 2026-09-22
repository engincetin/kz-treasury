/**
 * API dokümanı (tarayıcıdan açılır).
 *
 *   GET /kz-api.json  hazine ekranlarının kullandığı panel API'si
 *   GET /docs         tek sayfalık görüntüleyici
 *
 * Görüntüleyici sözleşme paketindedir (rafineri ile tek kopya), bağımlılıksızdır ve
 * dışarıdan dosya çekmez. Rafineri sözleşmesi rafinerinin kendi /docs sayfasındadır;
 * buradan bağlantı verilir (adres AMR_HTTP_URL'den gelir).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { docsViewerHtml } from "@amr/contract/docs-viewer";

function findSpec(): string | null {
  const candidates = [
    process.env.KZ_API_PATH,
    resolve(import.meta.dirname, "../../../kz-api.json"),
    resolve(process.cwd(), "kz-api.json"),
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function docsRoutes(app: FastifyInstance, refineryUrl: string) {
  const viewer = docsViewerHtml({
    title: "Kanzasset · API dokümanı",
    brand: "Kanzasset hazine çekirdeği",
    tabs: [
      {
        id: "api", label: "Panel API'si (/api)", url: "/kz-api.json",
        heading: "Kanzasset paneli API'si",
        intro: "Hazine ekranlarının (K1'den K9'a) kullandığı iç uçlar. Rafineri bu uçları kullanmaz. Aktör <code>X-User</code> başlığıyla gelir: denetim günlüğüne yazılır ve ikinci onayda \"isteyen ile onaylayan aynı olamaz\" kuralını besler.",
        note: `Rafineri sözleşmesi (<code>/v1</code>) rafinerinin kendi doküman sayfasındadır: <a href="${refineryUrl}/docs" target="_blank">${refineryUrl}/docs</a>. Bu belge çalışan sunucunun yol tablosundan üretilir (<code>npm run kzapi:export</code>), böylece uçlarla belgenin arası açılmaz.`,
        hint: "Belge için <code>npm run kzapi:export</code> çalıştırın.",
      },
      { id: "amr", label: "Rafineri sözleşmesi (/v1)", url: `${refineryUrl}/docs`, raw: true },
      { id: "raw", label: "kz-api.json", url: "/kz-api.json", raw: true },
    ],
  });

  app.get("/kz-api.json", async (_req, reply) => {
    const p = findSpec();
    if (!p) return reply.code(404).send({ error: "kz-api.json bulunamadı; npm run kzapi:export çalıştırın" });
    return reply.header("content-type", "application/json; charset=utf-8").send(readFileSync(p, "utf8"));
  });
  app.get("/docs", async (_req, reply) => reply.header("content-type", "text/html; charset=utf-8").send(viewer));
}
