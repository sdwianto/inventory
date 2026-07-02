import type { Db } from 'mongodb';
import type { AnyBulkWriteOperation } from 'mongodb';
import { resolveSalesApiAccess } from '@/lib/api/integration-links';
import { nextDocNumber } from '@/lib/api/document-sequence';
import {
  buildGrnInsertDoc,
  grnUpdateFieldsFromPayload,
} from '@/lib/api/grn-from-webhook';
import type { JsonObject } from '@/types/json';

const BULK_CHUNK = 100;
const BUILD_CONCURRENCY = 5;

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

async function flushBulkOps(
  db: Db,
  ops: AnyBulkWriteOperation<JsonObject>[],
): Promise<void> {
  for (let i = 0; i < ops.length; i += BULK_CHUNK) {
    const chunk = ops.slice(i, i + BULK_CHUNK);
    if (chunk.length) {
      await db.collection('goods_receipts').bulkWrite(chunk, { ordered: false });
    }
  }
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
    }).toArray()
    : [];
  const existingByDeliveryId = new Map(
    existingGrns.map((g) => [String(g.vendorDeliveryId), g as JsonObject]),
  );

  const insertOps: AnyBulkWriteOperation<JsonObject>[] = [];
  const updateOps: AnyBulkWriteOperation<JsonObject>[] = [];

  await mapWithConcurrency(deliveries, BUILD_CONCURRENCY, async (row) => {
    const payload = (row.payload || row) as JsonObject;
    const deliveryId = payload?.deliveryId ? String(payload.deliveryId) : '';
    const vendorTenantId = row.vendorTenantId ? String(row.vendorTenantId) : null;

    try {
      const existing = deliveryId ? existingByDeliveryId.get(deliveryId) : null;
      if (existing?.id) {
        updateOps.push({
          updateOne: {
            filter: { id: existing.id },
            update: {
              $set: grnUpdateFieldsFromPayload(payload, vendorTenantId, existing),
            },
          },
        });
        results.existing += 1;
        return;
      }

      const noGRN = await nextDocNumber(db, tid, 'GRN', 'GRN');
      const doc = await buildGrnInsertDoc(db, tid, payload, vendorTenantId, noGRN);
      insertOps.push({ insertOne: { document: doc } });
      if (deliveryId) existingByDeliveryId.set(deliveryId, doc);
      results.created += 1;
    } catch (e) {
      results.errors.push({
        noDO: payload?.noDO,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  await flushBulkOps(db, updateOps);
  await flushBulkOps(db, insertOps);

  return {
    ...results,
    total: deliveries.length,
    customerTenantId: tid,
    bulkWritten: insertOps.length + updateOps.length,
  };
}
