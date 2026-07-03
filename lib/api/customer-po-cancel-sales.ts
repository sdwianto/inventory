/** Beritahu sales.app bahwa CPO dibatalkan — cancel SO per vendor. */

import type { Db } from 'mongodb';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { integrationCorrelationId, salesFetchErrorMessage } from '@/lib/api/integration-common';
import type { JsonObject } from '@/types/json';

function vendorSubmissionsForPo(po: Record<string, unknown>): JsonObject[] {
  const subs = (po.vendorSubmissions as JsonObject[] | undefined) || [];
  if (subs.length) return subs;
  const vid = po.vendorTenantId;
  if (vid && vid !== 'multi') {
    return [{ vendorTenantId: vid }];
  }
  return [];
}

export async function notifySalesPoCancelled(
  db: Db,
  po: Record<string, unknown>,
  reason = 'Dibatalkan customer',
) {
  const tenantId = String(po.tenantId || 'default');
  const noPO = String(po.noPO || '');
  const customerPoId = String(po.id || '');
  const correlationId = integrationCorrelationId(customerPoId, noPO);
  const submissions = vendorSubmissionsForPo(po);

  const cancelled: JsonObject[] = [];
  const errors: JsonObject[] = [];

  for (const sub of submissions) {
    const vendorTenantId = String(sub.vendorTenantId || '');
    if (!vendorTenantId) continue;

    const config = await getIntegrationConfig(db, tenantId, vendorTenantId);
    const apiKey = await getSalesApiKeyForVendor(db, tenantId, vendorTenantId);
    if (!apiKey) {
      errors.push({ vendorTenantId, error: 'API key vendor tidak tersedia' });
      continue;
    }

    let res: Response;
    try {
      res = await fetch(`${config.salesAppUrl}/api/integrations/customer-po/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
        },
        body: JSON.stringify({
          customerTenantId: tenantId,
          vendorTenantId,
          noPO,
          customerPoId,
          correlationId,
          reason,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      errors.push({ vendorTenantId, error: salesFetchErrorMessage(e, config.salesAppUrl) });
      continue;
    }

    let data: JsonObject;
    try {
      data = await res.json() as JsonObject;
    } catch {
      errors.push({ vendorTenantId, error: `Sales.app HTTP ${res.status} tanpa JSON` });
      continue;
    }
    if (!res.ok) {
      errors.push({ vendorTenantId, error: String(data.error || `Sales.app ${res.status}`) });
      continue;
    }
    cancelled.push({ vendorTenantId, ...data });
  }

  return { cancelled, errors, correlationId };
}
