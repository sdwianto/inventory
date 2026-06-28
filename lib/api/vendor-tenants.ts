import type { Db } from 'mongodb';
// Registry nama vendor/tenant sales.app untuk tampilan UI.

import type { JsonObject } from '@/types/json';

interface VendorTenantRef {
  tenantId?: string;
  tenantName?: string;
}

export async function upsertVendorTenant(
  db: Db,
  customerTenantId: string | null | undefined,
  vendorTenantId: string | null | undefined,
  vendorTenantName: string | null | undefined,
  tierHargaDefault?: string,
): Promise<void> {
  const tid = customerTenantId || 'default';
  const vid = String(vendorTenantId || '').trim();
  if (!vid) return;
  const name = String(vendorTenantName || vid).trim() || vid;
  const tier = tierHargaDefault ? String(tierHargaDefault).toUpperCase() : undefined;
  const now = new Date();
  const set: Record<string, unknown> = { vendorTenantName: name, updatedAt: now };
  if (tier) set.tierHargaDefault = tier;
  await db.collection('vendor_tenants').updateOne(
    { tenantId: tid, vendorTenantId: vid },
    {
      $set: set,
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

export async function upsertVendorTenantsFromCatalog(
  db: Db,
  customerTenantId: string | null | undefined,
  availableTenants: VendorTenantRef[] = [],
): Promise<void> {
  for (const t of availableTenants) {
    if (!t?.tenantId) continue;
    await upsertVendorTenant(db, customerTenantId, t.tenantId, t.tenantName || t.tenantId);
  }
}

export async function getVendorTenantNameMap(
  db: Db,
  customerTenantId: string | null | undefined,
): Promise<Record<string, string>> {
  const tid = customerTenantId || 'default';
  const rows = await db.collection('vendor_tenants').find({ tenantId: tid }).toArray();
  const map: Record<string, string> = {};
  for (const r of rows) {
    if (r.vendorTenantId) map[String(r.vendorTenantId)] = String(r.vendorTenantName || r.vendorTenantId);
  }
  return map;
}

export async function backfillProductVendorNames(
  db: Db,
  customerTenantId: string | null | undefined,
): Promise<number> {
  const tid = customerTenantId || 'default';
  const map = await getVendorTenantNameMap(db, tid);
  let updated = 0;
  for (const [vendorTenantId, vendorTenantName] of Object.entries(map)) {
    const r = await db.collection('products').updateMany(
      {
        tenantId: tid,
        vendorTenantId,
        syncSource: 'sales.app',
        $or: [
          { vendorTenantName: { $exists: false } },
          { vendorTenantName: '' },
          { vendorTenantName: vendorTenantId },
        ],
      },
      { $set: { vendorTenantName, updatedAt: new Date() } },
    );
    updated += r.modifiedCount;
  }
  return updated;
}

export function resolveVendorTenantName(
  product: JsonObject | null | undefined,
  nameMap: Record<string, string> = {},
): string {
  if (product?.vendorTenantName && product.vendorTenantName !== product.vendorTenantId) {
    return String(product.vendorTenantName);
  }
  const vid = product?.vendorTenantId ? String(product.vendorTenantId) : '';
  if (vid && nameMap[vid]) return nameMap[vid];
  return String(product?.vendorTenantName || vid || '');
}

export async function enrichProductsVendorNames(
  db: Db,
  customerTenantId: string | null | undefined,
  products: JsonObject[] | null | undefined,
): Promise<JsonObject[]> {
  const nameMap = await getVendorTenantNameMap(db, customerTenantId);
  return (products || []).map((p) => ({
    ...p,
    vendorTenantName: resolveVendorTenantName(p, nameMap),
  }));
}
