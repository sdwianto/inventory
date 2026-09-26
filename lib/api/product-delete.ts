// Hapus produk master = soft delete: dokumen tetap ada untuk riwayat kartu/dokumen, kode dilepas agar bisa dipakai ulang.

import type { Db } from 'mongodb';
import { roundStockQty } from '@/lib/stock-ledger/precision';
import { isVendorSyncedProduct } from '@/lib/api/product-sync';
import { deleteProductUoms } from '@/lib/api/product-uom';
import { writeAuditLog } from '@/lib/api/audit-log';
import type { AuthContext } from '@/types/auth';

export type SoftDeleteProductsResult =
  | { ok: true; deleted: number; kodes: string[] }
  | { ok: false; status: number; error: string };

/** Filter daftar master: sembunyikan produk yang sudah dihapus. */
export const NOT_DELETED_PRODUCT_FILTER = { deletedAt: null } as const;

export function releasedProductKode(kode: string, id: string): string {
  return `${kode}~DEL-${id.slice(0, 8)}`;
}

async function productIdsWithStock(db: Db, tenantId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db.collection('stok_lokasi')
    .find({ tenantId, stokId: { $in: ids } })
    .project<{ stokId: string; qty?: number | string }>({ stokId: 1, qty: 1 })
    .toArray();
  return [...new Set(rows.filter((r) => roundStockQty(r.qty) > 0).map((r) => r.stokId))];
}

export async function softDeleteProducts(
  db: Db,
  tenantId: string,
  ids: string[],
  auth: AuthContext | null,
): Promise<SoftDeleteProductsResult> {
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  if (!unique.length) return { ok: false, status: 400, error: 'Tidak ada item dipilih' };
  const rows = await db.collection('products')
    .find({ tenantId, id: { $in: unique }, deletedAt: null })
    .project({ id: 1, kode: 1, nama: 1, syncSource: 1, vendorStokId: 1, vendorTenantId: 1, mergedInto: 1 })
    .toArray();
  if (!rows.length) return { ok: false, status: 404, error: 'Data tidak ditemukan atau tidak ada akses' };
  const vendorLocked = rows.filter((r) => isVendorSyncedProduct(r));
  if (vendorLocked.length) {
    return { ok: false, status: 400, error: `${vendorLocked.length} produk dari sales.app tidak bisa dihapus di inventory — nonaktifkan di vendor` };
  }
  const rowIds = rows.map((r) => String(r.id));
  const withStock = await productIdsWithStock(db, tenantId, rowIds);
  if (withStock.length) {
    return { ok: false, status: 400, error: `${withStock.length} produk masih punya stok — kosongkan lewat penyesuaian stok sebelum dihapus` };
  }
  const canonical = await db.collection('products').distinct('mergedInto', { tenantId, mergedInto: { $in: rowIds } });
  if (canonical.length) {
    return { ok: false, status: 400, error: `${canonical.length} produk adalah item persediaan untuk sumber vendor tergabung — tidak bisa dihapus` };
  }

  const now = new Date();
  const actorName = String(auth?.name || auth?.email || 'System');
  const kodes: string[] = [];
  for (const row of rows) {
    const id = String(row.id);
    const kode = String(row.kode || '');
    const res = await db.collection('products').updateOne(
      { tenantId, id, deletedAt: null },
      {
        $set: {
          aktif: false,
          deletedAt: now,
          deletedBy: { userId: auth?.userId || '', userName: actorName },
          kodeAsli: kode,
          kode: kode ? releasedProductKode(kode, id) : kode,
          barcode: null,
          updatedAt: now,
        },
      },
    );
    if (!res.modifiedCount) continue;
    await deleteProductUoms(db, tenantId, id);
    kodes.push(kode);
    await writeAuditLog(db, {
      tenantId,
      action: 'PRODUCT_DELETE',
      entityType: 'product',
      entityId: id,
      summary: `Produk ${kode} ${String(row.nama || '')} dihapus`.trim(),
      userId: auth?.userId,
      userName: actorName,
      metadata: { kode, nama: row.nama ?? null, softDelete: true },
    });
  }
  return { ok: true, deleted: kodes.length, kodes };
}
