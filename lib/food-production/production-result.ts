/**
 * Production Result (HSL) — ADR-001 Phase 2.
 * Catat hasil masak → stock IN finished goods.
 */

import type { DocHistoryEntry, FpDocStatus } from '@/lib/food-production/document';
import { FP_DEFAULT_TRANSITIONS, FP_OPEN_DOC_STATUSES } from '@/lib/food-production/document';
import {
  resolvePlanLineRecipeSlots,
  type ProductionPlanLine,
} from '@/lib/food-production/production-plan';
import type { MenuDoc } from '@/lib/food-production/menu';
import type { RecipeDoc } from '@/lib/food-production/recipe';
import { roundQty } from '@/lib/food-production/material-requirement';
import { postingDateFromIso } from '@/lib/food-production/material-issue';

export { postingDateFromIso };

export const PRODUCTION_RESULTS_COLLECTION = 'production_results';

export type ProductionResultStatus = FpDocStatus;

export interface ProductionResultLine {
  /** Legacy — kosong bila baris dari resep langsung di rencana. */
  menuId?: string;
  menuKode?: string;
  menuNama?: string;
  recipeId: string;
  recipeKode?: string;
  recipeNama?: string;
  /** Optional — MBG biasanya kosong (langsung distribusi, tidak masuk stok FG). */
  finishedGoodProductId?: string;
  finishedGoodKode?: string;
  finishedGoodNama?: string;
  satuan?: string;
  targetPorsi: number;
  actualPorsi: number;
  wastePorsi?: number;
  notes?: string;
}

export interface ProductionResultDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  productionPlanId: string;
  productionPlanNo?: string;
  materialIssueId?: string;
  materialIssueNo?: string;
  tanggal: string;
  kitchenId: string;
  kitchenNama?: string;
  warehouseKode: string;
  lines: ProductionResultLine[];
  status: ProductionResultStatus;
  history: DocHistoryEntry[];
  summary: {
    lineCount: number;
    targetPorsiTotal: number;
    actualPorsiTotal: number;
    wastePorsiTotal: number;
    warnings?: string[];
  };
  stockPostedAt?: Date;
  /** Phase 4 — batch stamped on COMPLETE. */
  batchNo?: string;
  expiryDate?: string;
  catatan?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

export const RESULT_ELIGIBLE_PLAN_STATUSES = new Set(['APPROVED', 'PROCESSING', 'COMPLETED']);

/** Status rencana ideal untuk catat HSL (catch-up COMPLETED tetap diizinkan API). */
export const RESULT_PRIMARY_PLAN_STATUSES = new Set(['APPROVED', 'PROCESSING']);

export const RESULT_OPEN_STATUSES = FP_OPEN_DOC_STATUSES;

export function isResultEditable(status: string): boolean {
  return status === 'DRAFT' || status === 'SUBMITTED';
}

export type BuildResultLinesInput = {
  planLines: ProductionPlanLine[];
  menusById: Map<string, MenuDoc>;
  recipesById: Map<string, RecipeDoc>;
};

export type BuildResultLinesResult =
  | { ok: true; lines: ProductionResultLine[]; warnings: string[] }
  | { ok: false; error: string };

