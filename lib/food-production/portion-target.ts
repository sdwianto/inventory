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
  expandLegacyKategoriPorsi,
  planRecipientPorsi,
  type KategoriPorsiCurrent,
  type ProductionPlanLine,
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

export function portionTargetKey(tanggal: string, kitchenId: string): string {
  return `${String(tanggal || '').trim()}::${String(kitchenId || '').trim()}`;
}

/** Penerima per kategori dari panel, dibatasi kategori rencana; null bila panel kosong/tidak valid. */
export function resolvePlanPenerimaByKategori(
  plan: { kategoriPorsiList?: readonly string[] | null },
  targets?: Partial<Record<string, number>> | null,
): Record<string, number> | null {
  if (!targets) return null;
  const norm = normalizePortionTargets(targets);
  if ('error' in norm) return null;
  const kp = expandLegacyKategoriPorsi(plan.kategoriPorsiList);
  const keys = kp.length ? kp : (Object.keys(norm) as string[]);
  const out: Record<string, number> = {};
  for (const k of keys) {
    const n = Number((norm as Record<string, number>)[k]) || 0;
    if (n > 0) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

export interface PlanPenerima {
  penerimaPorsi: number;
  /** Hanya bila dari panel Kategori Porsi — dipakai menggabung total harian tanpa hitung dobel. */
  penerimaByKategori?: Record<string, number>;
}

/**
 * Jumlah penerima makan RPN = total panel Kategori Porsi (tanggal + dapur), dibatasi kategori RPN.
 * Tidak melebihi porsi yang dimasak RPN (mis. RPN ad-hoc untuk sebagian penerima): bila porsi baris
 * lebih kecil, itu yang dipakai dan rincian per kategori diskalakan.
 * Cadangan bila acuan belum diisi: dari baris resep (porsi terbesar per kelompok kategori).
 */
export function resolvePlanPenerima(
  plan: { lines?: ProductionPlanLine[]; kategoriPorsiList?: readonly string[] | null },
  targets?: Partial<Record<string, number>> | null,
): PlanPenerima {
  const fromLines = planRecipientPorsi(plan.lines, plan.kategoriPorsiList);
  const panel = resolvePlanPenerimaByKategori(plan, targets);
  if (!panel) return { penerimaPorsi: fromLines };
  const panelTotal = Object.values(panel).reduce((s, n) => s + n, 0);
  if (fromLines > 0 && fromLines < panelTotal) {
    const f = fromLines / panelTotal;
    return {
      penerimaPorsi: fromLines,
      penerimaByKategori: Object.fromEntries(
        Object.entries(panel).map(([k, n]) => [k, Math.round(n * f * 100) / 100]),
      ),
    };
  }
  return { penerimaPorsi: panelTotal, penerimaByKategori: panel };
}

export function resolvePlanPenerimaPorsi(
  plan: { lines?: ProductionPlanLine[]; kategoriPorsiList?: readonly string[] | null },
  targets?: Partial<Record<string, number>> | null,
): number {
  return resolvePlanPenerima(plan, targets).penerimaPorsi;
}
