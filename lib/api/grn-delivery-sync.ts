import type { Db } from 'mongodb';
// Sinkronkan referensi DO/ SO GRN dengan data terbaru di sales.app sebelum post / invoice.

import { resolveSalesApiAccess } from '@/lib/api/integration-links';
import { salesFetchErrorMessage } from '@/lib/api/integration-common';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import { createIntegrationClient } from '@/lib/integration/client';
import { IntegrationError } from '@/lib/integration/errors';
import { randomUUID } from 'node:crypto';

/**
 * Perbarui noDO / noSO / vendorTenantId / snapshot GRN dari sales.app.
 * H2: Category B via IntegrationClient (bukan fetch ad-hoc).
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

  let data: Record<string, unknown>;
  try {
    const client = createIntegrationClient(db);
    data = await client.lookupDeliveryFromSales({
      salesAppUrl: access.salesAppUrl,
      apiKey: access.salesApiKey,
      correlationId: randomUUID(),
      grnId: grn.id ? String(grn.id) : null,
      query: {
        customerTenantId: tid,
        ...(grn.vendorDeliveryId ? { deliveryId: String(grn.vendorDeliveryId) } : {}),
        ...(grn.noDO ? { noDO: String(grn.noDO) } : {}),
        ...(grn.vendorTenantId ? { vendorTenantId: String(grn.vendorTenantId) } : {}),
      },
      timeoutMs: 30_000,
    });
  } catch (e) {
    if (e instanceof IntegrationError) {
      return {
        grn,
        synced: false,
        error: e.message,
        notFound: e.httpStatus === 404,
      };
    }
    return { grn, synced: false, error: salesFetchErrorMessage(e, access.salesAppUrl) };
  }

  const row = (data.delivery && typeof data.delivery === 'object')
    ? data.delivery as Record<string, unknown>
    : data;
  const payload = (row.payload && typeof row.payload === 'object')
    ? row.payload as Record<string, unknown>
    : row;
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
