// Pencarian daftar PO ke Vendor (`?search=`) — padanan pencarian Sales Order di sales.app.

import type { Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import { withTenantFilter } from '@/lib/api/tenant-master';

export const CUSTOMER_PO_SEARCH_MAX = 100;

const SEARCH_FIELDS = [
  'noPO',
  'vendorNoSO',
  'vendorSubmissions.vendorNoSO',
  'catatan',
  'createdBy.userName',
  'createdBy.name',
  'requestedBy.userName',
  'items.nama',
  'items.kode',
] as const;

const VENDOR_MATCH_MAX = 50;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseCustomerPoSearch(url: URL): string {
  return (url.searchParams.get('search') || url.searchParams.get('q') || '').trim().slice(0, CUSTOMER_PO_SEARCH_MAX);
}

/** Klausa `$or`: nomor PO, nomor SO vendor, catatan, pembuat, nama/kode item, dan vendor yang namanya cocok. */
export function customerPoSearchOr(term: string, vendorTenantIds: string[] = []): Record<string, unknown>[] {
  const regex = { $regex: escapeRegex(term), $options: 'i' };
  const or: Record<string, unknown>[] = SEARCH_FIELDS.map((f) => ({ [f]: regex }));
  if (vendorTenantIds.length) {
    or.push({ vendorTenantId: { $in: vendorTenantIds } });
    or.push({ 'vendorSubmissions.vendorTenantId': { $in: vendorTenantIds } });
  }
  return or;
}

export async function applyCustomerPoSearch(
  db: Db,
  scopeAuth: AuthContext | null | undefined,
  filter: Record<string, unknown>,
  term: string,
): Promise<Record<string, unknown>> {
  if (!term) return filter;
  const vendors = await db.collection('vendor_tenants')
    .find(
      withTenantFilter(scopeAuth, { vendorTenantName: { $regex: escapeRegex(term), $options: 'i' } }),
      { projection: { _id: 0, vendorTenantId: 1 } },
    )
    .limit(VENDOR_MATCH_MAX)
    .toArray();
  const vendorIds = [...new Set(vendors.map((v) => String(v.vendorTenantId || '')).filter(Boolean))];
  const or = customerPoSearchOr(term, vendorIds);
  return Object.keys(filter).length ? { $and: [filter, { $or: or }] } : { $or: or };
}
