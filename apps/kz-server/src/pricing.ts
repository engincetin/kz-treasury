/**
 * Fiyat zinciri (Akışlar 01, müşteri tarafı):
 *   1. rafineri fiyatı: alışta ask, satışta bid
 *   2. kâr marjı fiyata gömülü (hedef %0,30, tavan %1,00; pair ve yön bazında ayarlanabilir)
 *   3. işlem komisyonu %0,15 ayrı satır
 *   4. USDT / USDC ile ödemede dönüşüm kuru ve ücreti bilgi satırı (Sprint 2)
 * Hesap tam sayı cent üzerinden, gösterim 2 ondalık. Müşteri rafineri fiyatını ve marjı görmez.
 */
import type { PriceLevel } from "@amr/contract";

export interface PricingParams {
  marginBps: number; // 30 = %0,30
  marginCapBps: number; // 100 = %1,00
  commissionBps: number; // 15 = %0,15
}
export const DEFAULT_PRICING: PricingParams = { marginBps: 30, marginCapBps: 100, commissionBps: 15 };

export interface ClientQuote {
  ccy: PriceLevel["ccy"];
  refineryBid: string;
  refineryAsk: string;
  clientBuy: string; // müşteri alış fiyatı (bizim satış): ask × (1 + marj)
  clientSell: string; // müşteri satış fiyatı (bizim alış): bid × (1 − marj)
  commissionBps: number;
}

const toCents = (s: string) => Math.round(Number(s) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);

export function quote(level: PriceLevel, p: PricingParams = DEFAULT_PRICING): ClientQuote {
  const bps = Math.min(p.marginBps, p.marginCapBps);
  const ask = toCents(level.ask);
  const bid = toCents(level.bid);
  const clientBuy = Math.ceil((ask * (10_000 + bps)) / 10_000); // müşteri aleyhine yukarı
  const clientSell = Math.floor((bid * (10_000 - bps)) / 10_000); // müşteri aleyhine aşağı
  return { ccy: level.ccy, refineryBid: level.bid, refineryAsk: level.ask, clientBuy: fromCents(clientBuy), clientSell: fromCents(clientSell), commissionBps: p.commissionBps };
}

/** Emir fişi örneği: qty_mg gram için müşteri toplamı (bedel + komisyon), alış yönü. */
export function buyTotal(qty_mg: number, clientBuy: string, commissionBps: number) {
  const priceCents = toCents(clientBuy);
  const amount = Math.round((priceCents * qty_mg) / 1000); // cent
  const commission = Math.round((amount * commissionBps) / 10_000);
  return { amount_cents: amount, commission_cents: commission, total_cents: amount + commission };
}
