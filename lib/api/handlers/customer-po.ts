import type { NextResponse } from 'next/server';
import type { HandlerContext } from '@/types/api/handler';
import { parseHandlerBody } from '@/types/api/handler';
import type { AuthContext } from '@/types/auth';
import type { Db } from 'mongodb';
// PO customer ke vendor sales.app — Supervisor ajukan → Admin approve → kirim vendor.

import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  requireAuth,
  requireRole,
  PO_CREATE_ROLES,
  PO_REQUEST_APPROVAL_ROLES,
  PO_APPROVE_ROLES,
  PO_DIRECT_SUBMIT_ROLES,
  PO_EDIT_ROLES,
} from '@/lib/api/require-auth';
import { tenantIdForWrite, withTenantFilter, resolveOperationalScope } from '@/lib/api/tenant-master';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { enrichPoItemsForVendor } from '@/lib/api/customer-po-vendor';
import { runPoVendorSyncPending } from '@/lib/api/po-vendor-sync-run';
import { enqueueAndKickPoVendorSync } from '@/lib/api/po-vendor-sync-kick';
import { orchestrateEnsurePushCancelSoAfterCommit } from '@/lib/api/cpo-cancel-push-integration';
import { canEditCustomerPo, canRequestApprovalPoStatus } from '@/lib/pembelian-po/permissions';
import {
  parseCursorPageParams,
  applyDescDateIdCursor,
  sliceCursorPage,
  encodeCursor,
} from '@/lib/api/cursor-page';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import { guardPosting } from '@/lib/api/period-lock';
import { computeLineEstimasi, sumPoEstimasi, mergePoItemsByStokId } from '@/lib/api/po-estimasi';
import { findProductUomsByIds } from '@/lib/api/product-uom';
import type { JsonObject } from '@/types/json';
import { asObject } from '@/types/json';
import { vendorPoWriteFields } from '@/lib/api/po-channel';
import { enrichPoListWithSoCancelState, pullSoCancelStateForPo, backfillPoVendorSoFromSales } from '@/lib/api/cpo-so-pull-sync';
import { poHasVendorSoNumbers } from '@/lib/api/customer-po-so-extract';
import { applyWrResolutionLink, assertWrResolvable, loadWrById } from '@/lib/api/maintenance-resolve';

interface CustomerPoBody extends Record<string, unknown> {
  items?: JsonObject[];
  noPO?: string;
  tanggalKedatangan?: string;
  tanggal?: string;
  catatan?: string;
  paymentTerms?: string;
  reason?: string;
  maintenanceRequestId?: string | null;
  assetId?: string | null;
}

interface ActorInput {
  userId?: string;
  name?: string;
  email?: string;
  role?: string;
}

/** Status PO yang boleh pull nomor SO dari sales.app (HTTP). */
const SO_BACKFILL_STATUSES = new Set([
  'SUBMITTED', 'CONFIRMED', 'PARTIAL_CANCELLED',
  'PARTIAL_SHIPPED', 'SHIPPED', 'PARTIAL_RECEIVED', 'RECEIVED', 'INVOICED',
]);

/** Snapshot pengguna untuk audit — lookup DB hanya jika nama kosong di session. */
async function actorSnapshot(db: Db, auth: ActorInput | null | undefined) {
  let userName = String(auth?.name || auth?.email || '').trim();
  let role = auth?.role || '';
  if (auth?.userId && !userName) {
    const u = await db.collection('users').findOne(
      { id: auth.userId },
      { projection: { name: 1, email: 1, role: 1 } },
    );
    if (u) {
      userName = String(u.name || u.email || '').trim();
      if (!role) role = u.role || '';
    }
  }
  return {
    userId: auth?.userId || '',
    userName: userName || 'Pengguna',
    role,
  };
}

function resolvePersonLabel(snapshot, userMap) {
  if (!snapshot) return '';
  const direct = snapshot.userName || snapshot.name || snapshot.email;
  if (direct) return direct;
  const u = snapshot.userId ? userMap[snapshot.userId] : null;
  return u?.name || u?.email || '';
}

function normalizePerson(snapshot, userMap) {
  if (!snapshot?.userId && !snapshot?.userName && !snapshot?.name && !snapshot?.email) {
    return null;
  }
  const userName = resolvePersonLabel(snapshot, userMap) || (snapshot?.userId ? 'Pengguna' : '');
  if (!userName && !snapshot?.userId) return null;
  return {
    userId: snapshot.userId || '',
    userName,
    role: snapshot.role || userMap[snapshot.userId]?.role || '',
  };
}

