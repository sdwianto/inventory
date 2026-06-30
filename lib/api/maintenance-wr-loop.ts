import type { Db } from 'mongodb';
import type { MaintenanceRequestDoc, MaintenanceResolutionType } from '@/types/maintenance';
import { MAINTENANCE_REQUESTS_COLLECTION } from '@/lib/maintenance/constants';
import { syncAssetStatusFromOpenRequests } from '@/lib/api/maintenance-helpers';
import { touchScheduleOnWrClosed } from '@/lib/api/maintenance-schedule-engine';
import { writeAuditLog } from '@/lib/api/audit-log';

const FULFILLABLE_STATUSES = new Set(['APPROVED', 'IN_PROGRESS']);

export type WrFulfillmentTrigger =
  | { kind: 'GRN'; grnId: string; noGRN: string; noPO?: string | null }
  | { kind: 'RELEASE'; releaseId: string; noRelease: string }
  | { kind: 'SERVICE'; serviceOrderId: string; noMSO: string };

const RESOLUTION_FOR_KIND: Record<WrFulfillmentTrigger['kind'], MaintenanceResolutionType> = {
  GRN: 'PO',
  RELEASE: 'INTERNAL',
  SERVICE: 'SERVICE',
};

export type WrLoopResult = { action: 'closed' | 'skipped'; reason?: string; wrId?: string };

function fulfillmentNote(trigger: WrFulfillmentTrigger): string {
  if (trigger.kind === 'GRN') {
    return `Otomatis: GRN ${trigger.noGRN} diposting${trigger.noPO ? ` (PO ${trigger.noPO})` : ''}`;
  }
  if (trigger.kind === 'RELEASE') {
    return `Otomatis: Release ${trigger.noRelease} disetujui`;
  }
  return `Otomatis: Service order ${trigger.noMSO} selesai`;
}

/** Tutup WR otomatis setelah dokumen penyelesaian diposting / selesai. */
export async function tryAutoCompleteMaintenanceWr(
  db: Db,
  tenantId: string,
  wrId: string,
  trigger: WrFulfillmentTrigger,
): Promise<WrLoopResult> {
  const wr = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne({
    tenantId,
    id: wrId,
  }) as MaintenanceRequestDoc | null;

  if (!wr) return { action: 'skipped', reason: 'wr_not_found' };
  const status = String(wr.status || '');
  if (['COMPLETED', 'CLOSED'].includes(status)) {
    return { action: 'skipped', reason: 'already_done', wrId };
  }
  if (!FULFILLABLE_STATUSES.has(status)) {
    return { action: 'skipped', reason: 'wrong_status', wrId };
  }

  const expectedResolution = RESOLUTION_FOR_KIND[trigger.kind];
  if (wr.resolutionType && wr.resolutionType !== expectedResolution) {
    return { action: 'skipped', reason: 'resolution_mismatch', wrId };
  }

  const now = new Date();
  const note = fulfillmentNote(trigger);
  const patch: Record<string, unknown> = {
    status: 'CLOSED',
    completedAt: wr.completedAt || now,
    closedAt: now,
    catatanPenyelesaian: wr.catatanPenyelesaian || note,
    autoClosedAt: now,
    autoClosedBy: trigger.kind,
    updatedAt: now,
  };

  if (trigger.kind === 'GRN') {
    patch.linkedGrnId = trigger.grnId;
    patch.linkedGrnNo = trigger.noGRN;
  }

  await db.collection(MAINTENANCE_REQUESTS_COLLECTION).updateOne(
    { id: wr.id },
    { $set: patch },
  );

  if (wr.assetId) {
    await syncAssetStatusFromOpenRequests(db, tenantId, String(wr.assetId));
  }

  if (wr.scheduleId) {
    await touchScheduleOnWrClosed(db, { ...wr, tenantId, closedAt: now });
  }

  await writeAuditLog(db, {
    tenantId,
    action: 'MAINTENANCE_WR_CLOSED',
    entityType: 'maintenance_request',
    entityId: wr.id!,
    summary: `${wr.noWR} ditutup otomatis (${trigger.kind})`,
    userName: 'System',
    metadata: { trigger, auto: true },
  });

  return { action: 'closed', wrId };
}

export async function tryAutoCompleteWrFromGrn(
  db: Db,
  grn: {
    id?: string;
    tenantId?: string;
    noGRN?: string;
    noPO?: string | null;
    customerPoId?: string | null;
  },
): Promise<WrLoopResult> {
  const tenantId = String(grn.tenantId || 'default');
  let po: { maintenanceRequestId?: string; noPO?: string } | null = null;

  if (grn.customerPoId) {
    po = (await db.collection('customer_purchase_orders').findOne(
      { tenantId, id: grn.customerPoId },
      { projection: { maintenanceRequestId: 1, noPO: 1 } },
    )) as { maintenanceRequestId?: string; noPO?: string } | null;
  }
  if (!po?.maintenanceRequestId && grn.noPO) {
    po = (await db.collection('customer_purchase_orders').findOne(
      { tenantId, noPO: grn.noPO },
      { projection: { maintenanceRequestId: 1, noPO: 1 } },
    )) as { maintenanceRequestId?: string; noPO?: string } | null;
  }
  if (!po?.maintenanceRequestId) {
    return { action: 'skipped', reason: 'not_maintenance_po' };
  }

  const wrId = String(po.maintenanceRequestId);
  const result = await tryAutoCompleteMaintenanceWr(db, tenantId, wrId, {
    kind: 'GRN',
    grnId: String(grn.id),
    noGRN: String(grn.noGRN || grn.id),
    noPO: grn.noPO || po.noPO || null,
  });
  return { ...result, wrId };
}

export async function tryAutoCompleteWrFromRelease(
  db: Db,
  release: {
    tenantId?: string;
    id?: string;
    noRelease?: string;
    maintenanceRequestId?: string | null;
  },
): Promise<WrLoopResult> {
  if (!release.maintenanceRequestId) return { action: 'skipped', reason: 'no_wr_link' };
  const tenantId = String(release.tenantId || 'default');
  return tryAutoCompleteMaintenanceWr(db, tenantId, String(release.maintenanceRequestId), {
    kind: 'RELEASE',
    releaseId: String(release.id),
    noRelease: String(release.noRelease || release.id),
  });
}

export async function tryAutoCompleteWrFromServiceOrder(
  db: Db,
  so: {
    tenantId?: string;
    id?: string;
    noMSO?: string;
    maintenanceRequestId?: string;
  },
): Promise<WrLoopResult> {
  if (!so.maintenanceRequestId) return { action: 'skipped', reason: 'no_wr_link' };
  const tenantId = String(so.tenantId || 'default');
  return tryAutoCompleteMaintenanceWr(db, tenantId, String(so.maintenanceRequestId), {
    kind: 'SERVICE',
    serviceOrderId: String(so.id),
    noMSO: String(so.noMSO || so.id),
  });
}