/** Pure: plan → resep (langsung atau via menu legacy) → baris hasil (porsi). */
export function buildResultLinesFromPlan(input: BuildResultLinesInput): BuildResultLinesResult {
  const { planLines, menusById, recipesById } = input;
  if (!planLines?.length) return { ok: false, error: 'Rencana tidak punya baris resep' };

  const warnings: string[] = [];
  const acc = new Map<string, ProductionResultLine>();

  for (const pl of planLines) {
    const resolved = resolvePlanLineRecipeSlots(pl, menusById);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    for (const slot of resolved.slots) {
      const recipe = recipesById.get(slot.recipeId);
      if (!recipe) return { ok: false, error: `Resep ${slot.recipeId} tidak ditemukan` };
      if (recipe.aktif === false) {
        return { ok: false, error: `Resep ${recipe.kode || recipe.id} nonaktif` };
      }
      const fgId = String(recipe.finishedGoodProductId || '').trim() || undefined;
      const target = roundQty(Number(pl.targetPorsi) * Number(slot.recipeFactor || 1));
      if (!(target > 0)) continue;
      const key = `${slot.menuId || '_'}::${recipe.id}::${fgId || '_'}`;
      const prev = acc.get(key);
      if (prev) {
        prev.targetPorsi = roundQty(prev.targetPorsi + target);
        prev.actualPorsi = prev.targetPorsi;
      } else {
        acc.set(key, {
          menuId: slot.menuId,
          menuKode: slot.menuKode || pl.menuKode,
          menuNama: slot.menuNama || pl.menuNama,
          recipeId: recipe.id,
          recipeKode: recipe.kode,
          recipeNama: recipe.nama,
          finishedGoodProductId: fgId,
          finishedGoodKode: fgId ? recipe.finishedGoodKode : undefined,
          finishedGoodNama: fgId
            ? recipe.finishedGoodNama
            : (recipe.nama || recipe.kode || slot.menuNama || pl.recipeNama),
          satuan: 'PORSI',
          targetPorsi: target,
          actualPorsi: target,
          wastePorsi: 0,
        });
      }
    }
  }

  const lines = [...acc.values()].sort((a, b) =>
    String(a.finishedGoodNama || a.recipeNama || a.menuNama || a.recipeKode || '').localeCompare(
      String(b.finishedGoodNama || b.recipeNama || b.menuNama || b.recipeKode || ''),
      'id',
    ),
  );
  if (!lines.length) return { ok: false, error: 'Tidak ada hasil yang terhitung dari rencana' };
  const withoutFg = lines.filter((l) => !l.finishedGoodProductId).length;
  if (withoutFg > 0) {
    warnings.push(
      `${withoutFg} baris tanpa finished good — mode MBG: porsi dicatat, stok FG tidak diposting (langsung distribusi).`,
    );
  }
  return { ok: true, lines, warnings };
}

export function summarizeResultLines(lines: ProductionResultLine[]): ProductionResultDoc['summary'] {
  return {
    lineCount: lines.length,
    targetPorsiTotal: roundQty(lines.reduce((s, l) => s + (Number(l.targetPorsi) || 0), 0)),
    actualPorsiTotal: roundQty(lines.reduce((s, l) => s + (Number(l.actualPorsi) || 0), 0)),
    wastePorsiTotal: roundQty(lines.reduce((s, l) => s + (Number(l.wastePorsi) || 0), 0)),
  };
}

export function normalizeResultLines(raw: unknown): ProductionResultLine[] | { error: string } {
  if (!Array.isArray(raw) || !raw.length) {
    return { error: 'Minimal satu baris hasil' };
  }
  const out: ProductionResultLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const finishedGoodProductId = String(row.finishedGoodProductId || '').trim() || undefined;
    const menuId = String(row.menuId || '').trim() || undefined;
    const recipeId = String(row.recipeId || '').trim();
    const targetPorsi = Number(row.targetPorsi);
    const actualPorsi = Number(row.actualPorsi);
    const wastePorsi = row.wastePorsi != null ? Number(row.wastePorsi) : 0;
    if (!recipeId) return { error: `Baris ${i + 1}: recipeId wajib` };
    if (!Number.isFinite(targetPorsi) || targetPorsi < 0) {
      return { error: `Baris ${i + 1}: targetPorsi tidak valid` };
    }
    if (!Number.isFinite(actualPorsi) || actualPorsi < 0) {
      return { error: `Baris ${i + 1}: actualPorsi tidak valid` };
    }
    if (!Number.isFinite(wastePorsi) || wastePorsi < 0) {
      return { error: `Baris ${i + 1}: wastePorsi tidak valid` };
    }
    if (actualPorsi <= 0 && wastePorsi <= 0) {
      return { error: `Baris ${i + 1}: actualPorsi atau wastePorsi harus > 0` };
    }
    out.push({
      menuId,
      menuKode: row.menuKode != null ? String(row.menuKode) : undefined,
      menuNama: row.menuNama != null ? String(row.menuNama) : undefined,
      recipeId,
      recipeKode: row.recipeKode != null ? String(row.recipeKode) : undefined,
      recipeNama: row.recipeNama != null ? String(row.recipeNama) : undefined,
      finishedGoodProductId,
      finishedGoodKode: row.finishedGoodKode != null ? String(row.finishedGoodKode) : undefined,
      finishedGoodNama: row.finishedGoodNama != null ? String(row.finishedGoodNama) : undefined,
      satuan: row.satuan != null ? String(row.satuan) : 'PORSI',
      targetPorsi: roundQty(targetPorsi),
      actualPorsi: roundQty(actualPorsi),
      wastePorsi: roundQty(wastePorsi),
      notes: row.notes != null ? String(row.notes).trim() || undefined : undefined,
    });
  }
  return out;
}

