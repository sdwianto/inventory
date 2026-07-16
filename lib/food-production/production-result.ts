/**
 * Production Result (HSL) — ADR-001 Phase 2.
 * Catat hasil masak → stock IN finished goods.
 */

import type { DocHistoryEntry, FpDocStatus } from '@/lib/food-production/document';
import { FP_DEFAULT_TRANSITIONS, FP_OPEN_DOC_STATUSES } from '@/lib/food-production/document';
import type { ProductionPlanLine } from '@/lib/food-production/production-plan';
import type { MenuDoc } from '@/lib/food-production/menu';
import type { RecipeDoc } from '@/lib/food-production/recipe';
import { roundQty } from '@/lib/food-production/material-requirement';
import { postingDateFromIso } from '@/lib/food-production/material-issue';

export { postingDateFromIso };

export const PRODUCTION_RESULTS_COLLECTION = 'production_results';

export type ProductionResultStatus = FpDocStatus;

export interface ProductionResultLine {
  menuId: string;
  menuKode?: string;
  menuNama?: string;
  recipeId: string;
  recipeKode?: string;
  finishedGoodProductId: string;
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

export const RESULT_ELIGIBLE_PLAN_STATUSES = new Set(['APPROVED', 'PROCESSING']);

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

/** Pure: plan → menu items → FG lines with target porsi. */
export function buildResultLinesFromPlan(input: BuildResultLinesInput): BuildResultLinesResult {
  const { planLines, menusById, recipesById } = input;
  if (!planLines?.length) return { ok: false, error: 'Rencana tidak punya baris menu' };

  const warnings: string[] = [];
  const acc = new Map<string, ProductionResultLine>();

  for (const pl of planLines) {
    const menu = menusById.get(pl.menuId);
    if (!menu) return { ok: false, error: `Menu ${pl.menuId} tidak ditemukan` };
    if (menu.aktif === false) return { ok: false, error: `Menu ${menu.kode || menu.id} nonaktif` };
    if (!menu.items?.length) {
      return { ok: false, error: `Menu ${menu.kode || menu.id} tidak punya item resep` };
    }
    for (const item of menu.items) {
      const recipe = recipesById.get(item.recipeId);
      if (!recipe) return { ok: false, error: `Resep ${item.recipeId} tidak ditemukan` };
      if (recipe.aktif === false) {
        return { ok: false, error: `Resep ${recipe.kode || recipe.id} nonaktif` };
      }
      const fgId = String(recipe.finishedGoodProductId || '').trim();
      if (!fgId) {
        return { ok: false, error: `Resep ${recipe.kode || recipe.id} belum punya finished good` };
      }
      const target = roundQty(Number(pl.targetPorsi) * Number(item.porsi || 1));
      if (!(target > 0)) continue;
      const key = `${pl.menuId}::${recipe.id}::${fgId}`;
      const prev = acc.get(key);
      if (prev) {
        prev.targetPorsi = roundQty(prev.targetPorsi + target);
        prev.actualPorsi = prev.targetPorsi;
      } else {
        acc.set(key, {
          menuId: pl.menuId,
          menuKode: menu.kode || pl.menuKode,
          menuNama: menu.nama || pl.menuNama,
          recipeId: recipe.id,
          recipeKode: recipe.kode,
          finishedGoodProductId: fgId,
          finishedGoodKode: recipe.finishedGoodKode,
          finishedGoodNama: recipe.finishedGoodNama,
          satuan: 'PORSI',
          targetPorsi: target,
          actualPorsi: target,
          wastePorsi: 0,
        });
      }
    }
  }

  const lines = [...acc.values()].sort((a, b) =>
    String(a.finishedGoodNama || a.finishedGoodKode || a.finishedGoodProductId).localeCompare(
      String(b.finishedGoodNama || b.finishedGoodKode || b.finishedGoodProductId),
      'id',
    ),
  );
  if (!lines.length) return { ok: false, error: 'Tidak ada hasil yang terhitung dari rencana' };
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
    const finishedGoodProductId = String(row.finishedGoodProductId || '').trim();
    const menuId = String(row.menuId || '').trim();
    const recipeId = String(row.recipeId || '').trim();
    const targetPorsi = Number(row.targetPorsi);
    const actualPorsi = Number(row.actualPorsi);
    const wastePorsi = row.wastePorsi != null ? Number(row.wastePorsi) : 0;
    if (!finishedGoodProductId) return { error: `Baris ${i + 1}: finishedGoodProductId wajib` };
    if (!menuId) return { error: `Baris ${i + 1}: menuId wajib` };
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
  APPROVED: 'Selesai + Post Stok',
  PROCESSING: 'Selesai + Post Stok',
};

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
}): boolean {
  return input.hasCompletedIssue && !input.hasOpenIssue && !input.hasOpenResult;
}

/** Human-readable gate for Plan → COMPLETED (manual or auto). */
export function planCompleteGateMessage(input: {
  hasCompletedIssue: boolean;
  hasOpenIssue: boolean;
  hasOpenResult: boolean;
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
  return 'Rencana belum bisa selesai';
}
