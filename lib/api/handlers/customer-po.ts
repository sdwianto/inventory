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
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { enrichPoItemsForVendor, groupPoItemsByVendorTenant } from '@/lib/api/customer-po-vendor';
import { computeLineEstimasi, sumPoEstimasi, mergePoItemsByStokId } from '@/lib/api/po-estimasi';
import { buildVendorSoSnapshot, mergeVendorSoSnapshots } from '@/lib/api/vendor-so-snapshot';
import type { JsonObject } from '@/types/json';
import { asObject } from '@/types/json';
import { vendorPoWriteFields } from '@/lib/api/po-channel';
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

/** Snapshot pengguna untuk audit — selalu isi userName (lookup DB jika session kosong). */
async function actorSnapshot(db: Db, auth: ActorInput | null | undefined) {
  let userName = String(auth?.name || auth?.email || '').trim();
  let role = auth?.role || '';
  if (auth?.userId) {
    const u = await db.collection('users').findOne({ id: auth.userId });
    if (u) {
      if (!userName) userName = String(u.name || u.email || '').trim();
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

async function enrichOnePo(db: Db, po) {
  const [enriched] = await enrichPoPeople(db, [po]);
  return enriched;
}

function salesFetchErrorMessage(err, salesUrl) {
  const cause = err?.cause || err;
  const code = cause?.code || err?.code;
  if (code === 'ECONNREFUSED') {
    return `Sales.app tidak dapat dihubungi di ${salesUrl}. Pastikan sales.app sudah berjalan (biasanya port 3000).`;
  }
  if (code === 'ENOTFOUND') {
    return `Alamat sales.app tidak ditemukan: ${salesUrl}`;
  }
  if (err?.name === 'TimeoutError' || code === 'ABORT_ERR') {
    return `Sales.app tidak merespons (timeout) — cek ${salesUrl}`;
  }
  return `Gagal menghubungi sales.app: ${cause?.message || err?.message || 'koneksi gagal'}`;
}

async function pushPoGroupToVendor(db: Db, { tenantId, config, po, vendorTenantId, items }) {
  const salesUrl = config.salesAppUrl;
  const apiKey = config.salesApiKey;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;

  let res;
  try {
    res = await fetch(`${salesUrl}/api/integrations/customer-po`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        customerTenantId: tenantId,
        vendorTenantId,
        noPO: po.noPO,
        customerPoId: po.id,
        tanggalKedatangan: po.tanggalKedatangan || po.tanggal || null,
        items,
        catatan: po.catatan || '',
        paymentTerms: po.paymentTerms || 'KREDIT',
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return { error: salesFetchErrorMessage(e, salesUrl), vendorTenantId };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return {
      error: `Sales.app merespons HTTP ${res.status} tanpa data JSON valid`,
      vendorTenantId,
    };
  }
  if (!res.ok) return { error: data.error || `Sales.app ${res.status}`, vendorTenantId };
  return { vendorSo: data, vendorTenantId };
}

async function pushPoToVendor(db: Db, po, tenantId) {
  const config = await getIntegrationConfig(db, tenantId);
  const apiKey = config.salesApiKey;
  if (!apiKey) {
    return { error: 'Belum terhubung ke sales.app — jalankan pairing dari menu Integrasi atau sales.app /integrasi' };
  }

  const enriched = await enrichPoItemsForVendor(db, tenantId, po.items);
  if (enriched.error) return { error: enriched.error };

  const grouped = groupPoItemsByVendorTenant(enriched.items || []);
  if (grouped.error) return { error: grouped.error };

  const submissions: JsonObject[] = [];
  try {
    const groups = grouped.groups || [];
    for (const { vendorTenantId, items } of groups) {
      const pushed = await pushPoGroupToVendor(db, {
        tenantId,
        config,
        po,
        vendorTenantId,
        items,
      });
      if (pushed.error) {
        return {
          error: pushed.error,
          partialSubmissions: submissions,
        };
      }
      submissions.push({
        vendorTenantId,
        vendorSoId: pushed.vendorSo?.id,
        vendorNoSO: pushed.vendorSo?.noSO,
        vendorSo: pushed.vendorSo || null,
        itemCount: items.length,
      });
    }
  } catch (e) {
    return { error: salesFetchErrorMessage(e, config.salesAppUrl) };
  }

  return { submissions };
}

async function mapPoItems(db: Db, tenantId, items) {
  const mapped = await Promise.all((items || []).map(async (it) => {
    let vendorStokId = it.vendorStokId;
    let vendorKode = it.vendorKode || it.kode;
    let vendorTenantId = it.vendorTenantId;
    if (it.localStokId) {
      const prod = await db.collection('products').findOne({ tenantId, id: it.localStokId });
      if (prod) {
        vendorStokId = prod.vendorStokId || vendorStokId;
        vendorKode = prod.kode || vendorKode;
        vendorTenantId = prod.vendorTenantId || vendorTenantId;
      }
    }
    return computeLineEstimasi({
      lineId: it.lineId || uuidv4(),
      localStokId: it.localStokId,
      vendorStokId,
      vendorTenantId,
      vendorKode,
      kode: it.kode || vendorKode,
      nama: it.nama,
      satuan: it.satuan,
      qty: parseFloat(it.qty) || 0,
      estimasiHarga: parseInt(it.estimasiHarga || 0, 10),
      hargaBeliReferensi: parseInt(it.hargaBeliReferensi || 0, 10),
    });
  }));
  return mergePoItemsByStokId(mapped);
}

function canEditPo(auth: AuthContext, po: JsonObject) {
  const status = String(po.status || '');
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(status)) return false;
  if (auth.isMaster || auth.role === 'ADMIN') return true;
  if (status === 'DRAFT' && auth.role === 'SUPERVISOR') return true;
  if (status === 'DRAFT' && auth.role === 'GUDANG') {
    return String(asObject(po.createdBy).userId || '') === auth.userId;
  }
  return false;
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

/** Validasi lokal → coba kirim vendor; jika sales.app offline tetap APPROVED (sync ditunda). */
async function completePoWithVendorSync(db: Db, po, approverSnap) {
  const validation = await validatePoForApproval(db, po.tenantId || 'default', po.items);
  if (validation.error) return { error: validation.error, status: 400 };

  const pushed = await pushPoToVendor(db, po, po.tenantId || 'default');
  if (pushed.submissions?.length) {
    const updated = await finalizePoSubmission(db, po, pushed.submissions, approverSnap);
    return { po: updated, vendorSynced: true };
  }

  const updated = await markPoApproved(db, po, approverSnap, pushed.error);
  return { po: updated, vendorSynced: false, vendorSyncError: pushed.error };
}

async function retryVendorSync(db: Db, po, approverSnap) {
  const pushed = await pushPoToVendor(db, po, po.tenantId || 'default');
  if (!pushed.submissions?.length) {
    const now = new Date();
    await db.collection('customer_purchase_orders').updateOne(
      { id: po.id },
      { $set: { vendorSyncError: pushed.error, vendorSyncAt: now, updatedAt: now } },
    );
    return { error: pushed.error, status: 502 };
  }
  const updated = await finalizePoSubmission(db, po, pushed.submissions, approverSnap || po.approvedBy);
  return { po: updated, vendorSynced: true };
}

const VENDOR_SYNC_RETRY_COOLDOWN_MS = 30_000;
const VENDOR_SYNC_BATCH_LIMIT = 20;

/** Coba kirim semua PO APPROVED yang menunggu — dipanggil otomatis saat halaman PO terbuka. */
async function syncPendingVendorOrders(db: Db, auth) {
  const cutoff = new Date(Date.now() - VENDOR_SYNC_RETRY_COOLDOWN_MS);
  let filter: Record<string, unknown> = {
    status: 'APPROVED',
    vendorSyncPending: { $ne: false },
    $or: [
      { vendorSyncAt: { $exists: false } },
      { vendorSyncAt: { $lt: cutoff } },
    ],
  };
  filter = withTenantFilter(auth, filter);

  const pending = await db.collection('customer_purchase_orders')
    .find(filter)
    .sort({ approvedAt: 1 })
    .limit(VENDOR_SYNC_BATCH_LIMIT)
    .toArray();

  const synced: JsonObject[] = [];
  const failed: JsonObject[] = [];

  for (const po of pending) {
    const result = await retryVendorSync(db, po, po.approvedBy);
    if (result.po) {
      synced.push({
        id: result.po.id,
        noPO: result.po.noPO,
        vendorNoSO: result.po.vendorNoSO,
      });
    } else {
      failed.push({ id: po.id, noPO: po.noPO, error: result.error });
      // Sales.app masih offline — hentikan batch agar tidak spam request
      if (result.error?.includes('tidak dapat dihubungi') || result.error?.includes('ECONNREFUSED')) {
        break;
      }
    }
  }

  return { attempted: pending.length, synced, failed };
}

async function finalizePoSubmission(db: Db, po, submissions, approver) {
  const primary = submissions[0] || {};
  const now = new Date();
  const patch: Record<string, unknown> = {
    status: 'SUBMITTED',
    vendorSubmissions: submissions,
    vendorTenantId: submissions.length === 1 ? primary.vendorTenantId : 'multi',
    vendorSoId: primary.vendorSoId,
    vendorNoSO: submissions.length === 1
      ? primary.vendorNoSO
      : submissions.map((s) => s.vendorNoSO).filter(Boolean).join(', '),
    submittedAt: now,
    updatedAt: now,
    vendorSyncPending: false,
    vendorSyncError: null,
  };
  if (approver) {
    patch.approvedBy = {
      userId: approver.userId,
      userName: approver.userName,
      role: approver.role,
    };
    patch.approvedAt = now;
  }
  const soSnaps = submissions.map((sub) => buildVendorSoSnapshot({
    ...sub.vendorSo,
    salesOrderId: sub.vendorSoId,
    noSO: sub.vendorNoSO,
  })).filter(Boolean);
  const soSnap = mergeVendorSoSnapshots(soSnaps);
  if (soSnap) patch.vendorSoSnapshot = soSnap;
  await db.collection('customer_purchase_orders').updateOne({ id: po.id }, { $set: patch });
  return db.collection('customer_purchase_orders').findOne({ id: po.id });
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
    let filter: Record<string, unknown> = status ? { status } : {};
    filter = withTenantFilter(scopeAuth, filter);
    const list = await db.collection('customer_purchase_orders')
      .find(filter)
      .sort({ tanggalKedatangan: -1, tanggal: -1 })
      .limit(300)
      .toArray();
    return ok(await enrichPoPeople(db, list));
  }

  // POST /customer-purchase-orders/sync-pending — antrian kirim otomatis ke sales.app
  if (route === '/customer-purchase-orders/sync-pending' && method === 'POST') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const result = await syncPendingVendorOrders(db, scopeAuth);
    return ok(result);
  }

  if (route === '/customer-purchase-orders' && method === 'POST') {
    const deniedRole = requireRole(auth, PO_CREATE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;
    if (!poBody.items?.length) return err('Minimal satu item');

    const tenantId = tenantIdForWrite(scopeAuth, poBody);
    const now = new Date();
    const noPO = poBody.noPO || await nextDocNumber(db, tenantId, 'CPO', 'CPO');
    const tanggalKedatangan = poBody.tanggalKedatangan
      ? new Date(poBody.tanggalKedatangan)
      : (poBody.tanggal ? new Date(poBody.tanggal) : now);

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

    return ok(await enrichOnePo(db, doc));
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
    return ok(await enrichOnePo(db, updated));
  }

  // POST /customer-purchase-orders/:id/request-approval — Supervisor ajukan ke Admin
  if (path[0] === 'customer-purchase-orders' && path[2] === 'request-approval' && method === 'POST') {
    const deniedRole = requireRole(auth, PO_REQUEST_APPROVAL_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (po.status !== 'DRAFT') return err('Hanya PO DRAFT yang bisa diajukan', 400);
    if (!po.items?.length) return err('PO kosong', 400);
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
    return ok(await enrichOnePo(db, updated));
  }

  // POST /customer-purchase-orders/:id/approve — Admin setujui (sync vendor opsional / ditunda)
  if (path[0] === 'customer-purchase-orders' && path[2] === 'approve' && method === 'POST') {
    const deniedRole = requireRole(auth, PO_APPROVE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (po.status !== 'PENDING_APPROVAL') return err('Status harus PENDING_APPROVAL', 400);

    const approverSnap = await actorSnapshot(db, auth);
    const result = await completePoWithVendorSync(db, po, approverSnap);
    if ('error' in result && result.error) return err(result.error, result.status || 400);

    const enriched = await enrichOnePo(db, result.po);
    return ok({ ...enriched, vendorSynced: result.vendorSynced, vendorSyncError: result.vendorSyncError });
  }

  // POST /customer-purchase-orders/:id/sync-vendor — kirim ulang PO APPROVED ke sales.app
  if (path[0] === 'customer-purchase-orders' && path[2] === 'sync-vendor' && method === 'POST') {
    const deniedRole = requireRole(auth, PO_APPROVE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (po.status !== 'APPROVED') return err('Hanya PO berstatus APPROVED yang menunggu kirim ke vendor', 400);

    const result = await retryVendorSync(db, po, await actorSnapshot(db, auth));
    if ('error' in result && result.error) return err(result.error, result.status || 502);

    const enriched = await enrichOnePo(db, result.po);
    return ok({ ...enriched, vendorSynced: true });
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
    return ok(await enrichOnePo(db, updated));
  }

  // POST /customer-purchase-orders/:id/submit — Admin kirim langsung (tanpa approval)
  if (path[0] === 'customer-purchase-orders' && path[2] === 'submit' && method === 'POST') {
    const deniedRole = requireRole(auth, PO_DIRECT_SUBMIT_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (po.status !== 'DRAFT') return err('PO sudah dikirim atau sedang menunggu approval', 400);

    const result = await completePoWithVendorSync(db, po, await actorSnapshot(db, auth));
    if ('error' in result && result.error) return err(result.error, result.status || 400);

    const enriched = await enrichOnePo(db, result.po);
    return ok({ ...enriched, vendorSynced: result.vendorSynced, vendorSyncError: result.vendorSyncError });
  }

  return null;
}
