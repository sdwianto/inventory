/** Production Plan aggregate root — ADR-001 Sprint 3. */

import type { FpDocStatus, DocHistoryEntry } from '@/lib/food-production/document';

export const PRODUCTION_PLANS_COLLECTION = 'production_plans';

export type ProductionPlanStatus = FpDocStatus;

export interface ProductionPlanLine {
  menuId: string;
  menuKode?: string;
  menuNama?: string;
  /** Menu version snapshotted when plan line was saved. */
  menuVersion?: number;
  /** Target portions for this menu on the plan date. */
  targetPorsi: number;
  notes?: string;
}

export interface ProductionPlanDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  /** Production / serving date (YYYY-MM-DD). */
  tanggal: string;
  kitchenId: string;
  kitchenNama?: string;
  /** Denorm from kitchen.defaultWarehouseKode — for MRP / Issue later. */
  kitchenWarehouseKode?: string;
  lines: ProductionPlanLine[];
  status: ProductionPlanStatus;
  history: DocHistoryEntry[];
  catatan?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

/** Accepts YYYY-MM-DD only. */
export function isIsoDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === value;
}

export function summarizePlanLines(lines: ProductionPlanLine[] | undefined, max = 2): string {
  const list = lines || [];
  if (!list.length) return '—';
  const parts = list.slice(0, max).map((l) => {
    const name = l.menuNama || l.menuKode || l.menuId;
    return `${name} (${l.targetPorsi})`;
  });
  if (list.length > max) parts.push(`+${list.length - max} lain`);
  return parts.join(', ');
}

export function normalizePlanLines(raw: unknown): ProductionPlanLine[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Rencana wajib punya minimal 1 baris menu' };
  }
  const lines: ProductionPlanLine[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const menuId = String(row?.menuId || '').trim();
    const targetPorsi = Number(row?.targetPorsi);
    if (!menuId) return { error: `Baris ${i + 1}: menuId wajib` };
    if (!Number.isFinite(targetPorsi) || targetPorsi <= 0) {
      return { error: `Baris ${i + 1}: target porsi harus > 0` };
    }
    if (seen.has(menuId)) return { error: `Menu duplikat pada baris ${i + 1}` };
    seen.add(menuId);
    lines.push({
      menuId,
      menuKode: row.menuKode != null ? String(row.menuKode) : undefined,
      menuNama: row.menuNama != null ? String(row.menuNama) : undefined,
      targetPorsi,
      notes: row.notes != null ? String(row.notes).trim() || undefined : undefined,
    });
  }
  return lines;
}

export function isPlanEditable(status: string): boolean {
  return status === 'DRAFT' || status === 'SUBMITTED';
}

export function totalTargetPorsi(lines: ProductionPlanLine[] | undefined): number {
  return (lines || []).reduce((s, l) => s + (Number(l.targetPorsi) || 0), 0);
}

export const PLAN_STATUS_LABELS: Record<ProductionPlanStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Diajukan',
  APPROVED: 'Disetujui',
  PROCESSING: 'Diproses',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
};