/** Lengkapi nama pembuat/pengaju dari koleksi users (PO lama sering hanya punya userId). */
async function enrichPoPeople(db: Db, list) {
  if (!list?.length) return [];
  const ids = new Set();
  for (const po of list) {
    for (const key of ['createdBy', 'requestedBy', 'lastEditedBy', 'approvedBy', 'rejectedBy']) {
      const p = po[key];
      if (p?.userId) ids.add(p.userId);
    }
  }
  const users = ids.size
    ? await db.collection('users')
      .find({ id: { $in: [...ids] } })
      .project({ id: 1, name: 1, email: 1, role: 1 })
      .toArray()
    : [];
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  const persistPatches: { id: string; createdBy: Record<string, unknown> }[] = [];

  const enriched = list.map((po) => {
    const requestedBy = normalizePerson(po.requestedBy, userMap);
    let createdBy = normalizePerson(po.createdBy, userMap);
    if ((!createdBy || !createdBy.userName || createdBy.userName === 'Pengguna') && requestedBy?.userName) {
      createdBy = requestedBy;
    }

    if (
      createdBy?.userId
      && createdBy.userName
      && createdBy.userName !== 'Pengguna'
      && po.id
      && (!po.createdBy?.userName || po.createdBy.userName !== createdBy.userName)
    ) {
      persistPatches.push({ id: po.id, createdBy });
    }

    return clean({
      ...po,
      createdBy,
      requestedBy,
      lastEditedBy: normalizePerson(po.lastEditedBy, userMap) || po.lastEditedBy,
      approvedBy: normalizePerson(po.approvedBy, userMap) || po.approvedBy,
      rejectedBy: normalizePerson(po.rejectedBy, userMap) || po.rejectedBy,
    });
  });

  if (persistPatches.length) {
    Promise.all(
      persistPatches.map(({ id, createdBy }) => db.collection('customer_purchase_orders').updateOne(
        { id },
        { $set: { createdBy } },
      )),
    ).catch(() => {});
  }

  return enriched;
}

async function enrichOnePo(
  db: Db,
  po,
  opts?: { skipSalesBackfill?: boolean },
) {
  const [enriched] = await enrichPoPeople(db, [po]);
  if (opts?.skipSalesBackfill) return enriched;
  if (!po || poHasVendorSoNumbers(po as JsonObject)) return enriched;
  const st = String(po.status || '');
  if (!SO_BACKFILL_STATUSES.has(st)) return enriched;

  await backfillPoVendorSoFromSales(db, po as JsonObject);
  const fresh = await db.collection('customer_purchase_orders').findOne({ id: po.id });
  if (fresh) {
    const [withPeople] = await enrichPoPeople(db, [fresh]);
    return withPeople;
  }
  return enriched;
}

async function mapPoItems(db: Db, tenantId: string, items: JsonObject[]) {
  const rawItems = items || [];
  const localIds = [...new Set(
    rawItems.map((it) => it.localStokId).filter(Boolean).map((id) => String(id)),
  )];
  const uomIds = [...new Set(
    rawItems.map((it) => it.uomId).filter(Boolean).map((id) => String(id)),
  )];

  const [productRows, uomById] = await Promise.all([
    localIds.length
      ? db.collection('products').find({ tenantId, id: { $in: localIds } }).toArray()
      : Promise.resolve([]),
    findProductUomsByIds(db, tenantId, uomIds),
  ]);
  const prodById = new Map(productRows.map((p) => [String(p.id), p]));

  const mapped = rawItems.map((it) => {
    let vendorStokId = it.vendorStokId;
    let vendorKode = it.vendorKode || it.kode;
    let vendorTenantId = it.vendorTenantId;
    let vendorUomId = it.vendorUomId || '';
    let satuan = it.satuan;
    let prod: Record<string, unknown> | undefined;
    if (it.localStokId) {
      prod = prodById.get(String(it.localStokId)) as Record<string, unknown> | undefined;
      if (prod) {
        vendorStokId = prod.vendorStokId || vendorStokId;
        vendorKode = prod.kode || vendorKode;
        vendorTenantId = prod.vendorTenantId || vendorTenantId;
      }
    }
    if (it.uomId) {
      const localUom = uomById.get(String(it.uomId));
      if (localUom) {
        satuan = localUom.satuan;
        vendorUomId = localUom.vendorUomId || vendorUomId;
      }
    }
    // Fallback: ID satuan dasar dari snapshot katalog sales (setelah Sync Katalog)
    if (!vendorUomId || String(vendorUomId).startsWith('legacy:')) {
      const fromProduct = prod?.vendorBaseUomId != null ? String(prod.vendorBaseUomId).trim() : '';
      if (fromProduct && !fromProduct.startsWith('legacy:')) {
        vendorUomId = fromProduct;
      }
    }
    return computeLineEstimasi({
      lineId: String(it.lineId || uuidv4()),
      localStokId: it.localStokId != null ? String(it.localStokId) : undefined,
      vendorStokId: vendorStokId != null ? String(vendorStokId) : undefined,
      vendorTenantId: vendorTenantId != null ? String(vendorTenantId) : undefined,
      vendorKode: vendorKode != null ? String(vendorKode) : undefined,
      kode: it.kode != null ? String(it.kode) : (vendorKode != null ? String(vendorKode) : undefined),
      nama: it.nama != null ? String(it.nama) : undefined,
      satuan: satuan != null ? String(satuan) : undefined,
      uomId: String(it.uomId || ''),
      vendorUomId: String(vendorUomId || ''),
      qty: parseFloat(String(it.qty)) || 0,
      estimasiHarga: parseInt(String(it.estimasiHarga || 0), 10),
      hargaBeliReferensi: parseInt(String(it.hargaBeliReferensi || 0), 10),
    });
  });
  return mergePoItemsByStokId(mapped);
}

