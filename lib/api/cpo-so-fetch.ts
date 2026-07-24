/** Lookup status SO di sales.app — via IntegrationClient (P3 FP CPO bridge). */

import type { Db } from 'mongodb';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { integrationCorrelationId } from '@/lib/api/integration-common';
import { createIntegrationClient } from '@/lib/integration/client';
import { IntegrationError } from '@/lib/integration/errors';
import type { JsonObject } from '@/types/json';

export async function fetchSoStatusForCustomerPo(
  db: Db,
  tenantId: string,
  params: { customerPoId?: string; noPO?: string; vendorTenantId?: string; noSO?: string },
): Promise<{ payload?: JsonObject; error?: string }> {
  const config = await getIntegrationConfig(db, tenantId);
  const vid = params.vendorTenantId || '';
  const apiKey = vid
    ? await getSalesApiKeyForVendor(db, tenantId, vid)
    : await getSalesApiKeyForVendor(db, tenantId);
  if (!apiKey) return { error: 'Belum terhubung ke sales.app' };

  const correlationId = integrationCorrelationId(
    params.customerPoId || params.noPO || params.noSO || tenantId,
    'po-status',
  );

  try {
    const client = createIntegrationClient(db);
    const result = await client.getCustomerPoSalesOrderStatus({
      salesAppUrl: config.salesAppUrl,
      apiKey,
      correlationId,
      query: {
        customerTenantId: tenantId,
        ...(params.customerPoId ? { customerPoId: params.customerPoId } : {}),
        ...(params.noPO ? { noPO: params.noPO } : {}),
        ...(params.noSO ? { noSO: params.noSO } : {}),
        ...(vid ? { vendorTenantId: vid } : {}),
      },
    });
    return { payload: result.raw as JsonObject };
  } catch (e) {
    if (e instanceof IntegrationError) {
      return { error: e.message };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
