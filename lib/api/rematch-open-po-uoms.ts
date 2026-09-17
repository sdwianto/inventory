/**
 * Setelah Sync Katalog rebuild product_uom (UUID lokal diganti), rebind
 * uomId + vendorUomId pada baris CPO open supaya tidak tertinggal ID usang
 * + fallback ke vendorBaseUomId (ONS/PTG) saat push.
 *
 * Catatan: Purchase Requirement (PRB) menyimpan `lines[]` tanpa uomId/vendorUomId
 * — mapping UOM terjadi saat buat Draft CPO (`mapCpoItemsFromProducts`), jadi
 * rematch PRB tidak diperlukan.
 */

import type { Db } from 'mongodb';
import type { ProductUom } from '@/lib/uom/types';

function normSatuan(s?: string | null): string {
  return String(s || '').trim().toUpperCase();
}

export type RematchLinePatch = {
  index: number;
  kode?: string;
  satuan: string;
  uomIdBefore?: string;
  uomIdAfter: string;
  vendorUomIdBefore?: string;
  vendorUomIdAfter: string;
};

function rematchItemBySatuan(
  item: Record<string, unknown>,
  uoms: ProductUom[],
): { next: Record<string, unknown>; changed: boolean; patch?: Omit<RematchLinePatch, 'index'> } | null {
  const sat = normSatuan(item.satuan as string | undefined);
  if (!sat || !uoms.length) return null;

  const matched = uoms.find((u) => normSatuan(u.satuan) === sat);
  if (!matched) return null;

  const vendorUomId = String(matched.vendorUomId || '').trim();
  if (!vendorUomId || vendorUomId.startsWith('legacy:')) return null;

  const prevUom = item.uomId != null ? String(item.uomId) : undefined;
  const prevVendor = item.vendorUomId != null ? String(item.vendorUomId) : undefined;
  if (prevUom === matched.id && prevVendor === vendorUomId) {
    return { next: item, changed: false };
  }

  return {
    next: {
      ...item,
      uomId: matched.id,
      vendorUomId,
      satuan: matched.satuan,
    },
    changed: true,
    patch: {
      kode: item.kode != null ? String(item.kode) : (item.vendorKode != null ? String(item.vendorKode) : undefined),
      satuan: matched.satuan,
      uomIdBefore: prevUom,
      uomIdAfter: matched.id,
      vendorUomIdBefore: prevVendor,
      vendorUomIdAfter: vendorUomId,
    },
  };
}

/** Status CPO yang masih bisa dikirim / diedit binding UOM-nya. */
export const OPEN_CPO_STATUSES_FOR_UOM_REMATCH = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SUBMITTED',
  'CONFIRMED',
  'PARTIAL_RECEIVED',
  'PARTIAL_CANCELLED',
] as const;

/**
 * Rematch baris CPO open untuk satu produk lokal setelah UOM diganti Sync Katalog.
 */
export async function rematchOpenCpoUomsForProduct(
  db: Db,
  tenantId: string,
  localProductId: string,
  uoms: ProductUom[],
): Promise<{ docsTouched: number; linesPatched: number; patches: Array<RematchLinePatch & { noPO: string }> }> {
  const tid = tenantId || 'default';
  const pid = String(localProductId || '').trim();
  if (!pid || !uoms.length) {
    return { docsTouched: 0, linesPatched: 0, patches: [] };
  }

  const cursor = db.collection('customer_purchase_orders').find({
    tenantId: tid,
    status: { $in: [...OPEN_CPO_STATUSES_FOR_UOM_REMATCH] },
    'items.localStokId': pid,
  });

  let docsTouched = 0;
  let linesPatched = 0;
  const patches: Array<RematchLinePatch & { noPO: string }> = [];

  for await (const doc of cursor) {
    const items = Array.isArray(doc.items) ? [...doc.items] as Record<string, unknown>[] : [];
    let changed = false;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (String(it.localStokId || it.stokId || '') !== pid) continue;
      const result = rematchItemBySatuan(it, uoms);
      if (!result?.changed || !result.patch) continue;
      items[i] = result.next;
      changed = true;
      linesPatched += 1;
      patches.push({
        index: i,
        noPO: String(doc.noPO || doc.id || ''),
        ...result.patch,
      });
    }
    if (!changed) continue;
    await db.collection('customer_purchase_orders').updateOne(
      { _id: doc._id },
      { $set: { items, updatedAt: new Date(), uomRematchAt: new Date() } },
    );
    docsTouched += 1;
  }

  return { docsTouched, linesPatched, patches };
}

export async function rematchOpenDocsAfterProductUomSync(
  db: Db,
  tenantId: string,
  localProductId: string,
  uoms: ProductUom[],
): Promise<void> {
  await rematchOpenCpoUomsForProduct(db, tenantId, localProductId, uoms);
}

/** Rematch banyak produk setelah bulk Sync Katalog (satu putaran per productId). */
export async function rematchOpenDocsAfterBulkProductUomSync(
  db: Db,
  tenantId: string,
  uomDocsByProduct: Map<string, ProductUom[]>,
): Promise<{ products: number; docsTouched: number; linesPatched: number }> {
  let docsTouched = 0;
  let linesPatched = 0;
  for (const [productId, uoms] of uomDocsByProduct) {
    const r = await rematchOpenCpoUomsForProduct(db, tenantId, productId, uoms);
    docsTouched += r.docsTouched;
    linesPatched += r.linesPatched;
  }
  return { products: uomDocsByProduct.size, docsTouched, linesPatched };
}
