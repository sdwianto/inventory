import { describe, expect, it } from 'vitest';
import {
  BAHAN_PANGAN_TO_KATEGORI_MENU,
  bahanPanganFromKategoriMenu,
  kategoriMenuFromBahanPangan,
  normalizeMenuItems,
  presentMenuItems,
  resolveMenuItemKategoriMenu,
} from '@/lib/food-production/menu';

describe('menu kategoriMenu Fase 3', () => {
  it('maps legacy bahanPangan onto kategoriMenu slots', () => {
    expect(kategoriMenuFromBahanPangan('BAHAN_POKOK')).toBe('KARBOHIDRAT');
    expect(kategoriMenuFromBahanPangan('PROTEIN_HEWANI')).toBe('LAUK_HEWANI');
    expect(kategoriMenuFromBahanPangan('PROTEIN_NABATI')).toBe('LAUK_NABATI');
    expect(kategoriMenuFromBahanPangan('LAINNYA')).toBe('GARNISH');
    expect(bahanPanganFromKategoriMenu('KARBOHIDRAT')).toBe('BAHAN_POKOK');
    expect(bahanPanganFromKategoriMenu('GARNISH')).toBe('LAINNYA');
    expect(BAHAN_PANGAN_TO_KATEGORI_MENU.SAYUR).toBe('SAYUR');
  });

  it('normalizes kategoriMenu-only payload and keeps bahanPangan alias', () => {
    const ok = normalizeMenuItems([
      { recipeId: 'nasi', kategoriMenu: 'KARBOHIDRAT', porsi: 1 },
    ]);
    expect(ok).toEqual([
      expect.objectContaining({
        recipeId: 'nasi',
        kategoriMenu: 'KARBOHIDRAT',
        bahanPangan: 'BAHAN_POKOK',
        porsi: 1,
      }),
    ]);
  });

  it('presents old documents that only have bahanPangan', () => {
    const items = presentMenuItems([
      { recipeId: 'ayam', bahanPangan: 'PROTEIN_HEWANI', porsi: 1, recipeNama: 'Ayam' },
    ]);
    expect(items[0].kategoriMenu).toBe('LAUK_HEWANI');
    expect(resolveMenuItemKategoriMenu({ bahanPangan: 'BAHAN_POKOK' })).toBe('KARBOHIDRAT');
  });

  it('rewrites conflicting bahanPangan alias to match kategoriMenu', () => {
    const ok = normalizeMenuItems([
      { recipeId: 'nasi', kategoriMenu: 'KARBOHIDRAT', bahanPangan: 'SAYUR', porsi: 1 },
    ]);
    expect(ok).toEqual([
      expect.objectContaining({
        recipeId: 'nasi',
        kategoriMenu: 'KARBOHIDRAT',
        bahanPangan: 'BAHAN_POKOK',
      }),
    ]);
  });
});
