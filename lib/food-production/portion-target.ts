/**
 * Daily portion targets by beneficiary category — acuan rencana produksi.
 *
 * Core submodule (confirmed docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md Sprint 3):
 * feeds directly into Production Plan / Material Requirement, part of the
 * Procurement → Production → Dispatch flow. Not a candidate for extraction.
 */

import {
  KATEGORI_PORSI_LEGACY,
  KATEGORI_PORSI_OPTIONS,
  type KategoriPorsiCurrent,
} from '@/lib/food-production/production-plan';

export const PORTION_TARGETS_COLLECTION = 'portion_targets';

export type PortionTargetMap = Record<KategoriPorsiCurrent, number>;

export interface PortionTargetDoc {
  id: string;
  tenantId: string;
  /** Hari menu / distribusi pagi YYYY-MM-DD (bukan tanggal masak). */
  tanggal: string;
  kitchenId: string;
  kitchenNama?: string;
  targets: PortionTargetMap;
  createdAt: Date;
  updatedAt: Date;
  updatedBy?: string;
  updatedByName?: string;
}

export function emptyPortionTargets(): PortionTargetMap {
  return {
    PORSI_KECIL: 0,
    PORSI_BESAR: 0,
    POSYANDU_BALITA: 0,
    POSYANDU_BUMIL: 0,
    POSYANDU_BUSUI: 0,
    ORGANOLEPTIK: 0,
  };
}

export function emptyPortionDraft(): Record<KategoriPorsiCurrent, string> {
  return {
    PORSI_KECIL: '0',
    PORSI_BESAR: '0',
    POSYANDU_BALITA: '0',
    POSYANDU_BUMIL: '0',
    POSYANDU_BUSUI: '0',
    ORGANOLEPTIK: '0',
  };
}

export function portionDraftFromTargets(
  targets: PortionTargetMap,
): Record<KategoriPorsiCurrent, string> {
  const out = emptyPortionDraft();
  for (const opt of KATEGORI_PORSI_OPTIONS) {
    out[opt.value] = String(targets[opt.value] ?? 0);
  }
  return out;
}

export function sumSekolahPorsi(map: Partial<Record<string, number>> | null | undefined): number {
  if (!map) return 0;
  return Math.max(0, Number(map.PORSI_KECIL) || 0) + Math.max(0, Number(map.PORSI_BESAR) || 0);
}

export function sumPosyanduPorsi(map: Partial<Record<string, number>> | null | undefined): number {
  if (!map) return 0;
  const balita = Math.max(0, Number(map.POSYANDU_BALITA) || 0);
  const bumil = Math.max(0, Number(map.POSYANDU_BUMIL) || 0);
  const busui = Math.max(0, Number(map.POSYANDU_BUSUI) || 0);
  const organo = Math.max(0, Number(map.ORGANOLEPTIK) || 0);
  const legacy = (bumil > 0 || busui > 0)
    ? 0
    : Math.max(0, Number(map[KATEGORI_PORSI_LEGACY]) || 0);
  return balita + bumil + busui + organo + legacy;
}

export function sumAllPorsi(map: Partial<Record<string, number>> | null | undefined): number {
  return sumSekolahPorsi(map) + sumPosyanduPorsi(map);
}

/**
 * Isi 6 kunci UI. Payload lama yang hanya punya POSYANDU_BUMIL_BUSUI:
 * angka masuk ke PB Bumil; Busui = 0 (tidak menebak split 27/76).
 */
export function normalizePortionTargets(raw: unknown): PortionTargetMap | { error: string } {
  const out = emptyPortionTargets();
  if (raw == null || typeof raw !== 'object') {
    return out;
  }
  const obj = raw as Record<string, unknown>;
  for (const opt of KATEGORI_PORSI_OPTIONS) {
    const n = Number(obj[opt.value] ?? 0);
    if (!Number.isFinite(n) || n < 0) {
      return { error: `${opt.label}: porsi tidak valid` };
    }
    out[opt.value] = Math.floor(n);
  }
  const hasSplitBumilBusui = (out.POSYANDU_BUMIL > 0) || (out.POSYANDU_BUSUI > 0);
  if (!hasSplitBumilBusui) {
    const legacyRaw = obj[KATEGORI_PORSI_LEGACY];
    if (legacyRaw != null && legacyRaw !== '') {
      const legacy = Number(legacyRaw);
      if (!Number.isFinite(legacy) || legacy < 0) {
        return { error: 'Porsi Besar Posyandu (lama): porsi tidak valid' };
      }
      out.POSYANDU_BUMIL = Math.floor(legacy);
    }
  }
  return out;
}
