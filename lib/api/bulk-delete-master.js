import { ok, err } from '@/lib/api/db';
import { withTenantFilter } from '@/lib/api/tenant-master';

/** @param {import('mongodb').Db} db @param {object} auth @param {string} collection @param {string[]} ids */
export async function bulkDeleteMaster(db, auth, collection, ids) {
  const unique = [...new Set((ids || []).map(String).filter(Boolean))];
  if (unique.length === 0) return err('Tidak ada item dipilih', 400);
  const filter = withTenantFilter(auth, { id: { $in: unique } });
  const found = await db.collection(collection).countDocuments(filter);
  if (found === 0) return err('Data tidak ditemukan atau tidak ada akses', 404);
  const result = await db.collection(collection).deleteMany(filter);
  return ok({ deleted: result.deletedCount, requested: unique.length });
}
