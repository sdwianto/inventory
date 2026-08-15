/**
 * Qty returable: invoice/hutang line qty minus RTV POSTED/POSTING for the same invoice.
 */

import { vendorReturnLineKey, type VendorReturnLine } from '@/types/vendor-return';

export type HutangLike = {
  items?: Array<{
    lineId?: string;
    stokId?: string;
    localStokId?: string;
    kode?: string;
    nama?: string;
    satuan?: string;
    uomId?: string;
    qty?: number | string;
    harga?: number | string;
    qtyBase?: number | string;
  }>;
  creditNotes?: Array<{
    creditNoteId?: string;
    noReturn?: string;
    source?: string;
    items?: Array<{ lineId?: string; stokId?: string; uomId?: string; qty?: number | string }>;
  }>;
};

export type PostedReturnLike = {
  status?: string;
  id?: string;
  items?: Array<{
    invoiceLineId?: string | null;
    localStokId?: string;
    uomId?: string;
    satuan?: string;
    qty?: number;
  }>;
};

export function sumAppliedManualCreditNoteQtyByLine(
  hutang: HutangLike,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const cn of hutang.creditNotes || []) {
    if (String(cn.source || '') === 'inventory_return') continue;
    for (const it of cn.items || []) {
      const key = vendorReturnLineKey({
        invoiceLineId: it.lineId,
        localStokId: String(it.stokId || ''),
        uomId: it.uomId,
      });
      if (!key || key === '::' || key === 'inv:') continue;
      out[key] = (out[key] || 0) + (parseFloat(String(it.qty)) || 0);
    }
  }
  return out;
}

export function sumPostedReturnQtyByLine(
  posted: PostedReturnLike[],
  opts?: { excludeReturnId?: string },
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const doc of posted) {
    if (opts?.excludeReturnId && doc.id === opts.excludeReturnId) continue;
    const st = String(doc.status || '');
    if (st !== 'POSTED' && st !== 'POSTING') continue;
    for (const it of doc.items || []) {
      const key = vendorReturnLineKey(it);
      if (!key || key === '::' || key === 'inv:') continue;
      out[key] = (out[key] || 0) + (parseFloat(String(it.qty)) || 0);
    }
  }
  return out;
}

export function buildReturableLines(
  hutang: HutangLike,
  postedReturns: PostedReturnLike[],
  opts?: { excludeReturnId?: string },
): Array<{
  invoiceLineId: string;
  salesStokId: string;
  kode: string;
  nama: string;
  satuan: string;
  uomId: string;
  qtyInvoice: number;
  qtyReturned: number;
  maxQty: number;
  harga: number;
}> {
  const used = sumPostedReturnQtyByLine(postedReturns, opts);
  const cnUsed = sumAppliedManualCreditNoteQtyByLine(hutang);
  const rows: Array<{
    invoiceLineId: string;
    salesStokId: string;
    kode: string;
    nama: string;
    satuan: string;
    uomId: string;
    qtyInvoice: number;
    qtyReturned: number;
    maxQty: number;
    harga: number;
  }> = [];
  for (const it of hutang.items || []) {
    const invoiceLineId = String(it.lineId || '').trim();
    const qtyInvoice = parseFloat(String(it.qty || 0)) || 0;
    if (qtyInvoice <= 0) continue;
    const key = vendorReturnLineKey({
      invoiceLineId,
      localStokId: String(it.localStokId || it.stokId || ''),
      uomId: it.uomId,
      satuan: it.satuan,
    });
    const qtyReturned = (used[key] || 0) + (cnUsed[key] || 0);
    const maxQty = Math.max(0, Math.round((qtyInvoice - qtyReturned) * 1000) / 1000);
    rows.push({
      invoiceLineId,
      salesStokId: String(it.stokId || ''),
      kode: String(it.kode || ''),
      nama: String(it.nama || ''),
      satuan: String(it.satuan || ''),
      uomId: String(it.uomId || ''),
      qtyInvoice,
      qtyReturned,
      maxQty,
      harga: parseInt(String(it.harga || 0), 10) || 0,
    });
  }
  return rows;
}

export function assertReturnQtyWithinMax(
  items: Array<Pick<VendorReturnLine, 'qty' | 'invoiceLineId' | 'localStokId' | 'uomId' | 'satuan' | 'localKode'>>,
  returable: ReturnType<typeof buildReturableLines>,
): string | null {
  const maxByKey = new Map<string, number>();
  for (const r of returable) {
    maxByKey.set(vendorReturnLineKey({
      invoiceLineId: r.invoiceLineId,
      localStokId: r.salesStokId,
      uomId: r.uomId,
      satuan: r.satuan,
    }), r.maxQty);
  }
  for (const it of items) {
    const qty = parseFloat(String(it.qty)) || 0;
    if (qty <= 0) return `Qty retur ${it.localKode || it.localStokId} harus > 0`;
    const key = vendorReturnLineKey(it);
    const max = maxByKey.get(key);
    if (max == null) {
      return `Baris invoice tidak ditemukan untuk ${it.localKode || it.invoiceLineId || it.localStokId}`;
    }
    if (qty > max + 1e-9) {
      return `Qty retur ${it.localKode || ''} melebihi sisa ${max}`;
    }
  }
  return null;
}
