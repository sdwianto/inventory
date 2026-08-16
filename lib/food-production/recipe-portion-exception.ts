/** Daftar produk yang tidak dipotong % porsi kecil (qty kecil = 100% qty besar). */

export const RECIPE_PORTION_EXCEPTIONS_COLLECTION = 'recipe_portion_exceptions';

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
