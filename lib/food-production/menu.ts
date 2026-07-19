/** Menu master — ADR-001 Sprint 2. References Recipes. */

export const MENUS_COLLECTION = 'menus';

/** Kelompok bahan pangan MBG (per baris isi menu). */
export const BAHAN_PANGAN_OPTIONS = [
  { value: 'BAHAN_POKOK', label: 'Bahan Pokok' },
  { value: 'PROTEIN_HEWANI', label: 'Protein Hewani' },
  { value: 'PROTEIN_NABATI', label: 'Protein Nabati' },
  { value: 'SAYUR', label: 'Sayur' },
  { value: 'BUAH', label: 'Buah' },
  { value: 'SUSU', label: 'Susu' },
  { value: 'LAINNYA', label: 'Lainya' },
] as const;

export type BahanPangan = (typeof BAHAN_PANGAN_OPTIONS)[number]['value'];

const BAHAN_PANGAN_SET = new Set<string>(BAHAN_PANGAN_OPTIONS.map((o) => o.value));

export function isBahanPangan(v: unknown): v is BahanPangan {
  return typeof v === 'string' && BAHAN_PANGAN_SET.has(v);
}

export function bahanPanganLabel(v: string | undefined | null): string {
  if (!v) return '—';
  return BAHAN_PANGAN_OPTIONS.find((o) => o.value === v)?.label || v;
}

export interface MenuItem {
  recipeId: string;
  recipeKode?: string;
  recipeNama?: string;
  /** Kelompok bahan pangan MBG untuk baris ini. */
  bahanPangan: BahanPangan;
  /** Portions contributed by this recipe in the menu (default 1). */
  porsi: number;
}

export function normalizeMenuNama(value: unknown): string {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export interface MenuDoc {
  id: string;
  tenantId: string;
  kode: string;
  /** Menu identity (independent master). */
  nama: string;
  version: number;
  effectiveDate: string;
  items: MenuItem[];
  /** Target food cost per portion (IDR), optional. */
  targetCostPerPorsi?: number;
  catatan?: string;
  /** Optional menu photo (stored via media API). */
  gambarUrl?: string;
  gambarMediaFile?: string;
  aktif: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function itemKey(recipeId: string, bahanPangan: string): string {
  return `${recipeId}::${bahanPangan}`;
}

/** Same recipeId + bahanPangan → one row; porsi summed. */
export function consolidateMenuItems(items: MenuItem[]): MenuItem[] {
  const byKey = new Map<string, MenuItem>();
  for (const item of items) {
    const recipeId = String(item.recipeId || '').trim();
    const bahanPangan = item.bahanPangan;
    if (!recipeId || !bahanPangan) continue;
    const key = itemKey(recipeId, bahanPangan);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item, recipeId, bahanPangan, porsi: Number(item.porsi) || 0 });
      continue;
    }
    existing.porsi = (Number(existing.porsi) || 0) + (Number(item.porsi) || 0);
    if (!existing.recipeKode && item.recipeKode) existing.recipeKode = item.recipeKode;
    if (!existing.recipeNama && item.recipeNama) existing.recipeNama = item.recipeNama;
  }
  return [...byKey.values()];
}

export function normalizeMenuItems(raw: unknown): MenuItem[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Menu wajib punya minimal 1 baris isi' };
  }
  const items: MenuItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const recipeId = String(row?.recipeId || '').trim();
    const porsi = Number(row?.porsi ?? 1);
    const bahanPanganRaw = String(row?.bahanPangan || '').trim();
    if (!bahanPanganRaw) return { error: `Baris ${i + 1}: bahan pangan wajib dipilih` };
    if (!isBahanPangan(bahanPanganRaw)) {
      return { error: `Baris ${i + 1}: bahan pangan tidak valid` };
    }
    if (!recipeId) return { error: `Baris ${i + 1}: resep wajib` };
    if (!Number.isFinite(porsi) || porsi <= 0) return { error: `Baris ${i + 1}: porsi harus > 0` };
    items.push({
      recipeId,
      recipeKode: row.recipeKode != null ? String(row.recipeKode) : undefined,
      recipeNama: row.recipeNama != null ? String(row.recipeNama) : undefined,
      bahanPangan: bahanPanganRaw,
      porsi,
    });
  }
  const merged = consolidateMenuItems(items);
  if (!merged.length) return { error: 'Menu wajib punya minimal 1 baris isi' };
  for (const item of merged) {
    if (!(item.porsi > 0)) {
      return { error: `Porsi resep ${item.recipeNama || item.recipeId} harus > 0` };
    }
  }
  return merged;
}
