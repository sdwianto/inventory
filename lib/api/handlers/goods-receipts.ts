import type { Db } from 'mongodb';
import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { resolveOperationalScope, tenantIdForWrite, withTenantFilter } from '@/lib/api/tenant-master';
import { guardPosting } from '@/lib/api/period-lock';
import { GRN_POST_ROLES, requireRole } from '@/lib/api/require-auth';
import { syncShippedDeliveriesFromSales } from '@/lib/api/grn-sync-sales';
import { isUnresolvedGrnStatus, refreshGrnProducts, refreshUnresolvedGrnsForTenant } from '@/lib/api/grn-resolve-products';
import { enrichGrnList, enrichGrnDocWithProducts } from '@/lib/api/grn-enrich';
import { postGoodsReceipt, replayGrnInvoiceAsync, type GrnDoc } from '@/lib/api/grn-post';
import { actorSnapshot, parseKnowingSignature } from '@/lib/api/hutang-approval';
import { parseCursorPageParams, applyDescDateIdCursor, cursorPageResponse } from '@/lib/api/cursor-page';
import { GRN_LIST_EXCLUDE, stripGrnListRow } from '@/lib/api/grn-list-projection';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import { enqueueJob, scheduleJobProcessing, JOB_TYPES } from '@/lib/api/bg-jobs';
import { storeBase64Image } from '@/lib/api/media-storage';
import { grnPendingRejectFilter } from '@/lib/api/grn-reject-status';
import type { HandlerContext } from '@/types/api/handler';

interface GrnPostBody extends Record<string, unknown> {
  asyncInvoice?: boolean;
  items?: unknown[];
  photos?: unknown[];
  /** Stempel Penerima gudang (Nama + NIK wajib) — dari tombol Buat signature. */
  receivedBy?: { userName?: string; nama?: string; jabatan?: string; nik?: string };
}

const MAX_GRN_PHOTOS = 5;

