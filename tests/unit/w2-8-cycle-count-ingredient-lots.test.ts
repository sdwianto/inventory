import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncLotsOnVariance } from '@/lib/stock-ledger/lot-cycle-count';

const consumeIngredientLotsFefo = vi.fn();

const isTenantFeatureEnabled = vi.fn();

vi.mock('@/lib/stock-ledger/lot-consume', () => ({
  consumeIngredientLotsFefo: (...args: unknown[]) => consumeIngredientLotsFefo(...args),
}));

vi.mock('@/lib/api/feature-flags', () => ({
  isTenantFeatureEnabled: (...args: unknown[]) => isTenantFeatureEnabled(...args),
}));

type LotResult = Awaited<ReturnType<typeof syncLotsOnVariance>>;
const okResult = (r: LotResult) => {
  if ('error' in r) throw new Error(r.error);
  return r;
};

function emptyLotsDb() {
  const findCursor = {
    sort: () => findCursor,
    limit: () => findCursor,
    toArray: async () => [],
  };
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    collection: () => ({
      find: () => findCursor,
      insertOne: async (doc: Record<string, unknown>) => {
        inserted.push(doc);
        return { insertedId: 'x' };
      },
    }),
  };
  return { db, inserted };
}

const newLotInput = {
  tenantId: 't1',
  stokId: 'p1',
  warehouseKode: 'GBASAH',
  deltaQty: 175,
  asOf: new Date('2026-09-12T09:00:00.000Z'),
  noDokumen: 'PS2609000001',
  penyesuaianId: 'ps-id-1',
  productKode: 'B313252',
  productNama: 'Telur Ayam',
  satuan: 'PCS',
};

describe('W2-8 syncLotsOnVariance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTenantFeatureEnabled.mockResolvedValue(false);
  });

  it('count down calls FEFO lot consume with allowExpired', async () => {
    consumeIngredientLotsFefo.mockResolvedValue({
      allocated: 4,
      shortfall: 0,
      skippedNoLots: false,
      needQty: 4,
      stokId: 'p1',
      warehouseKode: 'GKERING',
      allocations: [],
    });
    const result = okResult(await syncLotsOnVariance({} as never, {
      tenantId: 't1',
      stokId: 'p1',
      warehouseKode: 'GKERING',
      deltaQty: -4,
      noDokumen: 'PS-1',
    }));
    expect(consumeIngredientLotsFefo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ needQty: 4, allowExpired: true }),
      undefined,
    );
    expect(result.consumed).toBe(4);
    expect(result.skippedNoLots).toBe(false);
  });

  it('count up increases newest lot', async () => {
    const lot = {
      id: 'l1',
      tenantId: 't1',
      qty: 10,
      qtyRemaining: 3,
      status: 'ACTIVE',
      expiryDate: '2026-09-01',
      productId: 'p1',
      warehouseKode: 'GKERING',
    };
    const updates: Array<Record<string, unknown>> = [];
    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => [lot],
    };
    const db = {
      collection: () => ({
        find: () => findCursor,
        updateOne: async (_f: unknown, u: { $set: Record<string, unknown> }) => {
          updates.push(u.$set);
          return { modifiedCount: 1 };
        },
      }),
    };

    const result = okResult(await syncLotsOnVariance(db as never, {
      tenantId: 't1',
      stokId: 'p1',
      warehouseKode: 'GKERING',
      deltaQty: 5,
      asOf: new Date('2026-07-25T12:00:00.000Z'),
      noDokumen: 'PS-2',
    }));

    expect(result.increased).toBe(5);
    expect(updates[0]).toMatchObject({ qtyRemaining: 8, status: 'ACTIVE' });
  });

  it('count up creates PENYESUAIAN lot when none exist (flag off, no shelf → DEFAULT marked)', async () => {
    const { db, inserted } = emptyLotsDb();
    const result = okResult(await syncLotsOnVariance(db as never, newLotInput));
    expect(result.skippedNoLots).toBe(false);
    expect(result.increased).toBe(175);
    expect(result.createdLotId).toBeTruthy();
    expect(inserted[0]).toMatchObject({
      sourceType: 'PENYESUAIAN',
      noPenyesuaian: 'PS2609000001',
      productId: 'p1',
      warehouseKode: 'GBASAH',
      qty: 175,
      qtyRemaining: 175,
      status: 'ACTIVE',
      expiryDate: '2026-10-12',
      expirySource: 'DEFAULT',
    });
  });

  it('new lot uses master shelf life (MASTER_SHELF) when set', async () => {
    isTenantFeatureEnabled.mockResolvedValue(true);
    const { db, inserted } = emptyLotsDb();
    okResult(await syncLotsOnVariance(db as never, { ...newLotInput, shelfLifeDays: 14 }));
    expect(inserted[0]).toMatchObject({ expiryDate: '2026-09-26', expirySource: 'MASTER_SHELF' });
  });

  it('flag on + no shelf life → rejected, no lot inserted', async () => {
    isTenantFeatureEnabled.mockResolvedValue(true);
    const { db, inserted } = emptyLotsDb();
    const result = await syncLotsOnVariance(db as never, newLotInput);
    expect('error' in result && result.error).toMatch(/isi masa simpan di master produk/);
    expect(inserted).toHaveLength(0);
  });
});
