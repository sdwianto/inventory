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
} from '@/lib/api/maintenance-helpers';
import {
  MAINTENANCE_SCHEDULES_COLLECTION,
  PM_MANAGE_ROLES,
} from '@/lib/maintenance/constants';
import {
  addInterval,
  countScheduleDueStats,
  formatIntervalLabel,
  isScheduleDue,
  isScheduleDueSoon,
  processDueMaintenanceSchedules,
  startOfDay,
} from '@/lib/api/maintenance-schedule-engine';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import type { HandlerContext } from '@/types/api/handler';
import type { MaintenanceIntervalUnit, MaintenanceScheduleDoc } from '@/types/maintenance';

interface ScheduleBody extends Record<string, unknown> {
  assetId?: string;
  judul?: string;
  deskripsi?: string;
  checklist?: string;
  priority?: string;
  intervalUnit?: string;
  intervalValue?: number | string;
  leadDays?: number | string;
  nextDueDate?: string;
  status?: string;
}

const VALID_UNITS = new Set<string>(['DAYS', 'WEEKS', 'MONTHS']);
const VALID_STATUS = new Set<string>(['ACTIVE', 'PAUSED', 'ARCHIVED']);

function normalizeUnit(value: unknown): MaintenanceIntervalUnit {
  const u = String(value || 'MONTHS').toUpperCase();
  return VALID_UNITS.has(u) ? (u as MaintenanceIntervalUnit) : 'MONTHS';
}

function enrichScheduleRow(row: MaintenanceScheduleDoc, today: Date) {
  const unit = normalizeUnit(row.intervalUnit);
  const value = Math.max(1, parseInt(String(row.intervalValue || 1), 10));
  const due = isScheduleDue(row.nextDueDate, today);
  const dueSoon = !due && isScheduleDueSoon(row.nextDueDate, row.leadDays || 0, today);
  return clean({
    ...row,
    intervalLabel: formatIntervalLabel(unit, value),
    isOverdue: due && row.status === 'ACTIVE',
    isDueSoon: dueSoon && row.status === 'ACTIVE',
  });
}

