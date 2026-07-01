import type { Db } from 'mongodb';
import { resolveSalesApiAccess } from '@/lib/api/integration-links';
import { createGrnFromDelivery } from '@/lib/api/grn-from-webhook';
import type { JsonObject } from '@/types/json';

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
  for (const row of deliveries) {
    try {
      const payload = (row.payload || row) as JsonObject;
      const before = await db.collection('goods_receipts').findOne({
        tenantId: tid,
        vendorDeliveryId: payload?.deliveryId,
      });
      await createGrnFromDelivery(db, tid, payload, row.vendorTenantId ? String(row.vendorTenantId) : null);
      if (before) results.existing += 1;
      else results.created += 1;
      const grn = await db.collection('goods_receipts').findOne({
        tenantId: tid,
        vendorDeliveryId: payload?.deliveryId,
      });
      if (!grn?.id) results.errors.push({ noDO: payload?.noDO, error: 'GRN gagal dibuat' });
    } catch (e) {
      const payload = (row.payload || row) as JsonObject;
      results.errors.push({
        noDO: payload?.noDO,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    ...results,
    total: deliveries.length,
    customerTenantId: tid,
  };
}
