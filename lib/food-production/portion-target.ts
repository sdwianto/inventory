/**
 * Daily portion targets by beneficiary category — acuan rencana produksi.
 *
 * Core submodule (confirmed docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md Sprint 3):
 * feeds directly into Production Plan / Material Requirement, part of the
 * Procurement → Production → Dispatch flow. Not a candidate for extraction.
 */

import {
  KATEGORI_PORSI_OPTIONS,
  type KategoriPorsi,
} from '@/lib/food-production/production-plan';

export const PORTION_TARGETS_COLLECTION = 'portion_targets';

export type PortionTargetMap = Record<KategoriPorsi, number>;

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
    PORSI_BESAR: 0,
    PORSI_KECIL: 0,
    POSYANDU_BUMIL_BUSUI: 0,
    POSYANDU_BALITA: 0,
  };
}

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
  return out;
}
