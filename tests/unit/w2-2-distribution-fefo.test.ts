import { describe, it, expect } from 'vitest';
import {
  computeDistFgReturnNeeds,
  computeDistFgShipNeeds,
  hslFgStockLines,
  planFefoRestore,
} from '@/lib/food-production/dist-fefo-ship';
import { FOOD_TRAY_ID } from '@/lib/food-production/distribution';
import { allocateFefo } from '@/lib/food-production/fefo-allocate';

describe('W2-2 dist FG ship needs', () => {
  it('aggregates HSL FG lines and skips FOOD_TRAY id', () => {
    const rows = hslFgStockLines([
      { finishedGoodProductId: 'fg1', actualPorsi: 10, finishedGoodNama: 'Nasi' },
      { finishedGoodProductId: 'fg1', actualPorsi: 5 },
      { finishedGoodProductId: FOOD_TRAY_ID, actualPorsi: 99 },
      { finishedGoodProductId: '', actualPorsi: 3 },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ stokId: 'fg1', qty: 15, nama: 'Nasi' }),
    ]);
  });

  it('scales needQty by ship / HSL tray ratio', () => {
    const needs = computeDistFgShipNeeds({
      hslLines: [
        { finishedGoodProductId: 'fgA', actualPorsi: 100, finishedGoodNama: 'A' },
        { finishedGoodProductId: 'fgB', actualPorsi: 40, finishedGoodNama: 'B' },
      ],
      distLines: [
        {
          servicePointId: 'sp1',
          qtyPorsi: 100,
          qtyDikirim: 50,
          recipeId: FOOD_TRAY_ID,
        },
      ],
    });
    // HSL tray = max(100,40)=100; ship=50 → ratio 0.5
    expect(needs).toEqual([
      expect.objectContaining({ stokId: 'fgA', hslQty: 100, needQty: 50 }),
      expect.objectContaining({ stokId: 'fgB', hslQty: 40, needQty: 20 }),
    ]);
  });

  it('returns empty when HSL has no FG stock lines', () => {
    const needs = computeDistFgShipNeeds({
      hslLines: [{ finishedGoodNama: 'Tray only', actualPorsi: 80 }],
      distLines: [{ servicePointId: 'sp1', qtyPorsi: 80, qtyDikirim: 80 }],
    });
    expect(needs).toEqual([]);
  });

  it('full ship consumes full HSL FG qty', () => {
    const needs = computeDistFgShipNeeds({
      hslLines: [{ finishedGoodProductId: 'fg1', actualPorsi: 30 }],
      distLines: [{ servicePointId: 'sp1', qtyPorsi: 30, qtyDikirim: 30 }],
    });
    expect(needs[0]).toMatchObject({ stokId: 'fg1', needQty: 30 });
  });
});

describe('W2-2 FEFO scoped allocate still earliest-first', () => {
  it('allocates from HSL batch candidates FEFO', () => {
    const plan = allocateFefo(
      12,
      [
        { id: 'b-late', expiryDate: '2026-08-20', qtyRemaining: 20, batchNo: 'LATE' },
        { id: 'b-early', expiryDate: '2026-08-01', qtyRemaining: 10, batchNo: 'EARLY' },
      ],
      { asOf: new Date('2026-07-25T12:00:00.000Z') },
    );
    expect(plan.allocations).toEqual([
      { batchId: 'b-early', batchNo: 'EARLY', expiryDate: '2026-08-01', qty: 10 },
      { batchId: 'b-late', batchNo: 'LATE', expiryDate: '2026-08-20', qty: 2 },
    ]);
  });
});

describe('W2-3 dist FG return needs + FEFO restore plan', () => {
  it('scales return needs and caps by shipped qty', () => {
    const needs = computeDistFgReturnNeeds({
      hslLines: [
        { finishedGoodProductId: 'fgA', actualPorsi: 100 },
        { finishedGoodProductId: 'fgB', actualPorsi: 40 },
      ],
      distLines: [
        {
          servicePointId: 'sp1',
          qtyPorsi: 100,
          qtyDikirim: 100,
          qtyDikembalikan: 20,
          recipeId: FOOD_TRAY_ID,
        },
      ],
      shippedByStok: { fgA: 100, fgB: 40 },
    });
    // returnTray 20 / hslTray 100 → 0.2
    expect(needs).toEqual([
      expect.objectContaining({ stokId: 'fgA', needQty: 20 }),
      expect.objectContaining({ stokId: 'fgB', needQty: 8 }),
    ]);
  });

  it('returns empty when no qtyDikembalikan', () => {
    const needs = computeDistFgReturnNeeds({
      hslLines: [{ finishedGoodProductId: 'fg1', actualPorsi: 30 }],
      distLines: [{ servicePointId: 'sp1', qtyPorsi: 30, qtyDikirim: 30, qtyDikembalikan: 0 }],
    });
    expect(needs).toEqual([]);
  });

  it('restores LIFO reverse of FEFO allocations', () => {
    const restored = planFefoRestore(7, [
      { batchId: 'early', batchNo: 'E', expiryDate: '2026-08-01', qty: 5 },
      { batchId: 'late', batchNo: 'L', expiryDate: '2026-08-10', qty: 5 },
    ]);
    expect(restored).toEqual([
      { batchId: 'late', batchNo: 'L', expiryDate: '2026-08-10', qty: 5 },
      { batchId: 'early', batchNo: 'E', expiryDate: '2026-08-01', qty: 2 },
    ]);
  });
});
