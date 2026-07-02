import type { NextResponse } from 'next/server';
import { ok, clean } from '@/lib/api/db';
import { resolveOperationalScope, withTenantFilter } from '@/lib/api/tenant-master';
import { enrichGrnList } from '@/lib/api/grn-enrich';
import { GRN_LIST_EXCLUDE, stripGrnListRow } from '@/lib/api/grn-list-projection';
import {
  parseCursorPageParams,
  applyDescDateIdCursor,
  sliceCursorPage,
  encodeCursor,
  applyAscStringIdCursor,
  encodeStringCursor,
} from '@/lib/api/cursor-page';
import { payableHutangFilter, approvalStatusFilter, stripHutangListSnapshot } from '@/lib/api/hutang-filters';
import { buildProductSearchFilter, PRODUCT_LIST_PROJECTION } from '@/lib/api/product-query';
import { enrichProductsVendorNames } from '@/lib/api/vendor-tenants';
import { ensureProdukMetaForTenant } from '@/lib/api/product-meta';
import type { HandlerContext } from '@/types/api/handler';

function mapHutangRow(h: Record<string, unknown>, today: Date) {
  const jatuh = h.jatuhTempo ? new Date(String(h.jatuhTempo)) : null;
  const overdue = jatuh && jatuh < today && h.status !== 'LUNAS';
  return { ...stripHutangListSnapshot(h), overdue };
}

export async function handlePages({
  db,
  route,
  method,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  if (method !== 'GET' || !route.startsWith('/pages/')) return null;

  if (route === '/pages/penerimaan') {
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const status = url.searchParams.get('status');
    let filter: Record<string, unknown> = status ? { status } : {};
    filter = withTenantFilter(scopeAuth, filter);
    const { limit, cursor } = parseCursorPageParams(url.searchParams, { defaultLimit: 100, maxLimit: 300 });
    const fetchLimit = limit + 1;
    const listFilter = applyDescDateIdCursor(filter, cursor, 'tanggal');
    const list = await db.collection('goods_receipts')
      .find(listFilter)
      .project(GRN_LIST_EXCLUDE)
      .sort({ tanggal: -1, id: -1 })
      .limit(fetchLimit)
      .toArray();
    const { items, hasMore } = sliceCursorPage(list, limit);
    const enriched = await enrichGrnList(db, tenantId, items);
    const cleaned = enriched.map((row) => clean(stripGrnListRow(row as Record<string, unknown>)));
    const last = items[items.length - 1] as Record<string, unknown> | undefined;
    return ok({
      items: cleaned,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(last, 'tanggal') : null,
    });
  }

  if (route === '/pages/hutang') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const status = url.searchParams.get('status') || '';
    const approvalStatus = url.searchParams.get('approvalStatus') || '';
    let filter: Record<string, unknown> = payableHutangFilter(approvalStatusFilter(approvalStatus));
    if (!approvalStatus && status) {
      filter = payableHutangFilter({
        $or: [
          { approvalStatus: status },
          { status, approvalStatus: { $exists: false } },
        ],
      });
    }
    filter = withTenantFilter(scopeAuth, filter);
    const { limit, cursor } = parseCursorPageParams(url.searchParams, { defaultLimit: 100, maxLimit: 500 });
    const fetchLimit = limit + 1;
    const listFilter = applyDescDateIdCursor(filter, cursor, 'tanggal');
    const list = await db.collection('hutang')
      .find(listFilter)
      .sort({ tanggal: -1, id: -1 })
      .limit(fetchLimit)
      .toArray();
    const today = new Date();
    const { items, hasMore } = sliceCursorPage(list, limit);
    const mapped = items.map((h) => mapHutangRow(h as Record<string, unknown>, today));
    const last = items[items.length - 1] as Record<string, unknown> | undefined;
    return ok({
      items: mapped,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(last, 'tanggal') : null,
    });
  }

  if (route === '/pages/produk') {
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!tenantId) return ok({ items: [], meta: { grup: [], satuan: [] } });

    const q = (url.searchParams.get('q') || '').trim();
    let filter: Record<string, unknown> = buildProductSearchFilter(q);
    filter = withTenantFilter(scopeAuth, filter);
    const { limit, cursor } = parseCursorPageParams(url.searchParams, { defaultLimit: 100, maxLimit: 500 });
    const fetchLimit = limit + 1;
    const listFilter = applyAscStringIdCursor(filter, cursor, 'nama');
    const list = await db.collection('products')
      .find(listFilter)
      .project(PRODUCT_LIST_PROJECTION)
      .sort({ nama: 1, id: 1 })
      .limit(fetchLimit)
      .toArray();
    const enriched = await enrichProductsVendorNames(db, tenantId, list);
    const cleaned = enriched.map(clean);
    const { items, hasMore } = sliceCursorPage(cleaned, limit);
    const last = list[Math.min(list.length, limit) - 1] as Record<string, unknown> | undefined;
    const meta = await Promise.all([
      db.collection('produk_grup').find({ tenantId }).sort({ nama: 1 }).toArray(),
      db.collection('produk_satuan').find({ tenantId }).sort({ nama: 1 }).toArray(),
    ]);
    await ensureProdukMetaForTenant(db, tenantId);
    const [grupRows, satuanRows] = meta;
    return ok({
      items,
      hasMore,
      nextCursor: hasMore && last ? encodeStringCursor(last, 'nama') : null,
      meta: {
        grup: grupRows.map(clean),
        satuan: satuanRows.map(clean),
      },
    });
  }

  return null;
}
