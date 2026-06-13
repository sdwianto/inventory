// Produk inventory — setiap SKU hanya boleh di satu gudang (GKERING atau GBASAH).

import { v4 as uuidv4 } from 'uuid';
import {
  normalizeWarehouseKode,
  WAREHOUSE_CODES,
  warehouseLabel,
} from '@/lib/api/warehouses';
import { productFilterById, updateProductStockScoped } from '@/lib/api/tenant-operational';

export const DEFAULT_PRODUCT_GUDANG = 'GKERING';

const BASAH_GRUPS = new Set(['Roti', 'Telur', 'Susu', 'Sayur', 'Daging', 'Ikan', 'Buah', 'Basah']);
const BASAH_NAME_HINTS = ['telur', 'susu', 'roti', 'ikan', 'daging', 'sayur', 'buah', 'ayam', 'basah'];

export function isValidProductGudang(kode) {
  return WAREHOUSE_CODES.includes(normalizeWarehouseKode(kode));
}

export function resolveProductGudangKode(prod) {
  const k = normalizeWarehouseKode(prod?.gudangKode || '');
  return WAREHOUSE_CODES.includes(k) ? k : DEFAULT_PRODUCT_GUDANG;
}

export function inferGudangKodeFromProduct(prod) {
  const grup = String(prod?.grup || '').trim();
  if (BASAH_GRUPS.has(grup)) return 'GBASAH';
  const nama = String(prod?.nama || '').toLowerCase();
  if (BASAH_NAME_HINTS.some((h) => nama.includes(h))) return 'GBASAH';
  return DEFAULT_PRODUCT_GUDANG;
}

export function assertProductWarehouse(prod, lokasiKode) {
  const expected = resolveProductGudangKode(prod);
  const actual = normalizeWarehouseKode(lokasiKode);
  if (actual !== expected) {
    return {
      error: `${prod?.nama || prod?.kode || 'Produk'} hanya boleh di ${warehouseLabel(expected)}, bukan ${warehouseLabel(actual)}`,
    };
  }
  return null;
}

/** Hapus baris stok di gudang selain gudang produk. */
export async function purgeOtherWarehouseRows(db, tenantId, stokId, gudangKode) {
  const tid = tenantId || 'default';
  const keep = normalizeWarehouseKode(gudangKode);
  await db.collection('stok_lokasi').deleteMany({
    tenantId: tid,
    stokId,
    lokasiKode: { $in: WAREHOUSE_CODES.filter((k) => k !== keep) },
  });
}

/** Set stok hanya di gudang produk — tidak boleh dua gudang sekaligus. */
export async function setProductWarehouseStock(db, tenantId, stokId, gudangKode, qty) {
  const tid = tenantId || 'default';
  const kode = normalizeWarehouseKode(gudangKode);
  if (!WAREHOUSE_CODES.includes(kode)) {
    return { error: 'Gudang produk tidak valid' };
  }
  await purgeOtherWarehouseRows(db, tid, stokId, kode);
  const next = parseFloat(qty) || 0;
  const filter = { tenantId: tid, stokId, lokasiKode: kode };
  const existing = await db.collection('stok_lokasi').findOne(filter);
  if (existing) {
    await db.collection('stok_lokasi').updateOne(filter, { $set: { qty: next, updatedAt: new Date() } });
  } else {
    await db.collection('stok_lokasi').insertOne({
      id: uuidv4(),
      ...filter,
      qty: next,
      updatedAt: new Date(),
    });
  }
  await updateProductStockScoped(db, tid, stokId, { $set: { stok: next, updatedAt: new Date() } });
  return { qty: next };
}

/** Backfill gudangKode + rapikan stok ganda untuk satu tenant. */
export async function backfillProductGudangForTenant(db, tenantId) {
  const tid = tenantId || 'default';
  const products = await db.collection('products').find({ tenantId: tid }).toArray();
  let updated = 0;

  for (const prod of products) {
    let gudang = prod.gudangKode && isValidProductGudang(prod.gudangKode)
      ? normalizeWarehouseKode(prod.gudangKode)
      : null;

    if (!gudang) {
      const rows = await db.collection('stok_lokasi')
        .find({ tenantId: tid, stokId: prod.id, lokasiKode: { $in: WAREHOUSE_CODES } })
        .toArray();
      const withQty = rows.filter((r) => (parseFloat(r.qty) || 0) > 0);
      if (withQty.length === 1) {
        gudang = withQty[0].lokasiKode;
      } else if (withQty.length > 1) {
        withQty.sort((a, b) => (parseFloat(b.qty) || 0) - (parseFloat(a.qty) || 0));
        gudang = withQty[0].lokasiKode;
      } else {
        gudang = inferGudangKodeFromProduct(prod);
      }
    }

    const patch = { gudangKode: gudang, updatedAt: new Date() };
    if (prod.gudangKode !== gudang) {
      await db.collection('products').updateOne(
        productFilterById(tid, prod.id),
        { $set: patch },
      );
      updated += 1;
    }

    const row = await db.collection('stok_lokasi').findOne({
      tenantId: tid, stokId: prod.id, lokasiKode: gudang,
    });
    const qty = row ? (parseFloat(row.qty) || 0) : (parseFloat(prod.stok) || 0);
    await setProductWarehouseStock(db, tid, prod.id, gudang, qty);
  }

  return { products: products.length, updated };
}

export async function backfillAllProductGudang(db) {
  const tenantIds = await db.collection('products').distinct('tenantId');
  const results = {};
  for (const tid of tenantIds.filter(Boolean)) {
    results[tid] = await backfillProductGudangForTenant(db, tid);
  }
  return results;
}
