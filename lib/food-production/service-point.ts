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

/**
 * Jam pengiriman tambahan per titik (bukan titik lokasi).
 * Contoh: 08:50, 09:00 — keterangan opsional.
 */
export interface ServicePointDrop {
  id: string;
  /** Jam pengiriman (HH:mm) — wajib. */
  jamKirim: string;
  /** Keterangan singkat opsional (bukan nama titik). */
  label?: string;
  /** Petunjuk qty porsi di jam ini (opsional). */
  qtyHint?: number;
  catatan?: string;
}

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
  /**
   * Jam makan / jam kirim target (HH:mm, lokal dapur).
   * Label UI lapangan: Jam Makan.
   */
  jamKirim?: string;
  /** Jam pengiriman tambahan (opsional), selain Jam Makan. */
  drops?: ServicePointDrop[];
  pic?: string;
  picNoTelp?: string;
  aktif: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Label singkat kategori untuk catatan lapangan (PK / PB). */
export const KATEGORI_PORSI_SHORT: Partial<Record<KategoriPorsi, string>> = {
  PORSI_KECIL: 'PK',
  PORSI_BESAR: 'PB',
  POSYANDU_BUMIL_BUSUI: 'Bumil',
  POSYANDU_BALITA: 'Balita',
};

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

/** Normalize jam makan/kirim ke HH:mm (00–23:59). Kosong → undefined. */
export function normalizeJamKirim(raw: unknown): string | undefined | { error: string } {
  if (raw == null || raw === '') return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return { error: 'Jam makan harus format HH:mm' };
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return { error: 'Jam makan tidak valid' };
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Parse jam pengiriman tambahan (drops) — field utama = jam, bukan titik lokasi. */
export function normalizeServicePointDrops(
  raw: unknown,
): ServicePointDrop[] | { error: string } {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: 'drops harus array' };
  const out: ServicePointDrop[] = [];
  const seenJam = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const jam = normalizeJamKirim(row?.jamKirim);
    if (jam && typeof jam === 'object' && 'error' in jam) {
      return { error: `Jam pengiriman ${i + 1}: ${jam.error}` };
    }
    if (!jam) return { error: `Jam pengiriman ${i + 1}: jam wajib` };
    if (seenJam.has(jam)) return { error: `Jam pengiriman duplikat: ${jam}` };
    seenJam.add(jam);
    const label = String(row?.label || row?.catatan || '').trim() || undefined;
    let qtyHint: number | undefined;
    if (row?.qtyHint != null && row.qtyHint !== '') {
      const n = Number(row.qtyHint);
      if (!Number.isFinite(n) || n < 0) {
        return { error: `Jam pengiriman ${jam}: qty tidak valid` };
      }
      qtyHint = Math.round(n) || undefined;
    }
    const id = String(row?.id || '').trim() || `drop-${jam.replace(':', '')}`;
    out.push({
      id,
      jamKirim: jam,
      label,
      qtyHint,
      catatan: String(row?.catatan || '').trim() || undefined,
    });
  }
  out.sort((a, b) => compareJamKirim(a.jamKirim, b.jamKirim));
  return out;
}

/** Tampilkan daftar jam pengiriman untuk UI tabel. */
export function formatServicePointDropsJam(
  drops?: ServicePointDrop[] | null,
): string {
  const times = (drops || [])
    .map((d) => d.jamKirim)
    .filter(Boolean)
    .sort(compareJamKirim);
  return times.length ? times.join(', ') : '—';
}

/** Urutkan titik berdasarkan jamKirim naik; tanpa jam di akhir. */
export function compareJamKirim(a?: string | null, b?: string | null): number {
  const aa = String(a || '').trim();
  const bb = String(b || '').trim();
  if (!aa && !bb) return 0;
  if (!aa) return 1;
  if (!bb) return -1;
  return aa.localeCompare(bb);
}

/**
 * Jam untuk urutan rute pengiriman:
 * drop terawal (jam pengiriman), fallback Jam Makan.
 */
export function routeJamKirim(input: {
  jamKirim?: string | null;
  drops?: Array<{ jamKirim?: string | null }> | null;
}): string | undefined {
  const fromDrops = (input.drops || [])
    .map((d) => String(d?.jamKirim || '').trim())
    .filter(Boolean)
    .sort(compareJamKirim)[0];
  if (fromDrops) return fromDrops;
  const jam = String(input.jamKirim || '').trim();
  return jam || undefined;
}

/** Bandingkan dua titik untuk urutan rute (drop → Jam Makan → nama). */
export function compareServicePointRouteOrder(
  a: { jamKirim?: string | null; drops?: Array<{ jamKirim?: string | null }> | null; nama?: string },
  b: { jamKirim?: string | null; drops?: Array<{ jamKirim?: string | null }> | null; nama?: string },
): number {
  const byJam = compareJamKirim(routeJamKirim(a), routeJamKirim(b));
  if (byJam !== 0) return byJam;
  return String(a.nama || '').localeCompare(String(b.nama || ''), 'id');
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
