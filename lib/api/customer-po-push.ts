/** Kirim PO ke sales.app — shared oleh handler & bg_jobs. */

import type { Db } from 'mongodb';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { enrichPoItemsForVendor, groupPoItemsByVendorTenant } from '@/lib/api/customer-po-vendor';
import { buildVendorSoSnapshot, mergeVendorSoSnapshots } from '@/lib/api/vendor-so-snapshot';
import type { JsonObject } from '@/types/json';

function salesFetchErrorMessage(err: unknown, salesUrl: string) {
  const e = err as { cause?: { code?: string; message?: string }; code?: string; name?: string; message?: string };
  const cause = e?.cause || e;
  const code = cause?.code || e?.code;
  if (code === 'ECONNREFUSED') {
    return `Sales.app tidak dapat dihubungi di ${salesUrl}. Pastikan sales.app sudah berjalan (biasanya port 3000).`;
  }
  if (code === 'ENOTFOUND') {
    return `Alamat sales.app tidak ditemukan: ${salesUrl}`;
  }
  if (e?.name === 'TimeoutError' || code === 'ABORT_ERR') {
    return `Sales.app tidak merespons (timeout) — cek ${salesUrl}`;
  }
  return `Gagal menghubungi sales.app: ${cause?.message || e?.message || 'koneksi gagal'}`;
}

async function pushPoGroupToVendor(
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

export async function pushPoToVendor(db: Db, po: Record<string, unknown>, tenantId: string) {
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
        return {
          error: pushed.error,
          partialSubmissions: submissions,
        };
      }
      submissions.push({
        vendorTenantId,
        vendorSoId: (pushed.vendorSo as JsonObject | undefined)?.id,
        vendorNoSO: (pushed.vendorSo as JsonObject | undefined)?.noSO,
        vendorSo: pushed.vendorSo || null,
        itemCount: items.length,
      });
    }
  } catch (e) {
    return { error: salesFetchErrorMessage(e, config.salesAppUrl) };
  }

  return { submissions };
}

export async function finalizePoSubmission(
  db: Db,
  po: Record<string, unknown>,
  submissions: JsonObject[],
  approver: Record<string, unknown> | null | undefined,
) {
  const primary = submissions[0] || {};
  const now = new Date();
  const patch: Record<string, unknown> = {
    status: 'SUBMITTED',
    vendorSubmissions: submissions,
    vendorTenantId: submissions.length === 1 ? primary.vendorTenantId : 'multi',
    vendorSoId: primary.vendorSoId,
    vendorNoSO: submissions.length === 1
      ? primary.vendorNoSO
      : submissions.map((s) => s.vendorNoSO).filter(Boolean).join(', '),
    submittedAt: now,
    updatedAt: now,
    vendorSyncPending: false,
    vendorSyncError: null,
  };
  if (approver) {
    patch.approvedBy = {
      userId: approver.userId,
      userName: approver.userName,
      role: approver.role,
    };
    patch.approvedAt = now;
  }
  const soSnaps = submissions.map((sub) => buildVendorSoSnapshot({
    ...(sub.vendorSo as JsonObject),
    salesOrderId: sub.vendorSoId,
    noSO: sub.vendorNoSO,
  })).filter(Boolean);
  const soSnap = mergeVendorSoSnapshots(soSnaps);
  if (soSnap) patch.vendorSoSnapshot = soSnap;
  await db.collection('customer_purchase_orders').updateOne({ id: po.id }, { $set: patch });
  return db.collection('customer_purchase_orders').findOne({ id: po.id });
}
