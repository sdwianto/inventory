// Shared aggregation helpers — hindari N+1 query di list endpoint.

import type { Db } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import type { AuthContext } from '@/types/auth';

/** @returns Map refId → saldo */
export async function saldoByRefId(
  db: Db,
  collection: string,
  matchFilter: Filter<Document>,
  refField = 'pelangganId',
  sumField = 'sisa',
): Promise<Map<string, number>> {
  const rows = await db.collection(collection).aggregate([
    { $match: matchFilter },
    { $group: { _id: `$${refField}`, saldo: { $sum: `$${sumField}` } } },
  ]).toArray();
  return new Map(
    rows.filter((r) => r._id).map((r) => [String(r._id), Number(r.saldo) || 0]),
  );
}

/** Batch load master docs by id → Map<id, doc>. */
export async function masterDocsByIds(
  db: Db,
  collection: string,
  auth: AuthContext | null,
  ids: Array<string | null | undefined>,
  projection: Record<string, 1> = { id: 1, nama: 1, kode: 1 },
): Promise<Map<string, Record<string, unknown>>> {
  const unique = [...new Set(ids.filter(Boolean))] as string[];
  if (unique.length === 0) return new Map();
  const { withTenantFilter } = await import('@/lib/api/tenant-master');
  const docs = await db.collection(collection)
    .find(withTenantFilter(auth, { id: { $in: unique } }))
    .project(projection)
    .toArray();
  return new Map(docs.map((d) => [String(d.id), d as Record<string, unknown>]));
}
