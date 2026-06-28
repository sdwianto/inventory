import type { Db } from 'mongodb';
import { resolveProductByKode } from '@/lib/api/resolve-product-by-kode';
import { ensureUniqueLineIds } from '@/lib/api/grn-line-ids';
import type { GrnDoc } from '@/types/documents';
import { asArray, type JsonObject } from '@/types/json';

export const UNRESOLVED_GRN_STATUSES = ['UNKNOWN_PRODUCT', 'NEEDS_MAPPING'] as const;

export function isUnresolvedGrnStatus(status: string) {
  return (UNRESOLVED_GRN_STATUSES as readonly string[]).includes(status);
}

type ProductDoc = JsonObject & { id?: string; kode?: string; nama?: string; vendorStokId?: string };
type ProductMaps = { kodeMap: Map<string, ProductDoc>; stokMap: Map<string, ProductDoc> };

export async function loadProductMaps(db: Db, tenantId: string, vendorTenantId: string | null, items: JsonObject[]) {
  const tid = tenantId || 'default';
  const kodes = [...new Set((items || []).map((it) => String(it.vendorKode || it.kode || '').trim()).filter(Boolean))];
  const stokIds = [...new Set((items || []).map((it) => String(it.vendorStokId || it.stokId || '')).filter(Boolean))];

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

  const kodeMap = new Map<string, ProductDoc>(
    byKode.map((p) => [String(p.kode), p as ProductDoc] as [string, ProductDoc]),
  );
  const stokMap = new Map<string, ProductDoc>(
    byVendorStok.map((p) => [String(p.vendorStokId), p as ProductDoc] as [string, ProductDoc]),
  );
  return { kodeMap, stokMap };
}

export function resolveFromMaps(maps: ProductMaps, vendorTenantId: string | null, item: JsonObject) {
  const kode = String(item.vendorKode || item.kode || '').trim();
  let prod = kode ? maps.kodeMap.get(kode) : null;
  const stokId = String(item.vendorStokId || item.stokId || '');
  if (!prod && stokId && vendorTenantId) {
    prod = maps.stokMap.get(stokId) || null;
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

export async function resolveGrnItemProduct(
  db: Db,
  tenantId: string,
  vendorTenantId: string | null,
  item: JsonObject,
) {
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

export async function refreshGrnProducts(db: Db, grn: GrnDoc, productMaps: ProductMaps | null = null) {
  if (!grn || grn.status === 'POSTED') return grn;

  const tenantId = grn.tenantId || 'default';
  const vendorTenantId = grn.vendorTenantId || null;
  const grnItems = asArray(grn.items) as JsonObject[];
  const needsResolve = grnItems.some((it) => !it.localStokId);
  const maps = productMaps || (needsResolve
    ? await loadProductMaps(db, tenantId, vendorTenantId, grnItems)
    : null);

  const items: JsonObject[] = [];
  for (const it of grnItems) {
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

export async function refreshUnresolvedGrnsForTenant(db: Db, tenantId) {
  const tid = tenantId || 'default';
  const grns = await db.collection('goods_receipts').find({
    tenantId: tid,
    status: { $in: UNRESOLVED_GRN_STATUSES },
  }).toArray();

  if (!grns.length) return 0;

  const allItems = grns.flatMap((g) => asArray(g.items) as JsonObject[]);
  const vendorTenantId = grns[0]?.vendorTenantId ? String(grns[0].vendorTenantId) : null;
  const maps = await loadProductMaps(db, tid, vendorTenantId, allItems);

  let updated = 0;
  for (const grn of grns) {
    const before = `${grn.status}:${JSON.stringify(grn.items)}`;
    const after = await refreshGrnProducts(db, grn as GrnDoc, maps);
    const afterKey = `${after.status}:${JSON.stringify(after.items)}`;
    if (before !== afterKey) updated += 1;
  }
  return updated;
}

export async function refreshGrnsForProductKode(db: Db, tenantId, kode) {
  const tid = tenantId || 'default';
  const trimmed = String(kode || '').trim();
  if (!trimmed) return 0;

  const grns = await db.collection('goods_receipts').find({
    tenantId: tid,
    status: { $in: UNRESOLVED_GRN_STATUSES },
    'items.vendorKode': trimmed,
  }).toArray();

  for (const grn of grns) {
    await refreshGrnProducts(db, grn as GrnDoc);
  }
  return grns.length;
}
