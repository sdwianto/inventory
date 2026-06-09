// Shared aggregation helpers — hindari N+1 query di list endpoint.

/** @returns {Map<string, number>} */
export async function saldoByRefId(db, collection, matchFilter, refField = 'pelangganId', sumField = 'sisa') {
  const rows = await db.collection(collection).aggregate([
    { $match: matchFilter },
    { $group: { _id: `$${refField}`, saldo: { $sum: `$${sumField}` } } },
  ]).toArray();
  return new Map(rows.filter((r) => r._id).map((r) => [r._id, r.saldo || 0]));
}

/** Batch load master docs by id → Map<id, doc>. */
export async function masterDocsByIds(db, collection, auth, ids, projection = { id: 1, nama: 1, kode: 1 }) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const { withTenantFilter } = await import('@/lib/api/tenant-master');
  const docs = await db.collection(collection)
    .find(withTenantFilter(auth, { id: { $in: unique } }))
    .project(projection)
    .toArray();
  return new Map(docs.map((d) => [d.id, d]));
}
