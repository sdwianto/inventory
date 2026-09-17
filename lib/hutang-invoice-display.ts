/**
 * Display-only netting for vendor invoice after Credit Note / RTV.
 * Does NOT mutate hutang.items — qty/total asli tetap di ledger.
 */

import type { JsonObject } from '@/types/json';
import { asArray, asObject, num, str } from '@/types/json';

export type HutangCreditDisplaySummary = {
  hasCredits: boolean;
  /** True when at least one physical-return qty is on the trail (RTV). */
  hasPhysicalReturnQty: boolean;
  invoiceTotal: number;
  creditTotal: number;
  /** Tagihan − Credit note (display net; bukan sisa setelah pembayaran). */
  netTagihan: number;
  terbayar: number;
  sisa: number;
  /** Returned qty keyed by normalized invoice lineId (RTV / inventory_return only). */
  returnedQtyByLineId: Record<string, number>;
};

export function normalizeInvoiceLineId(raw: unknown): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.startsWith('inv:') ? s.slice(4) : s;
}

export function isPhysicalReturnCreditNote(cn: JsonObject): boolean {
  const source = str(cn.source).toLowerCase();
  if (source === 'inventory_return') return true;
  if (str(cn.noReturn)) return true;
  return false;
}

/** Sum CN amounts already applied to hutang (creditNotes trail). */
export function sumCreditNotesAmount(creditNotes: unknown): number {
  let total = 0;
  for (const raw of asArray(creditNotes)) {
    const cn = asObject(raw);
    total += Math.max(0, num(cn.amount));
  }
  return Math.round(total * 100) / 100;
}

/**
 * Aggregate returned qty per invoice line from applied creditNotes[].items.
 * Only physical RTV trails — price-adjustment CN qty is financial, not "Diretur".
 */
export function returnedQtyByInvoiceLine(creditNotes: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of asArray(creditNotes)) {
    const cn = asObject(raw);
    if (!isPhysicalReturnCreditNote(cn)) continue;
    for (const itemRaw of asArray(cn.items)) {
      const it = asObject(itemRaw);
      const lineId = normalizeInvoiceLineId(it.lineId || it.invoiceLineId);
      if (!lineId) continue;
      const qty = num(it.qty);
      if (!(qty > 0)) continue;
      out[lineId] = Math.round(((out[lineId] || 0) + qty) * 1000) / 1000;
    }
  }
  return out;
}

export function summarizeHutangCreditDisplay(detail: JsonObject | null | undefined): HutangCreditDisplaySummary {
  if (!detail) {
    return {
      hasCredits: false,
      hasPhysicalReturnQty: false,
      invoiceTotal: 0,
      creditTotal: 0,
      netTagihan: 0,
      terbayar: 0,
      sisa: 0,
      returnedQtyByLineId: {},
    };
  }
  const creditNotes = detail.creditNotes;
  const creditTotal = sumCreditNotesAmount(creditNotes);
  const returnedQtyByLineId = returnedQtyByInvoiceLine(creditNotes);
  const hasPhysicalReturnQty = Object.values(returnedQtyByLineId).some((q) => q > 0);
  const hasCredits = asArray(creditNotes).length > 0 || creditTotal > 0 || hasPhysicalReturnQty;
  const invoiceTotal = num(detail.total);
  const netTagihan = Math.max(0, Math.round((invoiceTotal - creditTotal) * 100) / 100);
  const terbayar = num(detail.terbayar);
  const sisaRaw = detail.sisa;
  const sisa = sisaRaw != null && sisaRaw !== ''
    ? num(sisaRaw)
    : Math.max(0, Math.round((invoiceTotal - terbayar) * 100) / 100);

  return {
    hasCredits,
    hasPhysicalReturnQty,
    invoiceTotal,
    creditTotal,
    netTagihan,
    terbayar,
    sisa,
    returnedQtyByLineId,
  };
}

export function lineReturnedQty(
  summary: HutangCreditDisplaySummary,
  line: JsonObject,
): number {
  const id = normalizeInvoiceLineId(line.lineId || line.invoiceLineId);
  if (id && summary.returnedQtyByLineId[id]) return summary.returnedQtyByLineId[id];
  return 0;
}

export function lineNetQty(qtyInvoice: number, qtyReturned: number): number {
  return Math.max(0, Math.round((qtyInvoice - qtyReturned) * 1000) / 1000);
}
