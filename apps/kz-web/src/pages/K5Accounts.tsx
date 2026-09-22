import { useState } from "react";
import { api, FIELD_TR, fmtDT, fmtG, fmtMoney, needsApproval, type useLive } from "../api.ts";
import { ApprovalBox } from "../components/ApprovalBox.tsx";

type Live = ReturnType<typeof useLive>;

/**
 * K5 Cari hesap: rafineri tarafındaki R5'in karşılığı.
 * Üstte aynı büyüklükler (altın T ve kur bazında para), farkı şu: buradaki rakamlar KZ kaydıdır
 * ve her harekette rafinerinin bakiye bilgisiyle karşılaştırılır. Eşleşme kuralı, fark satırları ve
 * RECONCILE çözümü bu ekrandadır. Kasa hesabının kendi ekranı K4'tür; burada yalnız karşılaştırması vardır.
 */
export function K5Accounts({ live }: { live: Live }) {
  const s = live.status;
  const r = s?.record;
  const c = s?.checks;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [explanation, setExplanation] = useState("");
  /** Uyuşmazlık düzeltmesi kritik aksiyondur: sunucu önce onay ister, uygulamaz. */
  const [pending, setPending] = useState<{ id: number; requestedBy: string } | null>(null);
  const run = async (fn: () => Promise<string>) => { setBusy(true); setMsg(""); try { setMsg(await fn()); await live.refresh(); } catch (e) { setMsg(`Hata: ${(e as Error).message}`); } finally { setBusy(false); } };

  const last = r?.lastAccount;
  const money = (list: { ccy: string; cents: number }[] | undefined, ccy: string) => list?.find((m) => m.ccy === ccy)?.cents ?? 0;
  const v = r ? r.vault.in_vault_mg + r.vault.placing_mg + r.vault.shipping_mg : 0;

  return (
    <div>
      <span className="tag">K5</span>
      <h1>Cari hesap</h1>
      <p className="sub">Gün içinde biriken karşılıklı alacak ve borç, Kanzasset kaydına göre: altın T (artı = rafineriden aldık, henüz kasaya konmadı; eksi = sattık, kasadan çıkacak) ve kur bazında para. Aynı rakamlar rafineride de tutulur; her harekette karşılaştırılır. Kural: her harekette birebir eşit olmalı. Eşit değilse hareket geçerli kalır, hesap RECONCILE olur, mint ve kasa çıkışı talebi bloke edilir. Sıra numarası atlarsa anlık fotoğraf istenir.</p>

      <div className="grid c3" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>Altın (T)</h2>
          <div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>{(r?.current_account.gold_mg ?? 0) >= 0 ? "+" : ""}{fmtG(r?.current_account.gold_mg ?? 0)} g</div>
          <div className="small">{(r?.current_account.gold_mg ?? 0) > 0 ? "rafineriden alacağımız gram: kasa girişiyle kapanır" : (r?.current_account.gold_mg ?? 0) < 0 ? "rafineriye borçlu olduğumuz gram: kasa çıkışıyla kapanır" : "kapalı"}</div>
        </div>
        {["USD", "EUR", "AED"].map((ccy) => {
          const cents = money(r?.current_account.money, ccy);
          return (
            <div className="card" key={ccy}>
              <h2>Para · {ccy}</h2>
              <div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>{cents > 0 ? "+" : ""}{fmtMoney(cents)}</div>
              <div className="small">{cents < 0 ? "rafineriye borçluyuz (alışlar)" : cents > 0 ? "rafineri borçlu (satışlar)" : "kapalı"}</div>
            </div>
          );
        })}
      </div>

      <div className="grid c3" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>Eşleşme</h2>
          <div className="status"><span className={`dot ${r?.match === "EŞİT" ? "ok" : r?.match === "RECONCILE" ? "bad" : "warn"}`} />{r?.match ?? "…"}</div>
          <div className="small" style={{ marginTop: 6 }}>son karşılaştırma {r?.lastCompareTs ? fmtDT(r.lastCompareTs) : "yok"} · KZ sırası {r?.seq ?? 0} · rafineri sırası {last?.seq ?? 0}</div>
          <div className="small">mint {r?.blocked.mint ? <span className="pill bad">BLOKE</span> : <span className="pill ok">serbest</span>} · kasa çıkışı {r?.blocked.vault_out ? <span className="pill bad">BLOKE</span> : <span className="pill ok">serbest</span>}</div>
        </div>
        <div className="card">
          <h2>K1 · Arz ≤ Kasa hesabı</h2>
          <div className="status"><span className={`dot ${c?.k1.ok ? "ok" : "bad"}`} />{c?.k1.ok ? "sağlanıyor" : "İHLAL"}</div>
          <div className="small mono" style={{ marginTop: 6 }}>{c?.k1.text}</div>
          <div className="small">A = arz (dolaşımdaki + hazine stoku) · V = kasada + kasaya konuluyor + sevkiyatta</div>
        </div>
        <div className="card">
          <h2>K2 · Stok + Cari hesap altını = Hedef</h2>
          <div className="status"><span className={`dot ${c?.k2.ok ? "ok" : "bad"}`} />{c?.k2.ok ? "sağlanıyor" : "İHLAL"}</div>
          <div className="small mono" style={{ marginTop: 6 }}>{c?.k2.text}</div>
          <div className="small">S = hazine stoku (token) · T = cari hesap altını · K = envanter hedefi · müşteride C = {fmtG(c?.c_mg ?? 0)} g</div>
        </div>
      </div>

      <section className="card" style={{ marginBottom: 14 }}>
        <h2>KZ kaydı ↔ bakiye bilgisi (rafineri)</h2>
        <table>
          <thead><tr><th>Kalem</th><th className="num">KZ kaydı</th><th className="num">Rafineri (son bakiye bilgisi)</th><th>Durum</th></tr></thead>
          <tbody>
            {r && ([
              ["vault.in_vault_mg", r.vault.in_vault_mg, last?.vault.in_vault_mg, "g"],
              ["vault.placing_mg", r.vault.placing_mg, last?.vault.placing_mg, "g"],
              ["vault.shipping_mg", r.vault.shipping_mg, last?.vault.shipping_mg, "g"],
              ["current_account.gold_mg", r.current_account.gold_mg, last?.current_account.gold_mg, "g"],
              ["current_account.money.USD", money(r.current_account.money, "USD"), last ? money(last.current_account.money, "USD") : undefined, "USD"],
              ["current_account.money.EUR", money(r.current_account.money, "EUR"), last ? money(last.current_account.money, "EUR") : undefined, "EUR"],
              ["current_account.money.AED", money(r.current_account.money, "AED"), last ? money(last.current_account.money, "AED") : undefined, "AED"],
            ] as [string, number, number | undefined, string][]).map(([f, kz, amr, unit]) => {
              const fmt = (x: number) => (unit === "g" ? `${fmtG(x)} g` : `${fmtMoney(x)} ${unit}`);
              const diff = r.diffs.find((d) => d.field === f);
              return (
                <tr key={f}>
                  <td>{FIELD_TR[f] ?? f}</td>
                  <td className="num">{fmt(kz)}</td>
                  <td className="num">{amr === undefined ? "henüz yok" : fmt(amr)}</td>
                  <td>{amr === undefined ? <span className="pill warn">bekliyor</span> : diff ? <span className="pill bad">fark {fmt(diff.amr - diff.kz)}</span> : <span className="pill ok">eşit</span>}</td>
                </tr>
              );
            })}
            <tr><td><b>Kasa hesabı toplamı (V)</b></td><td className="num"><b>{fmtG(v)} g</b></td><td className="num">{last ? `${fmtG(last.vault.in_vault_mg + last.vault.placing_mg + last.vault.shipping_mg)} g` : ""}</td><td></td></tr>
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 12 }}>
          <button disabled={busy} onClick={() => run(async () => { const x = await api.snapshot(); return `Anlık fotoğraf alındı: seq ${x.account.seq} · ${x.match}${x.seqGap ? " · seq boşluğu vardı" : ""}`; })}>Anlık fotoğraf iste (GET /v1/account)</button>
          {r?.match === "RECONCILE" && (
            <>
              <input className="wide" placeholder="fark açıklaması (zorunlu)" value={explanation} onChange={(e) => setExplanation(e.target.value)} />
              <button className="danger" disabled={busy || !explanation.trim() || !!pending} onClick={() => run(async () => {
                const res = await api.resolveRecord(explanation.trim());
                if (needsApproval(res)) {
                  setPending({ id: res.approval_id, requestedBy: res.requested_by });
                  return `İkinci onay bekleniyor (onay ${res.approval_id}). İsteyen ${res.requested_by}; onaylayan farklı bir kullanıcı olmalı. Düzeltme henüz uygulanmadı.`;
                }
                setExplanation("");
                return "RECONCILE çözüldü: rafineri fotoğrafı KZ kaydına alındı, düzeltme kaydı tutuldu.";
              })}>RECONCILE çöz</button>
            </>
          )}
          {msg && <span className="small">{msg}</span>}
        </div>
        {pending && (
          <div style={{ marginTop: 10 }}>
            <ApprovalBox id={pending.id} requestedBy={pending.requestedBy} summary="uyuşmazlık düzeltmesi"
              onDone={async (m) => { setPending(null); setExplanation(""); setMsg(m); await live.refresh(); }} />
          </div>
        )}
      </section>

      <div className="grid c2">
        <section className="card">
          <h2>Hazine büyüklükleri (KZ tarafı)</h2>
          <div className="kv">
            <span className="k">Hazine stoku S</span><span className="mono">{fmtG(r?.stock.s_mg ?? 0)} g (token)</span>
            <span className="k">Envanter hedefi K</span><span className="mono">{fmtG(r?.stock.k_mg ?? 0)} g</span>
            <span className="k">Arz A</span><span className="mono">{fmtG(r?.stock.a_mg ?? 0)} g</span>
            <span className="k">Müşteride C = A − S</span><span className="mono">{fmtG(c?.c_mg ?? 0)} g</span>
            <span className="k">Cari hesap T</span><span className="mono">{(r?.current_account.gold_mg ?? 0) >= 0 ? "+" : ""}{fmtG(r?.current_account.gold_mg ?? 0)} g</span>
          </div>
          <p className="small" style={{ marginTop: 8 }}>Stoktan alışta S azalır, T artar; stoktan satışta S artar, T azalır. Mint (kasa girişi fişine karşı) ve burn Sprint 3'te; A ve S o zaman hareket eder.</p>
        </section>
        <section className="card">
          <h2>Düzeltme kayıtları</h2>
          {(r?.corrections ?? []).length === 0 && <div className="small">Düzeltme yok</div>}
          {r?.corrections.map((x, i) => <div key={i} className="small" style={{ marginBottom: 6 }}><span className="mono">{fmtDT(x.ts)}</span> · {x.explanation}</div>)}
        </section>
      </div>
    </div>
  );
}
