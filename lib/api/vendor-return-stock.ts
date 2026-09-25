/** Apply stok OUT per RTV line (qtyBase, sourceType VENDOR_RETURN) + FEFO lot consume. */

import type { ClientSession, Db } from 'mongodb';
import { resolveLineQtyBase } from '@/lib/uom/resolve-line-qty';
import { postStockMovements, roundUnitCost, type StockActor, type StockMovementLine } from '@/lib/stock-ledger';
import type { VendorReturnDoc, VendorReturnLine } from '@/types/vendor-return';
import { loadStockUomMapper, resolveStockProducts } from '@/lib/api/product-merge';

export type VendorReturnLotConsume = NonNullable<VendorReturnDoc['lotConsume']>[number];

/** Harga baris RTV per satuan input → harga per satuan dasar (kartu stok selalu satuan dasar). */
export function vendorReturnUnitCostBase(harga: unknown, qty: number, qtyBase: number): number | undefined {
  const h = Number(harga);
  if (!Number.isFinite(h) || h <= 0 || !(qty > 0) || !(qtyBase > 0)) return undefined;
  return roundUnitCost((h * qty) / qtyBase);
}

export async function applyVendorReturnStock(
  db: Db,
  tenantId: string,
  noReturn: string,
  items: VendorReturnLine[],
  session: ClientSession | undefined,
  ctx: { returnId: string; actor?: StockActor | null },
): Promise<{
  error?: string;
  items?: VendorReturnLine[];
  lotConsume?: VendorReturnLotConsume[];
}> {
  const tid = tenantId || 'default';
  const uomsCache = new Map<string, import('@/lib/uom/types').ProductUom[]>();
  const nextItems: VendorReturnLine[] = [];
  const movementLines: StockMovementLine[] = [];
  // Baris retur memegang salinan katalog vendor; stok keluar dari item persediaan kanonik.
  const targetRes = await resolveStockProducts(db, tid, items.map((it) => it.localStokId), session);
  if ('error' in targetRes) return { error: targetRes.error };
  const stockUomOf = await loadStockUomMapper(db, tid, targetRes.targets);

  for (const [idx, it] of items.entries()) {
    const qty = parseFloat(String(it.qty)) || 0;
    if (qty <= 0) continue;
    const resolved = await resolveLineQtyBase(db, tid, it.localStokId, {
      qty,
      uomId: it.uomId,
      satuan: it.satuan,
    }, uomsCache);
    if ('error' in resolved) return { error: resolved.error };

    movementLines.push({
      lineRef: `${idx + 1}:${it.lineId || it.invoiceLineId || it.localStokId}`,
      productId: targetRes.targets.get(it.localStokId)?.productId || it.localStokId,
      warehouseKode: it.gudangKode,
      deltaQtyBase: -resolved.qtyBase,
      unitCost: vendorReturnUnitCostBase(it.harga, qty, resolved.qtyBase),
      qtyEntered: qty,
      uomId: stockUomOf(it.localStokId, resolved.uomId),
      satuan: resolved.satuan,
      // Soft FEFO — sama Issue: tanpa lot / shortfall tidak gagalkan RTV.
      // Baris lot ditolak QC: hanya lot itu yang boleh diambil walau tertahan.
      lotPolicy: {
        mode: 'FEFO_CONSUME',
        preferredLotNo: it.lotNo,
        // Lot ditolak boleh sudah kedaluwarsa — tetap hanya lot itu yang keluar, penuh.
        ...(it.qcLotId && it.lotNo ? { qcHeld: 'PREFERRED' as const, allowExpired: true } : {}),
      },
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

  const posted = await postStockMovements(db, session, {
    tenantId: tid,
    sourceType: 'VENDOR_RETURN',
    sourceId: ctx.returnId,
    noTransaksi: noReturn,
    keterangan: `Retur vendor ${noReturn}`,
    actor: ctx.actor,
    lines: movementLines,
  });
  if (!posted.ok) return { error: posted.error };

  const lotConsume: VendorReturnLotConsume[] = posted.lines.map((line, i) => ({
    lineId: nextItems[i].lineId,
    invoiceLineId: nextItems[i].invoiceLineId,
    localStokId: line.productId,
    warehouseKode: nextItems[i].gudangKode,
    needQty: -line.deltaQtyBase,
    allocated: line.lot?.allocated ?? 0,
    shortfall: line.lot?.shortfall ?? -line.deltaQtyBase,
    skippedNoLots: line.lot?.skippedNoLots ?? true,
    allocations: line.lot?.allocations ?? [],
  }));
  return { items: nextItems, lotConsume };
}
