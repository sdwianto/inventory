import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FOOD_SAFETY_STATUS,
  applyFoodSafetyTransition,
  effectiveFoodSafetyStatus,
  foodSafetyStatusMatch,
  isFoodSafetyBlocked,
  normalizeFoodSafetyStatus,
  type FoodSafetyStatus,
  type ProductionBatchDoc,
} from '@/lib/food-production/production-batch';
import { consumeBatchesFefo } from '@/lib/food-production/fefo-consume';
import { relocateBatchesFefo } from '@/lib/food-production/transfer-fefo';
import { DEFAULT_FEATURE_FLAGS, mergeFeatureFlags } from '@/lib/api/feature-flags';

type BatchState = Pick<ProductionBatchDoc, 'foodSafetyStatus' | 'foodSafetyHistory'>;

function transition(batch: BatchState | null, to: FoodSafetyStatus, reason = 'alasan uji') {
  return applyFoodSafetyTransition(batch, {
    to,
    sourceType: 'HACCP',
    sourceId: 'HCP-1',
    reason,
    at: new Date('2026-08-10T00:00:00.000Z'),
    userId: 'u1',
    userName: 'QA',
  });
}

describe('ADR-004 P0A — food safety status pada production batch', () => {
  it('membaca baris lama tanpa field sebagai PENDING', () => {
    expect(effectiveFoodSafetyStatus(undefined)).toBe('PENDING');
    expect(effectiveFoodSafetyStatus({})).toBe('PENDING');
    expect(effectiveFoodSafetyStatus({ foodSafetyStatus: 'hold' as FoodSafetyStatus })).toBe('HOLD');
    expect(DEFAULT_FOOD_SAFETY_STATUS).toBe('PENDING');
  });

  it('menolak nilai status di luar kamus', () => {
    expect(normalizeFoodSafetyStatus('RELEASED')).toBe('RELEASED');
    expect(normalizeFoodSafetyStatus('QUARANTINE')).toEqual({
      error: expect.stringMatching(/PENDING/),
    });
  });

  it('hanya HOLD yang memblokir pengeluaran', () => {
    expect(isFoodSafetyBlocked({ foodSafetyStatus: 'HOLD' })).toBe(true);
    expect(isFoodSafetyBlocked({ foodSafetyStatus: 'PENDING' })).toBe(false);
    expect(isFoodSafetyBlocked({ foodSafetyStatus: 'PASS' })).toBe(false);
    expect(isFoodSafetyBlocked({ foodSafetyStatus: 'RELEASED' })).toBe(false);
    expect(isFoodSafetyBlocked({})).toBe(false);
  });

  it('status inventory dan status food safety tidak saling mengunci', () => {
    const batch: BatchState & { status: ProductionBatchDoc['status'] } = {
      status: 'ACTIVE',
      foodSafetyStatus: 'HOLD',
    };
    expect(batch.status).toBe('ACTIVE');
    expect(isFoodSafetyBlocked(batch)).toBe(true);
  });
});