function canEditPo(auth: AuthContext, po: JsonObject) {
  return canEditCustomerPo(auth.role, po, {
    isMaster: auth.isMaster,
    userId: auth.userId,
  });
}

async function validatePoForApproval(db: Db, tenantId, items) {
  if (!items?.length) return { error: 'PO kosong' };
  for (const it of items) {
    const qty = parseFloat(it.qty);
    if (!qty || qty <= 0) {
      return { error: `Qty harus lebih dari 0 untuk "${it.nama || it.kode || 'item'}"` };
    }
  }
  return enrichPoItemsForVendor(db, tenantId, items);
}

async function markPoApproved(
  db: Db,
  po: Record<string, unknown>,
  approverSnap: unknown,
  syncError: unknown,
  session?: import('mongodb').ClientSession,
  correlationId?: string | null,
) {
  const now = new Date();
  const patch: Record<string, unknown> = {
    status: 'APPROVED',
    approvedBy: approverSnap,
    approvedAt: now,
    updatedAt: now,
    vendorSyncPending: true,
    vendorSyncError: syncError || null,
    vendorSyncAt: now,
    vendorAutoSync: true,
  };
  const cid = String(correlationId || po.correlationId || '').trim();
  if (cid) patch.correlationId = cid;
  const { txOpts } = await import('@/lib/api/transaction');
  await db.collection('customer_purchase_orders').updateOne(
    { id: po.id },
    { $set: patch },
    txOpts(session),
  );
  return db.collection('customer_purchase_orders').findOne({ id: po.id }, txOpts(session));
}

/**
 * P1 + H1.3: approve + ENSURE_CREATE_SO atomik → drain CreateSO.
 * PO_VENDOR_SYNC hanya recovery jika drain gagal.
 */
async function approvePoAndSyncVendor(db: Db, po: Record<string, unknown>, approverSnap: unknown) {
  const validation = await validatePoForApproval(db, String(po.tenantId || 'default'), po.items as JsonObject[]);
  if (validation.error) return { error: validation.error, status: 400 };

  const { runInTransactionOrFallback } = await import('@/lib/api/transaction');
  const { insertEnsureCreateSoOutbox, drainEnsureCreateSo } = await import('@/lib/api/integration-outbox');
  const { integrationCorrelationId } = await import('@/lib/api/integration-common');
  // W1-3: stamp CID on CPO in approve TX (Entity → CID → outbox → CreateSO commands).
  const approveCorrelationId = String(po.correlationId || '').trim()
    || integrationCorrelationId(String(po.id || ''), String(po.noPO || ''))
    || '';

  const approved = await runInTransactionOrFallback(async ({ db: txDb, session }) => {
    const row = await markPoApproved(txDb, po, approverSnap, null, session, approveCorrelationId);
    await insertEnsureCreateSoOutbox(
      txDb,
      {
        tenantId: String(row?.tenantId || po.tenantId || 'default'),
        poId: String(po.id),
        noPO: po.noPO ? String(po.noPO) : null,
        correlationId: approveCorrelationId || null,
      },
      session,
    );
    return row;
  });

  const tenantId = String(approved?.tenantId || po.tenantId || 'default');
  const drained = await drainEnsureCreateSo(db, {
    tenantId,
    poId: String(po.id),
    approverSnap,
  });

  if (!drained.ok) {
    const { jobId, reused } = await enqueueAndKickPoVendorSync(db, tenantId, {
      poId: String(approved?.id || po.id),
    });
    const row = await db.collection('customer_purchase_orders').findOne({ id: po.id });
    return {
      po: row || approved,
      vendorSynced: false,
      vendorSyncPending: false,
      vendorSyncError: drained.error,
      vendorSyncJobId: jobId,
      async: false,
      reused,
      error: drained.error,
      outboxId: drained.outboxId,
    };
  }

  const row = await db.collection('customer_purchase_orders').findOne({ id: po.id });
  if (drained.partialFailures?.length) {
    const { jobId } = await enqueueAndKickPoVendorSync(db, tenantId, {
      poId: String(row?.id || po.id),
    });
    return {
      po: row || approved,
      vendorSynced: Boolean(drained.vendorNoSO || drained.vendorSoId),
      vendorSyncPending: true,
      vendorNoSO: drained.vendorNoSO || row?.vendorNoSO,
      vendorSyncJobId: jobId,
      async: false,
      partialFailures: drained.partialFailures,
      outboxId: drained.outboxId,
    };
  }

  return {
    po: row || approved,
    vendorSynced: true,
    vendorSyncPending: false,
    vendorNoSO: drained.vendorNoSO || row?.vendorNoSO,
    vendorSoId: drained.vendorSoId || row?.vendorSoId,
    async: false,
    outboxId: drained.outboxId,
  };
}

