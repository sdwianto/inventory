// Filter pencarian produk — exact barcode/kode lebih cepat dari regex penuh.

import type { Filter } from 'mongodb';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build Mongo filter for product search within tenant scope. */
export function buildProductSearchFilter(q?: string | null): Filter<Record<string, unknown>> {
  const term = (q || '').trim();
  if (!term) return {};

  const vendorClauses: Filter<Record<string, unknown>>[] = [
    { vendorTenantName: { $regex: escapeRegex(term), $options: 'i' } },
    { vendorTenantId: { $regex: escapeRegex(term), $options: 'i' } },
  ];

  const isCodeLike = /^[A-Za-z0-9\-_.]+$/.test(term) && term.length <= 48;
  if (!isCodeLike && term.length >= 3) {
    return { $text: { $search: term } };
  }
  if (isCodeLike) {
    return {
      $or: [
        { kode: term },
        { barcode: term },
        { kode: { $regex: `^${escapeRegex(term)}`, $options: 'i' } },
        { barcode: { $regex: `^${escapeRegex(term)}`, $options: 'i' } },
        { nama: { $regex: escapeRegex(term), $options: 'i' } },
        ...vendorClauses,
      ],
    };
  }
  return {
    $or: [
      { kode: { $regex: escapeRegex(term), $options: 'i' } },
      { nama: { $regex: escapeRegex(term), $options: 'i' } },
      { barcode: { $regex: escapeRegex(term), $options: 'i' } },
      ...vendorClauses,
    ],
  };
}

/** Gabungkan filter produk dengan vendorTenantId yang cocok nama vendor. */
export function mergeFilterWithVendorTenantIds(
  filter: Filter<Record<string, unknown>>,
  vendorTenantIds: string[],
): Filter<Record<string, unknown>> {
  if (!vendorTenantIds.length) return filter;
  const vendorClause = { vendorTenantId: { $in: vendorTenantIds } };
  if (filter.$text) {
    return { $or: [filter, vendorClause] };
  }
  const existingOr = Array.isArray(filter.$or) ? [...filter.$or] : [];
  if (!existingOr.length && Object.keys(filter).length === 0) {
    return vendorClause;
  }
  if (!existingOr.length) {
    return { $or: [filter, vendorClause] };
  }
  return { ...filter, $or: [...existingOr, vendorClause] };
}

/** Lookup vendor_tenants by name/id fragment — untuk produk yang belum punya vendorTenantName. */
export async function findVendorTenantIdsByNameSearch(
  db: import('mongodb').Db,
  tenantId: string,
  q: string | undefined | null,
): Promise<string[]> {
  const term = (q || '').trim();
  if (!term || term.length < 2) return [];
  const tid = tenantId || 'default';
  const rows = await db.collection('vendor_tenants').find({
    tenantId: tid,
    $or: [
      { vendorTenantName: { $regex: escapeRegex(term), $options: 'i' } },
      { vendorTenantId: { $regex: escapeRegex(term), $options: 'i' } },
    ],
  }).project({ vendorTenantId: 1 }).limit(30).toArray();
  return [...new Set(rows.map((r) => String(r.vendorTenantId)).filter(Boolean))];
}

export async function mergeProductSearchWithVendorName(
  db: import('mongodb').Db,
  tenantId: string,
  q: string | undefined | null,
  filter: Filter<Record<string, unknown>>,
): Promise<Filter<Record<string, unknown>>> {
  const vendorIds = await findVendorTenantIdsByNameSearch(db, tenantId, q);
  return mergeFilterWithVendorTenantIds(filter, vendorIds);
}

export const PRODUCT_LIST_PROJECTION = {
  id: 1,
  tenantId: 1,
  kode: 1,
  barcode: 1,
  nama: 1,
  grup: 1,
  satuan: 1,
  /** Bridge resep dapur — wajib di list agar COUNT (BTL/PCS/…) bisa pilih GR/ML. */
  recipeBaseGrams: 1,
  recipeBaseMl: 1,
  nutrition: 1,
  hargaBeli: 1,
  hargaSpesial: 1,
  hargaGrosir: 1,
  hargaEcer: 1,
  vendorHargaBeli: 1,
  vendorHargaGrosir: 1,
  vendorHargaSpesial: 1,
  vendorHargaEcer: 1,
  stok: 1,
  minStok: 1,
  gudangKode: 1,
  itemRole: 1,
  aktif: 1,
  syncSource: 1,
  vendorStokId: 1,
  vendorTenantId: 1,
  vendorTenantName: 1,
} as const;

export const TRANSACTION_LIST_PROJECTION = {
  id: 1,
  noNota: 1,
  tanggal: 1,
  tenantId: 1,
  tenantName: 1,
  kasirId: 1,
  kasirName: 1,
  lokasi: 1,
  mode: 1,
  paymentMethod: 1,
  edcBank: 1,
  pelangganId: 1,
  pelangganName: 1,
  memberId: 1,
  memberName: 1,
  items: 1,
  subTotal: 1,
  diskonNota: 1,
  ppn: 1,
  total: 1,
  bayar: 1,
  kembali: 1,
  hutang: 1,
  status: 1,
  poinDigunakan: 1,
  poinDiscount: 1,
  poinDidapat: 1,
  jatuhTempo: 1,
} as const;
