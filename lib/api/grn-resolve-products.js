import { resolveProductByKode } from '@/lib/api/resolve-product-by-kode';
import { ensureUniqueLineIds } from '@/lib/api/grn-line-ids';

export const UNRESOLVED_GRN_STATUSES = ['UNKNOWN_PRODUCT', 'NEEDS_MAPPING'];

export function isUnresolvedGrnStatus(status) {
  return UNRESOLVED_GRN_STATUSES.includes(status);
}

export async function resolveGrnItemProduct(db, tenantId, vendorTenantId, item) {
  const resolved = await resolveProductByKode(db, tenantId, vendorTenantId, {
    kode: item.vendorKode || item.kode,
    stokId: item.vendorStokId || item.stokId,
  });

  if (!resolved.localStokId) {
    return {
      ...item,
      mapStatus: 'UNKNOWN',
      localStokId: null,
      localKode: null,
      localNama: null,
    };
  }

  return {
    ...item,
    mapStatus: 'MAPPED',
    localStokId: resolved.localStokId,
    localKode: resolved.localKode,
    localNama: resolved.localNama,
  };
}

export async function refreshGrnProducts(db, grn) {
  if (!grn || grn.status === 'POSTED') return grn;

  const tenantId = grn.tenantId || 'default';
  const vendorTenantId = grn.vendorTenantId || null;
  const items = [];

  for (const it of grn.items || []) {
    if (it.localStokId) {
      items.push(it);
      continue;
    }
    const next = await resolveGrnItemProduct(db, tenantId, vendorTenantId, it);
    items.push(next);
  }

  const { items: uniqueItems, changed: lineIdsChanged } = ensureUniqueLineIds(items);
  const stillUnknown = uniqueItems.some((it) => !it.localStokId);
  const newStatus = stillUnknown ? 'UNKNOWN_PRODUCT' : 'DRAFT';
  const statusChanged = newStatus !== grn.status;
  const itemsChanged = lineIdsChanged || JSON.stringify(uniqueItems) !== JSON.stringify(grn.items || []);

  if (!statusChanged && !itemsChanged) return grn;

  await db.collection('goods_receipts').updateOne(
    { id: grn.id },
    { $set: { items: uniqueItems, status: newStatus } },
  );

  return { ...grn, items: uniqueItems, status: newStatus };
}

export async function refreshUnresolvedGrnsForTenant(db, tenantId) {
  const tid = tenantId || 'default';
  const grns = await db.collection('goods_receipts').find({
    tenantId: tid,
    status: { $in: UNRESOLVED_GRN_STATUSES },
  }).toArray();

  let updated = 0;
  for (const grn of grns) {
    const before = `${grn.status}:${JSON.stringify(grn.items)}`;
    const after = await refreshGrnProducts(db, grn);
    const afterKey = `${after.status}:${JSON.stringify(after.items)}`;
    if (before !== afterKey) updated += 1;
  }
  return updated;
}

export async function refreshGrnsForProductKode(db, tenantId, kode) {
  const tid = tenantId || 'default';
  const trimmed = String(kode || '').trim();
  if (!trimmed) return 0;

  const grns = await db.collection('goods_receipts').find({
    tenantId: tid,
    status: { $in: UNRESOLVED_GRN_STATUSES },
    'items.vendorKode': trimmed,
  }).toArray();

  for (const grn of grns) {
    await refreshGrnProducts(db, grn);
  }
  return grns.length;
}
