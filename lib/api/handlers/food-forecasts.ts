import type { NextResponse } from 'next/server';
import { ok, err } from '@/lib/api/db';
import {
  withTenantFilter,
  resolveOperationalScope,
  tenantIdForWrite,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { getStokByWarehouseBatch } from '@/lib/api/stok-lokasi';
import { parseHorizon, buildMaterialForecast } from '@/lib/food-production/forecast';
import { FP_MGMT_READ_ROLES } from '@/lib/food-production/roles';
import { loadActualConsumption } from '@/lib/food-production/actual-consumption';
import type { HandlerContext } from '@/types/api/handler';

export async function handleFoodForecasts(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, url, request } = ctx;

  if (route === '/food-forecasts' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_MGMT_READ_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const horizon = parseHorizon(url.searchParams.get('horizon'));
    const historyWindow = Math.max(horizon * 2, 14);
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - historyWindow);
    const sinceIso = since.toISOString().slice(0, 10);

    const tid = tenantIdForWrite(scopeAuth, {});
    const { points, productIds, warehouseKodes } = await loadActualConsumption(db, scopeAuth, {
      tenantId: tid,
      sinceIso,
      issueLimit: 500,
    });

    const ids = [...productIds];
    const products = ids.length
      ? await db.collection('products')
        .find(withTenantFilter(scopeAuth, { id: { $in: ids } }))
        .project({ id: 1, kode: 1, nama: 1, satuan: 1 })
        .toArray()
      : [];
    const productMeta = new Map(
      products.map((p) => [String(p.id), {
        productKode: p.kode != null ? String(p.kode) : undefined,
        productNama: p.nama != null ? String(p.nama) : undefined,
        satuan: p.satuan != null ? String(p.satuan) : undefined,
      }]),
    );

    const stockMap = ids.length ? await getStokByWarehouseBatch(db, tid, ids) : new Map();
    const onHandByProduct = new Map<string, number>();
    for (const pid of ids) {
      const byWh = stockMap.get(pid) || {};
      let sum = 0;
      if (warehouseKodes.size) {
        for (const wh of warehouseKodes) sum += Number(byWh[wh] || 0);
      } else {
        sum = Object.values(byWh).reduce((s: number, v) => s + Number(v || 0), 0);
      }
      onHandByProduct.set(pid, sum);
    }

    const forecast = buildMaterialForecast({
      horizon,
      points,
      onHandByProduct,
      productMeta,
      historyDays: historyWindow,
    });
    return ok(forecast);
  }

  return null;
}
