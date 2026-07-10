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
import { retryVendorSyncForPo } from '@/lib/api/customer-po-vendor-sync';
import { retryVendorSyncForSingleVendor } from '@/lib/api/customer-po-vendor-retry';
import { notifySalesPoCancelled } from '@/lib/api/customer-po-cancel-sales';
import { runPoVendorSyncPending } from '@/lib/api/po-vendor-sync-run';
import { enqueueAndKickPoVendorSync } from '@/lib/api/po-vendor-sync-kick';
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
    if (it.localStokId) {
      const prod = prodById.get(String(it.localStokId));
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

async function markPoApproved(db: Db, po, approverSnap, syncError) {
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
  await db.collection('customer_purchase_orders').updateOne({ id: po.id }, { $set: patch });
  return db.collection('customer_purchase_orders').findOne({ id: po.id });
}

/** Validasi lokal → setujui → kirim vendor inline (SYNC_CRITICAL). */
async function approvePoAndSyncVendor(db: Db, po: Record<string, unknown>, approverSnap: unknown) {
  const validation = await validatePoForApproval(db, String(po.tenantId || 'default'), po.items as JsonObject[]);
  if (validation.error) return { error: validation.error, status: 400 };

  const approved = await markPoApproved(db, po, approverSnap, null);
  const result = await retryVendorSyncForPo(db, approved as Record<string, unknown>, approverSnap);
  if (result.error && !result.po) {
    return {
      po: approved,
      vendorSynced: false,
      vendorSyncPending: true,
      vendorSyncError: result.error,
      async: false,
    };
  }
  return {
    po: result.po || approved,
    vendorSynced: result.vendorSynced ?? false,
    vendorSyncPending: result.vendorSynced === false,
    async: false,
  };
}

async function retryApprovedVendorSync(db: Db, po: Record<string, unknown>) {
  const result = await retryVendorSyncForPo(db, po, po.approvedBy);
  if (result.error && !result.po) {
    return { error: String(result.error), status: typeof result.status === 'number' ? result.status : 502 };
  }
  const row = result.po || po;
  const enriched = await enrichOnePo(db, row, { skipSalesBackfill: true });
  return {
    ...enriched,
    vendorSynced: result.vendorSynced ?? !enriched.vendorSyncPending,
    async: false,
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
      const result = await runPoVendorSyncPending(db, scopeAuth);
      return ok(result);
    }

    const { jobId, reused } = await enqueueAndKickPoVendorSync(db, tenantId);
    return ok({
      jobId,
      async: true,
      status: reused ? 'RUNNING' : 'PENDING',
      reused,
      message: 'Kirim PO ke vendor berjalan di background',
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

  // POST /customer-purchase-orders/:id/approve — Admin setujui (sync vendor opsional / ditunda)
  if (path[0] === 'customer-purchase-orders' && path[2] === 'approve' && method === 'POST') {
    const deniedRole = requireRole(auth, PO_APPROVE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;
    const locked = await guardPosting(db, scopeAuth, body as Record<string, unknown>);
    if (locked) return locked;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (po.status === 'APPROVED' && po.vendorSyncPending !== false) {
      const retried = await retryApprovedVendorSync(db, po as Record<string, unknown>);
      if ('error' in retried && retried.error) return err(String(retried.error), retried.status || 502);
      return ok({ ...retried, retried: true });
    }
    if (po.status !== 'PENDING_APPROVAL') return err('Status harus PENDING_APPROVAL', 400);

    const approverSnap = await actorSnapshot(db, auth);
    const result = await approvePoAndSyncVendor(db, po as Record<string, unknown>, approverSnap);
    if ('error' in result && result.error) return err(result.error, result.status || 400);

    const enriched = await enrichOnePo(db, result.po, { skipSalesBackfill: true });
    await invalidateDashboardSnapshot(db, String(po.tenantId || 'default'));
    return ok({
      ...enriched,
      vendorSynced: result.vendorSynced,
      vendorSyncPending: result.vendorSyncPending,
      vendorSyncError: (result as { vendorSyncError?: string }).vendorSyncError || null,
      async: result.async,
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

  // POST /customer-purchase-orders/:id/sync-vendor — antrian kirim ulang ke sales.app
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

    const result = await retryVendorSyncForPo(db, po, po.approvedBy);
    if (result.error && !result.po) {
      return err(String(result.error), typeof result.status === 'number' ? result.status : 502);
    }
    const enriched = await enrichOnePo(db, result.po || po);
    return ok({
      ...enriched,
      vendorSynced: result.vendorSynced ?? !enriched.vendorSyncPending,
      message: result.vendorSynced === false
        ? 'Sebagian vendor gagal — ulangi per vendor'
        : 'PO terkirim ke sales.app',
    });
  }

  // POST /customer-purchase-orders/:id/sync-vendor/:vendorTenantId — retry satu vendor gagal
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

    const result = await retryVendorSyncForSingleVendor(db, po, path[3]);
    if (result.error) return err(String(result.error), result.status || 502);

    const enriched = await enrichOnePo(db, result.po);
    return ok({ ...enriched, vendorSynced: result.vendorSynced });
  }

  // POST /customer-purchase-orders/:id/cancel — batalkan CPO + notify sales.app
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
    let salesNotify: Awaited<ReturnType<typeof notifySalesPoCancelled>> | null = null;
    if (['SUBMITTED', 'CONFIRMED', 'APPROVED'].includes(status)) {
      salesNotify = await notifySalesPoCancelled(db, po, poBody.reason || 'Dibatalkan customer');
    }

    await db.collection('customer_purchase_orders').updateOne(
      { id: po.id },
      {
        $set: {
          status: 'CANCELLED',
          cancelledBy: canceller,
          cancelledAt: now,
          cancelReason: poBody.reason || 'Dibatalkan',
          updatedAt: now,
        },
      },
    );
    const updated = await db.collection('customer_purchase_orders').findOne({ id: po.id });
    await invalidateDashboardSnapshot(db, String(po.tenantId || 'default'));
    return ok({ ...(await enrichOnePo(db, updated)), salesNotify });
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

    if (po.status === 'APPROVED' && po.vendorSyncPending !== false) {
      const retried = await retryApprovedVendorSync(db, po as Record<string, unknown>);
      if ('error' in retried && retried.error) return err(String(retried.error), retried.status || 502);
      return ok({
        ...retried,
        retried: true,
        message: retried.vendorSynced ? 'PO terkirim ke sales.app' : 'Sebagian vendor gagal — ulangi per vendor',
      });
    }

    if (po.status !== 'DRAFT') return err('PO sudah dikirim atau sedang menunggu approval', 400);

    const locked = await guardPosting(db, scopeAuth, poBody, po.tanggal || po.tanggalKedatangan);
    if (locked) return locked;

    const result = await approvePoAndSyncVendor(db, po as Record<string, unknown>, await actorSnapshot(db, auth));
    if ('error' in result && result.error) return err(result.error, result.status || 400);

    const enriched = await enrichOnePo(db, result.po, { skipSalesBackfill: true });
    return ok({
      ...enriched,
      vendorSynced: result.vendorSynced,
      vendorSyncPending: result.vendorSyncPending,
      vendorSyncError: (result as { vendorSyncError?: string }).vendorSyncError || null,
      async: result.async,
    });
  }

  return null;
}
