/** Bulk pairing — daftarkan banyak vendor dari sales.app dalam satu panggilan. */

import type { Db } from 'mongodb';
import { upsertIntegrationLink, listActiveLinksForCustomer } from '@/lib/api/integration-links';
import { upsertVendorTenant } from '@/lib/api/vendor-tenants';
import { enqueueJob, JOB_TYPES, scheduleJobProcessing } from '@/lib/api/bg-jobs';

export interface PlatformPairVendorInput {
  vendorTenantId: string;
  vendorName?: string;
  tierHargaDefault?: string;
}

export interface PlatformPairInput {
  customerTenantId: string;
  salesAppUrl: string;
  salesApiKey: string;
  webhookSecret: string;
  vendors: PlatformPairVendorInput[];
  autoSyncCatalog?: boolean;
}

async function enqueueCatalogSync(db: Db, tenantId: string) {
  const existing = await db.collection('bg_jobs').findOne({
    tenantId,
    type: JOB_TYPES.CATALOG_SYNC,
    status: { $in: ['PENDING', 'RUNNING'] },
  });
  if (existing) return { jobId: String(existing.id), reused: true };
  const { jobId } = await enqueueJob(db, { type: JOB_TYPES.CATALOG_SYNC, tenantId, payload: {} });
  scheduleJobProcessing(db, { limit: 1 });
  return { jobId, reused: false };
}

export async function runPlatformPair(db: Db, input: PlatformPairInput) {
  const customerTenantId = String(input.customerTenantId || '').trim().toLowerCase();
  const salesAppUrl = String(input.salesAppUrl || '').replace(/\/$/, '');
  const salesApiKey = String(input.salesApiKey || '').trim();
  const webhookSecret = String(input.webhookSecret || '').trim();
  const vendors = Array.isArray(input.vendors) ? input.vendors : [];

  if (!customerTenantId) return { error: 'customerTenantId wajib' };
  if (!salesApiKey || !webhookSecret) return { error: 'salesApiKey dan webhookSecret wajib' };
  if (!vendors.length) return { error: 'Daftar vendor kosong' };

  const paired: Array<{ vendorTenantId: string; vendorName: string }> = [];
  const errors: Array<{ vendorTenantId: string; error: string }> = [];

  for (const v of vendors) {
    const vendorTenantId = String(v.vendorTenantId || '').trim();
    if (!vendorTenantId) continue;
    try {
      const link = await upsertIntegrationLink(db, {
        customerTenantId,
        vendorTenantId,
        salesAppUrl,
        salesApiKey,
        webhookSecret,
        vendorName: String(v.vendorName || vendorTenantId).trim(),
        tierHargaDefault: String(v.tierHargaDefault || 'GROSIR').toUpperCase(),
      });
      await upsertVendorTenant(
        db,
        customerTenantId,
        vendorTenantId,
        link.vendorName || vendorTenantId,
        link.tierHargaDefault,
      );
      paired.push({ vendorTenantId, vendorName: link.vendorName });
    } catch (e: unknown) {
      errors.push({
        vendorTenantId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  let catalogSync: Record<string, unknown> | null = null;
  if (input.autoSyncCatalog !== false && paired.length) {
    catalogSync = await enqueueCatalogSync(db, customerTenantId);
    scheduleJobProcessing(db, { limit: 1 });
  }

  const vendorLinkCount = (await listActiveLinksForCustomer(db, customerTenantId)).length;
  return {
    message: `Platform pair — ${paired.length} vendor terdaftar`,
    tenantId: customerTenantId,
    pairedCount: paired.length,
    errorCount: errors.length,
    paired,
    errors,
    vendorLinkCount,
    catalogSync,
  };
}
