import type { Db } from 'mongodb';
import { normalizeBaseSatuan } from '@/lib/api/product-merge';

export type UomRebasePending = { from: string; to: string; at: Date };

/**
 * Satuan dasar dari sales.app berubah pada produk yang sudah punya riwayat stok: qty basis lama
 * (stok, kartu, lot, GRN, resep) masih dalam satuan lama. Produk ditandai `uomRebasePending`
 * sampai migrasi 0011 mengonversi datanya; posting stok ditolak selama tanda ini ada.
 */
export async function uomRebasePendingPatch(
  db: Db,
  tenantId: string,
  existing: Record<string, unknown> | null | undefined,
  nextSatuan: unknown,
  now: Date,
): Promise<{ uomRebasePending: UomRebasePending } | null> {
  if (!existing?.id || existing.mergedInto) return null;
  const from = normalizeBaseSatuan(existing.satuan);
  const to = normalizeBaseSatuan(nextSatuan);
  if (!from || !to || from === to) return null;
  const prev = existing.uomRebasePending as Partial<UomRebasePending> | undefined;
  const id = String(existing.id);
  const hasHistory = await db.collection('stok_kartu').countDocuments({ tenantId, stokId: id }, { limit: 1 })
    || await db.collection('stok_lokasi').countDocuments({ tenantId, stokId: id, qty: { $ne: 0 } }, { limit: 1 });
  if (!hasHistory) return null;
  return { uomRebasePending: { from: prev?.from ? normalizeBaseSatuan(prev.from) : from, to, at: now } };
}

export function uomRebasePendingError(product: { kode?: unknown; id?: unknown; uomRebasePending?: unknown }): string | null {
  const p = product.uomRebasePending as Partial<UomRebasePending> | null | undefined;
  if (!p?.from || !p?.to) return null;
  return `Satuan dasar ${String(product.kode || product.id)} berubah ${p.from} → ${p.to} di sales.app; `
    + 'riwayat stok belum dikonversi. Jalankan migrasi 0011-rebase-product-uom sebelum mutasi stok.';
}
