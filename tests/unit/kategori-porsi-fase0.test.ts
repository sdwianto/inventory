import { describe, expect, it } from 'vitest';
import {
  KATEGORI_PORSI_LEGACY,
  KATEGORI_PORSI_OPTIONS,
  expandLegacyKategoriPorsi,
  isKategoriPorsi,
  isKategoriPorsiCurrent,
  kategoriPorsiListLabel,
  kategoriPorsiShortLabel,
  mergeKategoriPorsiLists,
  normalizeKategoriPorsiList,
  presentKategoriPorsiList,
  presentProductionPlanKategori,
} from '@/lib/food-production/production-plan';
import {
  KATEGORI_PORSI_BESAR_FAMILY,
  KATEGORI_PORSI_KECIL_FAMILY,
  recipePorsiFamilyForKategori,
  splitPorsiByKategoriFamily,
} from '@/lib/food-production/recipe';
import {
  emptyPortionTargets,
  normalizePortionTargets,
  sumAllPorsi,
  sumPosyanduPorsi,
  sumSekolahPorsi,
} from '@/lib/food-production/portion-target';
import {
  formatKategoriPorsiShort,
  normalizePorsiByKategori,
  presentPorsiByKategori,
  resolvePenerimaManfaat,
  sumPorsiByKategori,
} from '@/lib/food-production/service-point';
import { scalePorsiByKategoriForQty, normalizeDistLines } from '@/lib/food-production/distribution';
import { suggestAkgProfileForCategories } from '@/lib/food-production/nutrition';

