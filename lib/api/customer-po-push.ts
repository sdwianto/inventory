/** Kirim PO ke sales.app — shared oleh handler & bg_jobs. */

import type { Db } from 'mongodb';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { enrichPoItemsForVendor, groupPoItemsByVendorTenant } from '@/lib/api/customer-po-vendor';
import { buildVendorSoSnapshot, mergeVendorSoSnapshots } from '@/lib/api/vendor-so-snapshot';
import {
  enrichSubmissionsWithSoFromSales,
  extractPushedVendorSo,
  summarizeVendorNoSo,
} from '@/lib/api/customer-po-so-extract';
import { integrationCorrelationId, salesFetchErrorMessage } from '@/lib/api/integration-common';
import type { JsonObject } from '@/types/json';

export type PushPoToVendorResult =
  | { error: string; partialFailures?: JsonObject[] }
  | { submissions: JsonObject[]; partialFailures?: JsonObject[] };

export async function pushPoGroupToVendor(
  db: Db,
  { tenantId, config, po, vendorTenantId, items }: {
    tenantId: string;
    config: { salesAppUrl: string };
    po: Record<string, unknown>;
    vendorTenantId: string;
    items: JsonObject[];
  },
) {
  const salesUrl = config.salesAppUrl;
  const apiKey = await getSalesApiKeyForVendor(db, tenantId, vendorTenantId);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;

  let res: Response;
  try {
    res = await fetch(`${salesUrl}/api/integrations/customer-po`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        customerTenantId: tenantId,
        vendorTenantId,
        noPO: po.noPO,
        customerPoId: po.id,
        correlationId: integrationCorrelationId(String(po.id || ''), String(po.noPO || '')),
        tanggalKedatangan: po.tanggalKedatangan || po.tanggal || null,
        items,
        catatan: po.catatan || '',
        paymentTerms: po.paymentTerms || 'KREDIT',
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return { error: salesFetchErrorMessage(e, salesUrl), vendorTenantId };
  }

  let data: JsonObject;
  try {
    data = await res.json() as JsonObject;
  } catch {
    return {
      error: `Sales.app merespons HTTP ${res.status} tanpa data JSON valid`,
      vendorTenantId,
    };
  }
  if (!res.ok) return { error: String(data.error || `Sales.app ${res.status}`), vendorTenantId };
  return { vendorSo: data, vendorTenantId };
}

export async function pushPoToVendor(db: Db, po: Record<string, unknown>, tenantId: string): Promise<PushPoToVendorResult> {
  const config = await getIntegrationConfig(db, tenantId);
  const apiKey = await getSalesApiKeyForVendor(db, tenantId);
  if (!apiKey) {
    return { error: 'Belum terhubung ke sales.app — jalankan pairing dari menu Integrasi atau sales.app /integrasi' };
  }

  const enriched = await enrichPoItemsForVendor(db, tenantId, (po.items || []) as JsonObject[]);
  if (enriched.error) return { error: enriched.error };

  const grouped = groupPoItemsByVendorTenant(enriched.items || []);
  if (grouped.error) return { error: grouped.error };

  const submissions: JsonObject[] = [];
  const partialFailures: JsonObject[] = [];
  try {
    const groups = grouped.groups || [];
    for (const { vendorTenantId, items } of groups) {
      const pushed = await pushPoGroupToVendor(db, {
        tenantId,
        config,
        po,
        vendorTenantId,
        items,
      });
      if (pushed.error) {
        partialFailures.push({
          vendorTenantId,
          status: 'FAILED',
          error: pushed.error,
          itemCount: items.length,
        });
        continue;
      }
      const soDoc = extractPushedVendorSo(pushed.vendorSo as JsonObject);
      submissions.push({
        vendorTenantId,
        status: 'SYNCED',
        vendorSoId: soDoc.id || soDoc.salesOrderId,
        vendorNoSO: soDoc.noSO,
        vendorSo: soDoc,
        itemCount: items.length,
      });
    }
  } catch (e) {
    return { error: salesFetchErrorMessage(e, config.salesAppUrl) };
  }

  if (!submissions.length && partialFailures.length) {
    return {
      error: String(partialFailures[0].error || 'Semua vendor gagal'),
      partialFailures,
    };
  }

  return {
    submissions,
    ...(partialFailures.length ? { partialFailures } : {}),
  };
}

export async function finalizePoSubmission(
  db: Db,
  po: Record<string, unknown>,
  submissions: JsonObject[],
  approver: Record<string, unknown> | null | undefined,
  { partialFailures = [] }: { partialFailures?: JsonObject[] } = {},
) {
  const syncedSubs = submissions.length
    ? await enrichSubmissionsWithSoFromSales(db, po as JsonObject, submissions)
    : submissions;
  const primary = syncedSubs[0] || {};
  const now = new Date();
  const allSubs = [...syncedSubs, ...partialFailures];
  const hasFailures = partialFailures.length > 0;
  const patch: Record<string, unknown> = {
    status: syncedSubs.length ? 'SUBMITTED' : 'APPROVED',
    vendorSubmissions: allSubs,
    vendorTenantId: syncedSubs.length === 1 ? primary.vendorTenantId : (syncedSubs.length ? 'multi' : po.vendorTenantId),
    vendorSoId: primary.vendorSoId,
    vendorNoSO: syncedSubs.length === 1
      ? primary.vendorNoSO
      : summarizeVendorNoSo(syncedSubs),
    submittedAt: syncedSubs.length ? now : po.submittedAt || null,
    updatedAt: now,
    vendorSyncPending: hasFailures,
    vendorSyncError: hasFailures
      ? partialFailures.map((f) => `${f.vendorTenantId}: ${f.error}`).join('; ')
      : null,
  };
  if (approver) {
    patch.approvedBy = {
      userId: approver.userId,
      userName: approver.userName,
      role: approver.role,
    };
    patch.approvedAt = now;
  }
  const soSnaps = syncedSubs.map((sub) => buildVendorSoSnapshot({
    ...(sub.vendorSo as JsonObject),
    salesOrderId: sub.vendorSoId,
    noSO: sub.vendorNoSO,
  })).filter(Boolean);
  const soSnap = mergeVendorSoSnapshots(soSnaps);
  if (soSnap) patch.vendorSoSnapshot = soSnap;
  await db.collection('customer_purchase_orders').updateOne({ id: po.id }, { $set: patch });
  return db.collection('customer_purchase_orders').findOne({ id: po.id });
}
