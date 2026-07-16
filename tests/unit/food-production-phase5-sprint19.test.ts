import { describe, expect, it } from 'vitest';
import { FP_DOC_PREFIX, FP_DOC_TYPES } from '@/lib/food-production/document';
import {
  normalizeServicePointJenis,
  normalizeServicePointKode,
  normalizeKapasitasPorsi,
} from '@/lib/food-production/service-point';
import {
  allocatePorsiAcrossPoints,
  assertDistQtyWithinSource,
  remainingSourceItems,
  normalizeDistLines,
  summarizeDistLines,
  DIST_UI_STATUS_NEXT,
  DIST_STATUS_TRANSITIONS,
} from '@/lib/food-production/distribution';

describe('food-production phase 5 sprint 19', () => {
  it('registers DST doc prefix', () => {
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.DISTRIBUTION_ORDER]).toBe('DST');
  });

  it('normalizes service point fields', () => {
    expect(normalizeServicePointJenis('sekolah')).toBe('SEKOLAH');
    expect(normalizeServicePointJenis('x')).toBe('LAINNYA');
    expect(normalizeServicePointKode(' sd 01 ')).toBe('SD-01');
    expect(normalizeKapasitasPorsi('120')).toBe(120);
    expect(normalizeKapasitasPorsi(-1)).toBeUndefined();
  });

  it('allocates porsi across points by kapasitas weight', () => {
    const lines = allocatePorsiAcrossPoints({
      items: [{ menuId: 'm1', menuNama: 'Nasi', qtyPorsi: 100 }],
      servicePoints: [
        { id: 'a', nama: 'A', kapasitasPorsi: 75 },
        { id: 'b', nama: 'B', kapasitasPorsi: 25 },
      ],
    });
    expect('error' in (lines as object)).toBe(false);
    if ('error' in (lines as object)) return;
    expect(lines).toHaveLength(2);
    expect(lines[0].qtyPorsi).toBe(75);
    expect(lines[1].qtyPorsi).toBe(25);
    expect(summarizeDistLines(lines).qtyPorsiTotal).toBe(100);
    expect(summarizeDistLines(lines).servicePointCount).toBe(2);
  });

  it('equal-splits when kapasitas missing; keeps all points with remainder', () => {
    const lines = allocatePorsiAcrossPoints({
      items: [{ menuId: 'm1', qtyPorsi: 99 }],
      servicePoints: [
        { id: 'a', nama: 'A' },
        { id: 'b', nama: 'B' },
        { id: 'c', nama: 'C' },
      ],
    });
    expect('error' in (lines as object)).toBe(false);
    if ('error' in (lines as object)) return;
    expect(summarizeDistLines(lines).qtyPorsiTotal).toBe(99);
    expect(summarizeDistLines(lines).servicePointCount).toBe(3);
  });

  it('remainingSourceItems subtracts consumed budget', () => {
    const remain = remainingSourceItems(
      [{ menuId: 'm1', qtyPorsi: 100 }],
      [{ servicePointId: 'a', menuId: 'm1', qtyPorsi: 40 }],
    );
    expect('error' in (remain as object)).toBe(false);
    if ('error' in (remain as object)) return;
    expect(remain).toHaveLength(1);
    expect(remain[0].qtyPorsi).toBe(60);

    expect(remainingSourceItems(
      [{ menuId: 'm1', qtyPorsi: 100 }],
      [{ servicePointId: 'a', menuId: 'm1', qtyPorsi: 100 }],
    )).toMatchObject({ error: expect.stringMatching(/penuh/) });
  });

  it('rejects over-allocation and orphan keys / empty source', () => {
    expect(assertDistQtyWithinSource({
      sourceItems: [],
      newLines: [{ servicePointId: 'a', menuId: 'm1', qtyPorsi: 10 }],
    })).toMatch(/Sumber/);

    expect(assertDistQtyWithinSource({
      sourceItems: [{ menuId: 'm1', qtyPorsi: 100 }],
      newLines: [{ servicePointId: 'a', menuId: 'm1', qtyPorsi: 80 }],
      existingConsumedLines: [{ servicePointId: 'b', menuId: 'm1', qtyPorsi: 30 }],
    })).toMatch(/melebihi/);

    expect(assertDistQtyWithinSource({
      sourceItems: [{ menuId: 'm1', qtyPorsi: 100 }],
      newLines: [{ servicePointId: 'a', menuId: 'm1', qtyPorsi: 70 }],
      existingConsumedLines: [{ servicePointId: 'b', menuId: 'm1', qtyPorsi: 30 }],
    })).toBeNull();

    // Orphan menu not in source
    expect(assertDistQtyWithinSource({
      sourceItems: [{ menuId: 'm1', qtyPorsi: 100 }],
      newLines: [{ servicePointId: 'a', menuId: 'unknown', qtyPorsi: 10 }],
    })).toMatch(/tidak ada di sumber/);

    // COMPLETED counts toward budget
    expect(assertDistQtyWithinSource({
      sourceItems: [{ menuId: 'm1', qtyPorsi: 100 }],
      newLines: [{ servicePointId: 'a', menuId: 'm1', qtyPorsi: 1 }],
      existingConsumedLines: [{ servicePointId: 'b', menuId: 'm1', qtyPorsi: 100 }],
    })).toMatch(/melebihi/);

    // Plan key (menu only) vs Result key (menu|fg) must not falsely orphan when budgets are separate
    expect(assertDistQtyWithinSource({
      sourceItems: [{ menuId: 'm1', finishedGoodProductId: 'fg1', qtyPorsi: 100 }],
      newLines: [{ servicePointId: 'a', menuId: 'm1', finishedGoodProductId: 'fg1', qtyPorsi: 50 }],
      existingConsumedLines: [],
    })).toBeNull();
  });

  it('normalizes dist lines; UI requires kirim before terima', () => {
    const lines = normalizeDistLines([
      { servicePointId: 'sp1', menuId: 'm1', qtyPorsi: 10 },
      { servicePointId: 'sp2', finishedGoodProductId: 'fg', qtyPorsi: 5 },
    ]);
    expect('error' in (lines as object)).toBe(false);
    expect(DIST_UI_STATUS_NEXT.APPROVED).toBe('PROCESSING');
    expect(DIST_UI_STATUS_NEXT.PROCESSING).toBe('COMPLETED');
    expect(DIST_STATUS_TRANSITIONS.APPROVED).toEqual(['PROCESSING', 'CANCELLED']);
    expect(DIST_STATUS_TRANSITIONS.APPROVED).not.toContain('COMPLETED');
  });
});
