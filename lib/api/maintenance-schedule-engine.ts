import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { loadAssetForTenant, normalizePriority } from '@/lib/api/maintenance-helpers';
import {
  BLOCKING_WR_STATUSES,
  MAINTENANCE_REQUESTS_COLLECTION,
  MAINTENANCE_SCHEDULES_COLLECTION,
} from '@/lib/maintenance/constants';
import { writeAuditLog } from '@/lib/api/audit-log';
import type {
  MaintenanceIntervalUnit,
  MaintenanceScheduleDoc,
} from '@/types/maintenance';

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addInterval(
  date: Date,
  unit: MaintenanceIntervalUnit,
  value: number,
): Date {
  const d = new Date(date);
  const n = Math.max(1, Math.floor(value) || 1);
  if (unit === 'DAYS') {
    d.setDate(d.getDate() + n);
  } else if (unit === 'WEEKS') {
    d.setDate(d.getDate() + n * 7);
  } else {
    d.setMonth(d.getMonth() + n);
  }
  return startOfDay(d);
}

export function formatIntervalLabel(unit: MaintenanceIntervalUnit, value: number): string {
  const n = Math.max(1, Math.floor(value) || 1);
  if (unit === 'DAYS') return n === 1 ? 'Setiap hari' : `Setiap ${n} hari`;
  if (unit === 'WEEKS') return n === 1 ? 'Setiap minggu' : `Setiap ${n} minggu`;
  return n === 1 ? 'Setiap bulan' : `Setiap ${n} bulan`;
}

export function isScheduleDue(nextDueDate: Date | string | undefined, today: Date): boolean {
  if (!nextDueDate) return false;
  return startOfDay(new Date(nextDueDate)).getTime() <= startOfDay(today).getTime();
}

export function isScheduleDueSoon(
  nextDueDate: Date | string | undefined,
  leadDays: number,
  today: Date,
): boolean {
  if (!nextDueDate) return false;
  const due = startOfDay(new Date(nextDueDate));
  const lead = Math.max(0, parseInt(String(leadDays || 0), 10));
  const threshold = startOfDay(today);
  threshold.setDate(threshold.getDate() + lead);
  return due.getTime() <= threshold.getTime() && due.getTime() > startOfDay(today).getTime();
}

export interface ProcessDueResult {
  scanned: number;
  generated: number;
  skipped: number;
  errors: { scheduleId: string; noPM?: string; error: string }[];
  wrIds: string[];
}

async function hasOpenWrForSchedule(
  db: Db,
  tenantId: string,
  scheduleId: string,
): Promise<boolean> {
  const open = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne({
    tenantId,
    scheduleId,
    status: { $in: BLOCKING_WR_STATUSES },
  });
  return !!open;
}

