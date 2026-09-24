// Produk inventory — setiap SKU hanya boleh di satu gudang (GKERING / GBASAH / GJANITOR).
// Penulisan stok gudang (set/purge/backfill) ada di lib/stock-ledger/master-stock.

import {
  normalizeWarehouseKode,
  warehouseLabel,
  isValidWarehouseKode,
  type WarehouseCode,
} from '@/lib/api/warehouses';
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