describe('ADR-004 P0A — transisi disposisi', () => {
  it('mengizinkan jalur sah PENDING → PASS/HOLD dan HOLD → RELEASED', () => {
    for (const [from, to] of [
      [undefined, 'PASS'],
      [undefined, 'HOLD'],
      ['PENDING', 'PASS'],
      ['PENDING', 'HOLD'],
      ['PASS', 'HOLD'],
    ] as Array<[FoodSafetyStatus | undefined, FoodSafetyStatus]>) {
      const res = transition({ foodSafetyStatus: from }, to);
      expect('error' in res ? res.error : res.foodSafetyStatus).toBe(to);
    }
    // RELEASED hanya via KA_FOLLOW_UP + sourceId (P0H Recovery gate).
    const released = applyFoodSafetyTransition(
      { foodSafetyStatus: 'HOLD' },
      {
        to: 'RELEASED',
        sourceType: 'KA_FOLLOW_UP',
        sourceId: 'fu-1',
        reason: 'alasan uji',
        at: new Date('2026-08-10T00:00:00.000Z'),
        userId: 'u1',
        userName: 'QA',
      },
    );
    expect('error' in released ? released.error : released.foodSafetyStatus).toBe('RELEASED');
  });

  it('mengizinkan RELEASED → HOLD agar temuan susulan bisa menahan ulang', () => {
    const res = transition({ foodSafetyStatus: 'RELEASED' }, 'HOLD');
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.foodSafetyStatus).toBe('HOLD');
  });

  it('melarang HOLD dilepas tanpa melewati RELEASED', () => {
    const res = transition({ foodSafetyStatus: 'HOLD' }, 'PASS');
    expect('error' in res).toBe(true);
    if (!('error' in res)) return;
    expect(res.error).toMatch(/tidak boleh/i);
  });

  it('melarang RELEASED tanpa pernah HOLD', () => {
    expect('error' in transition({ foodSafetyStatus: 'PENDING' }, 'RELEASED')).toBe(true);
    expect('error' in transition({ foodSafetyStatus: 'PASS' }, 'RELEASED')).toBe(true);
  });

  it('mengizinkan HOLD → HOLD agar kegagalan kedua tetap tercatat', () => {
    const first = transition({ foodSafetyStatus: 'HOLD' }, 'HOLD', 'CCP pendinginan gagal');
    expect('error' in first).toBe(false);
    if ('error' in first) return;
    expect(first.foodSafetyHistory).toHaveLength(1);
  });

  it('menolak transisi tanpa alasan', () => {
    const res = transition({ foodSafetyStatus: 'PENDING' }, 'HOLD', '   ');
    expect('error' in res).toBe(true);
    if (!('error' in res)) return;
    expect(res.error).toMatch(/alasan/i);
  });
});

describe('ADR-004 P0A — auditability history', () => {
  it('mencatat actor, waktu, sumber, alasan, dan status asal', () => {
    const held = transition({}, 'HOLD', 'Suhu inti 68°C di bawah batas kritis 74°C');
    expect('error' in held).toBe(false);
    if ('error' in held) return;

    expect(held.foodSafetyHistory).toHaveLength(1);
    expect(held.foodSafetyHistory[0]).toEqual({
      at: new Date('2026-08-10T00:00:00.000Z'),
      fromStatus: 'PENDING',
      toStatus: 'HOLD',
      userId: 'u1',
      userName: 'QA',
      note: 'Suhu inti 68°C di bawah batas kritis 74°C',
      sourceType: 'HACCP',
      sourceId: 'HCP-1',
    });
  });

  it('menumpuk history, bukan menimpa', () => {
    const held = transition({}, 'HOLD', 'CCP masak gagal');
    if ('error' in held) throw new Error(held.error);

    const released = applyFoodSafetyTransition(held, {
      to: 'RELEASED',
      sourceType: 'KA_FOLLOW_UP',
      sourceId: 'KAF-9',
      reason: 'Tindakan korektif terverifikasi',
      at: new Date('2026-08-11T00:00:00.000Z'),
      userId: 'u2',
      userName: 'Manager',
    });
    if ('error' in released) throw new Error(released.error);

    expect(released.foodSafetyStatus).toBe('RELEASED');
    expect(released.foodSafetyHistory.map((h) => h.toStatus)).toEqual(['HOLD', 'RELEASED']);
    expect(released.foodSafetyHistory[1].sourceType).toBe('KA_FOLLOW_UP');
    expect(released.foodSafetyHistory[1].fromStatus).toBe('HOLD');
    expect(held.foodSafetyHistory).toHaveLength(1);
  });
});

describe('ADR-004 P0A-2 — guard HOLD pada FEFO', () => {
  function dbCapturingFilter() {
    const seen: Array<Record<string, unknown>> = [];
    const cursor = { sort: () => cursor, toArray: async () => [] };
    const db = {
      collection: () => ({
        find: (filter: Record<string, unknown>) => {
          seen.push(filter);
          return cursor;
        },
      }),
    };
    return { db, seen };
  }

  const baseInput = {
    tenantId: 't1',
    stokId: 'fg1',
    warehouseKode: 'GKERING',
    needQty: 5,
  };

  it('menyaring batch HOLD saat jalur keluar mengaktifkan enforcement', async () => {
    const { db, seen } = dbCapturingFilter();
    await consumeBatchesFefo(db as never, { ...baseInput, enforceFoodSafetyHold: true });
    expect(seen[0].foodSafetyStatus).toEqual({ $ne: 'HOLD' });
  });

  it('tidak menyaring untuk jalur non-keluar (cycle count, rekonsiliasi, waste)', async () => {
    const { db, seen } = dbCapturingFilter();
    await consumeBatchesFefo(db as never, baseInput);
    expect(seen[0].foodSafetyStatus).toBeUndefined();
    expect(seen[0].status).toEqual({ $in: ['ACTIVE', 'EXPIRED'] });
  });
});