/**
 * Retry CreateSO sync (P1 + H1.3). Drain outbox; job hanya jika drain gagal (recovery).
 */
async function syncApprovedPoToVendor(db: Db, po: Record<string, unknown>) {
  const tenantId = String(po.tenantId || 'default');
  const { drainEnsureCreateSo } = await import('@/lib/api/integration-outbox');
  const drained = await drainEnsureCreateSo(db, {
    tenantId,
    poId: String(po.id),
    approverSnap: po.approvedBy,
  });

  if (!drained.ok) {
    const { jobId, reused } = await enqueueAndKickPoVendorSync(db, tenantId, { poId: String(po.id) });
    const row = await db.collection('customer_purchase_orders').findOne({ id: po.id });
    const enriched = await enrichOnePo(db, row || po, { skipSalesBackfill: true });
    return {
      po: enriched,
      vendorSynced: false,
      vendorSyncPending: false,
      vendorSyncError: drained.error,
      vendorSyncJobId: jobId,
      async: false,
      reused,
      error: drained.error,
      outboxId: drained.outboxId,
    };
  }

  const row = await db.collection('customer_purchase_orders').findOne({ id: po.id });
  const enriched = await enrichOnePo(db, row || po, { skipSalesBackfill: true });
  if (drained.partialFailures?.length) {
    const { jobId } = await enqueueAndKickPoVendorSync(db, tenantId, { poId: String(po.id) });
    return {
      po: enriched,
      vendorSynced: Boolean(drained.vendorNoSO || drained.vendorSoId),
      vendorSyncPending: true,
      vendorNoSO: drained.vendorNoSO || enriched?.vendorNoSO,
      vendorSyncJobId: jobId,
      async: false,
      partialFailures: drained.partialFailures,
      outboxId: drained.outboxId,
    };
  }

  return {
    po: enriched,
    vendorSynced: true,
    vendorSyncPending: false,
    vendorNoSO: drained.vendorNoSO || enriched?.vendorNoSO,
    vendorSoId: drained.vendorSoId || enriched?.vendorSoId,
    async: false,
    outboxId: drained.outboxId,
  };
}

async function mapListForResponse(
  db: Db,
  list: Record<string, unknown>[],
  { enrichSo }: { enrichSo: boolean },
) {
  const withPeople = await enrichPoPeople(db, list);
  if (!enrichSo) return withPeople;
  return enrichPoListWithSoCancelState(db, withPeople);
}

