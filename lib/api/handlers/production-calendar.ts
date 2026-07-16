import type { NextResponse } from 'next/server';
import { ok, err } from '@/lib/api/db';
import { withTenantFilter, resolveOperationalScope } from '@/lib/api/tenant-master';
import { buildProductionCalendar } from '@/lib/food-production/production-calendar';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import {
  PRODUCTION_PLANS_COLLECTION,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import type { HandlerContext } from '@/types/api/handler';

export async function handleProductionCalendar(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, url, request } = ctx;

  if (route === '/production-calendar' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const from = String(url.searchParams.get('from') || '').trim();
    const to = String(url.searchParams.get('to') || '').trim();
    if (!from || !to) return err('from dan to wajib (YYYY-MM-DD)');

    const kitchenId = resolveKitchenIdFilter(url, request);
    const filter: Record<string, unknown> = {
      tanggal: { $gte: from, $lte: to },
    };
    if (kitchenId) filter.kitchenId = kitchenId;

    const plans = await db.collection(PRODUCTION_PLANS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .project({
        id: 1,
        noDokumen: 1,
        tanggal: 1,
        kitchenId: 1,
        kitchenNama: 1,
        status: 1,
        lines: 1,
      })
      .limit(500)
      .toArray() as unknown as ProductionPlanDoc[];

    const calendar = buildProductionCalendar({
      from,
      to,
      kitchenId,
      plans: plans.map((p) => ({
        id: p.id,
        noDokumen: p.noDokumen,
        tanggal: p.tanggal,
        kitchenId: p.kitchenId,
        kitchenNama: p.kitchenNama,
        status: p.status,
        totalTargetPorsi: (p.lines || []).reduce((s, l) => s + (Number(l.targetPorsi) || 0), 0),
      })),
    });
    if ('error' in calendar) return err(calendar.error, 400);
    return ok(calendar);
  }

  return null;
}
