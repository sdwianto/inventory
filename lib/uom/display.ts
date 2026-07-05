import { fromBaseQty, pickBaseUom } from '@/lib/uom/conversion';
import type { ProductUom } from '@/lib/uom/types';

/** Satuan alternatif terbesar untuk tampilan stok (bukan base). */
export function pickDisplayAltUom(uoms: ProductUom[]): ProductUom | null {
  const alts = uoms.filter((u) => !u.isBase && u.factorToBase > 1);
  if (!alts.length) return null;
  return alts.reduce((best, u) => (u.factorToBase > best.factorToBase ? u : best));
}

function formatQty(n: number): string {
  const rounded = Math.round(n * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/**
 * Tampilan stok dual-unit: "120 SACHET (12 BOX)".
 * qtyBase = stok dalam satuan dasar.
 */
export function formatStockDualLabel(
  qtyBase: number,
  uoms: ProductUom[],
): string {
  const qty = parseFloat(String(qtyBase)) || 0;
  const base = pickBaseUom(uoms);
  const baseSatuan = base?.satuan || 'PCS';
  if (!base || uoms.length <= 1) {
    return `${formatQty(qty)} ${baseSatuan}`;
  }
  const alt = pickDisplayAltUom(uoms);
  if (!alt || alt.factorToBase <= 1) {
    return `${formatQty(qty)} ${baseSatuan}`;
  }
  const altQty = fromBaseQty(qty, alt.factorToBase);
  if (altQty < 0.01) {
    return `${formatQty(qty)} ${baseSatuan}`;
  }
  return `${formatQty(qty)} ${baseSatuan} (≈ ${formatQty(altQty)} ${alt.satuan})`;
}

/** Label mutasi kartu stok: qty transaksi + qty base jika berbeda. */
export function formatKartuMutasiLabel(row: {
  masuk?: number;
  keluar?: number;
  qtyEntered?: number;
  satuan?: string;
  uomId?: string;
}): string | null {
  const qtyEntered = row.qtyEntered != null ? parseFloat(String(row.qtyEntered)) : NaN;
  const satuan = row.satuan ? String(row.satuan).trim().toUpperCase() : '';
  const baseQty = parseFloat(String(row.masuk || row.keluar || 0)) || 0;
  if (!satuan || !Number.isFinite(qtyEntered) || qtyEntered <= 0) return null;
  if (Math.abs(qtyEntered - baseQty) < 0.001) return `${formatQty(qtyEntered)} ${satuan}`;
  return `${formatQty(qtyEntered)} ${satuan} (= ${formatQty(baseQty)} base)`;
}

/** Label stok produk untuk tabel/picker — prefer stokDisplay dari API. */
export function productStockLabel(p: { stok?: number; stokDisplay?: string; satuan?: string }): string {
  if (p.stokDisplay) return p.stokDisplay;
  const qty = parseFloat(String(p.stok)) || 0;
  const unit = p.satuan ? ` ${p.satuan}` : '';
  return `${formatQty(qty)}${unit}`;
}

/** Tooltip base qty bila tampilan dual berbeda dari angka mentah. */
export function productStockTitle(p: { stok?: number; stokDisplay?: string }): string | undefined {
  const raw = parseFloat(String(p.stok));
  if (p.stokDisplay && Number.isFinite(raw) && p.stokDisplay !== String(p.stok)) {
    return `Base: ${formatQty(raw)}`;
  }
  return undefined;
}
