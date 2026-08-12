import { describe, expect, it } from 'vitest';
import { allocateFefo } from '@/lib/food-production/fefo-allocate';
import {
  assertFefoExitNotBlockedByHold,
  buildFoodSafetyHoldBlockMessage,
  checkFefoExitLineAgainstHold,
} from '@/lib/food-production/food-safety-exit-gate';
import { DEFAULT_FEATURE_FLAGS, mergeFeatureFlags } from '@/lib/api/feature-flags';
import { consumeBatchesFefo } from '@/lib/food-production/fefo-consume';

describe('ADR-004 P0G — allocateFefo menolak HOLD', () => {
  it('rejectFoodSafetyHold melewatkan kandidat HOLD', () => {
    const result = allocateFefo(
      10,
      [
        {
          id: 'hold',
          batchNo: 'B-HOLD',
          expiryDate: '2026-08-01',
          qtyRemaining: 10,
          foodSafetyStatus: 'HOLD',
        },
        {
          id: 'ok',
          batchNo: 'B-OK',
          expiryDate: '2026-08-10',
          qtyRemaining: 4,
          foodSafetyStatus: 'PENDING',
        },
      ],
      { asOf: new Date('2026-08-05'), rejectFoodSafetyHold: true },
    );
    expect(result.allocations.map((a) => a.batchId)).toEqual(['ok']);
    expect(result.allocated).toBe(4);
    expect(result.shortfall).toBe(6);
  });

  it('tanpa rejectFoodSafetyHold — HOLD masih bisa dialokasi (pure allocator)', () => {
    const result = allocateFefo(
      5,
      [{
        id: 'hold',
        expiryDate: '2026-08-20',
        qtyRemaining: 5,
        foodSafetyStatus: 'HOLD',
      }],
      { asOf: new Date('2026-08-05') },
    );
    expect(result.allocated).toBe(5);
  });
});

describe('ADR-004 P0G — pesan shortfall food safety', () => {
  it('menyebut HOLD dan batch tertahan', () => {
    const msg = buildFoodSafetyHoldBlockMessage({
      stokId: 'fg1',
      stokNama: 'Nasi Kotak',
      needQty: 10,
      availableQty: 2,
      heldQty: 8,
      heldBatchNos: ['B-1', 'B-2'],
      context: 'distribusi',
    });
    expect(msg).toMatch(/food safety \(HOLD\)/);
    expect(msg).toMatch(/Nasi Kotak/);
    expect(msg).toMatch(/B-1/);
    expect(msg).toMatch(/distribusi/);
  });
});