export const RESULT_STATUS_LABELS: Record<ProductionResultStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Diajukan',
  APPROVED: 'Disetujui',
  PROCESSING: 'Diproses',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
};

/** Result may go APPROVED → COMPLETED (stock post) without mandatory PROCESSING step. */
export const RESULT_STATUS_TRANSITIONS: Record<string, string[]> = {
  ...FP_DEFAULT_TRANSITIONS,
  APPROVED: ['PROCESSING', 'COMPLETED', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'CANCELLED'],
};

/** Primary UI path (APPROVED may skip PROCESSING). */
export const RESULT_UI_STATUS_NEXT: Partial<Record<ProductionResultStatus, ProductionResultStatus>> = {
  DRAFT: 'SUBMITTED',
  SUBMITTED: 'APPROVED',
  APPROVED: 'COMPLETED',
  PROCESSING: 'COMPLETED',
};

export const RESULT_UI_STATUS_NEXT_LABEL: Partial<Record<ProductionResultStatus, string>> = {
  DRAFT: 'Ajukan',
  SUBMITTED: 'Setujui',
  APPROVED: 'Selesai',
  PROCESSING: 'Selesai',
};

/** True if any line would post FG stock (manufaktur). MBG biasanya false. */
export function resultHasStockableLines(lines: ProductionResultLine[]): boolean {
  return lines.some(
    (l) => Boolean(String(l.finishedGoodProductId || '').trim()) && Number(l.actualPorsi) > 0,
  );
}

/** Kitchen integrity before posting Result stock / closing plan. */
export function assertResultStockGate(input: {
  hasCompletedIssue: boolean;
  hasOpenIssue: boolean;
}): string | null {
  if (input.hasOpenIssue) {
    return 'Masih ada pengambilan bahan (PBL) terbuka — selesaikan atau batalkan dulu';
  }
  if (!input.hasCompletedIssue) {
    return 'Belum ada pengambilan bahan (PBL) selesai untuk rencana ini';
  }
  return null;
}

export function assertPlanCanComplete(input: {
  hasCompletedIssue: boolean;
  hasOpenIssue: boolean;
  hasOpenResult: boolean;
  hasCompletedResult: boolean;
}): boolean {
  return (
    input.hasCompletedIssue
    && !input.hasOpenIssue
    && !input.hasOpenResult
    && input.hasCompletedResult
  );
}

/** Human-readable gate for Plan → COMPLETED (manual or auto). */
export function planCompleteGateMessage(input: {
  hasCompletedIssue: boolean;
  hasOpenIssue: boolean;
  hasOpenResult: boolean;
  hasCompletedResult: boolean;
}): string | null {
  if (assertPlanCanComplete(input)) return null;
  if (!input.hasCompletedIssue) {
    return 'Rencana belum bisa selesai: wajib ada pengambilan bahan (PBL) selesai';
  }
  if (input.hasOpenIssue) {
    return 'Rencana belum bisa selesai: masih ada pengambilan bahan (PBL) terbuka';
  }
  if (input.hasOpenResult) {
    return 'Rencana belum bisa selesai: masih ada hasil produksi (HSL) terbuka';
  }
  if (!input.hasCompletedResult) {
    return 'Rencana belum bisa selesai: wajib catat & selesaikan hasil produksi (HSL) dulu';
  }
  return 'Rencana belum bisa selesai';
}
