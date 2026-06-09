// Enrich baris list/laporan dengan tenantName & lokasi gudang (sinkron master lokasi).

import { lokasiLabelMap, resolveLokasiDisplay } from '@/lib/api/lokasi-label';

export async function tenantNameMap(db, tenantIds) {
  const ids = [...new Set((tenantIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const settings = await db.collection('tenant_settings')
    .find({ tenantId: { $in: ids } })
    .project({ tenantId: 1, companyName: 1 })
    .toArray();
  return new Map(settings.map((s) => [s.tenantId, s.companyName || s.tenantId]));
}

export function resolveTenantName(map, tenantId, fallback) {
  const tid = tenantId || 'default';
  return map.get(tid) || fallback || tid;
}

export async function enrichWithScope(db, auth, rows, { getTenantId, getLokasi } = {}) {
  const tidOf = getTenantId || ((r) => r.tenantId);
  const lokOf = getLokasi || ((r) => r.lokasi);
  const tenantMap = await tenantNameMap(db, rows.map(tidOf));
  const lokMap = await lokasiLabelMap(db, auth);
  return rows.map((r) => ({
    ...r,
    tenantName: r.tenantName || resolveTenantName(tenantMap, tidOf(r)),
    lokasi: resolveLokasiDisplay(lokMap, tidOf(r), lokOf(r)),
  }));
}

export async function enrichTransactionsList(db, auth, rows) {
  return enrichWithScope(db, auth, rows);
}

export async function enrichPembelianList(db, auth, rows) {
  return enrichWithScope(db, auth, rows);
}

export async function enrichPiutangList(db, auth, rows) {
  const tenantMap = await tenantNameMap(db, rows.map((p) => p.tenantId));
  const lokMap = await lokasiLabelMap(db, auth);
  const refIds = [...new Set(rows.map((p) => p.referenceId).filter(Boolean))];
  const trxs = refIds.length
    ? await db.collection('transactions')
      .find({ id: { $in: refIds } })
      .project({ id: 1, lokasi: 1, tenantId: 1 })
      .toArray()
    : [];
  const trxMap = new Map(trxs.map((t) => [t.id, t]));
  return rows.map((p) => {
    const trx = trxMap.get(p.referenceId);
    return {
      ...p,
      tenantName: resolveTenantName(tenantMap, p.tenantId),
      lokasi: trx
        ? resolveLokasiDisplay(lokMap, trx.tenantId || p.tenantId, trx.lokasi)
        : '-',
    };
  });
}

export async function enrichHutangList(db, auth, rows) {
  const tenantMap = await tenantNameMap(db, rows.map((h) => h.tenantId));
  const lokMap = await lokasiLabelMap(db, auth);
  const refIds = [...new Set(rows.map((h) => h.referenceId).filter(Boolean))];
  const noPems = [...new Set(rows.map((h) => h.noPembelian).filter(Boolean))];
  const pembelians = (refIds.length || noPems.length)
    ? await db.collection('pembelian')
      .find({
        $or: [
          ...(refIds.length ? [{ id: { $in: refIds } }] : []),
          ...(noPems.length ? [{ noPembelian: { $in: noPems } }] : []),
        ],
      })
      .project({ id: 1, noPembelian: 1, lokasi: 1, tenantId: 1 })
      .toArray()
    : [];
  const pemById = new Map(pembelians.map((p) => [p.id, p]));
  const pemByNo = new Map(pembelians.map((p) => [p.noPembelian, p]));
  return rows.map((h) => {
    const pem = pemById.get(h.referenceId) || pemByNo.get(h.noPembelian);
    return {
      ...h,
      tenantName: resolveTenantName(tenantMap, h.tenantId),
      lokasi: pem
        ? resolveLokasiDisplay(lokMap, pem.tenantId || h.tenantId, pem.lokasi)
        : '-',
    };
  });
}
