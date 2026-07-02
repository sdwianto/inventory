import type { Db } from 'mongodb';
import { resolveSalesApiAccess } from '@/lib/api/integration-links';
import { createGrnFromDelivery } from '@/lib/api/grn-from-webhook';
import type { JsonObject } from '@/types/json';

const SYNC_CONCURRENCY = 5;

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    await Promise.all(chunk.map(fn));
  }
}

interface SyncErrorRow {
  noDO?: unknown;
  error: string;
}

export async function syncShippedDeliveriesFromSales(db: Db, customerTenantId: string) {
  const tid = String(customerTenantId || 'default').trim().toLowerCase();
  const access = await resolveSalesApiAccess(db, tid);
  if (!access) {
    return { error: 'Belum terhubung ke sales.app — jalankan pairing dari menu Integrasi' };
  }

  const headers = { 'X-Api-Key': access.salesApiKey };
  const res = await fetch(
    `${access.salesAppUrl}/api/integrations/customer-shipments?customerTenantId=${encodeURIComponent(tid)}`,
    { headers, signal: AbortSignal.timeout(30000) },
  );
  const data = await res.json() as JsonObject;
  if (!res.ok) return { error: String(data.error || `Sales.app ${res.status}`) };

  const results = { created: 0, existing: 0, errors: [] as SyncErrorRow[] };
  const deliveries = Array.isArray(data.deliveries) ? data.deliveries as JsonObject[] : [];

  const deliveryIds = deliveries
    .map((row) => {
      const payload = (row.payload || row) as JsonObject;
      return payload?.deliveryId ? String(payload.deliveryId) : null;
    })
    .filter(Boolean) as string[];

  const existingGrns = deliveryIds.length
    ? await db.collection('goods_receipts').find({
      tenantId: tid,
      vendorDeliveryId: { $in: deliveryIds },
    }).project({ vendorDeliveryId: 1 }).toArray()
    : [];
  const existingSet = new Set(existingGrns.map((g) => String(g.vendorDeliveryId)));

  await mapWithConcurrency(deliveries, SYNC_CONCURRENCY, async (row) => {
    const payload = (row.payload || row) as JsonObject;
    const deliveryId = payload?.deliveryId ? String(payload.deliveryId) : '';
    const hadBefore = deliveryId ? existingSet.has(deliveryId) : false;
    try {
      await createGrnFromDelivery(db, tid, payload, row.vendorTenantId ? String(row.vendorTenantId) : null);
      if (hadBefore) results.existing += 1;
      else {
        results.created += 1;
        if (deliveryId) existingSet.add(deliveryId);
      }
    } catch (e) {
      results.errors.push({
        noDO: payload?.noDO,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  return {
    ...results,
    total: deliveries.length,
    customerTenantId: tid,
  };
}
