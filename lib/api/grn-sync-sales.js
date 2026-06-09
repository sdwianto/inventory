import { getIntegrationConfig } from '@/lib/api/integration-config';
import { createGrnFromDelivery } from '@/lib/api/grn-from-webhook';

export async function syncShippedDeliveriesFromSales(db, customerTenantId) {
  const tid = String(customerTenantId || 'default').trim().toLowerCase();
  const config = await getIntegrationConfig(db, tid);
  if (!config.salesApiKey) {
    return { error: 'Belum terhubung ke sales.app — jalankan pairing dari menu Integrasi' };
  }

  const headers = { 'X-Api-Key': config.salesApiKey };
  const res = await fetch(
    `${config.salesAppUrl}/api/integrations/customer-shipments?customerTenantId=${encodeURIComponent(tid)}`,
    { headers, signal: AbortSignal.timeout(30000) },
  );
  const data = await res.json();
  if (!res.ok) return { error: data.error || `Sales.app ${res.status}` };

  const results = { created: 0, existing: 0, errors: [] };
  for (const row of data.deliveries || []) {
    try {
      const before = await db.collection('goods_receipts').findOne({
        tenantId: tid,
        vendorDeliveryId: row.payload?.deliveryId,
      });
      const grn = await createGrnFromDelivery(db, tid, row.payload, row.vendorTenantId);
      if (before) results.existing += 1;
      else results.created += 1;
      if (!grn?.id) results.errors.push({ noDO: row.payload?.noDO, error: 'GRN gagal dibuat' });
    } catch (e) {
      results.errors.push({ noDO: row.payload?.noDO, error: e.message });
    }
  }

  return {
    ...results,
    total: (data.deliveries || []).length,
    customerTenantId: tid,
  };
}
