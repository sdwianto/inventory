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
import { tenantIdForWrite, withTenantFilter } from '@/lib/api/tenant-master';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { enrichPoItemsForVendor, groupPoItemsByVendorTenant } from '@/lib/api/customer-po-vendor';
import { computeLineEstimasi, sumPoEstimasi } from '@/lib/api/po-estimasi';
import { buildVendorSoSnapshot } from '@/lib/api/vendor-so-snapshot';

/** Snapshot pengguna untuk audit — selalu isi userName (lookup DB jika session kosong). */
async function actorSnapshot(db, auth) {
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
async function enrichPoPeople(db, list) {
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
  const persistPatches = [];

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

async function enrichOnePo(db, po) {
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

async function pushPoGroupToVendor(db, { tenantId, config, po, vendorTenantId, items }) {
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

async function pushPoToVendor(db, po, tenantId) {
  const config = await getIntegrationConfig(db, tenantId);
  const apiKey = config.salesApiKey;
  if (!apiKey) {
    return { error: 'Belum terhubung ke sales.app — jalankan pairing dari menu Integrasi atau sales.app /integrasi' };
  }

  const enriched = await enrichPoItemsForVendor(db, tenantId, po.items);
  if (enriched.error) return { error: enriched.error };

  const grouped = groupPoItemsByVendorTenant(enriched.items);
  if (grouped.error) return { error: grouped.error };

  const submissions = [];
  try {
    for (const { vendorTenantId, items } of grouped.groups) {
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

async function mapPoItems(db, tenantId, items) {
  return Promise.all((items || []).map(async (it) => {
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
}

function canEditPo(auth, po) {
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(po.status)) return false;
  if (auth.isMaster || auth.role === 'ADMIN') return true;
  if (po.status === 'DRAFT' && ['SUPERVISOR', 'GUDANG'].includes(auth.role)) {
    return po.createdBy?.userId === auth.userId;
  }
  return false;
}

async function validatePoForApproval(db, tenantId, items) {
  if (!items?.length) return { error: 'PO kosong' };
  for (const it of items) {
    const qty = parseFloat(it.qty);
    if (!qty || qty <= 0) {
      return { error: `Qty harus lebih dari 0 untuk "${it.nama || it.kode || 'item'}"` };
    }
  }
  return enrichPoItemsForVendor(db, tenantId, items);
}

async function markPoApproved(db, po, approverSnap, syncError) {
  const now = new Date();
  const patch = {
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
async function completePoWithVendorSync(db, po, approverSnap) {
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

async function retryVendorSync(db, po, approverSnap) {
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
async function syncPendingVendorOrders(db, auth) {
  const cutoff = new Date(Date.now() - VENDOR_SYNC_RETRY_COOLDOWN_MS);
  let filter = {
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

  const synced = [];
  const failed = [];

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

async function finalizePoSubmission(db, po, submissions, approver) {
  const primary = submissions[0] || {};
  const now = new Date();
  const patch = {
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
  const soSnap = buildVendorSoSnapshot({
    ...primary.vendorSo,
    salesOrderId: primary.vendorSoId,
    noSO: primary.vendorNoSO,
  });
  if (soSnap) patch.vendorSoSnapshot = soSnap;
  await db.collection('customer_purchase_orders').updateOne({ id: po.id }, { $set: patch });
  return db.collection('customer_purchase_orders').findOne({ id: po.id });
}

export async function handleCustomerPo({ db, route, method, path, body, url, auth }) {
  if (route === '/customer-purchase-orders' && method === 'GET') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const status = url.searchParams.get('status');
    let filter = status ? { status } : {};
    filter = withTenantFilter(auth, filter);
    const list = await db.collection('customer_purchase_orders')
      .find(filter)
      .sort({ tanggalKedatangan: -1, tanggal: -1 })
      .limit(300)
      .toArray();
    return ok(await enrichPoPeople(db, list));
  }

  // POST /customer-purchase-orders/sync-pending — antrian kirim otomatis ke sales.app
  if (route === '/customer-purchase-orders/sync-pending' && method === 'POST') {
    const denied = requireAuth(auth);
    if (denied) return denied;

    const result = await syncPendingVendorOrders(db, auth);
    return ok(result);
  }

  if (route === '/customer-purchase-orders' && method === 'POST') {
    const denied = requireRole(auth, PO_CREATE_ROLES);
    if (denied) return denied;
    if (!body?.items?.length) return err('Minimal satu item');

    const tenantId = tenantIdForWrite(auth, body);
    const now = new Date();
    const noPO = body.noPO || await nextDocNumber(db, tenantId, 'CPO', 'CPO');
    const tanggalKedatangan = body.tanggalKedatangan
      ? new Date(body.tanggalKedatangan)
      : (body.tanggal ? new Date(body.tanggal) : now);

    const poItems = await mapPoItems(db, tenantId, body.items);
    const doc = {
      id: uuidv4(),
      tenantId,
      noPO,
      tanggal: now,
      tanggalKedatangan,
      status: 'DRAFT',
      items: poItems,
      estimasiTotal: sumPoEstimasi(poItems),
      catatan: body.catatan || '',
      paymentTerms: body.paymentTerms || 'KREDIT',
      createdBy: await actorSnapshot(db, auth),
      createdAt: now,
      updatedAt: now,
    };
    await db.collection('customer_purchase_orders').insertOne(doc);
    return ok(await enrichOnePo(db, doc));
  }

  // PUT /customer-purchase-orders/:id — edit PO (DRAFT / PENDING_APPROVAL)
  if (path[0] === 'customer-purchase-orders' && path.length === 2 && method === 'PUT') {
    const denied = requireRole(auth, PO_EDIT_ROLES);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(auth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (!canEditPo(auth, po)) {
      return err('PO tidak bisa diedit pada status ini atau role tidak diizinkan', 403);
    }
    if (!body?.items?.length) return err('Minimal satu item');

    const tenantId = po.tenantId || 'default';
    const now = new Date();
    const tanggalKedatangan = body.tanggalKedatangan
      ? new Date(body.tanggalKedatangan)
      : po.tanggalKedatangan;

    const editor = await actorSnapshot(db, auth);
    const poItems = await mapPoItems(db, tenantId, body.items);
    const patch = {
      items: poItems,
      estimasiTotal: sumPoEstimasi(poItems),
      catatan: body.catatan ?? po.catatan ?? '',
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
    const denied = requireRole(auth, PO_REQUEST_APPROVAL_ROLES);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(auth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (po.status !== 'DRAFT') return err('Hanya PO DRAFT yang bisa diajukan', 400);
    if (!po.items?.length) return err('PO kosong', 400);
    if (
      ['SUPERVISOR', 'GUDANG'].includes(auth.role)
      && po.createdBy?.userId !== auth.userId
      && !auth.isMaster
    ) {
      return err('Hanya pembuat PO yang bisa mengajukan', 403);
    }

    const now = new Date();
    const submitter = await actorSnapshot(db, auth);
    const approvalPatch = {
      status: 'PENDING_APPROVAL',
      requestedAt: now,
      updatedAt: now,
      requestedBy: submitter,
    };
    if (!po.createdBy?.userId) {
      approvalPatch.createdBy = submitter;
    } else if (!po.createdBy?.userName) {
      approvalPatch.createdBy = await actorSnapshot(db, {
        userId: po.createdBy.userId,
        name: po.createdBy.userName,
        email: po.createdBy.email,
        role: po.createdBy.role,
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
    const denied = requireRole(auth, PO_APPROVE_ROLES);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(auth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (po.status !== 'PENDING_APPROVAL') return err('Status harus PENDING_APPROVAL', 400);

    const approverSnap = await actorSnapshot(db, auth);
    const result = await completePoWithVendorSync(db, po, approverSnap);
    if (result.error) return err(result.error, result.status || 400);

    const enriched = await enrichOnePo(db, result.po);
    return ok({ ...enriched, vendorSynced: result.vendorSynced, vendorSyncError: result.vendorSyncError });
  }

  // POST /customer-purchase-orders/:id/sync-vendor — kirim ulang PO APPROVED ke sales.app
  if (path[0] === 'customer-purchase-orders' && path[2] === 'sync-vendor' && method === 'POST') {
    const denied = requireRole(auth, PO_APPROVE_ROLES);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(auth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (po.status !== 'APPROVED') return err('Hanya PO berstatus APPROVED yang menunggu kirim ke vendor', 400);

    const result = await retryVendorSync(db, po, await actorSnapshot(db, auth));
    if (result.error) return err(result.error, result.status || 502);

    const enriched = await enrichOnePo(db, result.po);
    return ok({ ...enriched, vendorSynced: true });
  }

  // POST /customer-purchase-orders/:id/reject — Admin tolak pengajuan
  if (path[0] === 'customer-purchase-orders' && path[2] === 'reject' && method === 'POST') {
    const denied = requireRole(auth, PO_APPROVE_ROLES);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(auth, { id: path[1] }));
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
          rejectReason: body?.reason || 'Ditolak admin',
          updatedAt: now,
        },
      },
    );
    const updated = await db.collection('customer_purchase_orders').findOne({ id: po.id });
    return ok(await enrichOnePo(db, updated));
  }

  // POST /customer-purchase-orders/:id/submit — Admin kirim langsung (tanpa approval)
  if (path[0] === 'customer-purchase-orders' && path[2] === 'submit' && method === 'POST') {
    const denied = requireRole(auth, PO_DIRECT_SUBMIT_ROLES);
    if (denied) return denied;

    const po = await db.collection('customer_purchase_orders').findOne(withTenantFilter(auth, { id: path[1] }));
    if (!po) return err('PO tidak ditemukan', 404);
    if (po.status !== 'DRAFT') return err('PO sudah dikirim atau sedang menunggu approval', 400);

    const result = await completePoWithVendorSync(db, po, await actorSnapshot(db, auth));
    if (result.error) return err(result.error, result.status || 400);

    const enriched = await enrichOnePo(db, result.po);
    return ok({ ...enriched, vendorSynced: result.vendorSynced, vendorSyncError: result.vendorSyncError });
  }

  return null;
}
