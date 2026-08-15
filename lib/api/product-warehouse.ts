// Produk inventory — setiap SKU hanya boleh di satu gudang (GKERING / GBASAH / GJANITOR).

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  normalizeWarehouseKode,
  WAREHOUSE_CODES,
  warehouseLabel,
  isValidWarehouseKode,
  type WarehouseCode,
} from '@/lib/api/warehouses';
import { productFilterById } from '@/lib/api/tenant-operational';
import { syncProductStokFromLokasi } from '@/lib/api/stok-lokasi';
import { txOpts } from '@/lib/api/transaction';
import { classifyProduct } from '@/lib/api/product-classification';

export const DEFAULT_PRODUCT_GUDANG: WarehouseCode = 'GKERING';

export function isValidProductGudang(kode: string | null | undefined): boolean {
  return isValidWarehouseKode(kode);
}

export function resolveProductGudangKode(prod: { gudangKode?: string | null } | null | undefined): WarehouseCode {
  const k = normalizeWarehouseKode(prod?.gudangKode || '');
  return isValidWarehouseKode(k) ? (k as WarehouseCode) : DEFAULT_PRODUCT_GUDANG;
}

export function inferGudangKodeFromProduct(prod: { grup?: string; nama?: string } | null | undefined): WarehouseCode {
  return classifyProduct(prod).gudangKode;
}

export function assertProductWarehouse(
  prod: { nama?: string; kode?: string; gudangKode?: string | null } | null | undefined,
  lokasiKode: string | null | undefined,
): { error: string } | null {
  const expected = resolveProductGudangKode(prod);
  const actual = normalizeWarehouseKode(lokasiKode);
  if (actual !== expected) {
    return {
      error: `${prod?.nama || prod?.kode || 'Produk'} hanya boleh di ${warehouseLabel(expected)}, bukan ${warehouseLabel(actual)}`,
    };
  }
  return null;
}

export async function purgeOtherWarehouseRows(
  db: Db,
  tenantId: string | null | undefined,
  stokId: string,
  gudangKode: string,
  session?: import('mongodb').ClientSession,
): Promise<void> {
  const tid = tenantId || 'default';
  const keep = normalizeWarehouseKode(gudangKode);
  await db.collection('stok_lokasi').deleteMany({
    tenantId: tid,
    stokId,
    lokasiKode: { $in: WAREHOUSE_CODES.filter((k) => k !== keep) },
  }, session ? { session } : {});
}

export type SetWarehouseStockResult = { qty: number } | { error: string };

export async function setProductWarehouseStock(
  db: Db,
  tenantId: string | null | undefined,
  stokId: string,
  gudangKode: string,
  qty: number | string,
  session?: import('mongodb').ClientSession,
): Promise<SetWarehouseStockResult> {
  const tid = tenantId || 'default';
  const kode = normalizeWarehouseKode(gudangKode);
  if (!isValidWarehouseKode(kode)) {
    return { error: 'Gudang produk tidak valid' };
  }
  await purgeOtherWarehouseRows(db, tid, stokId, kode, session);
  const next = parseFloat(String(qty)) || 0;
  const filter = { tenantId: tid, stokId, lokasiKode: kode };
  const existing = await db.collection('stok_lokasi').findOne(filter, txOpts(session));
  if (existing) {
    await db.collection('stok_lokasi').updateOne(
      filter,
      { $set: { qty: next, updatedAt: new Date() } },
      txOpts(session),
    );
  } else {
    await db.collection('stok_lokasi').insertOne({
      id: uuidv4(),
      ...filter,
      qty: next,
      updatedAt: new Date(),
    }, txOpts(session));
  }
  const total = await syncProductStokFromLokasi(db, tid, stokId, session);
  return { qty: total };
}

export async function backfillProductGudangForTenant(db: Db, tenantId: string | null | undefined) {
  const tid = tenantId || 'default';
  const products = await db.collection<{
    id: string;
    gudangKode?: string;
    stok?: number | string;
    grup?: string;
    nama?: string;
  }>('products').find({ tenantId: tid }).toArray();
  let updated = 0;

  for (const prod of products) {
    let gudang: WarehouseCode | null = prod.gudangKode && isValidProductGudang(prod.gudangKode)
      ? (normalizeWarehouseKode(prod.gudangKode) as WarehouseCode)
      : null;

    if (!gudang) {
      const rows = await db.collection<{ lokasiKode: string; qty?: number | string }>('stok_lokasi')
        .find({ tenantId: tid, stokId: prod.id, lokasiKode: { $in: [...WAREHOUSE_CODES] } })
        .toArray();
      const withQty = rows.filter((r) => (parseFloat(String(r.qty)) || 0) > 0);
      if (withQty.length === 1) {
        gudang = withQty[0].lokasiKode as WarehouseCode;
      } else if (withQty.length > 1) {
        withQty.sort((a, b) => (parseFloat(String(b.qty)) || 0) - (parseFloat(String(a.qty)) || 0));
        gudang = withQty[0].lokasiKode as WarehouseCode;
      } else {
        gudang = inferGudangKodeFromProduct(prod);
      }
    }

    if (prod.gudangKode !== gudang) {
      await db.collection('products').updateOne(
        productFilterById(tid, prod.id),
        { $set: { gudangKode: gudang, updatedAt: new Date() } },
      );
      updated += 1;
    }

    const row = await db.collection('stok_lokasi').findOne({
      tenantId: tid, stokId: prod.id, lokasiKode: gudang,
    });
    const rowDoc = row as { qty?: number | string } | null;
    const qty = rowDoc ? (parseFloat(String(rowDoc.qty)) || 0) : 0;
    await setProductWarehouseStock(db, tid, prod.id, gudang, qty);
  }

  return { products: products.length, updated };
}

export async function backfillAllProductGudang(db: Db) {
  const tenantIds = await db.collection('products').distinct('tenantId') as string[];
  const results: Record<string, Awaited<ReturnType<typeof backfillProductGudangForTenant>>> = {};
  for (const tid of tenantIds.filter(Boolean)) {
    results[tid] = await backfillProductGudangForTenant(db, tid);
  }
  return results;
}
