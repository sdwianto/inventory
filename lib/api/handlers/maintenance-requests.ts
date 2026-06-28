import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  tenantIdForWrite,
  withTenantFilter,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { nextDocNumber } from '@/lib/api/document-sequence';
import {
  actorSnapshot,
  loadAssetForTenant,
  normalizePriority,
  syncAssetStatusFromOpenRequests,
} from '@/lib/api/maintenance-helpers';
import {
  MAINTENANCE_REQUESTS_COLLECTION,
  WR_APPROVE_ROLES,
  WR_CREATE_ROLES,
  WR_PROGRESS_ROLES,
  WR_SUBMIT_ROLES,
} from '@/lib/maintenance/constants';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { validateBase64Images } from '@/lib/api/image-base64';
import {
  assertWrResolvable,
  buildPoCatatanFromWr,
  buildReleaseKeperluanFromWr,
  loadWrById,
} from '@/lib/api/maintenance-resolve';
import { touchScheduleOnWrClosed } from '@/lib/api/maintenance-schedule-engine';
import type { HandlerContext } from '@/types/api/handler';
import type { MaintenanceRequestDoc } from '@/types/maintenance';

interface WrBody extends Record<string, unknown> {
  assetId?: string;
  priority?: string;
  judul?: string;
  deskripsi?: string;
  photos?: unknown[];
  reason?: string;
  catatanPenyelesaian?: string;
}

function canEditWr(auth: { role?: string; userId?: string; isMaster?: boolean }, wr: MaintenanceRequestDoc): boolean {
  const status = String(wr.status || '');
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(status)) return false;
  if (auth.isMaster || ['ADMIN', 'OWNER'].includes(auth.role || '')) return true;
  if (status === 'DRAFT') {
    return wr.createdBy?.userId === auth.userId || ['SUPERVISOR'].includes(auth.role || '');
  }
  return false;
}

async function enrichWrList(db: HandlerContext['db'], list: MaintenanceRequestDoc[]) {
  if (!list.length) return [];
  const assetIds = [...new Set(list.map((w) => w.assetId).filter(Boolean))];
  const assets = assetIds.length
    ? await db.collection('assets').find({ id: { $in: assetIds } }).toArray()
    : [];
  const assetMap = Object.fromEntries(assets.map((a) => [a.id, a]));
  return list.map((wr) => {
    const asset = wr.assetId ? assetMap[wr.assetId] : null;
    return clean({
      ...wr,
      assetKode: wr.assetKode || asset?.kode || '',
      assetNama: wr.assetNama || asset?.nama || '',
      assetStatus: asset?.status || null,
      assetLokasi: asset?.lokasi || '',
      photoCount: Array.isArray(wr.photos) ? wr.photos.length : 0,
      photos: undefined,
      resolutionType: wr.resolutionType || null,
      linkedPoId: wr.linkedPoId || null,
      linkedPoNo: wr.linkedPoNo || null,
      linkedReleaseId: wr.linkedReleaseId || null,
      linkedReleaseNo: wr.linkedReleaseNo || null,
      linkedServiceOrderId: wr.linkedServiceOrderId || null,
      linkedServiceOrderNo: wr.linkedServiceOrderNo || null,
      linkedGrnId: wr.linkedGrnId || null,
      linkedGrnNo: wr.linkedGrnNo || null,
      autoClosedBy: wr.autoClosedBy || null,
      sourceType: wr.sourceType || 'CORRECTIVE',
      scheduleId: wr.scheduleId || null,
      noSchedule: wr.noSchedule || null,
    });
  });
}

