/**
 * Service Point (titik layanan) — ADR-001 Phase 5 / Sprint 19.
 * Master sekolah / tray / titik makan yang menerima distribusi dari dapur.
 */

export const SERVICE_POINTS_COLLECTION = 'service_points';

export type ServicePointJenis = 'SEKOLAH' | 'TRAY' | 'TITIK_MAKAN' | 'LAINNYA';

export interface ServicePointDoc {
  id: string;
  tenantId: string;
  kode?: string;
  nama: string;
  jenis: ServicePointJenis;
  kitchenId?: string;
  kitchenNama?: string;
  alamat?: string;
  kapasitasPorsi?: number;
  pic?: string;
  aktif: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const SERVICE_POINT_JENIS_LABELS: Record<ServicePointJenis, string> = {
  SEKOLAH: 'Sekolah',
  TRAY: 'Tray / gerai',
  TITIK_MAKAN: 'Titik makan',
  LAINNYA: 'Lainnya',
};

export function normalizeServicePointJenis(raw: unknown): ServicePointJenis {
  const v = String(raw || '').toUpperCase();
  if (v === 'SEKOLAH' || v === 'TRAY' || v === 'TITIK_MAKAN') return v;
  return 'LAINNYA';
}

export function normalizeServicePointKode(raw: unknown): string | undefined {
  const k = String(raw || '').trim().toUpperCase().replace(/\s+/g, '-');
  return k || undefined;
}

export function normalizeKapasitasPorsi(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n);
}
