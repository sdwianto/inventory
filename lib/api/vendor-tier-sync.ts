import type { Db } from 'mongodb';
// Sinkron tier harga pelanggan per vendor dari sales.app.

import { upsertVendorTenant } from '@/lib/api/vendor-tenants';

export async function syncVendorTiersFromSales(db: Db, customerTenantId, config) {
  if (!config?.salesApiKey) return { error: 'API key tidak ada' };

  const ctid = String(config.customerTenantId || customerTenantId || '').trim().toLowerCase();
  if (!ctid) return { error: 'customerTenantId tidak ada' };

  const headers = { 'X-Api-Key': config.salesApiKey };
  const url = `${config.salesAppUrl}/api/integrations/customer-profile?customerTenantId=${encodeURIComponent(ctid)}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  const data = await res.json();
  if (!res.ok) return { error: data.error || `Sales.app ${res.status}` };

  const vendors = data.vendors || [];
  const tierMap: Record<string, unknown> = {};
  for (const v of vendors) {
    if (!v?.vendorTenantId) continue;
    const tier = String(v.tierHargaDefault || 'ECER').toUpperCase();
    tierMap[v.vendorTenantId] = tier;
    await upsertVendorTenant(
      db,
      customerTenantId,
      v.vendorTenantId,
      v.vendorTenantName || v.vendorTenantId,
      tier,
    );
  }

  const primaryVendor = config.vendorTenantId;
  const primaryTier = tierMap[primaryVendor] || vendors[0]?.tierHargaDefault || 'ECER';
  const now = new Date();
  await db.collection('integration_settings').updateOne(
    { tenantId: customerTenantId },
    { $set: { tierHargaDefault: String(primaryTier).toUpperCase(), tierSyncedAt: now, updatedAt: now } },
  );

  return { synced: vendors.length, tierMap, tierHargaDefault: String(primaryTier).toUpperCase() };
}

export async function getVendorTierMap(db: Db, customerTenantId) {
  const tid = customerTenantId || 'default';
  const rows = await db.collection('vendor_tenants').find({ tenantId: tid }).toArray();
  const map: Record<string, unknown> = {};
  for (const r of rows) {
    if (r.vendorTenantId && r.tierHargaDefault) {
      map[r.vendorTenantId] = String(r.tierHargaDefault).toUpperCase();
    }
  }
  return map;
}
