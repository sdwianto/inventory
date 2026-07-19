/** Product classification for Food Production (ADR-001). */

export const ITEM_ROLES = [
  'INGREDIENT',
  'SEMI_FINISHED',
  'FINISHED_GOOD',
  'PACKAGING',
  'CONSUMABLE',
] as const;

export type ItemRole = (typeof ITEM_ROLES)[number];

export const ITEM_ROLE_LABELS: Record<ItemRole, string> = {
  INGREDIENT: 'Bahan Baku',
  SEMI_FINISHED: 'Setengah Jadi',
  FINISHED_GOOD: 'Barang Jadi',
  PACKAGING: 'Kemasan',
  CONSUMABLE: 'Habis Pakai',
};

/** Roles shown in Produk UI (SEMI_FINISHED cadangan ADR — nanti). */
export const ITEM_ROLES_UI: ItemRole[] = ITEM_ROLES.filter((r) => r !== 'SEMI_FINISHED');

export function isItemRole(value: unknown): value is ItemRole {
  return typeof value === 'string' && (ITEM_ROLES as readonly string[]).includes(value);
}

/** Default when unset — existing products behave as generic stock items. */
export function normalizeItemRole(value: unknown, fallback: ItemRole = 'INGREDIENT'): ItemRole {
  if (isItemRole(value)) return value;
  return fallback;
}

/** Output SKU for recipe / hasil produksi. Unset role → INGREDIENT, not FG. */
export function isFinishedGoodRole(value: unknown): boolean {
  const role = normalizeItemRole(value);
  return role === 'FINISHED_GOOD' || role === 'SEMI_FINISHED';
}

/** Input materials for recipe lines. FINISHED_GOOD excluded. */
export function isIngredientRole(value: unknown): boolean {
  const role = normalizeItemRole(value);
  return (
    role === 'INGREDIENT'
    || role === 'PACKAGING'
    || role === 'CONSUMABLE'
    || role === 'SEMI_FINISHED'
  );
}
