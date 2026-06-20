// Registry nama vendor/tenant sales.app untuk tampilan UI.

export async function upsertVendorTenant(db, customerTenantId, vendorTenantId, vendorTenantName, tierHargaDefault) {
  const tid = customerTenantId || 'default';
  const vid = String(vendorTenantId || '').trim();
  if (!vid) return;
  const name = String(vendorTenantName || vid).trim() || vid;
  const tier = tierHargaDefault ? String(tierHargaDefault).toUpperCase() : undefined;
  const now = new Date();
  const set = { vendorTenantName: name, updatedAt: now };
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

export async function upsertVendorTenantsFromCatalog(db, customerTenantId, availableTenants = []) {
  for (const t of availableTenants) {
    if (!t?.tenantId) continue;
    await upsertVendorTenant(db, customerTenantId, t.tenantId, t.tenantName || t.tenantId);
  }
}

export async function getVendorTenantNameMap(db, customerTenantId) {
  const tid = customerTenantId || 'default';
  const rows = await db.collection('vendor_tenants').find({ tenantId: tid }).toArray();
  const map = {};
  for (const r of rows) {
    if (r.vendorTenantId) map[r.vendorTenantId] = r.vendorTenantName || r.vendorTenantId;
  }
  return map;
}

export async function backfillProductVendorNames(db, customerTenantId) {
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

export function resolveVendorTenantName(product, nameMap = {}) {
  if (product?.vendorTenantName && product.vendorTenantName !== product.vendorTenantId) {
    return product.vendorTenantName;
  }
  const vid = product?.vendorTenantId;
  if (vid && nameMap[vid]) return nameMap[vid];
  return product?.vendorTenantName || vid || '';
}

export async function enrichProductsVendorNames(db, customerTenantId, products) {
  const nameMap = await getVendorTenantNameMap(db, customerTenantId);
  return (products || []).map((p) => ({
    ...p,
    vendorTenantName: resolveVendorTenantName(p, nameMap),
  }));
}
