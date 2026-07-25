/** Beritahu sales.app bahwa CPO dibatalkan — via IntegrationClient (P3 Category A). */

import type { Db } from 'mongodb';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { integrationCorrelationId } from '@/lib/api/integration-common';
import { createIntegrationClient } from '@/lib/integration/client';
import { IntegrationError } from '@/lib/integration/errors';
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
  const correlationId = String(po.correlationId || '').trim()
    || integrationCorrelationId(customerPoId, noPO);
  const submissions = vendorSubmissionsForPo(po);
  const client = createIntegrationClient(db);

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

    try {
      const result = await client.cancelSalesOrderFromCustomerPo({
        salesAppUrl: config.salesAppUrl,
        apiKey,
        correlationId,
        idempotencyKey: `cpo-cancel:${customerPoId || noPO}:${vendorTenantId}`,
        customerPoId,
        body: {
          customerTenantId: tenantId,
          vendorTenantId,
          noPO,
          customerPoId,
          reason,
        },
      });
      cancelled.push({ vendorTenantId, ...result.raw });
    } catch (e) {
      const message = e instanceof IntegrationError
        ? e.message
        : (e instanceof Error ? e.message : String(e));
      errors.push({ vendorTenantId, error: message });
    }
  }

  return { cancelled, errors, correlationId };
}
