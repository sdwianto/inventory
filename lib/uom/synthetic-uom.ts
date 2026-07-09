import type { ProductUom } from '@/lib/uom/types';

/** Satuan dasar sintetis untuk produk legacy tanpa baris product_uom. */
export function syntheticBaseUomFromProduct(
  tenantId: string,
  productId: string,
  prod: {
    satuan?: string;
    baseUomId?: string;
    barcode?: string;
    hargaEcer?: number | string;
    hargaGrosir?: number | string;
    hargaSpesial?: number | string;
  },
): ProductUom {
  const satuan = String(prod.satuan || 'PCS').trim().toUpperCase() || 'PCS';
  return {
    id: String(prod.baseUomId || `legacy:${productId}`),
    tenantId: tenantId || 'default',
    productId,
    satuan,
    isBase: true,
    factorToBase: 1,
    barcode: String(prod.barcode || ''),
    sortOrder: 0,
    hargaEcer: parseInt(String(prod.hargaEcer || 0), 10) || 0,
    hargaGrosir: parseInt(String(prod.hargaGrosir || 0), 10) || 0,
    hargaSpesial: parseInt(String(prod.hargaSpesial || 0), 10) || 0,
    aktif: true,
  };
}
