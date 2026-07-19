import { describe, expect, it } from 'vitest';
import {
  matchImportProduct,
  parseRecipeImportAoa,
  parseRecipeImportExcel,
  recipeImportTemplateXlsxBuffer,
  RECIPE_IMPORT_HEADERS,
  MBG_RECIPE_SEED_ROWS,
} from '@/lib/food-production/recipe-import';

const products = [
  { id: 'p1', kode: 'BERAS', nama: 'Beras', satuan: 'KG', itemRole: 'INGREDIENT' },
  { id: 'p2', kode: 'AYAM', nama: 'Ayam', satuan: 'KG', itemRole: 'INGREDIENT' },
  { id: 'p3', kode: 'T-001', nama: 'Tepung Terigu', satuan: 'KG', itemRole: 'INGREDIENT' },
];

describe('recipe import bank (Excel)', () => {
  it('matches by kode then nama', () => {
    expect(matchImportProduct(products, 'AYAM', '')?.product.id).toBe('p2');
    expect(matchImportProduct(products, '', 'Tepung Terigu')?.match).toBe('nama');
    expect(matchImportProduct(products, 'XYZ', 'Tidak Ada')).toBeNull();
  });

  it('parses AOA / Excel sheet into recipe drafts', () => {
    const aoa = [
      [...RECIPE_IMPORT_HEADERS],
      ['Nasi Putih', 100, '2026-07-17', 2, '', 'BERAS', 'Beras', 12, 'KG', ''],
      ['Nasi Putih', 100, '2026-07-17', 2, '', '', 'Ayam', 1, 'KG', ''],
    ];
    const parsed = parseRecipeImportAoa(aoa, products);
    expect(parsed.errors).toEqual([]);
    expect(parsed.recipes).toHaveLength(1);
    expect(parsed.recipes[0].ok).toBe(true);
    expect(parsed.recipes[0].lines).toHaveLength(2);
  });

  it('builds and re-parses template xlsx', () => {
    const buf = recipeImportTemplateXlsxBuffer();
    expect(buf.length).toBeGreaterThan(100);
    const parsed = parseRecipeImportExcel(buf, products);
    expect(parsed.recipes.length).toBeGreaterThan(0);
  });

  it('ships SPPG seed rows', () => {
    expect(MBG_RECIPE_SEED_ROWS.some((r) => String(r[0]).includes('Nasi Putih'))).toBe(true);
    const parsed = parseRecipeImportAoa(
      [[...RECIPE_IMPORT_HEADERS], ...MBG_RECIPE_SEED_ROWS],
      products,
    );
    expect(parsed.recipes.length).toBeGreaterThan(3);
  });
});
