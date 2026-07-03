import type { Db } from 'mongodb';
import type { AnyBulkWriteOperation } from 'mongodb';
import { listActiveLinksForCustomer, resolveSalesApiAccess } from '@/lib/api/integration-links';
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
  vendorTenantId?: string;
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

async function fetchShipmentsForVendor(
  salesAppUrl: string,
  salesApiKey: string,
  customerTenantId: string,
  vendorTenantId: string,
): Promise<{ deliveries: JsonObject[]; error?: string }> {
  const res = await fetch(
    `${salesAppUrl}/api/integrations/customer-shipments?customerTenantId=${encodeURIComponent(customerTenantId)}`,
    { headers: { 'X-Api-Key': salesApiKey }, signal: AbortSignal.timeout(30000) },
  );
  const data = await res.json() as JsonObject;
  if (!res.ok) {
    return {
      deliveries: [],
      error: String(data.error || `Sales.app ${res.status}`),
    };
  }
  const deliveries = Array.isArray(data.deliveries) ? data.deliveries as JsonObject[] : [];
  return {
    deliveries: deliveries.map((row) => ({
      ...row,
      vendorTenantId: row.vendorTenantId || vendorTenantId,
    })),
  };
}

export async function syncShippedDeliveriesFromSales(db: Db, customerTenantId: string) {
  const tid = String(customerTenantId || 'default').trim().toLowerCase();
  const links = await listActiveLinksForCustomer(db, tid);

  const vendorsToSync: { vendorTenantId: string; salesAppUrl: string; salesApiKey: string }[] = [];
  if (links.length) {
    for (const link of links) {
      const access = await resolveSalesApiAccess(db, tid, link.vendorTenantId);
      if (access?.salesApiKey) {
        vendorsToSync.push({
          vendorTenantId: link.vendorTenantId,
          salesAppUrl: access.salesAppUrl,
          salesApiKey: access.salesApiKey,
        });
      }
    }
  } else {
    const access = await resolveSalesApiAccess(db, tid);
    if (access?.salesApiKey) {
      vendorsToSync.push({
        vendorTenantId: '',
        salesAppUrl: access.salesAppUrl,
        salesApiKey: access.salesApiKey,
      });
    }
  }

  if (!vendorsToSync.length) {
    return { error: 'Belum terhubung ke sales.app — jalankan pairing dari menu Integrasi' };
  }

  const results = {
    created: 0,
    existing: 0,
    errors: [] as SyncErrorRow[],
    vendorsSynced: 0,
  };
  const deliveries: JsonObject[] = [];
  const seenDeliveryIds = new Set<string>();
  const fetchErrors: string[] = [];

  for (const vendor of vendorsToSync) {
    const fetched = await fetchShipmentsForVendor(
      vendor.salesAppUrl,
      vendor.salesApiKey,
      tid,
      vendor.vendorTenantId,
    );
    if (fetched.error) {
      fetchErrors.push(
        vendor.vendorTenantId
          ? `${vendor.vendorTenantId}: ${fetched.error}`
          : fetched.error,
      );
      continue;
    }
    results.vendorsSynced += 1;
    for (const row of fetched.deliveries) {
      const payload = (row.payload || row) as JsonObject;
      const deliveryId = payload?.deliveryId ? String(payload.deliveryId) : '';
      if (deliveryId && seenDeliveryIds.has(deliveryId)) continue;
      if (deliveryId) seenDeliveryIds.add(deliveryId);
      deliveries.push(row);
    }
  }

  if (!deliveries.length && fetchErrors.length === vendorsToSync.length) {
    return { error: fetchErrors[0] || 'Gagal tarik DO dari sales.app' };
  }

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
        vendorTenantId: vendorTenantId || undefined,
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
    fetchWarnings: fetchErrors.length ? fetchErrors : undefined,
  };
}
