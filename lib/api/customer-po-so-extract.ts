/** Ekstrak & backfill nomor SO dari respons sales.app. */

import type { Db } from 'mongodb';
import { fetchSoStatusForCustomerPo } from '@/lib/api/cpo-so-fetch';
import type { JsonObject } from '@/types/json';
import { asObject } from '@/types/json';

/** Normalisasi body respons POST /integrations/customer-po dari sales.app. */
export function extractPushedVendorSo(data: JsonObject | null | undefined): JsonObject {
  if (!data) return {};
  const root = asObject(data);
  if (root.noSO || root.id || root.salesOrderId) return root;
  for (const key of ['doc', 'data', 'salesOrder', 'vendorSo', 'so']) {
    const nested = asObject(root[key]);
    if (nested.noSO || nested.id) return nested;
  }
  return root;
}

export function submissionHasVendorSo(sub: JsonObject | null | undefined): boolean {
  if (!sub) return false;
  return Boolean(String(sub.vendorNoSO || '').trim() || String(sub.vendorSoId || '').trim());
}

export function poHasVendorSoNumbers(po: JsonObject): boolean {
  if (String(po.vendorNoSO || '').trim()) return true;
  const subs = Array.isArray(po.vendorSubmissions) ? po.vendorSubmissions as JsonObject[] : [];
  return subs.some((s) => submissionHasVendorSo(s));
}

/** Lengkapi submission yang belum punya vendorNoSO dengan lookup ke sales.app. */
export async function enrichSubmissionsWithSoFromSales(
  db: Db,
  po: JsonObject,
  submissions: JsonObject[],
): Promise<JsonObject[]> {
  const tenantId = String(po.tenantId || 'default');
  const enriched: JsonObject[] = [];

  for (const sub of submissions) {
    if (submissionHasVendorSo(sub)) {
      enriched.push(sub);
      continue;
    }
    const vendorTenantId = String(sub.vendorTenantId || '');
    const fetched = await fetchSoStatusForCustomerPo(db, tenantId, {
      customerPoId: String(po.id || ''),
      noPO: String(po.noPO || ''),
      vendorTenantId: vendorTenantId || undefined,
    });
    const payload = fetched.payload;
    if (!payload?.noSO && !payload?.salesOrderId) {
      enriched.push(sub);
      continue;
    }
    enriched.push({
      ...sub,
      vendorSoId: payload.salesOrderId || sub.vendorSoId,
      vendorNoSO: payload.noSO || sub.vendorNoSO,
      vendorSo: {
        ...asObject(sub.vendorSo),
        id: payload.salesOrderId,
        noSO: payload.noSO,
        items: payload.items,
        subTotal: payload.subTotal,
        total: payload.total,
      },
    });
  }

  return enriched;
}

export function summarizeVendorNoSo(submissions: JsonObject[]): string {
  return submissions.map((s) => String(s.vendorNoSO || '').trim()).filter(Boolean).join(', ');
}
