/**
 * Field jembatan resep di master produk: recipeBaseGrams / recipeBaseMl / isiPerKemasan / satuanIsi,
 * plus metadata asal (recipeBridgeSource) yang hanya ditulis server.
 */

import {
  normalizeRecipeSatuan,
  validateIsiPerKemasan,
} from '@/lib/food-production/recipe-uom';

export const RECIPE_BRIDGE_VALUE_FIELDS = ['recipeBaseGrams', 'recipeBaseMl', 'isiPerKemasan', 'satuanIsi'] as const;

/** Metadata yang tidak boleh dikirim klien lewat PUT/POST produk. */
export const RECIPE_BRIDGE_META_FIELDS = [
  'recipeBridgeSource',
  'recipeBridgeUpdatedAt',
  'recipeBridgeConfirmedAt',
  'recipeBridgeConfirmedBy',
  'recipeBridgeConfirmedByName',
] as const;

/** MASTER = diisi manual; CONFIRMED_INFER = tebakan nama yang dikonfirmasi user. */
export type RecipeBridgeSource = 'MASTER' | 'CONFIRMED_INFER';

export type RecipeBridgeValues = {
  recipeBaseGrams: number | null;
  recipeBaseMl: number | null;
  isiPerKemasan: number | null;
  satuanIsi: string | null;
};

function parsePositive(field: string, value: unknown): { value: number | null } | { error: string } {
  if (value === null || value === '') return { value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { error: `${field} harus angka > 0 (kosongkan untuk menghapus)` };
  return { value: Math.round(n * 1e6) / 1e6 };
}

function currentValues(existing?: Record<string, unknown> | null): RecipeBridgeValues {
  const num = (v: unknown) => (v != null && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return {
    recipeBaseGrams: num(existing?.recipeBaseGrams),
    recipeBaseMl: num(existing?.recipeBaseMl),
    isiPerKemasan: num(existing?.isiPerKemasan),
    satuanIsi: normalizeRecipeSatuan(existing?.satuanIsi) || null,
  };
}

/**
 * Terapkan input jembatan resep (hanya field yang dikirim) ke nilai tersimpan.
 * `changed` = ada nilai yang benar-benar berubah.
 */
export function resolveRecipeBridgeInput(
  body: Record<string, unknown>,
  baseSatuan: string | null | undefined,
  existing?: Record<string, unknown> | null,
): { values: RecipeBridgeValues; changed: boolean; touched: boolean } | { error: string } {
  const before = currentValues(existing);
  const next: RecipeBridgeValues = { ...before };
  let touched = false;

  for (const field of ['recipeBaseGrams', 'recipeBaseMl', 'isiPerKemasan'] as const) {
    if (body[field] === undefined) continue;
    touched = true;
    const parsed = parsePositive(field, body[field]);
    if ('error' in parsed) return parsed;
    next[field] = parsed.value;
  }
  if (body.satuanIsi !== undefined) {
    touched = true;
    next.satuanIsi = normalizeRecipeSatuan(body.satuanIsi) || null;
  }

  if (touched) {
    const isiErr = validateIsiPerKemasan(baseSatuan, next.isiPerKemasan, next.satuanIsi);
    if (isiErr) return { error: isiErr };
  }

  const changed = RECIPE_BRIDGE_VALUE_FIELDS.some((k) => next[k] !== before[k]);
  return { values: next, changed, touched };
}

export function stripRecipeBridgeMeta(update: Record<string, unknown>): void {
  for (const k of RECIPE_BRIDGE_META_FIELDS) delete update[k];
}

/** $set untuk perubahan manual: sumber MASTER, konfirmasi tebakan lama tidak berlaku. */
export function manualRecipeBridgeSet(values: RecipeBridgeValues, now: Date): Record<string, unknown> {
  return {
    ...values,
    recipeBridgeSource: 'MASTER' satisfies RecipeBridgeSource,
    recipeBridgeUpdatedAt: now,
    recipeBridgeConfirmedAt: null,
    recipeBridgeConfirmedBy: null,
    recipeBridgeConfirmedByName: null,
  };
}
