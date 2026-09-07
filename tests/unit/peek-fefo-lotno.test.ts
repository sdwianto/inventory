import { describe, expect, it } from 'vitest';
import { peekFefoLotNo } from '@/lib/food-production/ingredient-lot-consume';

describe('peekFefoLotNo', () => {
  it('mengembalikan lot FEFO pertama yang qtyRemaining > 0', async () => {
    const lots = [
      {
        id: 'a',
        lotNo: 'OLD',
        expiryDate: '2026-01-01',
        qty: 10,
        qtyRemaining: 0,
        status: 'ACTIVE',
      },
      {
        id: 'b',
        lotNo: 'NEXT',
        expiryDate: '2026-02-01',
        qty: 5,
        qtyRemaining: 5,
        status: 'ACTIVE',
      },
    ];
    const db = {
      collection: () => ({
        find: () => ({
          sort: () => ({
            limit: () => ({
              toArray: async () => lots,
            }),
          }),
        }),
      }),
    } as never;

    const no = await peekFefoLotNo(db, {
      tenantId: 'sppg',
      stokId: 'p1',
      warehouseKode: 'GKERING',
    });
    expect(no).toBe('NEXT');
  });

  it('null jika tidak ada lot', async () => {
    const db = {
      collection: () => ({
        find: () => ({
          sort: () => ({
            limit: () => ({
              toArray: async () => [],
            }),
          }),
        }),
      }),
    } as never;
    expect(await peekFefoLotNo(db, {
      tenantId: 'sppg',
      stokId: 'p1',
      warehouseKode: 'GKERING',
    })).toBeNull();
  });
});
