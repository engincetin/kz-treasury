/**
 * Denetim günlüğü ve ikinci onay (K9).
 * Kural sunucudadır: isteyen kendi isteğini onaylayamaz, onay bir kez kullanılır,
 * onaysız değişiklik uygulanmaz.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditDesk, ApprovalError, SECOND_APPROVAL, type AuditState } from "../src/audit.ts";

function desk() {
  const s: AuditState = { audit: [], auditId: 0, approvals: [], approvalId: 0 };
  const notices: string[] = [];
  return { s, notices, d: new AuditDesk(s, { save: () => {}, notify: (t) => notices.push(t) }) };
}

test("günlük kalıcı durumda tutulur, en yeni başta", () => {
  const { s, d } = desk();
  d.log("hazineci", "trading.stop", "müşteri işlemleri durduruldu: bakım");
  d.log("yonetici", "pricing.update", "fiyatlama değişti");
  assert.equal(s.audit.length, 2);
  assert.equal(s.audit[0].action, "pricing.update");
  assert.equal(s.audit[0].actor, "yonetici");
  assert.equal(d.list(1).length, 1);
});

test("kritik aksiyon tek adımda uygulanmaz: istek açılır ve bildirim düşer", () => {
  const { d, notices } = desk();
  const g = d.gate("pricing.update", { marginBps: 40 }, "hazineci");
  assert.ok("pending" in g);
  assert.equal(d.pending().length, 1);
  assert.equal(d.pending()[0].summary, SECOND_APPROVAL["pricing.update"]);
  assert.ok(notices.includes("approval.requested"));
});

test("isteyen kendi isteğini onaylayamaz", () => {
  const { d } = desk();
  const g = d.gate("pricing.update", { marginBps: 40 }, "hazineci") as { pending: { id: number } };
  assert.throws(() => d.gate("pricing.update", {}, "hazineci", g.pending.id, "hazineci"), (e: Error) => {
    assert.ok(e instanceof ApprovalError);
    assert.match(e.message, /farklı bir kullanıcıdan/);
    return true;
  });
  assert.equal(d.pending().length, 1, "istek hâlâ bekliyor");
});

test("farklı kullanıcı onaylayınca istekteki değerler döner ve günlüğe yazılır", () => {
  const { s, d } = desk();
  const g = d.gate("pricing.update", { marginBps: 40 }, "hazineci") as { pending: { id: number } };
  const applied = d.gate<{ marginBps?: number }>("pricing.update", {}, "yonetici", g.pending.id, "yonetici");
  assert.ok("payload" in applied);
  assert.equal(applied.payload.marginBps, 40, "uygulanan değer istekteki değerdir, ikinci çağrının gövdesi değil");
  assert.equal(d.pending().length, 0);
  assert.ok(s.audit.some((e) => e.action === "approval.approve:pricing.update"));
});

test("aynı onay ikinci kez kullanılamaz", () => {
  const { d } = desk();
  const g = d.gate("stock-params.update", { floorMg: 1 }, "hazineci") as { pending: { id: number } };
  d.gate("stock-params.update", {}, "yonetici", g.pending.id, "yonetici");
  assert.throws(() => d.gate("stock-params.update", {}, "yonetici", g.pending.id, "yonetici"), /zaten kullanıldı/);
});

test("onay başka bir aksiyon için kullanılamaz", () => {
  const { d } = desk();
  const g = d.gate("pricing.update", { marginBps: 40 }, "hazineci") as { pending: { id: number } };
  assert.throws(() => d.gate("settlement.pay", {}, "yonetici", g.pending.id, "yonetici"), /başka bir aksiyon/);
});

test("reddedilen istek uygulanmaz", () => {
  const { d } = desk();
  const g = d.gate("record.resolve", { explanation: "x" }, "hazineci") as { pending: { id: number } };
  d.reject(g.pending.id, "yonetici");
  assert.equal(d.pending().length, 0);
  assert.throws(() => d.gate("record.resolve", {}, "yonetici", g.pending.id, "yonetici"), /reddedilmiş/);
});
