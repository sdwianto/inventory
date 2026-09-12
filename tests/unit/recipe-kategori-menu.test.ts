import { describe, it, expect } from 'vitest';
import {
  KATEGORI_MENU_OPTIONS,
  isKategoriMenu,
  kategoriMenuLabel,
} from '@/lib/food-production/recipe';

describe('Kategori Menu (recipe master)', () => {
  it('exposes all seven MBG categories', () => {
    expect(KATEGORI_MENU_OPTIONS.map((o) => o.label)).toEqual([
      'Karbohidrat',
      'Lauk Nabati',
      'Lauk Hewani',
      'Sayur',
      'Buah',
      'Susu',
      'Garnish',
    ]);
  });

  it('accepts only known values', () => {
    expect(isKategoriMenu('KARBOHIDRAT')).toBe(true);
    expect(isKategoriMenu('LAUK_NABATI')).toBe(true);
    expect(isKategoriMenu('GARNISH')).toBe(true);
    expect(isKategoriMenu('')).toBe(false);
    expect(isKategoriMenu('Bahan Pokok')).toBe(false);
    expect(isKategoriMenu('SAYURAN')).toBe(false);
    expect(isKategoriMenu(null)).toBe(false);
  });

  it('labels known values and falls back for empty/unknown', () => {
    expect(kategoriMenuLabel('LAUK_HEWANI')).toBe('Lauk Hewani');
    expect(kategoriMenuLabel(undefined)).toBe('—');
    expect(kategoriMenuLabel('')).toBe('—');
    expect(kategoriMenuLabel('UNKNOWN')).toBe('UNKNOWN');
  });
});
