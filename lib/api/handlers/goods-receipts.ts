import type { Db } from 'mongodb';
import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { resolveOperationalScope, tenantIdForWrite, withTenantFilter } from '@/lib/api/tenant-master';
import { guardPosting } from '@/lib/api/period-lock';
import { syncShippedDeliveriesFromSales } from '@/lib/api/grn-sync-sales';
import { isUnresolvedGrnStatus, refreshGrnProducts, refreshUnresolvedGrnsForTenant } from '@/lib/api/grn-resolve-products';
import { enrichGrnList, enrichGrnDoc } from '@/lib/api/grn-enrich';
import { postGoodsReceipt, replayGrnInvoiceAsync, type GrnDoc } from '@/lib/api/grn-post';
import { processPendingJobs } from '@/lib/api/bg-jobs';
import type { HandlerContext } from '@/types/api/handler';

interface GrnPostBody extends Record<string, unknown> {
  asyncInvoice?: boolean;
  items?: unknown[];
}

export async function handleGoodsReceipts({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const grnBody = (body || {}) as GrnPostBody;

  if (route === '/goods-receipts/pending-count' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const filter = withTenantFilter(scopeAuth, {
      status: { $in: ['DRAFT', 'UNKNOWN_PRODUCT', 'NEEDS_MAPPING'] },
    });
    const count = await db.collection('goods_receipts').countDocuments(filter);
    return ok({ count });
  }

  if (route === '/goods-receipts' && method === 'GET') {
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;

    const status = url.searchParams.get('status');

    let filter: Record<string, unknown> = status ? { status } : {};

    filter = withTenantFilter(scopeAuth, filter);

    const refreshProducts = url.searchParams.get('refreshProducts') === '1';
    if (refreshProducts && tenantId) {
      await refreshUnresolvedGrnsForTenant(db, tenantId);
    }

    const list = await db.collection('goods_receipts').find(filter).sort({ tanggal: -1 }).limit(300).toArray();

    const enriched = await enrichGrnList(db, tenantId, list);

    return ok(enriched.map(clean));
  }

  if (route === '/goods-receipts/sync-shipped' && method === 'POST') {
    const { denied, tenantId } = resolveOperationalScope(auth, { url, body: grnBody, request });
    if (denied) return denied;
    if (!tenantId) return err('Scope tidak valid', 400);
    const result = await syncShippedDeliveriesFromSales(db, tenantId);
    if ('error' in result && result.error) return err(result.error, 400);
    return ok(result);
  }

  if (path[0] === 'goods-receipts' && path[2] === 'invoice-status' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const grn = await db.collection('goods_receipts').findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as GrnDoc | null;
    if (!grn) return err('Tidak ditemukan', 404);
    if (grn.invoiceSyncStatus === 'PENDING' || grn.invoiceSyncStatus === 'SYNCING') {
      await processPendingJobs(db, { limit: 3 });
      const fresh = await db.collection('goods_receipts').findOne({ id: grn.id }) as GrnDoc | null;
      if (!fresh) return err('Tidak ditemukan', 404);
      return ok({
        id: fresh.id,
        noGRN: fresh.noGRN,
        noInvoice: fresh.noInvoice || null,
        invoiceSyncStatus: fresh.invoiceSyncStatus || 'NONE',
        invoiceSyncError: fresh.invoiceSyncError || null,
        hutangId: fresh.hutangId || null,
      });
    }
    return ok({
      id: grn.id,
      noGRN: grn.noGRN,
      noInvoice: grn.noInvoice || null,
      invoiceSyncStatus: grn.invoiceSyncStatus || 'NONE',
      invoiceSyncError: grn.invoiceSyncError || null,
      hutangId: grn.hutangId || null,
    });
  }

  if (path[0] === 'goods-receipts' && path.length === 2 && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;

    let doc = await db.collection('goods_receipts').findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as GrnDoc | null;

    if (!doc) return err('Tidak ditemukan', 404);

    doc = await refreshGrnProducts(db, doc as import('@/types/documents').GrnDoc) as GrnDoc;

    doc = await enrichGrnDoc(db, doc) as GrnDoc;

    return ok(clean(doc));
  }

  if (path[0] === 'goods-receipts' && path[2] === 'post' && method === 'POST') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: grnBody, request });
    if (denied) return denied;

    const locked = await guardPosting(db, scopeAuth, grnBody);

    if (locked) return locked;

    const grn = await db.collection('goods_receipts').findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as GrnDoc | null;

    if (!grn) return err('GRN tidak ditemukan', 404);

    if (grn.status === 'POSTED') return err('GRN sudah diposting');

    if (isUnresolvedGrnStatus(grn.status || '')) {
      return err('Produk belum terdaftar di Master Produk. Daftarkan/sync kode barang yang sama dari sales.app.');
    }

    const tenantId = grn.tenantId || tenantIdForWrite(scopeAuth, grnBody);

    const posted = await postGoodsReceipt(db, {
      grn,
      tenantId,
      body: grnBody,
      asyncInvoice: grnBody.asyncInvoice !== false,
    });
    if (posted.error) return err(posted.error, 400);

    return ok(clean(posted));
  }

  if (path[0] === 'goods-receipts' && path[2] === 'replay-invoice' && method === 'POST') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: grnBody, request });
    if (denied) return denied;

    const grn = await db.collection('goods_receipts').findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as GrnDoc | null;
    if (!grn) return err('GRN tidak ditemukan', 404);
    if (grn.status !== 'POSTED') return err('GRN harus POSTED dulu', 400);

    const tenantId = grn.tenantId || tenantIdForWrite(scopeAuth, grnBody);
    const result = await replayGrnInvoiceAsync(db, { grn, tenantId });
    return ok(clean(result));
  }

  return null;
}
