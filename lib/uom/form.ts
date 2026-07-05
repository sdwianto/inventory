import type { UomInput } from '@/lib/uom/types';

export type ProductUomFormRow = {
  satuan: string;
  isBase: boolean;
  factorToBase: number;
  barcode: string;
  hargaEcer: number;
  hargaGrosir: number;
  hargaSpesial: number;
};

type UomLike = {
  satuan?: string;
  isBase?: boolean;
  factorToBase?: number;
  barcode?: string;
  hargaEcer?: number;
  hargaGrosir?: number;
  hargaSpesial?: number;
};

export type ProductLike = {
  kode?: string;
  nama?: string;
  grup?: string;
  satuan?: string;
  barcode?: string;
  tenantId?: string;
  hargaBeli?: number;
  hargaEcer?: number;
  hargaGrosir?: number;
  hargaSpesial?: number;
  stok?: number;
  minStok?: number;
  aktif?: boolean;
  uoms?: UomLike[];
};

export function defaultUomRow(overrides: Partial<ProductUomFormRow> = {}): ProductUomFormRow {
  return {
    satuan: 'PCS',
    isBase: true,
    factorToBase: 1,
    barcode: '',
    hargaEcer: 0,
    hargaGrosir: 0,
    hargaSpesial: 0,
    ...overrides,
  };
}

export function defaultUomRows(): ProductUomFormRow[] {
  return [defaultUomRow()];
}

export function uomRowsFromProduct(product: ProductLike): ProductUomFormRow[] {
  if (Array.isArray(product.uoms) && product.uoms.length > 0) {
    return product.uoms.map((u) => ({
      satuan: String(u.satuan || 'PCS').toUpperCase(),
      isBase: u.isBase === true,
      factorToBase: parseInt(String(u.factorToBase ?? 1), 10) || 1,
      barcode: String(u.barcode || ''),
      hargaEcer: parseInt(String(u.hargaEcer ?? 0), 10) || 0,
      hargaGrosir: parseInt(String(u.hargaGrosir ?? 0), 10) || 0,
      hargaSpesial: parseInt(String(u.hargaSpesial ?? 0), 10) || 0,
    }));
  }
  return [defaultUomRow({
    satuan: String(product.satuan || 'PCS').toUpperCase(),
    barcode: String(product.barcode || ''),
    hargaEcer: product.hargaEcer ?? 0,
    hargaGrosir: product.hargaGrosir ?? 0,
    hargaSpesial: product.hargaSpesial ?? 0,
  })];
}

export function uomRowsToPayload(rows: ProductUomFormRow[]): UomInput[] {
  return rows.map((r) => ({
    satuan: r.satuan,
    isBase: r.isBase,
    factorToBase: r.factorToBase,
    barcode: r.barcode,
    hargaEcer: r.hargaEcer,
    hargaGrosir: r.hargaGrosir,
    hargaSpesial: r.hargaSpesial,
  }));
}

export function validateFormUomRows(rows: ProductUomFormRow[]): string | null {
  if (!rows.length) return 'Minimal satu satuan wajib diisi';
  const baseCount = rows.filter((r) => r.isBase).length;
  if (baseCount !== 1) return 'Tandai tepat satu satuan sebagai satuan dasar (stok)';
  for (const r of rows) {
    if (!r.satuan.trim()) return 'Pilih satuan untuk setiap baris';
    if (r.isBase && r.factorToBase !== 1) return 'Satuan dasar harus faktor 1';
    if (!r.isBase && r.factorToBase < 2) return `Faktor "${r.satuan}" minimal 2 (atau jadikan satuan dasar)`;
  }
  const names = rows.map((r) => r.satuan.trim().toUpperCase());
  if (new Set(names).size !== names.length) return 'Satuan tidak boleh duplikat';
  return null;
}

export function setBaseUomRow(rows: ProductUomFormRow[], index: number): ProductUomFormRow[] {
  return rows.map((row, i) => {
    if (i === index) {
      return { ...row, isBase: true, factorToBase: 1 };
    }
    return { ...row, isBase: false, factorToBase: row.factorToBase < 1 ? 1 : row.factorToBase };
  });
}

export function addUomRow(rows: ProductUomFormRow[]): ProductUomFormRow[] {
  return [
    ...rows,
    defaultUomRow({
      isBase: false,
      factorToBase: 10,
      satuan: '',
      barcode: '',
    }),
  ];
}

export function removeUomRow(rows: ProductUomFormRow[], index: number): ProductUomFormRow[] {
  if (rows.length <= 1) return rows;
  const next = rows.filter((_, i) => i !== index);
  if (!next.some((r) => r.isBase)) {
    return setBaseUomRow(next, 0);
  }
  return next;
}

export type ProductFormUomFields = {
  kode: string;
  nama: string;
  grup: string;
  hargaBeli: number;
  stok: number;
  minStok: number;
  aktif: boolean;
  tenantId: string;
  uoms: ProductUomFormRow[];
};

export function productToFormFields(
  product: ProductLike,
  tenantId?: string,
): ProductFormUomFields {
  const uoms = uomRowsFromProduct(product);
  return {
    kode: String(product.kode || ''),
    nama: String(product.nama || ''),
    grup: String(product.grup || ''),
    hargaBeli: product.hargaBeli ?? 0,
    stok: product.stok ?? 0,
    minStok: product.minStok ?? 0,
    aktif: product.aktif !== false,
    tenantId: tenantId ?? String(product.tenantId || 'default'),
    uoms,
  };
}

export function formFieldsToProductPayload(
  fields: ProductFormUomFields,
  options?: { includeTenantId?: boolean; isEdit?: boolean },
): Record<string, unknown> {
  const base = fields.uoms.find((r) => r.isBase) ?? fields.uoms[0];
  const payload: Record<string, unknown> = {
    kode: fields.kode,
    nama: fields.nama,
    grup: fields.grup,
    hargaBeli: fields.hargaBeli,
    minStok: fields.minStok,
    aktif: fields.aktif,
    uoms: uomRowsToPayload(fields.uoms),
    satuan: base?.satuan,
    barcode: base?.barcode,
    hargaEcer: base?.hargaEcer,
    hargaGrosir: base?.hargaGrosir,
    hargaSpesial: base?.hargaSpesial,
  };
  if (options?.includeTenantId) payload.tenantId = fields.tenantId;
  if (!options?.isEdit) payload.stok = fields.stok;
  return payload;
}
