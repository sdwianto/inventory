/** Menu master — ADR-001 Sprint 2. References Recipes. */

export const MENUS_COLLECTION = 'menus';

export interface MenuItem {
  recipeId: string;
  recipeKode?: string;
  recipeNama?: string;
  /** Portions contributed by this recipe in the menu (default 1). */
  porsi: number;
}

export interface MenuDoc {
  id: string;
  tenantId: string;
  kode: string;
  nama: string;
  version: number;
  effectiveDate: string;
  items: MenuItem[];
  /** Target food cost per portion (IDR), optional. */
  targetCostPerPorsi?: number;
  catatan?: string;
  aktif: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function normalizeMenuItems(raw: unknown): MenuItem[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Menu wajib punya minimal 1 resep' };
  }
  const items: MenuItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const recipeId = String(row?.recipeId || '').trim();
    const porsi = Number(row?.porsi ?? 1);
    if (!recipeId) return { error: `Baris ${i + 1}: recipeId wajib` };
    if (!Number.isFinite(porsi) || porsi <= 0) return { error: `Baris ${i + 1}: porsi harus > 0` };
    if (seen.has(recipeId)) return { error: `Resep duplikat pada baris ${i + 1}` };
    seen.add(recipeId);
    items.push({
      recipeId,
      recipeKode: row.recipeKode != null ? String(row.recipeKode) : undefined,
      recipeNama: row.recipeNama != null ? String(row.recipeNama) : undefined,
      porsi,
    });
  }
  return items;
}
