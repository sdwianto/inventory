/** Apply stok OUT per RTV line (qtyBase, sourceType VENDOR_RETURN) + FEFO lot consume. */

import type { ClientSession, Db } from 'mongodb';
import { postStockMutation } from '@/lib/api/stock-mutation';
import { resolveLineQtyBase } from '@/lib/uom/resolve-line-qty';
import { consumeIngredientLotsFefo } from '@/lib/food-production/ingredient-lot-consume';
import type { VendorReturnDoc, VendorReturnLine } from '@/types/vendor-return';

export type VendorReturnLotConsume = NonNullable<VendorReturnDoc['lotConsume']>[number];

export async function applyVendorReturnStock(
  db: Db,
  tenantId: string,
  noReturn: string,
  items: VendorReturnLine[],
  session?: ClientSession,
): Promise<{
  error?: string;
  items?: VendorReturnLine[];
  lotConsume?: VendorReturnLotConsume[];
}> {
  const tid = tenantId || 'default';
  const uomsCache = new Map<string, import('@/lib/uom/types').ProductUom[]>();
  const nextItems: VendorReturnLine[] = [];
  const lotConsume: VendorReturnLotConsume[] = [];
  const now = new Date();

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

    // Soft FEFO — sama Issue: tanpa lot / shortfall tidak gagalkan RTV.
    const fefo = await consumeIngredientLotsFefo(
      db,
      {
        tenantId: tid,
        stokId: it.localStokId,
        warehouseKode: it.gudangKode,
        needQty: resolved.qtyBase,
        asOf: now,
        noDokumen: noReturn,
        preferredLotNo: it.lotNo,
      },
      session,
    );
    lotConsume.push({
      lineId: it.lineId,
      invoiceLineId: it.invoiceLineId,
      localStokId: it.localStokId,
      warehouseKode: it.gudangKode,
      needQty: fefo.needQty,
      allocated: fefo.allocated,
      shortfall: fefo.shortfall,
      skippedNoLots: fefo.skippedNoLots,
      allocations: fefo.allocations,
    });

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
  if (!nextItems.length) return { error: 'Tidak ada baris stok yang bisa dikeluarkan' };
  return { items: nextItems, lotConsume };
}