export async function handleMaintenanceSchedules({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const schedBody = (body || {}) as ScheduleBody;
  const scopeOpts = { url, body: schedBody, request };
  const today = startOfDay(new Date());

  if (route === '/maintenance-schedules/due-count' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const stats = await countScheduleDueStats(db, withTenantFilter(scopeAuth, {}), today);
    return ok(stats);
  }

  if (route === '/maintenance-schedules/run-due' && method === 'POST') {
    const deniedRole = requireRole(auth, [...PM_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;
    const tenantId = tenantIdForWrite(scopeAuth, schedBody);
    const result = await processDueMaintenanceSchedules(db, tenantId);
    return ok(result);
  }

  if (route === '/maintenance-schedules' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;

    const status = url.searchParams.get('status') || '';
    const assetId = url.searchParams.get('assetId') || '';
    let filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (assetId) filter.assetId = assetId;
    filter = withTenantFilter(scopeAuth, filter);

    const list = await db.collection(MAINTENANCE_SCHEDULES_COLLECTION)
      .find(filter)
      .sort({ nextDueDate: 1, judul: 1 })
      .limit(300)
      .toArray() as MaintenanceScheduleDoc[];

    return ok(list.map((row) => enrichScheduleRow(row, today)));
  }

  if (route === '/maintenance-schedules' && method === 'POST') {
    const deniedRole = requireRole(auth, [...PM_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    if (!schedBody.assetId) return err('Aset wajib dipilih');
    if (!schedBody.judul?.trim()) return err('Judul jadwal wajib diisi');

    const tenantId = tenantIdForWrite(scopeAuth, schedBody);
    const asset = await loadAssetForTenant(db, tenantId, schedBody.assetId);
    if (!asset) return err('Aset tidak ditemukan', 404);
    if (asset.status === 'DISPOSED') return err('Aset sudah dibuang', 400);

    const unit = normalizeUnit(schedBody.intervalUnit);
    const intervalValue = Math.max(1, parseInt(String(schedBody.intervalValue || 1), 10));
    const leadDays = Math.max(0, parseInt(String(schedBody.leadDays ?? 7), 10));
    const nextDueRaw = schedBody.nextDueDate
      ? startOfDay(new Date(schedBody.nextDueDate))
      : addInterval(today, unit, intervalValue);

    const now = new Date();
    const noPM = await nextDocNumber(db, tenantId, 'PM', 'PM');
    const doc: MaintenanceScheduleDoc = {
      id: uuidv4(),
      tenantId,
      noPM,
      assetId: asset.id,
      assetKode: asset.kode,
      assetNama: asset.nama,
      judul: String(schedBody.judul).trim(),
      deskripsi: String(schedBody.deskripsi || '').trim(),
      checklist: String(schedBody.checklist || '').trim(),
      priority: normalizePriority(schedBody.priority),
      intervalUnit: unit,
      intervalValue,
      leadDays,
      nextDueDate: nextDueRaw,
      lastCompletedAt: null,
      lastGeneratedAt: null,
      lastWrId: null,
      lastWrNo: null,
      status: 'ACTIVE',
      createdBy: await actorSnapshot(db, scopeAuth),
      createdAt: now,
      updatedAt: now,
    };

    await db.collection(MAINTENANCE_SCHEDULES_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'MAINTENANCE_SCHEDULE_CREATED',
      entityType: 'maintenance_schedule',
      entityId: doc.id!,
      summary: `${noPM} — ${doc.judul}`,
      metadata: { assetId: asset.id, intervalUnit: unit, intervalValue },
      ...auditActor(scopeAuth),
    });
    return ok(enrichScheduleRow(doc, today));
  }

  if (path[0] === 'maintenance-schedules' && path.length === 2 && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const doc = await db.collection(MAINTENANCE_SCHEDULES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaintenanceScheduleDoc | null;
    if (!doc) return err('Jadwal tidak ditemukan', 404);
    return ok(enrichScheduleRow(doc, today));
  }

  if (path[0] === 'maintenance-schedules' && path.length === 2 && method === 'PUT') {
    const deniedRole = requireRole(auth, [...PM_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const existing = await db.collection(MAINTENANCE_SCHEDULES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaintenanceScheduleDoc | null;
    if (!existing) return err('Jadwal tidak ditemukan', 404);

    const tenantId = String(existing.tenantId || 'default');
    const patch: Record<string, unknown> = { updatedAt: new Date() };

    if (schedBody.assetId && schedBody.assetId !== existing.assetId) {
      const asset = await loadAssetForTenant(db, tenantId, schedBody.assetId);
      if (!asset) return err('Aset tidak ditemukan', 404);
      patch.assetId = asset.id;
      patch.assetKode = asset.kode;
      patch.assetNama = asset.nama;
    }
    if (schedBody.judul !== undefined) {
      if (!String(schedBody.judul).trim()) return err('Judul jadwal wajib diisi');
      patch.judul = String(schedBody.judul).trim();
    }
    if (schedBody.deskripsi !== undefined) patch.deskripsi = String(schedBody.deskripsi || '').trim();
    if (schedBody.checklist !== undefined) patch.checklist = String(schedBody.checklist || '').trim();
    if (schedBody.priority !== undefined) patch.priority = normalizePriority(schedBody.priority);
    if (schedBody.intervalUnit !== undefined) patch.intervalUnit = normalizeUnit(schedBody.intervalUnit);
    if (schedBody.intervalValue !== undefined) {
      patch.intervalValue = Math.max(1, parseInt(String(schedBody.intervalValue), 10));
    }
    if (schedBody.leadDays !== undefined) {
      patch.leadDays = Math.max(0, parseInt(String(schedBody.leadDays), 10));
    }
    if (schedBody.nextDueDate !== undefined) {
      patch.nextDueDate = startOfDay(new Date(schedBody.nextDueDate));
    }
    if (schedBody.status !== undefined) {
      const st = String(schedBody.status).toUpperCase();
      if (!VALID_STATUS.has(st)) return err('Status tidak valid', 400);
      patch.status = st;
    }

    await db.collection(MAINTENANCE_SCHEDULES_COLLECTION).updateOne({ id: existing.id }, { $set: patch });
    const updated = await db.collection(MAINTENANCE_SCHEDULES_COLLECTION).findOne({ id: existing.id });
    return ok(enrichScheduleRow(updated as MaintenanceScheduleDoc, today));
  }

  if (path[0] === 'maintenance-schedules' && path.length === 2 && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...PM_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;

    const existing = await db.collection(MAINTENANCE_SCHEDULES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!existing) return err('Jadwal tidak ditemukan', 404);

    await db.collection(MAINTENANCE_SCHEDULES_COLLECTION).updateOne(
      { id: existing.id },
      { $set: { status: 'ARCHIVED', updatedAt: new Date() } },
    );
    return ok({ message: 'archived' });
  }

  return null;
}
