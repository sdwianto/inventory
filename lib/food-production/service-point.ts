/**
 * Service Point (titik layanan) — ADR-001 Phase 5 / Sprint 19.
 * Master sekolah / tray / titik makan yang menerima distribusi dari dapur.
 */

import {
  KATEGORI_PORSI_OPTIONS,
  isKategoriPorsi,
  type KategoriPorsi,
} from '@/lib/food-production/production-plan';

export const SERVICE_POINTS_COLLECTION = 'service_points';

export type ServicePointJenis = 'SEKOLAH' | 'POSYANDU' | 'LAINNYA';

/** Qty penerima manfaat per kategori porsi. */
export type ServicePointPorsiByKategori = Partial<Record<KategoriPorsi, number>>;

export interface ServicePointDoc {
  id: string;
  tenantId: string;
  kode?: string;
  nama: string;
  jenis: ServicePointJenis;
  kitchenId?: string;
  kitchenNama?: string;
  alamat?: string;
  /**
   * Total penerima manfaat (sum kategori porsi).
   * Field name historis `kapasitasPorsi` — label UI: Penerima Manfaat.
   */
  kapasitasPorsi?: number;
  /** Rincian penerima manfaat per kategori porsi. */
  porsiByKategori?: ServicePointPorsiByKategori;
  pic?: string;
  picNoTelp?: string;
  aktif: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const SERVICE_POINT_JENIS_LABELS: Record<ServicePointJenis, string> = {
  SEKOLAH: 'Sekolah',
  POSYANDU: 'Posyandu',
  LAINNYA: 'Lainya',
};

export function normalizeServicePointJenis(raw: unknown): ServicePointJenis {
  const v = String(raw || '').toUpperCase();
  if (v === 'SEKOLAH' || v === 'POSYANDU') return v;
  return 'LAINNYA';
}

export function normalizeServicePointKode(raw: unknown): string | undefined {
  const k = String(raw || '').trim().replace(/\s+/g, '-');
  return k || undefined;
}

export function normalizeKapasitasPorsi(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n);
}

export function normalizePicNoTelp(raw: unknown): string | undefined {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits || undefined;
}

/** Parse map kategori → qty; abaikan kategori kosong / non-positif. */
export function normalizePorsiByKategori(raw: unknown): ServicePointPorsiByKategori | { error: string } {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'porsiByKategori harus object' };
  }
  const out: ServicePointPorsiByKategori = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!isKategoriPorsi(key)) {
      return { error: `Kategori porsi tidak valid: ${key}` };
    }
    if (val == null || val === '') continue;
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) {
      return { error: `Qty kategori ${key} tidak valid` };
    }
    const qty = Math.round(n);
    if (qty > 0) out[key] = qty;
  }
  return out;
}

export function sumPorsiByKategori(map: ServicePointPorsiByKategori | null | undefined): number {
  if (!map) return 0;
  let total = 0;
  for (const opt of KATEGORI_PORSI_OPTIONS) {
    total += Number(map[opt.value]) || 0;
  }
  return total;
}

/**
 * Resolve penerima manfaat:
 * - jika porsiByKategori dikirim → total = sum kategori
 * - else fallback kapasitasPorsi mentah
 */
export function resolvePenerimaManfaat(input: {
  porsiByKategori?: unknown;
  kapasitasPorsi?: unknown;
}): { porsiByKategori?: ServicePointPorsiByKategori; kapasitasPorsi?: number } | { error: string } {
  if (input.porsiByKategori !== undefined) {
    const map = normalizePorsiByKategori(input.porsiByKategori);
    if ('error' in map) return map;
    const total = sumPorsiByKategori(map);
    return {
      porsiByKategori: map,
      kapasitasPorsi: total > 0 ? total : undefined,
    };
  }
  return {
    kapasitasPorsi: normalizeKapasitasPorsi(input.kapasitasPorsi),
  };
}

export { KATEGORI_PORSI_OPTIONS };