/** Simpan foto data-URL ke media storage; URL /api/media yang sudah ada dibiarkan. */
async function persistGrnPhotos(tenantId: string, raw: unknown[]): Promise<string[] | { error: string }> {
  if (raw.length > MAX_GRN_PHOTOS) return { error: `Maksimal ${MAX_GRN_PHOTOS} foto untuk penerimaan barang` };
  const urls: string[] = [];
  for (const item of raw) {
    const s = String(item || '').trim();
    if (!s) continue;
    if (s.startsWith('/api/media/') || s.startsWith('http://') || s.startsWith('https://')) {
      urls.push(s);
      continue;
    }
    const stored = await storeBase64Image(tenantId, s, { prefix: 'grn', maxBytes: 768_000 });
    if ('error' in stored) return { error: `Foto: ${stored.error}` };
    urls.push(stored.url);
  }
  return urls;
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

  if (route === '/goods-receipts/refresh-unresolved' && method === 'POST') {
    const roleDenied = requireRole(auth, GRN_POST_ROLES);
    if (roleDenied) return roleDenied;
    const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!tenantId) return err('Scope tidak valid', 400);

    const inline = url.searchParams.get('inline') === '1';
    if (inline) {
      const refreshed = await refreshUnresolvedGrnsForTenant(db, tenantId);
      await invalidateDashboardSnapshot(db, tenantId);
      return ok({ refreshed });
    }

    const { jobId, reused } = await enqueueJob(db, {
      type: JOB_TYPES.GRN_RESOLVE_PRODUCTS,
      tenantId,
      payload: { dedupeKey: 'grn-resolve-products' },
    });
    scheduleJobProcessing(db);
    return ok({ jobId, async: true, status: reused ? 'RUNNING' : 'PENDING', reused }, 202);
  }

  if (route === '/goods-receipts' && method === 'GET') {
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;

    const status = url.searchParams.get('status');
    const rejectStatus = url.searchParams.get('rejectStatus');

    let filter: Record<string, unknown> = status ? { status } : {};
    if (rejectStatus) {
      filter = {
        ...filter,
        status: filter.status || 'POSTED',
        // GRN lama tidak punya field rejectStatus sama sekali — anggap PENDING juga.
        ...(rejectStatus === 'PENDING'
          ? grnPendingRejectFilter()
          : { items: { $elemMatch: { rejectStatus } } }),
      };
    }

    filter = withTenantFilter(scopeAuth, filter);

    // GET murni baca — resolve produk unresolved lewat POST /goods-receipts/refresh-unresolved.
    const { pageMode, limit, cursor } = parseCursorPageParams(url.searchParams, { defaultLimit: 100, maxLimit: 300 });
    let listFilter = applyDescDateIdCursor(filter, cursor, 'tanggal');
    const list = await db.collection('goods_receipts')
      .find(listFilter)
      .project(GRN_LIST_EXCLUDE)
      .sort({ tanggal: -1, id: -1 })
      .limit(limit)
      .toArray();

    const enriched = await enrichGrnList(db, tenantId, list);
    const cleaned = enriched.map((row) => clean(stripGrnListRow(row as Record<string, unknown>)));

    if (pageMode) {
      const last = list[list.length - 1] as Record<string, unknown> | undefined;
      return ok(cursorPageResponse(cleaned, limit, 'tanggal', last));
    }
    return ok(cleaned);
  }

  if (route === '/goods-receipts/sync-shipped' && method === 'POST') {
    const roleDenied = requireRole(auth, GRN_POST_ROLES);
    if (roleDenied) return roleDenied;
    const { denied, tenantId } = resolveOperationalScope(auth, { url, body: grnBody, request });
    if (denied) return denied;
    if (!tenantId) return err('Scope tidak valid', 400);

    const inline = url.searchParams.get('inline') === '1';
    if (inline) {
      const result = await syncShippedDeliveriesFromSales(db, tenantId);
      if ('error' in result && result.error) return err(result.error, 400);
      const grnRefreshed = await refreshUnresolvedGrnsForTenant(db, tenantId);
      await invalidateDashboardSnapshot(db, tenantId);
      return ok({ ...result, grnRefreshed });
    }

    const { jobId, reused } = await enqueueJob(db, {
      type: JOB_TYPES.GRN_SYNC_SHIPPED,
      tenantId,
      payload: { dedupeKey: 'grn-sync-shipped' },
    });
    scheduleJobProcessing(db);
    return ok({ jobId, async: true, status: reused ? 'RUNNING' : 'PENDING', reused }, 202);
  }

  if (path[0] === 'goods-receipts' && path[2] === 'invoice-status' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const grn = await db.collection('goods_receipts').findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as GrnDoc | null;
    if (!grn) return err('Tidak ditemukan', 404);
    if (grn.invoiceSyncStatus === 'PENDING' || grn.invoiceSyncStatus === 'SYNCING') {
      const { recoverStuckGrnInvoiceSyncs } = await import('@/lib/api/grn-invoice-sync-recover');
      await recoverStuckGrnInvoiceSyncs(db, [grn as Record<string, unknown>]).catch(() => {});
      scheduleJobProcessing(db);
      const fresh = await db.collection('goods_receipts').findOne({ id: grn.id }) as GrnDoc | null;
      if (!fresh) return err('Tidak ditemukan', 404);
      return ok({
        id: fresh.id,
        noGRN: fresh.noGRN,
        noInvoice: fresh.noInvoice || null,
        invoiceSyncStatus: fresh.invoiceSyncStatus || 'NONE',
        invoiceSyncError: fresh.invoiceSyncError || null,
        hutangId: fresh.hutangId || null,
        invoiceSyncAt: fresh.invoiceSyncAt || null,
        postedAt: fresh.postedAt || null,
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

    doc = await enrichGrnDocWithProducts(db, doc) as GrnDoc;

    return ok(clean(doc));
  }

  if (path[0] === 'goods-receipts' && path[2] === 'post' && method === 'POST') {
    const roleDenied = requireRole(auth, GRN_POST_ROLES);
    if (roleDenied) return roleDenied;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: grnBody, request });
    if (denied) return denied;

    const locked = await guardPosting(db, scopeAuth, grnBody);

    if (locked) return locked;

    const grn = await db.collection('goods_receipts').findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as GrnDoc | null;

    if (!grn) return err('GRN tidak ditemukan', 404);

    if (grn.status === 'POSTED') return err('GRN sudah diposting');
    if (grn.status === 'REVERSED') return err('GRN sudah dibalik — penerimaan ulang lewat DO baru dari vendor', 409);

    if (isUnresolvedGrnStatus(grn.status || '')) {
      return err('Produk belum terdaftar di Master Produk. Daftarkan/sync kode barang yang sama dari sales.app.');
    }

    const tenantId = grn.tenantId || tenantIdForWrite(scopeAuth, grnBody);

    if (Array.isArray(grnBody.photos) && grnBody.photos.length) {
      const photoResult = await persistGrnPhotos(tenantId, grnBody.photos);
      if ('error' in photoResult) return err(photoResult.error, 400);
      grnBody.photoUrls = photoResult;
    }

    const actor = await actorSnapshot(db, scopeAuth);
    const sig = parseKnowingSignature(grnBody.receivedBy, 'Penerima gudang');
    if (!sig.ok) return err(sig.error, 400);
    const receivedBy = {
      userId: actor.userId,
      userName: sig.value.userName,
      role: actor.role,
      nik: sig.value.nik,
      jabatan: sig.value.jabatan,
    };
    const posted = await postGoodsReceipt(db, {
      grn,
      tenantId,
      body: grnBody,
      asyncInvoice: grnBody.asyncInvoice !== false,
      receivedBy,
    });
    if (posted.error) return err(posted.error, posted.conflict ? 409 : 400);

    await invalidateDashboardSnapshot(db, tenantId);

    return ok(clean(posted));
  }

  if (path[0] === 'goods-receipts' && path[2] === 'replay-invoice' && method === 'POST') {
    const roleDenied = requireRole(auth, GRN_POST_ROLES);
    if (roleDenied) return roleDenied;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: grnBody, request });
    if (denied) return denied;

    const grn = await db.collection('goods_receipts').findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as GrnDoc | null;
    if (!grn) return err('GRN tidak ditemukan', 404);
    if (grn.status !== 'POSTED') return err('GRN harus POSTED dulu', 400);
    if ((grn as { reversalPendingId?: string }).reversalPendingId) {
      return err('GRN sedang diajukan pembalik — tolak/batalkan pengajuan pembalik dulu', 409);
    }

    const tenantId = grn.tenantId || tenantIdForWrite(scopeAuth, grnBody);
    const result = await replayGrnInvoiceAsync(db, { grn, tenantId });
    return ok(clean(result));
  }

  return null;
}
