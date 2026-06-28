import type { NextResponse } from 'next/server';
import type { Db } from 'mongodb';
import { ok, err } from '@/lib/api/db';
import { withTenantFilter } from '@/lib/api/tenant-master';
import type { AuthContext } from '@/types/auth';

export async function bulkDeleteMaster(
  db: Db,
  auth: AuthContext | null,
  collection: string,
  ids: unknown[] | null | undefined,
): Promise<NextResponse> {
  const unique = [...new Set((ids || []).map(String).filter(Boolean))];
  if (unique.length === 0) return err('Tidak ada item dipilih', 400);
  const filter = withTenantFilter(auth, { id: { $in: unique } });
  const found = await db.collection(collection).countDocuments(filter);
  if (found === 0) return err('Data tidak ditemukan atau tidak ada akses', 404);
  const result = await db.collection(collection).deleteMany(filter);
  return ok({ deleted: result.deletedCount, requested: unique.length });
}
