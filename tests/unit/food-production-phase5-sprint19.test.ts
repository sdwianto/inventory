import { describe, expect, it } from 'vitest';
import { FP_DOC_PREFIX, FP_DOC_TYPES } from '@/lib/food-production/document';
import {
  normalizeServicePointJenis,
  normalizeServicePointKode,
  normalizeKapasitasPorsi,
  resolvePenerimaManfaat,
  sumPorsiByKategori,
} from '@/lib/food-production/service-point';
import {
  allocatePorsiAcrossPoints,
  assertDistQtyWithinSource,
  remainingSourceItems,
  normalizeDistLines,
  summarizeDistLines,
  applyDistLineActuals,
  applyDistSettleLines,
  collapseSourceToFoodTray,
  FOOD_TRAY_ID,
  FOOD_TRAY_LABEL,
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
    expect(normalizeServicePointKode(' Ti 01 ')).toBe('Ti-01');
    expect(normalizeKapasitasPorsi('120')).toBe(120);
    expect(normalizeKapasitasPorsi(-1)).toBeUndefined();
  });

  it('sums kategori porsi into penerima manfaat', () => {
    const resolved = resolvePenerimaManfaat({
      porsiByKategori: {
        PORSI_BESAR: 100,
        PORSI_KECIL: 50,
        POSYANDU_BALITA: 10,
      },
    });
    expect('error' in resolved).toBe(false);
    if ('error' in resolved) return;
    expect(resolved.kapasitasPorsi).toBe(160);
    expect(sumPorsiByKategori(resolved.porsiByKategori)).toBe(160);
  });

  it('collapses recipe lines to one Food Tray (max porsi = set makanan)', () => {
    const tray = collapseSourceToFoodTray([
      { qtyPorsi: 300 },
      { qtyPorsi: 300 },
    ]);
    expect('error' in (tray as object)).toBe(false);
    if ('error' in (tray as object)) return;
    expect(tray).toHaveLength(1);
    expect(tray[0].recipeId).toBe(FOOD_TRAY_ID);
    expect(tray[0].menuNama).toBe(FOOD_TRAY_LABEL);
    expect(tray[0].qtyPorsi).toBe(300);

    const lines = allocatePorsiAcrossPoints({
      items: tray,
      servicePoints: [
        { id: 'a', nama: 'A', kapasitasPorsi: 40 },
        { id: 'b', nama: 'B', kapasitasPorsi: 50 },
      ],
    });
    expect('error' in (lines as object)).toBe(false);
    if ('error' in (lines as object)) return;
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.menuNama === FOOD_TRAY_LABEL)).toBe(true);
    expect(summarizeDistLines(lines).qtyPorsiTotal).toBe(300);
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

    // MBG recipe-direct (no menu / FG) — HSL → DST
    expect(assertDistQtyWithinSource({
      sourceItems: [{ recipeId: 'r1', qtyPorsi: 300 }],
      newLines: [{ servicePointId: 'a', recipeId: 'r1', qtyPorsi: 100 }],
      existingConsumedLines: [],
    })).toBeNull();
  });

  it('normalizes dist lines; UI moves disiapkan -> dikirim -> selesai', () => {
    const lines = normalizeDistLines([
      { servicePointId: 'sp1', menuId: 'm1', qtyPorsi: 10 },
      { servicePointId: 'sp2', finishedGoodProductId: 'fg', qtyPorsi: 5 },
    ]);
    expect('error' in (lines as object)).toBe(false);
    expect(DIST_UI_STATUS_NEXT.DRAFT).toBe('PROCESSING');
    expect(DIST_UI_STATUS_NEXT.PROCESSING).toBe('COMPLETED');
    expect(DIST_STATUS_TRANSITIONS.DRAFT).toEqual(['PROCESSING', 'CANCELLED']);
    expect(DIST_STATUS_TRANSITIONS.DRAFT).not.toContain('COMPLETED');
    expect(DIST_STATUS_TRANSITIONS.PROCESSING).toEqual(['COMPLETED']);
    expect(DIST_STATUS_TRANSITIONS.COMPLETED).toEqual([]);
  });

  it('stores kapasitas on allocate and settles per titik diterima/kembali', () => {
    const allocated = allocatePorsiAcrossPoints({
      items: [{ menuId: 'm1', menuNama: 'Nasi', qtyPorsi: 100 }],
      servicePoints: [
        { id: 'a', nama: 'A', kapasitasPorsi: 40 },
        { id: 'b', nama: 'B', kapasitasPorsi: 60 },
      ],
    });
    expect('error' in (allocated as object)).toBe(false);
    if ('error' in (allocated as object)) return;
    expect(allocated[0].kapasitasPorsi).toBe(40);
    expect(allocated[1].kapasitasPorsi).toBe(60);

    const sent = applyDistLineActuals(allocated, 'PROCESSING', [
      { servicePointId: 'a', menuId: 'm1', qty: 38 },
      { servicePointId: 'b', menuId: 'm1', qty: 55 },
    ]);
    expect('error' in (sent as object)).toBe(false);
    if ('error' in (sent as object)) return;
    expect(sent[0].qtyDikirim).toBe(38);
    expect(sent[1].qtyDikirim).toBe(55);

    const settled = applyDistSettleLines(sent, [
      { servicePointId: 'a', menuId: 'm1', qtyDiterima: 30, qtyDikembalikan: 8 },
      { servicePointId: 'b', menuId: 'm1', qtyDiterima: 55, qtyDikembalikan: 0 },
    ]);
    expect('error' in (settled as object)).toBe(false);
    if ('error' in (settled as object)) return;
    expect(settled[0].qtyDiterima).toBe(30);
    expect(settled[0].qtyDikembalikan).toBe(8);
    expect(settled[1].qtyDiterima).toBe(55);
    expect(summarizeDistLines(settled).qtyDiterimaTotal).toBe(85);
    expect(summarizeDistLines(settled).qtyDikembalikanTotal).toBe(8);

    const bad = applyDistSettleLines(sent, [
      { servicePointId: 'a', menuId: 'm1', qtyDiterima: 20, qtyDikembalikan: 5 },
    ]);
    expect('error' in (bad as object)).toBe(true);
  });
});