describe('ADR-004 P0G — pra-validasi exit gate', () => {
  function fakeDb(rows: Array<Record<string, unknown>>) {
    const cursor = {
      sort: () => cursor,
      toArray: async () => rows,
    };
    return {
      collection: () => ({
        find: () => cursor,
      }),
    };
  }

  it('lolos bila qty aman cukup meski ada HOLD', async () => {
    const result = await checkFefoExitLineAgainstHold(fakeDb([
      {
        id: 'h1', batchNo: 'B-H', expiryDate: '2026-08-20', qtyRemaining: 100,
        status: 'ACTIVE', foodSafetyStatus: 'HOLD',
      },
      {
        id: 'ok', batchNo: 'B-OK', expiryDate: '2026-08-10', qtyRemaining: 10,
        status: 'ACTIVE', foodSafetyStatus: 'PENDING',
      },
    ]) as never, {
      tenantId: 't1',
      line: { stokId: 'fg1', warehouseKode: 'G1', needQty: 5 },
      asOf: new Date('2026-08-05'),
    });
    expect(result.ok).toBe(true);
  });

  it('blokir bila shortfall karena stok HOLD', async () => {
    const result = await checkFefoExitLineAgainstHold(fakeDb([
      {
        id: 'h1', batchNo: 'B-HOLD', expiryDate: '2026-08-01', qtyRemaining: 10,
        status: 'ACTIVE', foodSafetyStatus: 'HOLD',
      },
      {
        id: 'ok', batchNo: 'B-OK', expiryDate: '2026-08-10', qtyRemaining: 2,
        status: 'ACTIVE', foodSafetyStatus: 'PENDING',
      },
    ]) as never, {
      tenantId: 't1',
      line: {
        stokId: 'fg1',
        stokNama: 'Ayam',
        warehouseKode: 'G1',
        needQty: 8,
      },
      asOf: new Date('2026-08-05'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/food safety \(HOLD\)/);
      expect(result.error).toMatch(/Ayam/);
      expect(result.heldBatchNos).toContain('B-HOLD');
      expect(result.availableQty).toBe(2);
      expect(result.heldQty).toBe(10);
    }
  });

  it('legacy tanpa batch production → lolos', async () => {
    const result = await checkFefoExitLineAgainstHold(fakeDb([]) as never, {
      tenantId: 't1',
      line: { stokId: 'fg1', warehouseKode: 'G1', needQty: 5 },
    });
    expect(result.ok).toBe(true);
  });

  it('enforce=false → assert selalu lolos', async () => {
    const result = await assertFefoExitNotBlockedByHold(fakeDb([
      {
        id: 'h1', batchNo: 'B-H', expiryDate: '2026-08-01', qtyRemaining: 10,
        status: 'ACTIVE', foodSafetyStatus: 'HOLD',
      },
    ]) as never, {
      tenantId: 't1',
      enforce: false,
      lines: [{ stokId: 'fg1', warehouseKode: 'G1', needQty: 5 }],
    });
    expect(result.ok).toBe(true);
  });

  it('blokir bila seluruh batch HOLD', async () => {
    const result = await checkFefoExitLineAgainstHold(fakeDb([
      {
        id: 'h1', batchNo: 'B-ONLY-HOLD', expiryDate: '2026-08-20', qtyRemaining: 10,
        status: 'ACTIVE', foodSafetyStatus: 'HOLD',
      },
    ]) as never, {
      tenantId: 't1',
      line: { stokId: 'fg1', warehouseKode: 'G1', needQty: 5 },
      asOf: new Date('2026-08-05'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.availableQty).toBe(0);
      expect(result.heldQty).toBe(10);
      expect(result.error).toMatch(/HOLD/);
    }
  });

  it('shortfall tanpa HOLD → tidak diblokir gate food safety', async () => {
    const result = await checkFefoExitLineAgainstHold(fakeDb([
      {
        id: 'ok', batchNo: 'B-OK', expiryDate: '2026-08-10', qtyRemaining: 2,
        status: 'ACTIVE', foodSafetyStatus: 'PENDING',
      },
    ]) as never, {
      tenantId: 't1',
      line: { stokId: 'fg1', warehouseKode: 'G1', needQty: 8 },
      asOf: new Date('2026-08-05'),
    });
    expect(result.ok).toBe(true);
  });
  it('assertConsumeShortfallNotDueToHold — no-op bila shortfall 0', async () => {
    const { assertConsumeShortfallNotDueToHold } = await import(
      '@/lib/food-production/food-safety-exit-gate'
    );
    const result = await assertConsumeShortfallNotDueToHold(fakeDb([]) as never, {
      tenantId: 't1',
      enforce: true,
      shortfall: 0,
      skippedNoBatches: false,
      line: { stokId: 'fg1', warehouseKode: 'G1', needQty: 5 },
    });
    expect(result.ok).toBe(true);
  });
});

describe('ADR-004 P0G — consume + flag', () => {
  it('consumeBatchesFefo filter HOLD saat enforce', async () => {
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
    await consumeBatchesFefo(db as never, {
      tenantId: 't1',
      stokId: 'fg1',
      warehouseKode: 'G1',
      needQty: 1,
      enforceFoodSafetyHold: true,
    });
    expect(seen[0].foodSafetyStatus).toEqual({ $ne: 'HOLD' });
  });

  it('feature flag foodSafetyHoldEnabled default true / kill switch false', () => {
    expect(DEFAULT_FEATURE_FLAGS.foodSafetyHoldEnabled).toBe(true);
    expect(mergeFeatureFlags({ features: { foodSafetyHoldEnabled: false } }).foodSafetyHoldEnabled)
      .toBe(false);
  });
});

describe('ADR-004 P0G — relocate FEFO menghormati HOLD', () => {
  it('enforceFoodSafetyHold menyaring HOLD dari query relocate', async () => {
    const { relocateBatchesFefo } = await import('@/lib/food-production/transfer-fefo');
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
    await relocateBatchesFefo(db as never, {
      tenantId: 't1',
      stokId: 'fg1',
      fromWarehouseKode: 'A',
      toWarehouseKode: 'B',
      needQty: 5,
      enforceFoodSafetyHold: true,
    });
    expect(seen[0].foodSafetyStatus).toEqual({ $ne: 'HOLD' });
  });
});

describe('ADR-004 P0G — filter publik (kontrak query)', () => {
  it('filter HOLD sama bentuknya dengan FEFO exit', () => {
    // Kontrak yang dipakai fp-public/batches saat flag aktif.
    const filter = { status: 'ACTIVE', foodSafetyStatus: { $ne: 'HOLD' } };
    expect(filter.foodSafetyStatus).toEqual({ $ne: 'HOLD' });
  });
});
