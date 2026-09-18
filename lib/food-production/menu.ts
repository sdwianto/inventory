/** Menu master — ADR-001 Sprint 2. References Recipes. Fase 3: slot = kategoriMenu. */

import {
  KATEGORI_MENU_OPTIONS,
  isKategoriMenu,
  kategoriMenuLabel,
  type KategoriMenu,
} from '@/lib/food-production/recipe';

export const MENUS_COLLECTION = 'menus';

/** @deprecated Fase 3 — alias lama; kanonik = kategoriMenu resep. Masih dibaca. */
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

export const BAHAN_PANGAN_TO_KATEGORI_MENU: Record<BahanPangan, KategoriMenu> = {
  BAHAN_POKOK: 'KARBOHIDRAT',
  PROTEIN_HEWANI: 'LAUK_HEWANI',
  PROTEIN_NABATI: 'LAUK_NABATI',
  SAYUR: 'SAYUR',
  BUAH: 'BUAH',
  SUSU: 'SUSU',
  LAINNYA: 'GARNISH',
};

export const KATEGORI_MENU_TO_BAHAN_PANGAN: Record<KategoriMenu, BahanPangan> = {
  KARBOHIDRAT: 'BAHAN_POKOK',
  LAUK_HEWANI: 'PROTEIN_HEWANI',
  LAUK_NABATI: 'PROTEIN_NABATI',
  SAYUR: 'SAYUR',
  BUAH: 'BUAH',
  SUSU: 'SUSU',
  GARNISH: 'LAINNYA',
};

export function isBahanPangan(v: unknown): v is BahanPangan {
  return typeof v === 'string' && BAHAN_PANGAN_SET.has(v);
}

export function bahanPanganLabel(v: string | undefined | null): string {
  if (!v) return '—';
  return BAHAN_PANGAN_OPTIONS.find((o) => o.value === v)?.label || v;
}

export function kategoriMenuFromBahanPangan(v: unknown): KategoriMenu | null {
  if (!isBahanPangan(v)) return null;
  return BAHAN_PANGAN_TO_KATEGORI_MENU[v];
}

export function bahanPanganFromKategoriMenu(v: unknown): BahanPangan | null {
  if (!isKategoriMenu(v)) return null;
  return KATEGORI_MENU_TO_BAHAN_PANGAN[v];
}

/** Kanonik: kategoriMenu; bahanPangan lama di-map. */
export function resolveMenuItemKategoriMenu(row: {
  kategoriMenu?: unknown;
  bahanPangan?: unknown;
} | null | undefined): KategoriMenu | null {
  if (isKategoriMenu(row?.kategoriMenu)) return row.kategoriMenu;
  return kategoriMenuFromBahanPangan(row?.bahanPangan);
}

export interface MenuItem {
  recipeId: string;
  recipeKode?: string;
  recipeNama?: string;
  /** Slot papan minggu — sama dengan recipe.kategoriMenu. */
  kategoriMenu: KategoriMenu;
  /** Alias lama (Fase 3: tetap ditulis agar dokumen lama/API lama aman). */
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

function itemKey(recipeId: string, kategoriMenu: string): string {
  return `${recipeId}::${kategoriMenu}`;
}

function pairFromRow(row: Record<string, unknown>): {
  kategoriMenu: KategoriMenu;
  bahanPangan: BahanPangan;
} | { error: string } {
  const km = resolveMenuItemKategoriMenu(row);
  if (!km) {
    return { error: 'kategori menu wajib dipilih' };
  }
  const bp = bahanPanganFromKategoriMenu(km) || 'LAINNYA';
  return { kategoriMenu: km, bahanPangan: bp };
}

/** Same recipeId + kategoriMenu → one row; porsi summed. */
export function consolidateMenuItems(items: MenuItem[]): MenuItem[] {
  const byKey = new Map<string, MenuItem>();
  for (const item of items) {
    const recipeId = String(item.recipeId || '').trim();
    const kategoriMenu = item.kategoriMenu;
    if (!recipeId || !kategoriMenu) continue;
    const key = itemKey(recipeId, kategoriMenu);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...item,
        recipeId,
        kategoriMenu,
        bahanPangan: item.bahanPangan || bahanPanganFromKategoriMenu(kategoriMenu) || 'LAINNYA',
        porsi: Number(item.porsi) || 0,
      });
      continue;
    }
    existing.porsi = (Number(existing.porsi) || 0) + (Number(item.porsi) || 0);
    if (!existing.recipeKode && item.recipeKode) existing.recipeKode = item.recipeKode;
    if (!existing.recipeNama && item.recipeNama) existing.recipeNama = item.recipeNama;
  }
  return [...byKey.values()];
}

export function presentMenuItem(raw: unknown): MenuItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const recipeId = String(row.recipeId || '').trim();
  if (!recipeId) return null;
  const pair = pairFromRow(row);
  if ('error' in pair) return null;
  const porsi = Number(row.porsi);
  return {
    recipeId,
    recipeKode: row.recipeKode != null ? String(row.recipeKode) : undefined,
    recipeNama: row.recipeNama != null ? String(row.recipeNama) : undefined,
    kategoriMenu: pair.kategoriMenu,
    bahanPangan: pair.bahanPangan,
    porsi: Number.isFinite(porsi) && porsi > 0 ? porsi : 1,
  };
}

export function presentMenuItems(raw: unknown): MenuItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(presentMenuItem).filter((x): x is MenuItem => Boolean(x));
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
    const pair = pairFromRow(row || {});
    if ('error' in pair) {
      return { error: `Baris ${i + 1}: ${pair.error}` };
    }
    if (!recipeId) return { error: `Baris ${i + 1}: resep wajib` };
    if (!Number.isFinite(porsi) || porsi <= 0) return { error: `Baris ${i + 1}: porsi harus > 0` };
    items.push({
      recipeId,
      recipeKode: row.recipeKode != null ? String(row.recipeKode) : undefined,
      recipeNama: row.recipeNama != null ? String(row.recipeNama) : undefined,
      kategoriMenu: pair.kategoriMenu,
      bahanPangan: pair.bahanPangan,
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

export function menuItemSlotLabel(item: Pick<MenuItem, 'kategoriMenu' | 'bahanPangan'>): string {
  return kategoriMenuLabel(item.kategoriMenu) || bahanPanganLabel(item.bahanPangan);
}

export { KATEGORI_MENU_OPTIONS, kategoriMenuLabel };
