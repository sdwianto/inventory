/** Multi-UOM produk — kontrak bersama Sales & Inventory. */

export const PRODUCT_UOM_COLLECTION = 'product_uom';

export interface ProductUom {
  id: string;
  tenantId: string;
  productId: string;
  satuan: string;
  isBase: boolean;
  factorToBase: number;
  barcode?: string;
  sortOrder: number;
  hargaEcer: number;
  hargaGrosir: number;
  hargaSpesial: number;
  aktif: boolean;
  /** Mapping ke UOM di sales.app (Inventory vendor-sync). */
  vendorUomId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Input dari API / form — belum dinormalisasi. */
export interface UomInput {
  id?: string;
  satuan?: string;
  isBase?: boolean;
  factorToBase?: number | string;
  barcode?: string;
  sortOrder?: number | string;
  hargaEcer?: number | string;
  hargaGrosir?: number | string;
  hargaSpesial?: number | string;
  aktif?: boolean;
  vendorUomId?: string;
}

export interface NormalizedUomInput {
  satuan: string;
  isBase: boolean;
  factorToBase: number;
  barcode: string;
  sortOrder: number;
  hargaEcer: number;
  hargaGrosir: number;
  hargaSpesial: number;
  aktif: boolean;
  vendorUomId?: string;
}

/** Field line transaksi (Fase 3 — stok selalu qtyBase). */
export interface LineItemUomFields {
  uomId?: string;
  satuan?: string;
  factorToBase?: number;
  qty: number;
  qtyBase: number;
}

export interface ProductLookupUomResult {
  product: Record<string, unknown>;
  uom: ProductUom;
  resolvedBy: 'barcode' | 'kode' | 'base';
}

export const UOM_SCHEMA_VERSION = 2;
