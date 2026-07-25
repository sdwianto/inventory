import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { withTenantFilter, resolveOperationalScope } from '@/lib/api/tenant-master';
import { isValidWarehouseKode, normalizeWarehouseKode, warehouseLabel } from '@/lib/api/warehouses';
import { isValidBinKode, normalizeBinKode } from '@/lib/api/warehouse-bins';
import { STOK_BIN_COLLECTION } from '@/lib/api/stok-bin';
import type { HandlerContext } from '@/types/api/handler';

export async function handleStokBin({
  db,
  route,
  method,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  if (route !== '/stok-bin' || method !== 'GET') return null;

  const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
  if (denied) return denied;
  if (!scopeAuth) return err('Scope tidak valid', 400);

  const warehouseKodeRaw = url.searchParams.get('warehouseKode');
  const stokId = String(url.searchParams.get('stokId') || '').trim();
  const binKodeRaw = url.searchParams.get('binKode');
  const onlyPositive = url.searchParams.get('qty') !== 'all';

  let filter: Record<string, unknown> = {};
  if (warehouseKodeRaw) {
    const wh = normalizeWarehouseKode(warehouseKodeRaw);
    if (!isValidWarehouseKode(wh)) return err('Gudang tidak valid', 400);
    filter.warehouseKode = wh;
  }
  if (stokId) filter.stokId = stokId;
  if (binKodeRaw) {
    const bin = normalizeBinKode(binKodeRaw);
    if (!isValidBinKode(bin)) return err('Kode bin tidak valid', 400);
    filter.binKode = bin;
  }
  if (onlyPositive) filter.qty = { $gt: 0 };
  filter = withTenantFilter(scopeAuth, filter);

  const list = await db.collection(STOK_BIN_COLLECTION)
    .find(filter)
    .sort({ warehouseKode: 1, binKode: 1, stokId: 1 })
    .limit(500)
    .toArray();

  return ok(list.map((doc) => clean({
    ...doc,
    warehouseLabel: warehouseLabel(String(doc.warehouseKode || '')),
  })));
}