describe('kategori porsi fase 0 — 6 kategori + legacy Bumil+Busui', () => {
  it('exposes six current options and still recognizes legacy', () => {
    expect(KATEGORI_PORSI_OPTIONS.map((o) => o.value)).toEqual([
      'PORSI_KECIL',
      'PORSI_BESAR',
      'POSYANDU_BALITA',
      'POSYANDU_BUMIL',
      'POSYANDU_BUSUI',
      'ORGANOLEPTIK',
    ]);
    expect(isKategoriPorsiCurrent(KATEGORI_PORSI_LEGACY)).toBe(false);
    expect(isKategoriPorsi(KATEGORI_PORSI_LEGACY)).toBe(true);
    expect(isKategoriPorsi('POSYANDU_BUMIL')).toBe(true);
    expect(isKategoriPorsi('ORGANOLEPTIK')).toBe(true);
  });

  it('expands legacy Bumil+Busui into two current categories', () => {
    expect(expandLegacyKategoriPorsi(['PORSI_BESAR', KATEGORI_PORSI_LEGACY])).toEqual([
      'PORSI_BESAR',
      'POSYANDU_BUMIL',
      'POSYANDU_BUSUI',
    ]);
  });

  it('normalizes write payload: legacy in, split out', () => {
    const ok = normalizeKategoriPorsiList([KATEGORI_PORSI_LEGACY, 'PORSI_KECIL']);
    expect(ok).toEqual(['PORSI_KECIL', 'POSYANDU_BUMIL', 'POSYANDU_BUSUI']);
    expect(normalizeKategoriPorsiList(['BUKAN'])).toEqual({
      error: expect.stringMatching(/tidak valid/i),
    });
  });

  it('maps legacy portion-target count to PB Bumil (Busui stays 0)', () => {
    const empty = emptyPortionTargets();
    expect(Object.keys(empty)).toEqual([
      'PORSI_KECIL',
      'PORSI_BESAR',
      'POSYANDU_BALITA',
      'POSYANDU_BUMIL',
      'POSYANDU_BUSUI',
      'ORGANOLEPTIK',
    ]);
    expect(empty).not.toHaveProperty(KATEGORI_PORSI_LEGACY);

    const mapped = normalizePortionTargets({
      PORSI_KECIL: 1058,
      PORSI_BESAR: 1129,
      POSYANDU_BALITA: 331,
      POSYANDU_BUMIL_BUSUI: 103,
    });
    expect(mapped).toEqual({
      PORSI_KECIL: 1058,
      PORSI_BESAR: 1129,
      POSYANDU_BALITA: 331,
      POSYANDU_BUMIL: 103,
      POSYANDU_BUSUI: 0,
      ORGANOLEPTIK: 0,
    });

    const alreadySplit = normalizePortionTargets({
      POSYANDU_BUMIL: 27,
      POSYANDU_BUSUI: 76,
      POSYANDU_BUMIL_BUSUI: 999,
    });
    expect('error' in alreadySplit).toBe(false);
    if ('error' in alreadySplit) return;
    expect(alreadySplit.POSYANDU_BUMIL).toBe(27);
    expect(alreadySplit.POSYANDU_BUSUI).toBe(76);
  });

  it('sums sekolah / posyandu / total including legacy-only maps', () => {
    const split = {
      PORSI_KECIL: 1058,
      PORSI_BESAR: 1129,
      POSYANDU_BALITA: 331,
      POSYANDU_BUMIL: 27,
      POSYANDU_BUSUI: 76,
      ORGANOLEPTIK: 13,
    };
    expect(sumSekolahPorsi(split)).toBe(2187);
    expect(sumPosyanduPorsi(split)).toBe(447);
    expect(sumAllPorsi(split)).toBe(2634);

    expect(sumPosyanduPorsi({
      POSYANDU_BALITA: 331,
      POSYANDU_BUMIL_BUSUI: 103,
    })).toBe(434);
  });

  it('treats Bumil, Busui, Organoleptik as qty besar family', () => {
    expect(recipePorsiFamilyForKategori('POSYANDU_BUMIL')).toBe('BESAR');
    expect(recipePorsiFamilyForKategori('POSYANDU_BUSUI')).toBe('BESAR');
    expect(recipePorsiFamilyForKategori('ORGANOLEPTIK')).toBe('BESAR');
    expect(recipePorsiFamilyForKategori('POSYANDU_BALITA')).toBe('KECIL');
    expect(recipePorsiFamilyForKategori(KATEGORI_PORSI_LEGACY)).toBe('BESAR');
    expect(KATEGORI_PORSI_BESAR_FAMILY.has('ORGANOLEPTIK')).toBe(true);
    expect(KATEGORI_PORSI_KECIL_FAMILY.has('PORSI_KECIL')).toBe(true);

    const split = splitPorsiByKategoriFamily(
      [
        'PORSI_KECIL',
        'PORSI_BESAR',
        'POSYANDU_BALITA',
        'POSYANDU_BUMIL',
        'POSYANDU_BUSUI',
        'ORGANOLEPTIK',
      ],
      2634,
      {
        PORSI_KECIL: 1058,
        PORSI_BESAR: 1129,
        POSYANDU_BALITA: 331,
        POSYANDU_BUMIL: 27,
        POSYANDU_BUSUI: 76,
        ORGANOLEPTIK: 13,
      },
    );
    expect(split.porsiBesar).toBe(1245);
    expect(split.porsiKecil).toBe(1389);
  });

  it('legacy plan line still hits besar when acuan already split to Bumil', () => {
    const split = splitPorsiByKategoriFamily(
      [KATEGORI_PORSI_LEGACY],
      103,
      { POSYANDU_BUMIL: 103, POSYANDU_BUSUI: 0 },
    );
    expect(split.porsiBesar).toBe(103);
    expect(split.porsiKecil).toBe(0);
  });

  it('merges legacy list into current Bumil+Busui', () => {
    expect(mergeKategoriPorsiLists([[KATEGORI_PORSI_LEGACY], ['PORSI_BESAR']])).toEqual([
      'PORSI_BESAR',
      'POSYANDU_BUMIL',
      'POSYANDU_BUSUI',
    ]);
  });

  it('maps service-point legacy qty to PB Bumil and still sums old docs', () => {
    const mapped = normalizePorsiByKategori({
      PORSI_BESAR: 40,
      POSYANDU_BUMIL_BUSUI: 15,
    });
    expect('error' in mapped).toBe(false);
    if ('error' in mapped) return;
    expect(mapped.POSYANDU_BUMIL).toBe(15);
    expect(mapped.POSYANDU_BUMIL_BUSUI).toBeUndefined();
    expect(sumPorsiByKategori(mapped)).toBe(55);

    expect(sumPorsiByKategori({
      PORSI_KECIL: 10,
      POSYANDU_BUMIL_BUSUI: 5,
    })).toBe(15);
    expect(formatKategoriPorsiShort({
      PORSI_KECIL: 10,
      POSYANDU_BUMIL_BUSUI: 5,
    })).toContain('PKS');
    expect(formatKategoriPorsiShort({
      PORSI_KECIL: 10,
      POSYANDU_BUMIL_BUSUI: 5,
    })).toContain('PBP');
  });

  it('resolvePenerimaManfaat accepts the six current keys', () => {
    const resolved = resolvePenerimaManfaat({
      porsiByKategori: {
        PORSI_BESAR: 100,
        PORSI_KECIL: 50,
        POSYANDU_BALITA: 10,
        POSYANDU_BUMIL: 4,
        POSYANDU_BUSUI: 6,
        ORGANOLEPTIK: 2,
      },
    });
    expect('error' in resolved).toBe(false);
    if ('error' in resolved) return;
    expect(resolved.kapasitasPorsi).toBe(172);
  });

  it('GET present expands legacy RPN kategori without keeping the enum', () => {
    expect(presentKategoriPorsiList([KATEGORI_PORSI_LEGACY], 'PORSI_BESAR')).toEqual([
      'POSYANDU_BUMIL',
      'POSYANDU_BUSUI',
    ]);
    expect(kategoriPorsiShortLabel(KATEGORI_PORSI_LEGACY)).toBe('Porsi Besar Posyandu (lama)');
    expect(kategoriPorsiListLabel([KATEGORI_PORSI_LEGACY])).toBe('PB Bumil, PB Busui');

    const presented = presentProductionPlanKategori({
      id: 'rpn-1',
      kategoriPorsi: KATEGORI_PORSI_LEGACY,
      kategoriPorsiList: [KATEGORI_PORSI_LEGACY],
      lines: [
        { recipeId: 'nasi', targetPorsi: 103, kategoriPorsiList: [KATEGORI_PORSI_LEGACY] },
        { recipeId: 'jus', targetPorsi: 50 },
      ],
    });
    expect(presented.kategoriPorsi).toBe('POSYANDU_BUMIL');
    expect(presented.kategoriPorsiList).toEqual(['POSYANDU_BUMIL', 'POSYANDU_BUSUI']);
    expect(presented.lines[0].kategoriPorsiList).toEqual(['POSYANDU_BUMIL', 'POSYANDU_BUSUI']);
    expect(presented.lines[1].kategoriPorsiList).toBeUndefined();
  });

  it('GET present maps service-point legacy qty to PB Bumil', () => {
    expect(presentPorsiByKategori({
      PORSI_BESAR: 40,
      POSYANDU_BUMIL_BUSUI: 15,
    })).toEqual({
      PORSI_BESAR: 40,
      POSYANDU_BUMIL: 15,
    });
    expect(presentPorsiByKategori(undefined)).toBeUndefined();
  });

  it('DST scale/write never persists POSYANDU_BUMIL_BUSUI', () => {
    const scaled = scalePorsiByKategoriForQty(
      { PORSI_BESAR: 40, POSYANDU_BUMIL_BUSUI: 10 },
      50,
      50,
    );
    expect(scaled).toEqual({
      PORSI_BESAR: 40,
      POSYANDU_BUMIL: 10,
    });
    expect(scaled?.POSYANDU_BUMIL_BUSUI).toBeUndefined();

    const lines = normalizeDistLines([{
      servicePointId: 'sp-1',
      recipeId: 'r-1',
      qtyPorsi: 15,
      porsiByKategori: { POSYANDU_BUMIL_BUSUI: 15 },
    }]);
    expect(Array.isArray(lines)).toBe(true);
    if (!Array.isArray(lines)) return;
    expect(lines[0].porsiByKategori).toEqual({ POSYANDU_BUMIL: 15 });
    expect(lines[0].porsiByKategori?.POSYANDU_BUMIL_BUSUI).toBeUndefined();
  });

  it('AKG stays two profiles: Organoleptik/Bumil/Busui map to PORSI_BESAR', () => {
    expect(suggestAkgProfileForCategories([['ORGANOLEPTIK']])).toBe('PORSI_BESAR');
    expect(suggestAkgProfileForCategories([['POSYANDU_BUMIL', 'POSYANDU_BUSUI']])).toBe('PORSI_BESAR');
    expect(suggestAkgProfileForCategories([[KATEGORI_PORSI_LEGACY]])).toBe('PORSI_BESAR');
    expect(suggestAkgProfileForCategories([['ORGANOLEPTIK', 'PORSI_KECIL']])).toBe('MIXED');
    expect(suggestAkgProfileForCategories([['POSYANDU_BALITA']])).toBe('PORSI_KECIL');
  });
});
