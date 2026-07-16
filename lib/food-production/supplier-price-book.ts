/**
 * Supplier price book — ADR-001 Phase 5 / Sprint 23.
 * Multi-supplier catalogue harga beli untuk feed CHEAPER_SUPPLY.
 */

export const SUPPLIER_PRICE_BOOK_COLLECTION = 'supplier_price_book';

export interface SupplierPriceBookDoc {
  id: string;
  tenantId: string;
  supplierId: string;
  supplierKode?: string;
  supplierNama?: string;
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  harga: number;
  effectiveFrom?: string;
  effectiveTo?: string;
  aktif: boolean;
  catatan?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function normalizeHargaBeliBook(raw: unknown): number | { error: string } {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { error: 'harga wajib > 0' };
  return Math.round(n * 100) / 100;
}

export function isPriceBookEffective(
  row: Pick<SupplierPriceBookDoc, 'effectiveFrom' | 'effectiveTo'> & { aktif?: boolean },
  asOfIso = new Date().toISOString().slice(0, 10),
): boolean {
  if (row.aktif === false) return false;
  const from = String(row.effectiveFrom || '').trim();
  const to = String(row.effectiveTo || '').trim();
  if (from && from > asOfIso) return false;
  if (to && to < asOfIso) return false;
  return true;
}

/** Best (lowest) active book price per product. */
export function pickBestBookPrices(
  rows: Array<{
    productId: string;
    harga: number;
    supplierId: string;
    supplierNama?: string;
    supplierKode?: string;
    aktif?: boolean;
    effectiveFrom?: string;
    effectiveTo?: string;
  }>,
  asOfIso = new Date().toISOString().slice(0, 10),
): Map<string, {
  harga: number;
  supplierId: string;
  supplierNama?: string;
  supplierKode?: string;
}> {
  const best = new Map<string, {
    harga: number;
    supplierId: string;
    supplierNama?: string;
    supplierKode?: string;
  }>();
  for (const row of rows) {
    if (!isPriceBookEffective(row, asOfIso)) continue;
    const pid = String(row.productId || '').trim();
    const harga = Number(row.harga) || 0;
    if (!pid || !(harga > 0)) continue;
    const cur = best.get(pid);
    if (!cur || harga < cur.harga) {
      best.set(pid, {
        harga,
        supplierId: row.supplierId,
        supplierNama: row.supplierNama,
        supplierKode: row.supplierKode,
      });
    }
  }
  return best;
}
