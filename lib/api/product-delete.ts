// Hapus produk master = soft delete: dokumen tetap ada untuk riwayat kartu/dokumen, kode dilepas agar bisa dipakai ulang.

import type { ClientSession, Db } from 'mongodb';
import { roundStockQty } from '@/lib/stock-ledger/precision';
import { isVendorSyncedProduct } from '@/lib/api/product-sync';
import { PRODUCT_UOM_COLLECTION } from '@/lib/uom/types';
import { writeAuditLog } from '@/lib/api/audit-log';
import { runInTransactionOnDb, txOpts } from '@/lib/api/transaction';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import type { AuthContext } from '@/types/auth';

export type SoftDeleteProductsResult =
  | { ok: true; deleted: number; kodes: string[] }
  | { ok: false; status: number; error: string };

/** Filter daftar master: sembunyikan produk yang sudah dihapus. */
export const NOT_DELETED_PRODUCT_FILTER = { deletedAt: null } as const;

export function releasedProductKode(kode: string, id: string): string {
  return `${kode}~DEL-${id.slice(0, 8)}`;
}

class DeleteAbort extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function productIdsWithStock(db: Db, tenantId: string, ids: string[], session?: ClientSession): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db.collection('stok_lokasi')
    .find({ ...tenantIdMatchFilter(tenantId), stokId: { $in: ids } }, txOpts(session))
    .project<{ stokId: string; qty?: number | string }>({ stokId: 1, qty: 1 })
    .toArray();
  return [...new Set(rows.filter((r) => roundStockQty(r.qty) !== 0).map((r) => r.stokId))];
}

/**
 * Dalam satu transaksi: cek stok lalu tandai terhapus. Posting stok bersamaan menulis dokumen produk
 * (stok / avgCost) sehingga bentrok write-conflict dan diulang dengan data terbaru.
 */
export async function softDeleteProducts(
  db: Db,
  tenantId: string,
  ids: string[],
  auth: AuthContext | null,
): Promise<SoftDeleteProductsResult> {
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  if (!unique.length) return { ok: false, status: 400, error: 'Tidak ada item dipilih' };
  const actorName = String(auth?.name || auth?.email || 'System');
  try {
    return await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const rows = await txDb.collection('products')
        .find({ ...tenantIdMatchFilter(tenantId), id: { $in: unique }, deletedAt: null }, txOpts(session))
        .project({ id: 1, tenantId: 1, kode: 1, nama: 1, syncSource: 1, vendorStokId: 1, vendorTenantId: 1, mergedInto: 1 })
        .toArray();
      if (!rows.length) throw new DeleteAbort(404, 'Data tidak ditemukan atau tidak ada akses');
      const vendorLocked = rows.filter((r) => isVendorSyncedProduct(r));
      if (vendorLocked.length) {
        throw new DeleteAbort(400, `${vendorLocked.length} produk dari sales.app tidak bisa dihapus di inventory — nonaktifkan di vendor`);
      }
      const rowIds = rows.map((r) => String(r.id));
      const withStock = await productIdsWithStock(txDb, tenantId, rowIds, session);
      if (withStock.length) {
        throw new DeleteAbort(400, `${withStock.length} produk masih punya saldo stok (positif atau minus) — nolkan lewat penyesuaian stok sebelum dihapus`);
      }
      const canonical = await txDb.collection('products').distinct(
        'mergedInto',
        { ...tenantIdMatchFilter(tenantId), mergedInto: { $in: rowIds } },
        txOpts(session),
      );
      if (canonical.length) {
        throw new DeleteAbort(400, `${canonical.length} produk adalah item persediaan untuk sumber vendor tergabung — tidak bisa dihapus`);
      }

      const now = new Date();
      const kodes: string[] = [];
      for (const row of rows) {
        const id = String(row.id);
        const kode = String(row.kode || '');
        const res = await txDb.collection('products').updateOne(
          { ...tenantIdMatchFilter(tenantId), id, deletedAt: null },
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
          txOpts(session),
        );
        if (!res.modifiedCount) throw new DeleteAbort(409, 'Produk berubah bersamaan — muat ulang');
        await txDb.collection(PRODUCT_UOM_COLLECTION).deleteMany({ ...tenantIdMatchFilter(tenantId), productId: id }, txOpts(session));
        kodes.push(kode);
        await writeAuditLog(txDb, {
          tenantId,
          action: 'PRODUCT_DELETE',
          entityType: 'product',
          entityId: id,
          summary: `Produk ${kode} ${String(row.nama || '')} dihapus`.trim(),
          userId: auth?.userId,
          userName: actorName,
          metadata: { kode, nama: row.nama ?? null, softDelete: true },
        }, session);
      }
      return { ok: true as const, deleted: kodes.length, kodes };
    });
  } catch (e) {
    if (e instanceof DeleteAbort) return { ok: false, status: e.status, error: e.message };
    throw e;
  }
}