export async function handleCustomerPo({
  db, route, method, path, body, url, auth, request,
}: HandlerContext): Promise<NextResponse | null> {
  const poBody = parseHandlerBody(body) as CustomerPoBody;
  const scopeOpts = { url, body: poBody, request };

  if (route === '/customer-purchase-orders' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const status = url.searchParams.get('status');
    const enrichSo = url.searchParams.get('enrichSo') === '1';
    let filter: Record<string, unknown> = status ? { status } : {};
    filter = withTenantFilter(scopeAuth, filter);
    const { pageMode, limit, cursor } = parseCursorPageParams(url.searchParams, { defaultLimit: 100, maxLimit: 300 });
    if (pageMode) {
      const listFilter = applyDescDateIdCursor(filter, cursor, 'tanggal');
      const rows = await db.collection('customer_purchase_orders')
        .find(listFilter)
        .sort({ tanggal: -1, id: -1 })
        .limit(limit + 1)
        .toArray();
      const { items, hasMore } = sliceCursorPage(rows, limit);
      const last = items[items.length - 1] as Record<string, unknown> | undefined;
      return ok({
        items: await mapListForResponse(db, items, { enrichSo }),
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last, 'tanggal') : null,
      });
    }
    const list = await db.collection('customer_purchase_orders')
      .find(filter)
      .sort({ tanggalKedatangan: -1, tanggal: -1 })
      .limit(300)
      .toArray();
    return ok(await mapListForResponse(db, list, { enrichSo }));
  }

  // POST /customer-purchase-orders/sync-pending — antrian kirim otomatis ke sales.app
  if (route === '/customer-purchase-orders/sync-pending' && method === 'POST') {
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;
    if (!tenantId) return err('Scope tidak valid', 400);

    const inline = url.searchParams.get('inline') === '1';
    if (inline) {
      // Escape hatch debug — dilarang di VPS agar UI/ops tidak menunggu push 45s.
      if (String(process.env.DEPLOYMENT_MODE || '').toLowerCase() === 'vps') {
        return err('inline sync-pending dinonaktifkan di VPS — gunakan job PO_VENDOR_SYNC', 400);
      }
      const result = await runPoVendorSyncPending(db, scopeAuth);
      return ok(result);
    }

    // Ops recovery bulk — bukan happy path approve/submit (P1).
    const { jobId, reused } = await enqueueAndKickPoVendorSync(db, tenantId);
    return ok({
      jobId,
      async: true,
      status: reused ? 'RUNNING' : 'PENDING',
      reused,
      message: 'Recovery: mengulang kirim PO yang gagal/pending',
    }, 202);
  }

  if (route === '/customer-purchase-orders' && method === 'POST') {
    const deniedRole = requireRole(auth, PO_CREATE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;
    if (!poBody.items?.length) return err('Minimal satu item');

    const tenantId = tenantIdForWrite(scopeAuth, poBody);
    const now = new Date();
    const tanggalKedatangan = poBody.tanggalKedatangan
      ? new Date(poBody.tanggalKedatangan)
      : (poBody.tanggal ? new Date(poBody.tanggal) : now);
    const locked = await guardPosting(db, scopeAuth, poBody, tanggalKedatangan);
    if (locked) return locked;

    const noPO = poBody.noPO || await nextDocNumber(db, tenantId, 'CPO', 'CPO');

    const poItems = await mapPoItems(db, tenantId, poBody.items);
    const doc = {
      id: uuidv4(),
      tenantId,
      noPO,
      tanggal: now,
      tanggalKedatangan,
      status: 'DRAFT',
      items: poItems,
      estimasiTotal: sumPoEstimasi(poItems),
      catatan: poBody.catatan || '',
      paymentTerms: poBody.paymentTerms || 'KREDIT',
      ...vendorPoWriteFields({
        maintenanceRequestId: poBody.maintenanceRequestId || null,
        assetId: poBody.assetId || null,
      }),
      createdBy: await actorSnapshot(db, auth),
      createdAt: now,
      updatedAt: now,
    };
    await db.collection('customer_purchase_orders').insertOne(doc);

    if (poBody.maintenanceRequestId) {
      const wr = await loadWrById(db, scopeAuth, String(poBody.maintenanceRequestId));
      const block = assertWrResolvable(wr, 'PO');
      if (!block && wr && !wr.linkedPoId) {
        await applyWrResolutionLink(db, wr, {
          resolutionType: 'PO',
          linkedPoId: doc.id,
          linkedPoNo: noPO,
        });
      }
    }

    return ok(clean(doc));
  }

  // GET /customer-purchase-orders/:id — detail (deep-link highlight dari Food Production)
  if (path[0] === 'customer-purchase-orders' && path.length === 2 && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const po = await db.collection('customer_purchase_orders').findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!po) return err('PO tidak ditemukan', 404);
    return ok(clean(await enrichOnePo(db, po as JsonObject)));
  }

  // PUT /customer-purchase-orders/:id — edit PO (DRAFT / PENDING_APPROVAL)
  if (path[0] === 'customer-purchase-orders' && path.length === 2 && method === 'PUT') {
    const deniedRole = requireRole(auth, PO_EDIT_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (!canEditPo(scopeAuth!, po)) {
      return err('PO tidak bisa diedit pada status ini atau role tidak diizinkan', 403);
    }
    if (!poBody.items?.length) return err('Minimal satu item');

    const locked = await guardPosting(db, scopeAuth, poBody, po.tanggal || po.tanggalKedatangan);
    if (locked) return locked;

    const tenantId = po.tenantId || 'default';
    const now = new Date();
    const tanggalKedatangan = poBody.tanggalKedatangan
      ? new Date(poBody.tanggalKedatangan)
      : po.tanggalKedatangan;

    const editor = await actorSnapshot(db, scopeAuth);
    const poItems = await mapPoItems(db, tenantId, poBody.items);
    const patch: Record<string, unknown> = {
      items: poItems,
      estimasiTotal: sumPoEstimasi(poItems),
      catatan: poBody.catatan ?? po.catatan ?? '',
      tanggalKedatangan,
      updatedAt: now,
      lastEditedBy: editor,
      lastEditedAt: now,
    };

    await db.collection('customer_purchase_orders').updateOne({ id: po.id }, { $set: patch });
    const updated = await db.collection('customer_purchase_orders').findOne({ id: po.id });
    return ok(clean(updated));
  }

  // DELETE /customer-purchase-orders/:id — hapus permanen hanya DRAFT
  if (path[0] === 'customer-purchase-orders' && path.length === 2 && method === 'DELETE') {
    const deniedRole = requireRole(auth, PO_EDIT_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (String(po.status || '') !== 'DRAFT') {
      return err('Hanya PO DRAFT yang bisa dihapus', 400);
    }
    if (!canEditPo(scopeAuth!, po)) {
      return err('Tidak diizinkan menghapus PO ini', 403);
    }

    await db.collection('customer_purchase_orders').deleteOne({ id: po.id });
    await invalidateDashboardSnapshot(db, String(po.tenantId || 'default'));
    return ok({ deleted: true, id: po.id, noPO: po.noPO || null });
  }

  // POST /customer-purchase-orders/:id/request-approval — Supervisor ajukan ke Admin
  if (path[0] === 'customer-purchase-orders' && path[2] === 'request-approval' && method === 'POST') {
    const deniedRole = requireRole(auth, PO_REQUEST_APPROVAL_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (!canRequestApprovalPoStatus(String(po.status || ''))) {
      return err('Hanya PO DRAFT atau REJECTED yang bisa diajukan', 400);
    }
    if (!po.items?.length) return err('PO kosong', 400);
    const locked = await guardPosting(db, scopeAuth, poBody, po.tanggal || po.tanggalKedatangan);
    if (locked) return locked;
    if (
      scopeAuth!.role === 'GUDANG'
      && po.createdBy?.userId !== scopeAuth!.userId
      && !scopeAuth!.isMaster
    ) {
      return err('Hanya pembuat PO yang bisa mengajukan', 403);
    }

    const now = new Date();
    const submitter = await actorSnapshot(db, auth);
    const approvalPatch: Record<string, unknown> = {
      status: 'PENDING_APPROVAL',
      requestedAt: now,
      updatedAt: now,
      requestedBy: submitter,
      rejectReason: null,
      rejectedBy: null,
      rejectedAt: null,
    };
    if (!po.createdBy?.userId) {
      approvalPatch.createdBy = submitter;
    } else if (!po.createdBy?.userName) {
      const createdBy = asObject(po.createdBy);
      approvalPatch.createdBy = await actorSnapshot(db, {
        userId: String(createdBy.userId || ''),
        name: String(createdBy.userName || createdBy.name || ''),
        email: String(createdBy.email || ''),
        role: String(createdBy.role || ''),
      });
    }

    await db.collection('customer_purchase_orders').updateOne(
      { id: po.id },
      { $set: approvalPatch },
    );
    const updated = await db.collection('customer_purchase_orders').findOne({ id: po.id });
    return ok(await enrichOnePo(db, updated, { skipSalesBackfill: true }));
  }

  // POST /customer-purchase-orders/:id/approve — Admin setujui + sync CreateSO (P1 Category A)
  if (path[0] === 'customer-purchase-orders' && path[2] === 'approve' && method === 'POST') {
    const deniedRole = requireRole(auth, PO_APPROVE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;
    const locked = await guardPosting(db, scopeAuth, body as Record<string, unknown>);
    if (locked) return locked;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (po.status === 'APPROVED' && (po.vendorSyncPending || po.vendorSyncError || !poHasVendorSoNumbers(po as JsonObject))) {
      const retried = await syncApprovedPoToVendor(db, po as Record<string, unknown>);
      return ok({ ...retried, retried: true });
    }
    if (po.status !== 'PENDING_APPROVAL') return err('Status harus PENDING_APPROVAL', 400);

    const approverSnap = await actorSnapshot(db, auth);
    const result = await approvePoAndSyncVendor(db, po as Record<string, unknown>, approverSnap);
    if ('error' in result && result.error && !('po' in result && result.po)) {
      return err(result.error, result.status || 400);
    }

    const enriched = await enrichOnePo(db, result.po, { skipSalesBackfill: true });
    await invalidateDashboardSnapshot(db, String(po.tenantId || 'default'));
    // P1: sync CreateSO — 200 + SUCCESS|FAILED flags (bukan PENDING happy path).
    return ok({
      ...enriched,
      vendorSynced: result.vendorSynced,
      vendorSyncPending: result.vendorSyncPending,
      vendorSyncJobId: 'vendorSyncJobId' in result ? result.vendorSyncJobId : null,
      vendorSyncError: ('vendorSyncError' in result ? result.vendorSyncError : null)
        || ('error' in result && result.vendorSynced === false ? result.error : null),
      vendorNoSO: 'vendorNoSO' in result ? result.vendorNoSO : enriched?.vendorNoSO,
      async: false,
    });
  }

  // POST /customer-purchase-orders/:id/sync-so-lines — tarik cancel baris SO dari sales.app
  if (path[0] === 'customer-purchase-orders' && path[2] === 'sync-so-lines' && method === 'POST') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (!String(po.noPO || '')) return err('PO tanpa noPO', 400);

    let working = po as JsonObject;
    if (!poHasVendorSoNumbers(working)) {
      const backfill = await backfillPoVendorSoFromSales(db, working);
      if (backfill.updated) {
        working = await db.collection('customer_purchase_orders').findOne({ id: po.id }) as JsonObject;
      } else if (backfill.error && !poHasVendorSoNumbers(working)) {
        return err(`Gagal ambil nomor SO: ${backfill.error}`, 502);
      }
    }

    const result = await pullSoCancelStateForPo(db, working);
    const updated = result.updated
      ? await db.collection('customer_purchase_orders').findOne({ id: po.id })
      : po;
    if (result.error && !result.updated) {
      return err(`Gagal sync SO: ${result.error}`, 502);
    }
    return ok({
      ...(await enrichOnePo(db, updated)),
      synced: result.updated,
      message: result.updated ? 'Baris PO diselaraskan dengan SO sales.app' : 'Sudah selaras dengan SO sales.app',
    });
  }

  // POST /customer-purchase-orders/:id/sync-vendor — sync ulang CreateSO (recovery manual)
  if (path[0] === 'customer-purchase-orders' && path[2] === 'sync-vendor' && path.length === 3 && method === 'POST') {
    const deniedRole = requireRole(auth, PO_APPROVE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (!['APPROVED', 'SUBMITTED'].includes(String(po.status))) {
      return err('Hanya PO berstatus APPROVED/SUBMITTED yang bisa dikirim ulang ke vendor', 400);
    }

    const synced = await syncApprovedPoToVendor(db, po as Record<string, unknown>);
    return ok({
      ...synced,
      message: synced.vendorSynced
        ? 'Berhasil kirim ke vendor'
        : (synced.vendorSyncError || 'Kirim ke vendor gagal — coba lagi'),
    });
  }

  // POST /customer-purchase-orders/:id/sync-vendor/:vendorTenantId — sync retry satu vendor (P1)
  if (path[0] === 'customer-purchase-orders' && path[2] === 'sync-vendor' && path.length === 4 && method === 'POST') {
    const deniedRole = requireRole(auth, PO_APPROVE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (!['APPROVED', 'SUBMITTED'].includes(String(po.status))) {
      return err('Retry vendor hanya untuk PO APPROVED/SUBMITTED', 400);
    }

    const vendorTenantId = String(path[3] || '').trim();
    if (!vendorTenantId) return err('vendorTenantId wajib', 400);

    const { retryVendorSyncForSingleVendor } = await import('@/lib/api/customer-po-vendor-retry');
    const retried = await retryVendorSyncForSingleVendor(
      db,
      po as Record<string, unknown>,
      vendorTenantId,
    );
    if (retried.error && !retried.po) {
      const tenantId = String(po.tenantId || 'default');
      const { jobId } = await enqueueAndKickPoVendorSync(db, tenantId, {
        poId: String(po.id),
        vendorTenantId,
      });
      const row = await db.collection('customer_purchase_orders').findOne({ id: po.id });
      const enriched = await enrichOnePo(db, row || po, { skipSalesBackfill: true });
      return ok({
        ...enriched,
        vendorSynced: false,
        vendorSyncPending: false,
        vendorSyncError: retried.error,
        vendorSyncJobId: jobId,
        async: false,
        message: `Gagal kirim ke vendor ${vendorTenantId}`,
      });
    }

    const enriched = await enrichOnePo(db, retried.po || po, { skipSalesBackfill: true });
    return ok({
      ...enriched,
      vendorSynced: !!retried.vendorSynced,
      vendorSyncPending: false,
      vendorSyncError: retried.vendorSynced ? null : (retried.error || null),
      vendorNoSO: enriched?.vendorNoSO,
      async: false,
      message: retried.vendorSynced
        ? `Vendor ${vendorTenantId} tersinkron`
        : 'Masih ada vendor lain yang gagal',
    });
  }

  // POST /customer-purchase-orders/:id/cancel — TX CANCELLED + ENSURE_PUSH_CANCEL_SO (W1-2)
  if (path[0] === 'customer-purchase-orders' && path[2] === 'cancel' && method === 'POST') {
    const deniedRole = requireRole(auth, PO_EDIT_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    const status = String(po.status || '');
    if (['CANCELLED', 'REJECTED', 'RECEIVED', 'INVOICED'].includes(status)) {
      return err(`PO status ${status} tidak bisa dibatalkan`, 400);
    }
    const anyReceived = (po.items || []).some((it: { qtyReceived?: number }) => (it.qtyReceived || 0) > 0);
    if (anyReceived) return err('PO sudah ada penerimaan barang, tidak bisa dibatalkan', 400);

    const now = new Date();
    const canceller = await actorSnapshot(db, auth);
    const reason = String(poBody.reason || 'Dibatalkan customer');
    const needsPeerPush = ['SUBMITTED', 'CONFIRMED', 'APPROVED'].includes(status);
    const tenantId = String(po.tenantId || 'default');

    const { runInTransactionOrFallback, txOpts } = await import('@/lib/api/transaction');
    const { insertEnsurePushCancelSoOutbox } = await import('@/lib/api/integration-outbox');

    const { integrationCorrelationId } = await import('@/lib/api/integration-common');
    const cancelCorrelationId = String(po.correlationId || '').trim()
      || integrationCorrelationId(String(po.id || ''), String(po.noPO || ''))
      || '';

    await runInTransactionOrFallback(async ({ db: txDb, session }) => {
      await txDb.collection('customer_purchase_orders').updateOne(
        { id: po.id },
        {
          $set: {
            status: 'CANCELLED',
            cancelledBy: canceller,
            cancelledAt: now,
            cancelReason: reason,
            updatedAt: now,
            ...(cancelCorrelationId ? { correlationId: cancelCorrelationId } : {}),
          },
        },
        txOpts(session),
      );
      if (needsPeerPush) {
        await insertEnsurePushCancelSoOutbox(
          txDb,
          {
            tenantId,
            poId: String(po.id),
            noPO: po.noPO ? String(po.noPO) : null,
            reason,
            correlationId: cancelCorrelationId || null,
          },
          session,
        );
      }
    });

    let salesNotify: Record<string, unknown> | null = null;
    let cancelPushJobId: string | undefined;
    let cancelPushError: string | undefined;
    if (needsPeerPush) {
      const orch = await orchestrateEnsurePushCancelSoAfterCommit(db, {
        tenantId,
        poId: String(po.id),
        reason,
      });
      salesNotify = (orch.salesNotify as Record<string, unknown> | undefined) || null;
      cancelPushJobId = orch.jobId;
      cancelPushError = orch.error;
    }

    const updated = await db.collection('customer_purchase_orders').findOne({ id: po.id });
    await invalidateDashboardSnapshot(db, tenantId);
    return ok({
      ...(await enrichOnePo(db, updated)),
      salesNotify,
      cancelPushJobId: cancelPushJobId || null,
      cancelPushError: cancelPushError || null,
    });
  }

  // POST /customer-purchase-orders/:id/reject — Admin tolak pengajuan
  if (path[0] === 'customer-purchase-orders' && path[2] === 'reject' && method === 'POST') {
    const deniedRole = requireRole(auth, PO_APPROVE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (po.status !== 'PENDING_APPROVAL') return err('Status harus PENDING_APPROVAL', 400);

    const now = new Date();
    const rejector = await actorSnapshot(db, auth);
    await db.collection('customer_purchase_orders').updateOne(
      { id: po.id },
      {
        $set: {
          status: 'REJECTED',
          rejectedBy: rejector,
          rejectedAt: now,
          rejectReason: poBody.reason || 'Ditolak admin',
          updatedAt: now,
        },
      },
    );
    const updated = await db.collection('customer_purchase_orders').findOne({ id: po.id });
    return ok(await enrichOnePo(db, updated, { skipSalesBackfill: true }));
  }

  // POST /customer-purchase-orders/:id/submit — Admin kirim langsung (tanpa approval)
  if (path[0] === 'customer-purchase-orders' && path[2] === 'submit' && method === 'POST') {
    const deniedRole = requireRole(auth, PO_DIRECT_SUBMIT_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);

    if (po.status === 'APPROVED' && (po.vendorSyncPending || po.vendorSyncError || !poHasVendorSoNumbers(po as JsonObject))) {
      const retried = await syncApprovedPoToVendor(db, po as Record<string, unknown>);
      return ok({
        ...retried,
        retried: true,
        message: retried.vendorSynced
          ? 'Berhasil kirim ke vendor'
          : (retried.vendorSyncError || 'Kirim ke vendor gagal — coba lagi'),
      });
    }

    if (po.status !== 'DRAFT') return err('PO sudah dikirim atau sedang menunggu approval', 400);

    const locked = await guardPosting(db, scopeAuth, poBody, po.tanggal || po.tanggalKedatangan);
    if (locked) return locked;

    const result = await approvePoAndSyncVendor(
      db,
      po as Record<string, unknown>,
      await actorSnapshot(db, auth),
    );
    if ('error' in result && result.error && !('po' in result && result.po)) {
      return err(result.error, result.status || 400);
    }

    const enriched = await enrichOnePo(db, result.po, { skipSalesBackfill: true });
    return ok({
      ...enriched,
      vendorSynced: result.vendorSynced,
      vendorSyncPending: result.vendorSyncPending,
      vendorSyncJobId: 'vendorSyncJobId' in result ? result.vendorSyncJobId : null,
      vendorSyncError: ('vendorSyncError' in result ? result.vendorSyncError : null)
        || ('error' in result && result.vendorSynced === false ? result.error : null),
      vendorNoSO: 'vendorNoSO' in result ? result.vendorNoSO : enriched?.vendorNoSO,
      async: false,
    });
  }

  return null;
}
