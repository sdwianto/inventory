import type { Db } from 'mongodb';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
// Sinkron tier harga pelanggan per vendor dari sales.app. H2: SDK.

import { upsertVendorTenant } from '@/lib/api/vendor-tenants';
import { createIntegrationClient } from '@/lib/integration/client';
import { IntegrationError } from '@/lib/integration/errors';
import { randomUUID } from 'node:crypto';

export async function syncVendorTiersFromSales(
  db: Db,
  customerTenantId: string,
  config: Record<string, unknown>,
) {
  const ctid = String(config.customerTenantId || customerTenantId || '').trim().toLowerCase();
  if (!ctid) return { error: 'customerTenantId tidak ada' };

  const salesApiKey = await getSalesApiKeyForVendor(db, ctid);
  if (!salesApiKey) return { error: 'API key tidak ada' };
  const salesAppUrl = String(config.salesAppUrl || '').trim();
  if (!salesAppUrl) return { error: 'salesAppUrl tidak ada' };

  let data: Record<string, unknown>;
  try {
    const client = createIntegrationClient(db);
    data = await client.getCustomerProfile({
      salesAppUrl,
      apiKey: salesApiKey,
      correlationId: randomUUID(),
      customerTenantId: ctid,
      timeoutMs: 20_000,
    });
  } catch (e) {
    if (e instanceof IntegrationError) return { error: e.message };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const vendors = Array.isArray(data.vendors) ? (data.vendors as Array<Record<string, unknown>>) : [];
  const tierMap: Record<string, unknown> = {};
  for (const v of vendors) {
    if (!v?.vendorTenantId) continue;
    const tier = String(v.tierHargaDefault || 'ECER').toUpperCase();
    tierMap[String(v.vendorTenantId)] = tier;
    await upsertVendorTenant(
      db,
      customerTenantId,
      String(v.vendorTenantId),
      String(v.vendorTenantName || v.vendorTenantId),
      tier,
    );
  }

  const primaryVendor = String(config.vendorTenantId || '');
  const primaryTier = tierMap[primaryVendor] || vendors[0]?.tierHargaDefault || 'ECER';
  const now = new Date();
  await db.collection('integration_settings').updateOne(
    { tenantId: customerTenantId },
    { $set: { tierHargaDefault: String(primaryTier).toUpperCase(), tierSyncedAt: now, updatedAt: now } },
  );

  return { synced: vendors.length, tierMap, tierHargaDefault: String(primaryTier).toUpperCase() };
}

export async function getVendorTierMap(db: Db, customerTenantId: string) {
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
