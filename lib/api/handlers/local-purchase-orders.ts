import type { NextResponse } from 'next/server';
import { ok, err } from '@/lib/api/db';
import { resolveOperationalScope, withTenantFilter } from '@/lib/api/tenant-master';
import { LOCAL_PO_COLLECTION, LOCAL_PO_MODULE_ENABLED } from '@/lib/api/po-channel';
import type { HandlerContext } from '@/types/api/handler';

const NOT_ENABLED_MSG =
  'PO lokal (non-vendor) belum diaktifkan. Saat ini gunakan PO ke Vendor via sales.app.';

export async function handleLocalPurchaseOrders({
  db,
  route,
  method,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  if (!route.startsWith('/local-purchase-orders')) return null;

  if (route === '/local-purchase-orders' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;

    if (!LOCAL_PO_MODULE_ENABLED) {
      return ok({
        enabled: false,
        list: [],
        message: NOT_ENABLED_MSG,
      });
    }

    const status = url.searchParams.get('status');
    const filter = withTenantFilter(scopeAuth, status ? { status } : {});
    const list = await db.collection(LOCAL_PO_COLLECTION)
      .find(filter)
      .sort({ tanggal: -1 })
      .limit(300)
      .toArray();
    return ok({ enabled: true, list });
  }

  if (route === '/local-purchase-orders/status' && method === 'GET') {
    return ok({
      enabled: LOCAL_PO_MODULE_ENABLED,
      collection: LOCAL_PO_COLLECTION,
      message: LOCAL_PO_MODULE_ENABLED
        ? 'PO lokal aktif.'
        : NOT_ENABLED_MSG,
    });
  }

  return err(NOT_ENABLED_MSG, 501);
}
