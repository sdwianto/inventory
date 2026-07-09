/** Lookup status SO di sales.app — dipisah agar tidak circular import. */

import type { Db } from 'mongodb';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { salesFetchErrorMessage } from '@/lib/api/integration-common';
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

  const qs = new URLSearchParams({
    customerTenantId: tenantId,
    ...(params.customerPoId ? { customerPoId: params.customerPoId } : {}),
    ...(params.noPO ? { noPO: params.noPO } : {}),
    ...(params.noSO ? { noSO: params.noSO } : {}),
    ...(vid ? { vendorTenantId: vid } : {}),
  });

  let res: Response;
  try {
    res = await fetch(`${config.salesAppUrl}/api/integrations/customer-po-status?${qs}`, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    return { error: salesFetchErrorMessage(e, config.salesAppUrl) };
  }

  let data: JsonObject;
  try {
    data = await res.json() as JsonObject;
  } catch {
    return { error: `Sales.app HTTP ${res.status}` };
  }
  if (!res.ok) return { error: String(data.error || `Sales.app ${res.status}`) };
  return { payload: data };
}
