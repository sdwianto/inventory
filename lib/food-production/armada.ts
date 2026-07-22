/**
 * Armada kendaraan distribusi MBG — master armada per dapur.
 */

export const ARMADAS_COLLECTION = 'armadas';

export interface ArmadaDoc {
  id: string;
  tenantId: string;
  kode: string;
  nama: string;
  platNomor?: string;
  /** Kapasitas muat (porsi) — opsional, untuk validasi ringan. */
  kapasitasPorsi?: number;
  kitchenId?: string;
  kitchenNama?: string;
  aktif: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function normalizeArmadaKode(raw: unknown): string | undefined {
  const k = String(raw || '').trim().replace(/\s+/g, '-').toUpperCase();
  return k || undefined;
}

export function normalizePlatNomor(raw: unknown): string | undefined {
  const p = String(raw || '').trim().replace(/\s+/g, ' ').toUpperCase();
  return p || undefined;
}

export function normalizeArmadaKapasitas(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n);
}

export function nextArmadaKode(rows: Array<{ kode?: unknown }>): string {
  let max = 0;
  for (const row of rows) {
    const match = /^ARM-(\d+)$/i.exec(String(row.kode || '').trim());
    if (!match) continue;
    max = Math.max(max, Number(match[1]) || 0);
  }
  return `ARM-${String(max + 1).padStart(2, '0')}`;
}
