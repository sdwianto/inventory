/** Tarik status SO terbaru dari sales.app untuk sinkron cancel baris PO. */

import type { Db } from 'mongodb';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { syncCpoFromSoPayload } from '@/lib/api/cpo-line-cancel-sync';
import { salesFetchErrorMessage } from '@/lib/api/integration-common';
import type { JsonObject } from '@/types/json';

/** Status PO yang tidak boleh diturunkan saat sync cancel baris dari SO. */
const PRESERVE_PO_STATUS = new Set([
  'PARTIAL_RECEIVED', 'RECEIVED', 'INVOICED', 'CANCELLED',
]);

/** Status PO yang perlu pull status SO dari sales.app. */
const SO_PULL_STATUSES = new Set([
  'SUBMITTED', 'CONFIRMED', 'PARTIAL_CANCELLED',
  'PARTIAL_SHIPPED', 'SHIPPED', 'PARTIAL_RECEIVED', 'RECEIVED', 'INVOICED',
]);

function poNeedsSoPull(po: JsonObject): boolean {
  const st = String(po.status || '');
  if (!SO_PULL_STATUSES.has(st)) return false;
  if (!String(po.noPO || '')) return false;
  if (!String(po.vendorNoSO || po.vendorSoId || '')) return false;
  return !(po.items as JsonObject[] | undefined)?.some((it) => it.cancelled);
}

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

/** Pull SO state dari sales.app dan patch PO jika ada perubahan baris. */
export async function pullSoCancelStateForPo(
  db: Db,
  po: JsonObject,
): Promise<{ updated: boolean; error?: string }> {
  const tenantId = String(po.tenantId || 'default');
  const subs = Array.isArray(po.vendorSubmissions) ? po.vendorSubmissions as JsonObject[] : [];
  const vendorTenantId = String(
    po.vendorTenantId === 'multi'
      ? subs[0]?.vendorTenantId || ''
      : po.vendorTenantId || subs[0]?.vendorTenantId || '',
  );

  const fetched = await fetchSoStatusForCustomerPo(db, tenantId, {
    customerPoId: String(po.id || ''),
    noPO: String(po.noPO || ''),
    noSO: String(po.vendorNoSO || ''),
    vendorTenantId: vendorTenantId || undefined,
  });
  if (fetched.error || !fetched.payload) return { updated: false, error: fetched.error };

  const preserveStatus = PRESERVE_PO_STATUS.has(String(po.status || ''));
  const payload = fetched.payload;
  const synced = syncCpoFromSoPayload(po, {
    salesOrderId: payload.salesOrderId,
    noSO: payload.noSO,
    noPO: payload.noPO || po.noPO,
    customerPoId: po.id,
    items: payload.items,
    cancelledLines: payload.cancelledItems || payload.cancelledLines,
    subTotal: payload.subTotal,
    ppn: payload.ppn,
    total: payload.total,
    updatedAt: payload.updatedAt,
  });

  const itemsChanged = JSON.stringify(synced.items) !== JSON.stringify(po.items);
  const nextStatus = preserveStatus ? String(po.status) : (synced.status || String(po.status));
  const statusChanged = !preserveStatus && synced.status && synced.status !== po.status;
  const auditChanged = JSON.stringify(synced.cancelledSoLines || []) !== JSON.stringify(po.cancelledSoLines || []);
  if (!itemsChanged && !statusChanged && !auditChanged) return { updated: false };

  await db.collection('customer_purchase_orders').updateOne(
    { id: po.id },
    {
      $set: {
        items: synced.items,
        ...(synced.vendorSoSnapshot ? { vendorSoSnapshot: synced.vendorSoSnapshot } : {}),
        ...(synced.cancelledSoLines ? { cancelledSoLines: synced.cancelledSoLines } : {}),
        ...(statusChanged ? { status: nextStatus } : {}),
        lastVendorEvent: 'sales_order.updated',
        lastVendorEventAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );
  return { updated: true };
}

export async function enrichPoListWithSoCancelState(
  db: Db,
  pos: JsonObject[],
): Promise<JsonObject[]> {
  const eligible = pos.filter(poNeedsSoPull);

  const pulled = new Map<string, JsonObject>();
  await Promise.all(eligible.slice(0, 30).map(async (po) => {
    const result = await pullSoCancelStateForPo(db, po);
    if (result.updated) {
      const fresh = await db.collection('customer_purchase_orders').findOne({ id: po.id }) as JsonObject | null;
      if (fresh) pulled.set(String(po.id), fresh);
    } else if (result.error) {
      // Tetap coba diff dari snapshot lokal jika pull gagal
      const snapItems = (po.vendorSoSnapshot as JsonObject | undefined)?.items;
      if (Array.isArray(snapItems) && snapItems.length && snapItems.length < (po.items as JsonObject[]).length) {
        const items = syncCpoFromSoPayload(po, {
          salesOrderId: po.vendorSoId,
          noSO: po.vendorNoSO,
          items: snapItems,
        }).items;
        if (JSON.stringify(items) !== JSON.stringify(po.items)) {
          pulled.set(String(po.id), { ...po, items });
        }
      }
    }
  }));

  return pos.map((po) => {
    const fresh = pulled.get(String(po.id));
    if (fresh) return fresh;
    const hasCancel = (po.items as JsonObject[] | undefined)?.some((it) => it.cancelled);
    if (hasCancel) return po;
    const snapItems = (po.vendorSoSnapshot as JsonObject | undefined)?.items;
    if (!Array.isArray(snapItems) || !snapItems.length) return po;
    if (snapItems.length >= (po.items as JsonObject[]).length) return po;
    const items = syncCpoFromSoPayload(po, {
      salesOrderId: po.vendorSoId,
      noSO: po.vendorNoSO,
      items: snapItems,
    }).items;
    return { ...po, items };
  });
}
