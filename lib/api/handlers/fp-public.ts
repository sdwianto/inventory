/**
 * Food Production public/integration API — ADR-001 Phase 4.
 * Requires API key with scope food-production:read (or session manage roles).
 */

import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { withTenantFilter, resolveOperationalScope } from '@/lib/api/tenant-master';
import { requireApiScope } from '@/lib/api/require-scope';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import { KITCHENS_COLLECTION } from '@/lib/food-production/kitchen';
import { PRODUCTION_PLANS_COLLECTION } from '@/lib/food-production/production-plan';
import { PRODUCTION_RESULTS_COLLECTION } from '@/lib/food-production/production-result';
import { PRODUCTION_BATCHES_COLLECTION } from '@/lib/food-production/production-batch';
import type { HandlerContext } from '@/types/api/handler';

const FP_READ = 'food-production:read';

export async function handleFpPublic(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request } = ctx;

  if (!route.startsWith('/fp-public')) return null;
  if (method !== 'GET') return err('Method tidak diizinkan', 405);

  const scopeDenied = requireApiScope(auth, FP_READ);
  if (scopeDenied) return scopeDenied;

  const { denied, scopeAuth } = resolveOperationalScope(auth, {
    url,
    request,
    allowApiKey: true,
  });
  if (denied) return denied;
  if (!scopeAuth) return err('Scope tidak valid', 400);

  const kitchenId = resolveKitchenIdFilter(url, request);

  if (route === '/fp-public/kitchens') {
    const filter: Record<string, unknown> = { aktif: true };
    if (kitchenId) filter.id = kitchenId;
    const list = await db.collection(KITCHENS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .project({ id: 1, kode: 1, nama: 1, kitchenType: 1, defaultWarehouseKode: 1, centralKitchenId: 1 })
      .sort({ nama: 1 })
      .limit(200)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/fp-public/plans') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const filter: Record<string, unknown> = {};
    if (from && to) filter.tanggal = { $gte: from, $lte: to };
    else if (from) filter.tanggal = { $gte: from };
    if (kitchenId) filter.kitchenId = kitchenId;
    const list = await db.collection(PRODUCTION_PLANS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .project({
        id: 1, noDokumen: 1, tanggal: 1, kitchenId: 1, kitchenNama: 1, status: 1, lines: 1,
      })
      .sort({ tanggal: -1 })
      .limit(100)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (path[0] === 'fp-public' && path[1] === 'plans' && path[2] && method === 'GET') {
    const filter: Record<string, unknown> = { id: path[2] };
    if (kitchenId) filter.kitchenId = kitchenId;
    const doc = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, filter),
    );
    if (!doc) return err('Rencana tidak ditemukan', 404);
    return ok(clean(doc as Record<string, unknown>));
  }

  if (route === '/fp-public/results') {
    const filter: Record<string, unknown> = { status: 'COMPLETED' };
    if (kitchenId) filter.kitchenId = kitchenId;
    const list = await db.collection(PRODUCTION_RESULTS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .project({
        id: 1, noDokumen: 1, tanggal: 1, kitchenId: 1, kitchenNama: 1,
        batchNo: 1, expiryDate: 1, summary: 1, productionPlanNo: 1,
      })
      .sort({ tanggal: -1 })
      .limit(100)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/fp-public/batches') {
    const todayIso = new Date().toISOString().slice(0, 10);
    await db.collection(PRODUCTION_BATCHES_COLLECTION).updateMany(
      withTenantFilter(scopeAuth, { status: 'ACTIVE', expiryDate: { $lt: todayIso } }),
      { $set: { status: 'EXPIRED', updatedAt: new Date() } },
    );
    const filter: Record<string, unknown> = {
      status: 'ACTIVE',
      expiryDate: { $gte: todayIso },
    };
    if (kitchenId) filter.kitchenId = kitchenId;
    const list = await db.collection(PRODUCTION_BATCHES_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ expiryDate: 1 })
      .limit(200)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  return err('Endpoint fp-public tidak dikenal', 404);
}
