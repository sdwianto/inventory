/** Production Plan aggregate root — ADR-001 Sprint 3. */

import type { FpDocStatus, DocHistoryEntry } from '@/lib/food-production/document';

export const PRODUCTION_PLANS_COLLECTION = 'production_plans';

export type ProductionPlanStatus = FpDocStatus;

/** Penerima porsi MBG / SPPG. */
export const KATEGORI_PORSI_OPTIONS = [
  { value: 'PORSI_BESAR', label: 'Porsi besar', hint: 'Kelas 3 SD – SMA' },
  { value: 'PORSI_KECIL', label: 'Porsi kecil', hint: 'PAUD – SD kelas 3' },
  { value: 'POSYANDU_BUMIL_BUSUI', label: 'Posyandu Bumil Busui', hint: '' },
  { value: 'POSYANDU_BALITA', label: 'Posyandu Balita', hint: '' },
] as const;

export type KategoriPorsi = (typeof KATEGORI_PORSI_OPTIONS)[number]['value'];

const KATEGORI_PORSI_SET = new Set<string>(KATEGORI_PORSI_OPTIONS.map((o) => o.value));

export function isKategoriPorsi(v: unknown): v is KategoriPorsi {
  return typeof v === 'string' && KATEGORI_PORSI_SET.has(v);
}

export function kategoriPorsiLabel(v: string | undefined | null): string {
  if (!v) return '—';
  const opt = KATEGORI_PORSI_OPTIONS.find((o) => o.value === v);
  if (!opt) return v;
  return opt.hint ? `${opt.label} (${opt.hint})` : opt.label;
}

/** Normalize one or many kategori porsi (checkbox multi-select). Preserves option order. */
export function normalizeKategoriPorsiList(raw: unknown): KategoriPorsi[] | { error: string } {
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) list = [raw];
  else return { error: 'Minimal satu kategori porsi wajib dipilih' };

  const seen = new Set<KategoriPorsi>();
  for (const item of list) {
    const v = String(item || '').trim();
    if (!v) continue;
    if (!isKategoriPorsi(v)) return { error: `Kategori porsi tidak valid: ${v}` };
    seen.add(v);
  }
  if (!seen.size) return { error: 'Minimal satu kategori porsi wajib dipilih' };
  return KATEGORI_PORSI_OPTIONS.map((o) => o.value).filter((v) => seen.has(v));
}

export function kategoriPorsiListLabel(list: KategoriPorsi[] | undefined | null): string {
  if (!list?.length) return '—';
  return list
    .map((v) => KATEGORI_PORSI_OPTIONS.find((o) => o.value === v)?.label || v)
    .join(', ');
}

export interface ProductionPlanLine {
  menuId: string;
  menuKode?: string;
  menuNama?: string;
  /** Menu version snapshotted when plan line was saved. */
  menuVersion?: number;
  /** Kategori penerima porsi untuk baris ini (multi-select). */
  kategoriPorsiList?: KategoriPorsi[];
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
  /** @deprecated gunakan kategoriPorsiList — disimpan sebagai kategori pertama untuk kompatibilitas. */
  kategoriPorsi?: KategoriPorsi;
  /** Kategori penerima porsi (MBG) — multi-select. */
  kategoriPorsiList?: KategoriPorsi[];
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
    let kategoriPorsiList: KategoriPorsi[] | undefined;
    if (row.kategoriPorsiList !== undefined || row.kategoriPorsi !== undefined) {
      const kp = normalizeKategoriPorsiList(row.kategoriPorsiList ?? row.kategoriPorsi);
      if ('error' in kp) return { error: `Baris ${i + 1}: ${kp.error}` };
      kategoriPorsiList = kp;
    }
    lines.push({
      menuId,
      menuKode: row.menuKode != null ? String(row.menuKode) : undefined,
      menuNama: row.menuNama != null ? String(row.menuNama) : undefined,
      kategoriPorsiList,
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
