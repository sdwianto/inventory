// Sinkronkan referensi DO/ SO GRN dengan data terbaru di sales.app sebelum post / invoice.

import { getIntegrationConfig } from '@/lib/api/integration-config';
import { normalizeTenantId } from '@/lib/api/tenant-scope';

function salesFetchErrorMessage(err, salesUrl) {
  const cause = err?.cause;
  const code = cause?.code || err?.code;
  if (code === 'ECONNREFUSED') return `Sales.app tidak dapat dihubungi di ${salesUrl}`;
  if (err?.name === 'TimeoutError' || code === 'ABORT_ERR') return 'Sales.app tidak merespons (timeout)';
  return err?.message || 'Gagal menghubungi sales.app';
}

/**
 * Perbarui noDO / noSO / vendorTenantId / snapshot GRN dari sales.app.
 * Mengurangi mismatch noDO stale vs deliveryId yang masih valid.
 */
export async function syncGrnDeliveryFromSales(db, tenantId, grn) {
  const tid = normalizeTenantId(grn?.tenantId || tenantId);
  const config = await getIntegrationConfig(db, tid);
  if (!config.salesApiKey) {
    return { grn, synced: false, reason: 'not_paired' };
  }
  if (!grn?.vendorDeliveryId && !grn?.noDO) {
    return { grn, synced: false, reason: 'no_reference' };
  }

  const params = new URLSearchParams({ customerTenantId: tid });
  if (grn.vendorDeliveryId) params.set('deliveryId', grn.vendorDeliveryId);
  if (grn.noDO) params.set('noDO', grn.noDO);
  if (grn.vendorTenantId) params.set('vendorTenantId', grn.vendorTenantId);

  let res;
  try {
    res = await fetch(
      `${config.salesAppUrl}/api/integrations/delivery-lookup?${params.toString()}`,
      {
        headers: { 'X-Api-Key': config.salesApiKey },
        signal: AbortSignal.timeout(30000),
      },
    );
  } catch (e) {
    return { grn, synced: false, error: salesFetchErrorMessage(e, config.salesAppUrl) };
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
  const patch = {
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