async function createPreventiveWr(
  db: Db,
  tenantId: string,
  schedule: MaintenanceScheduleDoc,
): Promise<{ id: string; noWR: string }> {
  const asset = await loadAssetForTenant(db, tenantId, String(schedule.assetId));
  if (!asset) throw new Error('Aset tidak ditemukan');

  const noWR = await nextDocNumber(db, tenantId, 'WR', 'WR');
  const now = new Date();
  const checklist = String(schedule.checklist || '').trim();
  const deskripsi = [
    String(schedule.deskripsi || '').trim(),
    checklist ? `Checklist:\n${checklist}` : '',
  ].filter(Boolean).join('\n\n');

  const doc = {
    id: uuidv4(),
    tenantId,
    noWR,
    assetId: asset.id,
    assetKode: asset.kode,
    assetNama: asset.nama,
    priority: normalizePriority(schedule.priority),
    judul: `[PM] ${String(schedule.judul || 'Perawatan rutin').trim()}`,
    deskripsi,
    photos: [],
    status: 'DRAFT',
    sourceType: 'PREVENTIVE',
    scheduleId: schedule.id,
    noSchedule: schedule.noPM,
    resolutionType: null,
    createdBy: { userId: 'system', userName: 'Jadwal PM', role: 'SYSTEM' },
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(MAINTENANCE_REQUESTS_COLLECTION).insertOne(doc);
  await writeAuditLog(db, {
    tenantId,
    action: 'MAINTENANCE_WR_CREATED',
    entityType: 'maintenance_request',
    entityId: doc.id,
    summary: `${noWR} — preventif dari ${schedule.noPM || schedule.id}`,
    userName: 'System',
    metadata: { scheduleId: schedule.id, sourceType: 'PREVENTIVE', auto: true },
  });

  return { id: doc.id, noWR };
}

export async function processDueMaintenanceSchedules(
  db: Db,
  tenantId: string,
  now = new Date(),
): Promise<ProcessDueResult> {
  const today = startOfDay(now);
  const schedules = await db.collection(MAINTENANCE_SCHEDULES_COLLECTION)
    .find({
      tenantId,
      status: 'ACTIVE',
      nextDueDate: { $lte: today },
    })
    .sort({ nextDueDate: 1 })
    .limit(50)
    .toArray() as MaintenanceScheduleDoc[];

  const result: ProcessDueResult = {
    scanned: schedules.length,
    generated: 0,
    skipped: 0,
    errors: [],
    wrIds: [],
  };

  for (const schedule of schedules) {
    try {
      if (!schedule.assetId) {
        result.skipped += 1;
        result.errors.push({ scheduleId: String(schedule.id), noPM: schedule.noPM, error: 'Aset kosong' });
        continue;
      }

      const asset = await loadAssetForTenant(db, tenantId, String(schedule.assetId));
      if (!asset) {
        result.skipped += 1;
        result.errors.push({ scheduleId: String(schedule.id), noPM: schedule.noPM, error: 'Aset tidak ditemukan' });
        continue;
      }
      if (asset.status === 'DISPOSED' || asset.status === 'RETIRED') {
        result.skipped += 1;
        continue;
      }

      if (await hasOpenWrForSchedule(db, tenantId, String(schedule.id))) {
        result.skipped += 1;
        continue;
      }

      const wr = await createPreventiveWr(db, tenantId, schedule);
      const unit = (schedule.intervalUnit || 'MONTHS') as MaintenanceIntervalUnit;
      const value = Math.max(1, parseInt(String(schedule.intervalValue || 1), 10));
      let nextDue = startOfDay(new Date(schedule.nextDueDate || today));
      do {
        nextDue = addInterval(nextDue, unit, value);
      } while (nextDue.getTime() <= today.getTime());

      await db.collection(MAINTENANCE_SCHEDULES_COLLECTION).updateOne(
        { id: schedule.id },
        {
          $set: {
            lastGeneratedAt: now,
            lastWrId: wr.id,
            lastWrNo: wr.noWR,
            nextDueDate: nextDue,
            updatedAt: now,
          },
        },
      );

      result.generated += 1;
      result.wrIds.push(wr.id);
    } catch (e) {
      result.errors.push({
        scheduleId: String(schedule.id),
        noPM: schedule.noPM,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return result;
}

export async function touchScheduleOnWrClosed(
  db: Db,
  wr: { tenantId?: string; scheduleId?: string | null; closedAt?: Date | string | null },
): Promise<void> {
  if (!wr.scheduleId) return;
  const tenantId = String(wr.tenantId || 'default');
  await db.collection(MAINTENANCE_SCHEDULES_COLLECTION).updateOne(
    { tenantId, id: wr.scheduleId },
    {
      $set: {
        lastCompletedAt: wr.closedAt || new Date(),
        updatedAt: new Date(),
      },
    },
  );
}

export async function countScheduleDueStats(
  db: Db,
  tenantFilter: Record<string, unknown>,
  now: Date,
): Promise<{ overdue: number; dueSoon: number; active: number }> {
  const today = startOfDay(now);
  const active = await db.collection(MAINTENANCE_SCHEDULES_COLLECTION).countDocuments({
    ...tenantFilter,
    status: 'ACTIVE',
  });

  const activeSchedules = await db.collection(MAINTENANCE_SCHEDULES_COLLECTION)
    .find({ ...tenantFilter, status: 'ACTIVE' })
    .project({ nextDueDate: 1, leadDays: 1 })
    .toArray() as MaintenanceScheduleDoc[];

  let overdue = 0;
  let dueSoon = 0;
  for (const s of activeSchedules) {
    if (isScheduleDue(s.nextDueDate, today)) overdue += 1;
    else if (isScheduleDueSoon(s.nextDueDate, s.leadDays || 0, today)) dueSoon += 1;
  }

  return { overdue, dueSoon, active };
}
