import type { Db } from 'mongodb';
import { calendarDateAtUtcNoon, calendarDateKey, isIsoDateOnly } from '@/lib/calendar-date';
import {
  PRODUCTION_PLANS_COLLECTION,
  procureDateFromPlanTanggal,
} from '@/lib/food-production/production-plan';

export type ArrivalDateResult =
  | { ok: true; date: Date; iso: string; fromPlan: boolean }
  | { ok: false; error: string };

/**
 * PO dari rencana produksi: kedatangan selalu H-1 tanggal menu.
 * PO ad-hoc: pakai tanggal yang dikirim, di-parse sebagai hari kalender (UTC noon).
 */
export async function resolveTanggalKedatanganForWrite(
  db: Db,
  opts: {
    productionPlanId?: unknown;
    raw?: unknown;
    existing?: unknown;
  },
): Promise<ArrivalDateResult> {
  const planId = String(opts.productionPlanId || '').trim();
  if (planId) {
    const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      { id: planId },
      { projection: { tanggal: 1 } },
    );
    const expected = plan?.tanggal ? procureDateFromPlanTanggal(String(plan.tanggal)) : '';
    if (!isIsoDateOnly(expected)) {
      return { ok: false, error: 'Rencana produksi tertaut tidak punya tanggal menu yang valid' };
    }
    return {
      ok: true,
      date: calendarDateAtUtcNoon(expected),
      iso: expected,
      fromPlan: true,
    };
  }

  const key = calendarDateKey(opts.raw ?? opts.existing);
  if (!isIsoDateOnly(key)) {
    return { ok: false, error: 'tanggalKedatangan tidak valid' };
  }
  return { ok: true, date: calendarDateAtUtcNoon(key), iso: key, fromPlan: false };
}

export type PlanPoArrivalMismatch = {
  id: string;
  noPO: string;
  status: string;
  productionPlanId: string;
  productionPlanNo?: string;
  actual: string;
  expected: string;
};

const SKIP_STATUSES = new Set(['CANCELLED']);

/** Cari PO tertaut RPN yang kedatangannya ≠ H-1. */
export async function findPlanPoArrivalMismatches(
  db: Db,
  opts: { tenantId?: string; includeStatuses?: string[] } = {},
): Promise<PlanPoArrivalMismatch[]> {
  const filter: Record<string, unknown> = {
    productionPlanId: { $exists: true, $nin: [null, ''] },
    status: { $nin: [...SKIP_STATUSES] },
  };
  if (opts.tenantId) filter.tenantId = opts.tenantId;
  if (opts.includeStatuses?.length) {
    filter.status = { $in: opts.includeStatuses };
  }

  const pos = await db.collection('customer_purchase_orders').find(filter, {
    projection: {
      id: 1,
      noPO: 1,
      status: 1,
      tanggalKedatangan: 1,
      productionPlanId: 1,
      tenantId: 1,
    },
  }).toArray();

  const planIds = [...new Set(pos.map((p) => String(p.productionPlanId || '')).filter(Boolean))];
  const plans = planIds.length
    ? await db.collection(PRODUCTION_PLANS_COLLECTION).find(
      { id: { $in: planIds } },
      { projection: { id: 1, noDokumen: 1, tanggal: 1 } },
    ).toArray()
    : [];
  const planById = new Map(plans.map((p) => [String(p.id), p]));

  const mismatches: PlanPoArrivalMismatch[] = [];
  for (const po of pos) {
    const plan = planById.get(String(po.productionPlanId || ''));
    const expected = plan?.tanggal ? procureDateFromPlanTanggal(String(plan.tanggal)) : '';
    const actual = calendarDateKey(po.tanggalKedatangan);
    if (!expected || actual === expected) continue;
    mismatches.push({
      id: String(po.id),
      noPO: String(po.noPO || ''),
      status: String(po.status || ''),
      productionPlanId: String(po.productionPlanId),
      productionPlanNo: plan?.noDokumen ? String(plan.noDokumen) : undefined,
      actual,
      expected,
    });
  }
  return mismatches;
}
