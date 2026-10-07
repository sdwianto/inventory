import type { Db } from 'mongodb';
import { withTenantFilter } from '@/lib/api/tenant-master';
import {
  PORTION_TARGETS_COLLECTION,
  portionTargetKey,
  resolvePlanPenerima,
  type PlanPenerima,
  type PortionTargetDoc,
} from '@/lib/food-production/portion-target';
import type { ProductionPlanLine } from '@/lib/food-production/production-plan';

type ScopeAuth = Parameters<typeof withTenantFilter>[0];
type PlanLike = {
  tanggal?: unknown;
  kitchenId?: unknown;
  lines?: ProductionPlanLine[];
  kategoriPorsiList?: readonly string[] | null;
};

/** Acuan porsi per tanggal+dapur untuk sekumpulan rencana (satu query). */
export async function loadPortionTargetsForPlans(
  db: Db,
  scopeAuth: ScopeAuth,
  plans: PlanLike[],
): Promise<Map<string, PortionTargetDoc['targets']>> {
  const pairs = new Map<string, { tanggal: string; kitchenId: string }>();
  for (const p of plans) {
    const tanggal = String(p.tanggal || '').trim();
    const kitchenId = String(p.kitchenId || '').trim();
    if (tanggal && kitchenId) pairs.set(portionTargetKey(tanggal, kitchenId), { tanggal, kitchenId });
  }
  if (!pairs.size) return new Map();
  const docs = await db.collection(PORTION_TARGETS_COLLECTION)
    .find(withTenantFilter(scopeAuth, { $or: [...pairs.values()] }))
    .project({ tanggal: 1, kitchenId: 1, targets: 1 })
    .toArray();
  return new Map(docs.map((d) => [
    portionTargetKey(String(d.tanggal), String(d.kitchenId)),
    d.targets as PortionTargetDoc['targets'],
  ]));
}

export type { PlanPenerima };

export function penerimaFromMap(
  plan: PlanLike,
  targetsByKey: Map<string, PortionTargetDoc['targets']>,
): PlanPenerima {
  return resolvePlanPenerima(
    plan,
    targetsByKey.get(portionTargetKey(String(plan.tanggal || ''), String(plan.kitchenId || ''))),
  );
}

export function penerimaPorsiFromMap(
  plan: PlanLike,
  targetsByKey: Map<string, PortionTargetDoc['targets']>,
): number {
  return penerimaFromMap(plan, targetsByKey).penerimaPorsi;
}

export async function loadPlanPenerima(db: Db, scopeAuth: ScopeAuth, plan: PlanLike): Promise<PlanPenerima> {
  const map = await loadPortionTargetsForPlans(db, scopeAuth, [plan]);
  return penerimaFromMap(plan, map);
}

export async function loadPlanPenerimaPorsi(db: Db, scopeAuth: ScopeAuth, plan: PlanLike): Promise<number> {
  return (await loadPlanPenerima(db, scopeAuth, plan)).penerimaPorsi;
}