describe('ADR-004 P0A — disposisi ikut saat batch dipindah gudang', () => {
  const heldBatch = {
    id: 'b1',
    tenantId: 't1',
    batchNo: 'BATCH-1',
    finishedGoodProductId: 'fg1',
    warehouseKode: 'GUDANG-A',
    expiryDate: '2026-12-01',
    qty: 10,
    qtyRemaining: 10,
    status: 'ACTIVE',
    foodSafetyStatus: 'HOLD',
    foodSafetyHistory: [
      {
        at: new Date('2026-08-10T00:00:00.000Z'),
        fromStatus: 'PENDING',
        toStatus: 'HOLD',
        note: 'CCP masak gagal',
        sourceType: 'HACCP',
      },
    ],
  };

  function fakeDb(destExisting: unknown = null) {
    const inserted: Array<Record<string, unknown>> = [];
    const findOneFilters: Array<Record<string, unknown>> = [];
    const cursor = {
      sort: () => cursor,
      toArray: async () => [heldBatch],
    };
    const db = {
      collection: () => ({
        find: () => cursor,
        findOne: async (filter: Record<string, unknown>) => {
          findOneFilters.push(filter);
          return destExisting;
        },
        updateOne: async () => ({ modifiedCount: 1 }),
        insertOne: async (doc: Record<string, unknown>) => {
          inserted.push(doc);
          return { insertedId: '1' };
        },
      }),
    };
    return { db, inserted, findOneFilters };
  }

  const relocateInput = {
    tenantId: 't1',
    stokId: 'fg1',
    fromWarehouseKode: 'GUDANG-A',
    toWarehouseKode: 'GUDANG-B',
    needQty: 4,
    asOf: new Date('2026-08-10T00:00:00.000Z'),
  };

  it('klon di gudang tujuan mewarisi HOLD beserta riwayatnya', async () => {
    const { db, inserted } = fakeDb(null);
    await relocateBatchesFefo(db as never, relocateInput);

    expect(inserted).toHaveLength(1);
    expect(inserted[0].foodSafetyStatus).toBe('HOLD');
    expect(inserted[0].warehouseKode).toBe('GUDANG-B');
    expect(inserted[0].relocatedFromBatchId).toBe('b1');
    expect((inserted[0].foodSafetyHistory as unknown[])).toHaveLength(1);
  });

  it('hanya mencari batch tujuan dengan disposisi yang sama', async () => {
    const { db, findOneFilters } = fakeDb(null);
    await relocateBatchesFefo(db as never, relocateInput);

    expect(findOneFilters[0].foodSafetyStatus).toBe('HOLD');
  });

  it('mencocokkan baris lama tanpa field sebagai PENDING', () => {
    expect(foodSafetyStatusMatch('PENDING')).toEqual({ $in: ['PENDING', null] });
    expect(foodSafetyStatusMatch('HOLD')).toBe('HOLD');
    expect(foodSafetyStatusMatch('RELEASED')).toBe('RELEASED');
  });
});

describe('ADR-004 P0A-2 — feature flag foodSafetyHoldEnabled', () => {
  it('aktif secara default', () => {
    expect(DEFAULT_FEATURE_FLAGS.foodSafetyHoldEnabled).toBe(true);
    expect(mergeFeatureFlags(null).foodSafetyHoldEnabled).toBe(true);
    expect(mergeFeatureFlags({}).foodSafetyHoldEnabled).toBe(true);
  });

  it('hanya mati bila di-set false secara eksplisit', () => {
    expect(
      mergeFeatureFlags({ features: { foodSafetyHoldEnabled: false } }).foodSafetyHoldEnabled,
    ).toBe(false);
  });
});
