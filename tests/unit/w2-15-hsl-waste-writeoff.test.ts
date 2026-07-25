import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('uuid', () => ({ v4: () => 'hsl-waste-uuid-1' }));

import {
  resultHasStockableLines,
  resultLineGrossPorsi,
} from '@/lib/food-production/production-result';
import {
  detectHslWasteUnposted,
  runHslWasteDetect,
} from '@/lib/api/hsl-waste-reconcile';

describe('W2-15 HSL yield/waste helpers', () => {
  it('gross = actual + waste', () => {
    expect(resultLineGrossPorsi({ actualPorsi: 90, wastePorsi: 10 })).toBe(100);
    expect(resultLineGrossPorsi({ actualPorsi: 0, wastePorsi: 5 })).toBe(5);
  });

  it('resultHasStockableLines includes FG with waste-only', () => {
    expect(
      resultHasStockableLines([
        {
          recipeId: 'r1',
          finishedGoodProductId: 'fg1',
          targetPorsi: 100,
          actualPorsi: 0,
          wastePorsi: 8,
        },
      ]),
    ).toBe(true);
    expect(
      resultHasStockableLines([
        {
          recipeId: 'r1',
          targetPorsi: 100,
          actualPorsi: 0,
          wastePorsi: 8,
        },
      ]),
    ).toBe(false);
  });
});

describe('W2-15 HSL waste Detect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags COMPLETED FG waste without wasteStockPostedAt', async () => {
    const results = [
      {
        id: 'hsl-1',
        noDokumen: 'HSL-1',
        tenantId: 't1',
        status: 'COMPLETED',
        summary: { wastePorsiTotal: 12 },
        lines: [
          {
            recipeId: 'r1',
            finishedGoodProductId: 'fg1',
            actualPorsi: 88,
            wastePorsi: 12,
            targetPorsi: 100,
          },
        ],
      },
      {
        id: 'hsl-mbg',
        noDokumen: 'HSL-MBG',
        tenantId: 't1',
        status: 'COMPLETED',
        summary: { wastePorsiTotal: 5 },
        lines: [
          {
            recipeId: 'r2',
            actualPorsi: 95,
            wastePorsi: 5,
            targetPorsi: 100,
          },
        ],
      },
    ];
    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => results,
    };
    const db = { collection: () => ({ find: () => findCursor }) };

    const report = await detectHslWasteUnposted(db as never, 't1');
    expect(report.summary.totalMismatch).toBe(1);
    expect(report.mismatches[0]?.kind).toBe('HSL_WASTE_UNPOSTED');
    expect(report.mismatches[0]?.resultId).toBe('hsl-1');
  });

  it('persists report on runHslWasteDetect', async () => {
    const results = [
      {
        id: 'hsl-x',
        noDokumen: 'HSL-X',
        tenantId: 't1',
        status: 'COMPLETED',
        summary: { wastePorsiTotal: 3 },
        lines: [
          {
            recipeId: 'r1',
            finishedGoodProductId: 'fg1',
            actualPorsi: 7,
            wastePorsi: 3,
            targetPorsi: 10,
          },
        ],
      },
    ];
    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => results,
    };
    const insertOne = vi.fn(async () => ({ insertedId: 'r1' }));
    const db = {
      collection: (name: string) => {
        if (name === 'production_results') return { find: () => findCursor };
        return { insertOne, find: () => findCursor };
      },
    };
    const report = await runHslWasteDetect(db as never, 't1');
    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(report.id).toBe('hsl-waste-uuid-1');
  });
});