export async function handleMaintenanceRequests({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const wrBody = (body || {}) as WrBody;
  const scopeOpts = { url, body: wrBody, request };

  if (route === '/maintenance-requests/pending-count' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const filter = withTenantFilter(scopeAuth, { status: 'PENDING_APPROVAL' });
    const count = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).countDocuments(filter);
    return ok({ count });
  }

  if (route === '/maintenance-requests' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;

    const status = url.searchParams.get('status') || '';
    const assetId = url.searchParams.get('assetId') || '';
    let filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (assetId) filter.assetId = assetId;
    filter = withTenantFilter(scopeAuth, filter);

    const list = await db.collection(MAINTENANCE_REQUESTS_COLLECTION)
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(300)
      .toArray() as MaintenanceRequestDoc[];
    return ok(await enrichWrList(db, list));
  }

  if (route === '/maintenance-requests' && method === 'POST') {
    const deniedRole = requireRole(auth, [...WR_CREATE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    if (!wrBody.assetId) return err('Aset wajib dipilih');
    if (!wrBody.judul?.trim()) return err('Judul permintaan wajib diisi');

    const tenantId = tenantIdForWrite(scopeAuth, wrBody);
    const asset = await loadAssetForTenant(db, tenantId, wrBody.assetId);
    if (!asset) return err('Aset tidak ditemukan', 404);
    if (asset.status === 'DISPOSED') return err('Aset sudah dibuang — tidak bisa buat permintaan', 400);

    const photosChecked = validateBase64Images(wrBody.photos);
    if (!Array.isArray(photosChecked)) return err(photosChecked.error, 400);

    const now = new Date();
    const noWR = await nextDocNumber(db, tenantId, 'WR', 'WR');
    const creator = await actorSnapshot(db, scopeAuth);
    const doc: MaintenanceRequestDoc = {
      id: uuidv4(),
      tenantId,
      noWR,
      assetId: asset.id,
      assetKode: asset.kode,
      assetNama: asset.nama,
      priority: normalizePriority(wrBody.priority),
      judul: String(wrBody.judul).trim(),
      deskripsi: String(wrBody.deskripsi || '').trim(),
      photos: photosChecked,
      status: 'DRAFT',
      sourceType: 'CORRECTIVE',
      resolutionType: null,
      createdBy: creator,
      createdAt: now,
      updatedAt: now,
    };
    await db.collection(MAINTENANCE_REQUESTS_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'MAINTENANCE_WR_CREATED',
      entityType: 'maintenance_request',
      entityId: doc.id!,
      summary: `${noWR} — ${doc.judul}`,
      metadata: { assetId: asset.id, noWR },
      ...auditActor(scopeAuth),
    });
    return ok(clean(doc));
  }

  if (path[0] === 'maintenance-requests' && path[2] === 'resolve-prefill' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const wr = await loadWrById(db, scopeAuth, path[1]);
    if (!wr) return err('Permintaan tidak ditemukan', 404);
    return ok(clean({
      id: wr.id,
      noWR: wr.noWR,
      assetId: wr.assetId,
      assetKode: wr.assetKode,
      assetNama: wr.assetNama,
      judul: wr.judul,
      deskripsi: wr.deskripsi,
      status: wr.status,
      resolutionType: wr.resolutionType || null,
      linkedPoId: wr.linkedPoId || null,
      linkedPoNo: wr.linkedPoNo || null,
      linkedReleaseId: wr.linkedReleaseId || null,
      linkedReleaseNo: wr.linkedReleaseNo || null,
      linkedServiceOrderId: wr.linkedServiceOrderId || null,
      linkedServiceOrderNo: wr.linkedServiceOrderNo || null,
      linkedGrnId: wr.linkedGrnId || null,
      linkedGrnNo: wr.linkedGrnNo || null,
      poCatatan: buildPoCatatanFromWr(wr),
      releaseKeperluan: buildReleaseKeperluanFromWr(wr),
      canResolvePo: !assertWrResolvable(wr, 'PO') && !wr.linkedPoId,
      canResolveInternal: !assertWrResolvable(wr, 'INTERNAL') && !wr.linkedReleaseId,
      canResolveService: !assertWrResolvable(wr, 'SERVICE') && !wr.linkedServiceOrderId,
    }));
  }

  if (path[0] === 'maintenance-requests' && path.length === 2 && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const wr = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaintenanceRequestDoc | null;
    if (!wr) return err('Permintaan tidak ditemukan', 404);
    const [enriched] = await enrichWrList(db, [wr]);
    return ok(clean({ ...enriched, photos: wr.photos || [] }));
  }

  if (path[0] === 'maintenance-requests' && path.length === 2 && method === 'PUT') {
    const deniedRole = requireRole(auth, [...WR_CREATE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const wr = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaintenanceRequestDoc | null;
    if (!wr) return err('Permintaan tidak ditemukan', 404);
    if (!canEditWr(scopeAuth, wr)) return err('Permintaan tidak bisa diedit pada status ini', 403);

    const tenantId = String(wr.tenantId || 'default');
    const patch: Record<string, unknown> = { updatedAt: new Date() };

    if (wrBody.assetId && wrBody.assetId !== wr.assetId) {
      const asset = await loadAssetForTenant(db, tenantId, wrBody.assetId);
      if (!asset) return err('Aset tidak ditemukan', 404);
      patch.assetId = asset.id;
      patch.assetKode = asset.kode;
      patch.assetNama = asset.nama;
    }
    if (wrBody.priority !== undefined) patch.priority = normalizePriority(wrBody.priority);
    if (wrBody.judul !== undefined) {
      if (!String(wrBody.judul).trim()) return err('Judul permintaan wajib diisi');
      patch.judul = String(wrBody.judul).trim();
    }
    if (wrBody.deskripsi !== undefined) patch.deskripsi = String(wrBody.deskripsi || '').trim();
    if (wrBody.photos !== undefined) {
      const photosChecked = validateBase64Images(wrBody.photos);
      if (!Array.isArray(photosChecked)) return err(photosChecked.error, 400);
      patch.photos = photosChecked;
    }

    await db.collection(MAINTENANCE_REQUESTS_COLLECTION).updateOne({ id: wr.id }, { $set: patch });
    const updated = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne({ id: wr.id });
    return ok(clean(updated));
  }

  if (path[0] === 'maintenance-requests' && path[2] === 'request-approval' && method === 'POST') {
    const deniedRole = requireRole(auth, [...WR_SUBMIT_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const wr = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaintenanceRequestDoc | null;
    if (!wr) return err('Permintaan tidak ditemukan', 404);
    if (wr.status !== 'DRAFT') return err('Hanya draft yang bisa diajukan', 400);
    if (
      ['GUDANG', 'SUPERVISOR'].includes(scopeAuth.role || '')
      && wr.createdBy?.userId !== scopeAuth.userId
      && !scopeAuth.isMaster
    ) {
      return err('Hanya pembuat permintaan yang bisa mengajukan', 403);
    }

    const now = new Date();
    const submitter = await actorSnapshot(db, scopeAuth);
    await db.collection(MAINTENANCE_REQUESTS_COLLECTION).updateOne(
      { id: wr.id },
      {
        $set: {
          status: 'PENDING_APPROVAL',
          requestedBy: submitter,
          requestedAt: now,
          updatedAt: now,
        },
      },
    );
    const updated = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne({ id: wr.id });
    return ok(clean(updated));
  }

  if (path[0] === 'maintenance-requests' && path[2] === 'approve' && method === 'POST') {
    const deniedRole = requireRole(auth, [...WR_APPROVE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const wr = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaintenanceRequestDoc | null;
    if (!wr) return err('Permintaan tidak ditemukan', 404);
    if (wr.status !== 'PENDING_APPROVAL') return err('Status harus PENDING_APPROVAL', 400);

    const now = new Date();
    const approver = await actorSnapshot(db, auth);
    const tenantId = String(wr.tenantId || 'default');
    await db.collection(MAINTENANCE_REQUESTS_COLLECTION).updateOne(
      { id: wr.id },
      {
        $set: {
          status: 'APPROVED',
          approvedBy: approver,
          approvedAt: now,
          updatedAt: now,
        },
      },
    );
    await syncAssetStatusFromOpenRequests(db, tenantId, String(wr.assetId));
    await writeAuditLog(db, {
      tenantId,
      action: 'MAINTENANCE_WR_APPROVED',
      entityType: 'maintenance_request',
      entityId: wr.id!,
      summary: `${wr.noWR} disetujui`,
      ...auditActor(auth),
    });
    const updated = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne({ id: wr.id });
    return ok(clean(updated));
  }

  if (path[0] === 'maintenance-requests' && path[2] === 'reject' && method === 'POST') {
    const deniedRole = requireRole(auth, [...WR_APPROVE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const wr = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaintenanceRequestDoc | null;
    if (!wr) return err('Permintaan tidak ditemukan', 404);
    if (wr.status !== 'PENDING_APPROVAL') return err('Status harus PENDING_APPROVAL', 400);

    const now = new Date();
    const rejector = await actorSnapshot(db, auth);
    const tenantId = String(wr.tenantId || 'default');
    await db.collection(MAINTENANCE_REQUESTS_COLLECTION).updateOne(
      { id: wr.id },
      {
        $set: {
          status: 'REJECTED',
          rejectedBy: rejector,
          rejectedAt: now,
          rejectReason: wrBody.reason || 'Ditolak',
          updatedAt: now,
        },
      },
    );
    await syncAssetStatusFromOpenRequests(db, tenantId, String(wr.assetId));
    const updated = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne({ id: wr.id });
    return ok(clean(updated));
  }

  if (path[0] === 'maintenance-requests' && path[2] === 'start' && method === 'POST') {
    const deniedRole = requireRole(auth, [...WR_PROGRESS_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const wr = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaintenanceRequestDoc | null;
    if (!wr) return err('Permintaan tidak ditemukan', 404);
    if (wr.status !== 'APPROVED') return err('Status harus APPROVED', 400);

    const now = new Date();
    const tenantId = String(wr.tenantId || 'default');
    await db.collection(MAINTENANCE_REQUESTS_COLLECTION).updateOne(
      { id: wr.id },
      { $set: { status: 'IN_PROGRESS', startedAt: now, updatedAt: now } },
    );
    await syncAssetStatusFromOpenRequests(db, tenantId, String(wr.assetId));
    const updated = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne({ id: wr.id });
    return ok(clean(updated));
  }

  if (path[0] === 'maintenance-requests' && path[2] === 'complete' && method === 'POST') {
    const deniedRole = requireRole(auth, [...WR_PROGRESS_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const wr = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaintenanceRequestDoc | null;
    if (!wr) return err('Permintaan tidak ditemukan', 404);
    if (!['APPROVED', 'IN_PROGRESS'].includes(String(wr.status))) {
      return err('Status harus APPROVED atau IN_PROGRESS', 400);
    }

    const now = new Date();
    await db.collection(MAINTENANCE_REQUESTS_COLLECTION).updateOne(
      { id: wr.id },
      {
        $set: {
          status: 'COMPLETED',
          completedAt: now,
          catatanPenyelesaian: wrBody.catatanPenyelesaian || wr.catatanPenyelesaian || '',
          updatedAt: now,
        },
      },
    );
    const updated = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne({ id: wr.id });
    return ok(clean(updated));
  }

  if (path[0] === 'maintenance-requests' && path[2] === 'close' && method === 'POST') {
    const deniedRole = requireRole(auth, [...WR_APPROVE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const wr = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaintenanceRequestDoc | null;
    if (!wr) return err('Permintaan tidak ditemukan', 404);
    if (wr.status !== 'COMPLETED') return err('Status harus COMPLETED', 400);

    const now = new Date();
    const tenantId = String(wr.tenantId || 'default');
    await db.collection(MAINTENANCE_REQUESTS_COLLECTION).updateOne(
      { id: wr.id },
      { $set: { status: 'CLOSED', closedAt: now, updatedAt: now } },
    );
    await syncAssetStatusFromOpenRequests(db, tenantId, String(wr.assetId));
    await touchScheduleOnWrClosed(db, { ...wr, tenantId, closedAt: now });
    await writeAuditLog(db, {
      tenantId,
      action: 'MAINTENANCE_WR_CLOSED',
      entityType: 'maintenance_request',
      entityId: wr.id!,
      summary: `${wr.noWR} ditutup`,
      ...auditActor(auth),
    });
    const updated = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne({ id: wr.id });
    return ok(clean(updated));
  }

  if (path[0] === 'maintenance-requests' && path[2] === 'cancel' && method === 'POST') {
    const deniedRole = requireRole(auth, [...WR_CREATE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const wr = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaintenanceRequestDoc | null;
    if (!wr) return err('Permintaan tidak ditemukan', 404);
    if (!['DRAFT', 'PENDING_APPROVAL'].includes(String(wr.status))) {
      return err('Hanya draft atau pending yang bisa dibatalkan', 400);
    }
    if (
      wr.createdBy?.userId !== scopeAuth?.userId
      && !['ADMIN', 'OWNER', 'MASTER'].includes(scopeAuth?.role || '')
      && !scopeAuth?.isMaster
    ) {
      return err('Tidak diizinkan membatalkan permintaan ini', 403);
    }

    const tenantId = String(wr.tenantId || 'default');
    await db.collection(MAINTENANCE_REQUESTS_COLLECTION).updateOne(
      { id: wr.id },
      { $set: { status: 'CANCELLED', updatedAt: new Date() } },
    );
    await syncAssetStatusFromOpenRequests(db, tenantId, String(wr.assetId));
    const updated = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne({ id: wr.id });
    return ok(clean(updated));
  }

  return null;
}
