/** Apply stok OUT per RTV line (qtyBase, sourceType VENDOR_RETURN). */

import type { ClientSession, Db } from 'mongodb';
import { postStockMutation } from '@/lib/api/stock-mutation';
import { resolveLineQtyBase } from '@/lib/uom/resolve-line-qty';
import type { VendorReturnLine } from '@/types/vendor-return';

export async function applyVendorReturnStock(
  db: Db,
  tenantId: string,
  noReturn: string,
  items: VendorReturnLine[],
  session?: ClientSession,
): Promise<{ error?: string; items?: VendorReturnLine[] }> {
  const tid = tenantId || 'default';
  const uomsCache = new Map<string, import('@/lib/uom/types').ProductUom[]>();
  const nextItems: VendorReturnLine[] = [];
  for (const it of items) {
    const qty = parseFloat(String(it.qty)) || 0;
    if (qty <= 0) continue;
    const resolved = await resolveLineQtyBase(db, tid, it.localStokId, {
      qty,
      uomId: it.uomId,
      satuan: it.satuan,
    }, uomsCache);
    if ('error' in resolved) return { error: resolved.error };
    const mut = await postStockMutation(db, {
      tenantId: tid,
      productId: it.localStokId,
      warehouseKode: it.gudangKode,
      deltaQtyBase: -resolved.qtyBase,
      sourceType: 'VENDOR_RETURN',
      noTransaksi: noReturn,
      keterangan: `Retur vendor ${noReturn}`,
      hargaSatuan: it.harga,
      qtyEntered: qty,
      uomId: resolved.uomId,
      satuan: resolved.satuan,
      session,
    });
    if (!mut.ok) return { error: mut.error };
    nextItems.push({
      ...it,
      qty,
      qtyBase: resolved.qtyBase,
      uomId: resolved.uomId || it.uomId,
      satuan: resolved.satuan || it.satuan,
      factorToBase: resolved.factorToBase,
      jumlah: Math.round(qty * (it.harga || 0)),
    });
  }
  return { items: nextItems };
}
