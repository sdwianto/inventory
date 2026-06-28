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
import { stampTenantId } from '@/lib/api/tenant-operational';
import { actorSnapshot } from '@/lib/api/maintenance-helpers';
import {
  applyWrResolutionLink,
  assertWrResolvable,
  loadWrById,
} from '@/lib/api/maintenance-resolve';
import { tryAutoCompleteWrFromServiceOrder } from '@/lib/api/maintenance-wr-loop';
import { WR_PROGRESS_ROLES } from '@/lib/maintenance/constants';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import type { HandlerContext } from '@/types/api/handler';
import type { MaintenanceServiceOrderDoc } from '@/types/maintenance';

export const SERVICE_ORDERS_COLLECTION = 'maintenance_service_orders';

interface ServiceOrderBody extends Record<string, unknown> {
  maintenanceRequestId?: string;
  vendorName?: string;
  vendorContact?: string;
  scope?: string;
  estimasiBiaya?: number | string;
  actualBiaya?: number | string;
  note?: string;
}

export async function handleMaintenanceServiceOrders({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const soBody = (body || {}) as ServiceOrderBody;
  const scopeOpts = { url, body: soBody, request };

  if (route === '/maintenance-service-orders' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const wrId = url.searchParams.get('maintenanceRequestId') || '';
    const filter = withTenantFilter(scopeAuth, wrId ? { maintenanceRequestId: wrId } : {});
    const list = await db.collection(SERVICE_ORDERS_COLLECTION)
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    return ok(list.map(clean));
  }

  if (route === '/maintenance-service-orders' && method === 'POST') {
    const deniedRole = requireRole(auth, [...WR_PROGRESS_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    if (!soBody.maintenanceRequestId) return err('maintenanceRequestId wajib');
    if (!soBody.vendorName?.trim()) return err('Nama vendor/jasa wajib diisi');
    if (!soBody.scope?.trim()) return err('Scope pekerjaan wajib diisi');

    const wr = await loadWrById(db, scopeAuth, soBody.maintenanceRequestId);
    const block = assertWrResolvable(wr, 'SERVICE');
    if (block) return err(block, 400);
    if (wr!.linkedServiceOrderId) return err('Service order sudah dibuat untuk permintaan ini', 400);

    const tenantId = tenantIdForWrite(scopeAuth, soBody);
    const now = new Date();
    const noMSO = await nextDocNumber(db, tenantId, 'MSO', 'MSO');
    const estimasiBiaya = parseInt(String(soBody.estimasiBiaya || 0), 10);

    const doc: MaintenanceServiceOrderDoc = stampTenantId(tenantId, {
      id: uuidv4(),
      noMSO,
      maintenanceRequestId: wr!.id,
      noWR: wr!.noWR,
      assetId: wr!.assetId,
      assetKode: wr!.assetKode,
      assetNama: wr!.assetNama,
      vendorName: String(soBody.vendorName).trim(),
      vendorContact: String(soBody.vendorContact || '').trim(),
      scope: String(soBody.scope).trim(),
      estimasiBiaya,
      actualBiaya: null,
      status: 'OPEN',
      hutangId: null,
      createdBy: await actorSnapshot(db, scopeAuth),
      createdAt: now,
      updatedAt: now,
    });

    await db.collection(SERVICE_ORDERS_COLLECTION).insertOne(doc);
    await applyWrResolutionLink(db, wr!, {
      resolutionType: 'SERVICE',
      linkedServiceOrderId: doc.id,
      linkedServiceOrderNo: noMSO,
    });
    await writeAuditLog(db, {
      tenantId,
      action: 'MAINTENANCE_SERVICE_CREATED',
      entityType: 'maintenance_service_order',
      entityId: doc.id!,
      summary: `${noMSO} — ${doc.vendorName}`,
      metadata: { maintenanceRequestId: wr!.id, noWR: wr!.noWR },
      ...auditActor(scopeAuth),
    });
    return ok(clean(doc));
  }

  if (path[0] === 'maintenance-service-orders' && path.length === 2 && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const doc = await db.collection(SERVICE_ORDERS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!doc) return err('Service order tidak ditemukan', 404);
    return ok(clean(doc));
  }

  if (path[0] === 'maintenance-service-orders' && path[2] === 'complete' && method === 'POST') {
    const deniedRole = requireRole(auth, [...WR_PROGRESS_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const so = await db.collection(SERVICE_ORDERS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaintenanceServiceOrderDoc | null;
    if (!so) return err('Service order tidak ditemukan', 404);
    if (so.status !== 'OPEN') return err('Service order sudah selesai/dibatalkan', 400);

    const actualBiaya = parseInt(String(soBody.actualBiaya ?? so.estimasiBiaya ?? 0), 10);
    if (actualBiaya <= 0) return err('Biaya aktual wajib > 0', 400);

    const tenantId = String(so.tenantId || 'default');
    const now = new Date();
    const noHutang = await nextDocNumber(db, tenantId, 'HMS', 'HMS');
    const hutangId = uuidv4();

    const hutangDoc = stampTenantId(tenantId, {
      id: hutangId,
      noHutang,
      referenceType: 'MAINTENANCE_SERVICE',
      maintenanceRequestId: so.maintenanceRequestId,
      maintenanceServiceOrderId: so.id,
      noWR: so.noWR,
      supplierName: so.vendorName,
      keterangan: `${so.noMSO} — ${so.scope}`,
      total: actualBiaya,
      terbayar: 0,
      sisa: actualBiaya,
      approvalStatus: 'PENDING_REVIEW',
      status: 'PENDING_REVIEW',
      tanggal: now,
      jatuhTempo: now,
      createdAt: now,
      updatedAt: now,
    });

    await db.collection('hutang').insertOne(hutangDoc);
    await db.collection(SERVICE_ORDERS_COLLECTION).updateOne(
      { id: so.id },
      {
        $set: {
          status: 'COMPLETED',
          actualBiaya,
          hutangId,
          completedAt: now,
          completedNote: soBody.note || '',
          updatedAt: now,
        },
      },
    );

    await writeAuditLog(db, {
      tenantId,
      action: 'HUTANG_CREATED',
      entityType: 'hutang',
      entityId: hutangId,
      summary: `Hutang jasa maintenance ${noHutang}`,
      metadata: { referenceType: 'MAINTENANCE_SERVICE', noMSO: so.noMSO },
      ...auditActor(auth),
    });

    const updated = await db.collection(SERVICE_ORDERS_COLLECTION).findOne({ id: so.id });
    const wrLoop = await tryAutoCompleteWrFromServiceOrder(db, updated || so);
    return ok(clean({ ...updated, hutangNo: noHutang, wrLoop }));
  }

  return null;
}
