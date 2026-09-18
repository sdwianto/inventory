/** Daftar produk yang tidak dipotong % porsi kecil (qty kecil = 100% qty besar). */

import { portionExceptionMatchSet } from '@/lib/food-production/recipe';

export const RECIPE_PORTION_EXCEPTIONS_COLLECTION = 'recipe_portion_exceptions';

export async function fetchPortionExceptionMatchSet(
  headers?: HeadersInit,
): Promise<Set<string>> {
  try {
    const res = await fetch('/api/recipe-portion-exceptions', { headers });
    const data = await res.json();
    if (!res.ok || !Array.isArray(data)) return new Set();
    return portionExceptionMatchSet(
      data as Array<{ productId?: string; productKode?: string }>,
    );
  } catch {
    return new Set();
  }
}

export interface RecipePortionExceptionDoc {
  id: string;
  tenantId: string;
  productId: string;
  productKode?: string;
  productNama?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}
