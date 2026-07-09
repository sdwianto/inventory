import type { Db } from 'mongodb';
// Sinkronkan referensi DO/ SO GRN dengan data terbaru di sales.app sebelum post / invoice.

import { resolveSalesApiAccess } from '@/lib/api/integration-links';
import { salesFetchErrorMessage } from '@/lib/api/integration-common';
import { normalizeTenantId } from '@/lib/api/tenant-scope';

/**
 * Perbarui noDO / noSO / vendorTenantId / snapshot GRN dari sales.app.
 * Mengurangi mismatch noDO stale vs deliveryId yang masih valid.
 */
export async function syncGrnDeliveryFromSales(db: Db, tenantId: string, grn: Record<string, unknown>) {
  const tid = normalizeTenantId(grn?.tenantId || tenantId);
  const access = await resolveSalesApiAccess(db, tid, grn?.vendorTenantId ? String(grn.vendorTenantId) : undefined);
  if (!access) {
    return { grn, synced: false, reason: 'not_paired' };
  }
  if (!grn?.vendorDeliveryId && !grn?.noDO) {
    return { grn, synced: false, reason: 'no_reference' };
  }

  const params = new URLSearchParams({ customerTenantId: tid });
  if (grn.vendorDeliveryId) params.set('deliveryId', String(grn.vendorDeliveryId));
  if (grn.noDO) params.set('noDO', String(grn.noDO));
  if (grn.vendorTenantId) params.set('vendorTenantId', String(grn.vendorTenantId));

  let res;
  try {
    res = await fetch(
      `${access.salesAppUrl}/api/integrations/delivery-lookup?${params.toString()}`,
      {
        headers: { 'X-Api-Key': access.salesApiKey },
        signal: AbortSignal.timeout(30000),
      },
    );
  } catch (e) {
    return { grn, synced: false, error: salesFetchErrorMessage(e, access.salesAppUrl) };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { grn, synced: false, error: `Sales.app merespons HTTP ${res.status} tanpa JSON valid` };
  }

  if (!res.ok) {
    return { grn, synced: false, error: data.error || `Sales.app ${res.status}`, notFound: res.status === 404 };
  }

  const row = data.delivery || data;
  const payload = row.payload || row;
  const patch: Record<string, unknown> = {
    noDO: payload.noDO || row.noDO || grn.noDO,
    noSO: payload.noSO || row.noSO || grn.noSO,
    noPO: payload.noPO || row.noPO || grn.noPO,
    vendorTenantId: row.vendorTenantId || payload.vendorTenantId || grn.vendorTenantId,
    vendorDeliveryId: payload.deliveryId || row.id || grn.vendorDeliveryId,
    vendorDeliverySnapshot: payload,
  };

  if (grn.id) {
    await db.collection('goods_receipts').updateOne({ id: grn.id }, { $set: patch });
  }

  return { grn: { ...grn, ...patch }, synced: true };
}
