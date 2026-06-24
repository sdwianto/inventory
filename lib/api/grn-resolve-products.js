import { resolveProductByKode } from '@/lib/api/resolve-product-by-kode';
import { ensureUniqueLineIds } from '@/lib/api/grn-line-ids';

export const UNRESOLVED_GRN_STATUSES = ['UNKNOWN_PRODUCT', 'NEEDS_MAPPING'];

export function isUnresolvedGrnStatus(status) {
  return UNRESOLVED_GRN_STATUSES.includes(status);
}

export async function loadProductMaps(db, tenantId, vendorTenantId, items) {
  const tid = tenantId || 'default';
  const kodes = [...new Set((items || []).map((it) => String(it.vendorKode || it.kode || '').trim()).filter(Boolean))];
  const stokIds = [...new Set((items || []).map((it) => it.vendorStokId || it.stokId).filter(Boolean))];

  const [byKode, byVendorStok] = await Promise.all([
    kodes.length
      ? db.collection('products').find({ tenantId: tid, kode: { $in: kodes }, aktif: { $ne: false } }).toArray()
      : [],
    stokIds.length && vendorTenantId
      ? db.collection('products').find({
        tenantId: tid,
        vendorStokId: { $in: stokIds },
        vendorTenantId,
        aktif: { $ne: false },
      }).toArray()
      : [],
  ]);

  const kodeMap = new Map(byKode.map((p) => [p.kode, p]));
  const stokMap = new Map(byVendorStok.map((p) => [p.vendorStokId, p]));
  return { kodeMap, stokMap };
}

export function resolveFromMaps(maps, vendorTenantId, item) {
  const kode = String(item.vendorKode || item.kode || '').trim();
  let prod = kode ? maps.kodeMap.get(kode) : null;
  const stokId = item.vendorStokId || item.stokId;
  if (!prod && stokId && vendorTenantId) {
    prod = maps.stokMap.get(stokId);
  }
  if (!prod) {
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
    localStokId: prod.id,
    localKode: prod.kode,
    localNama: prod.nama,
  };
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

export async function refreshGrnProducts(db, grn, productMaps = null) {
  if (!grn || grn.status === 'POSTED') return grn;

  const tenantId = grn.tenantId || 'default';
  const vendorTenantId = grn.vendorTenantId || null;
  const needsResolve = (grn.items || []).some((it) => !it.localStokId);
  const maps = productMaps || (needsResolve
    ? await loadProductMaps(db, tenantId, vendorTenantId, grn.items)
    : null);

  const items = [];
  for (const it of grn.items || []) {
    if (it.localStokId) {
      items.push(it);
      continue;
    }
    items.push(maps ? resolveFromMaps(maps, vendorTenantId, it) : await resolveGrnItemProduct(db, tenantId, vendorTenantId, it));
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

  if (!grns.length) return 0;

  const allItems = grns.flatMap((g) => g.items || []);
  const vendorTenantId = grns[0]?.vendorTenantId || null;
  const maps = await loadProductMaps(db, tid, vendorTenantId, allItems);

  let updated = 0;
  for (const grn of grns) {
    const before = `${grn.status}:${JSON.stringify(grn.items)}`;
    const after = await refreshGrnProducts(db, grn, maps);
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
