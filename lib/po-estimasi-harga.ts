/** Default estimasi harga PO = harga beli terakhir + 10% (buffer). */

import {
  resolveVendorTier,
  vendorPriceFromProduct,
  type VendorPriceProduct,
} from '@/lib/vendor-price';

export function defaultEstimasiHarga(hargaBeli: string | number | null | undefined): number {
  const beli = parseInt(String(hargaBeli || 0), 10);
  if (beli <= 0) return 0;
  return Math.round(beli * 1.1);
}

export interface PoEstimasiProduct extends VendorPriceProduct {
  syncSource?: string;
  hargaBeli?: number;
}

/** Estimasi baris PO — harga vendor sesuai tier pelanggan (ecer/grosir/spesial). */
export function poEstimasiFromProduct(
  product: PoEstimasiProduct | null | undefined,
  tierMap: Record<string, string> = {},
  defaultTier = 'ECER',
): number {
  if (!product) return 0;
  if (product.syncSource === 'sales.app') {
    const tier = resolveVendorTier(product, tierMap, defaultTier);
    return vendorPriceFromProduct(product, tier) || 0;
  }
  return defaultEstimasiHarga(product.hargaBeli);
}

/** Selisih persen estimasi/harga vendor vs harga beli di gudang. */
export function beliDeltaPercent(
  hargaBeli: string | number | null | undefined,
  hargaEstimasi: string | number | null | undefined,
): number | null {
  const beli = parseInt(String(hargaBeli || 0), 10);
  const estimasi = parseInt(String(hargaEstimasi || 0), 10);
  if (beli <= 0 || estimasi <= 0) return null;
  return Math.round(((estimasi - beli) / beli) * 100);
}

export function formatBeliDeltaSign(pct: number): string {
  if (pct === 0) return '±0%';
  if (pct > 0) return `+${pct}%`;
  return `${pct}%`;
}

export type EstimasiHargaHint =
  | { kind: 'manual'; beli: number; deltaPct: number | null; label: string }
  | { kind: 'vendor'; beli: number; vendorPrice: number; tier: string; deltaPct: number | null }
  | { kind: 'local'; beli: number; withBuffer: number; label: string };

/** Sumber estimasi harga untuk hint UI form PO. */
export function getEstimasiHargaHint(
  product: PoEstimasiProduct | null | undefined,
  tierMap: Record<string, string> = {},
  defaultTier = 'ECER',
  estimasiManual = false,
  estimasiHarga: string | number = '',
): EstimasiHargaHint | null {
  if (!product) return null;
  if (estimasiManual) {
    const beli = parseInt(String(product.hargaBeli || 0), 10);
    const manual = parseEstimasiHargaInput(estimasiHarga);
    const deltaPct = beliDeltaPercent(beli, manual);
    return {
      kind: 'manual',
      beli,
      deltaPct,
      label: deltaPct != null ? formatBeliDeltaSign(deltaPct) : 'Diubah manual',
    };
  }

  const beli = parseInt(String(product.hargaBeli || 0), 10);

  if (product.syncSource === 'sales.app') {
    const tier = resolveVendorTier(product, tierMap, defaultTier);
    const vendorPrice = vendorPriceFromProduct(product, tier);
    const deltaPct = beliDeltaPercent(beli, vendorPrice);
    return {
      kind: 'vendor',
      beli,
      vendorPrice,
      tier,
      deltaPct,
    };
  }

  const withBuffer = defaultEstimasiHarga(beli);
  return {
    kind: 'local',
    beli,
    withBuffer,
    label: beli > 0
      ? 'Beli terakhir + 10% buffer'
      : 'Belum ada harga beli — isi manual',
  };
}

export function parseEstimasiHargaInput(value: string | number | null | undefined): number {
  const n = parseInt(String(value ?? '').replace(/\D/g, ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
