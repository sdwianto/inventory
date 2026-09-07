import { describe, expect, it } from 'vitest';
import { allocateFefo, planFefoRestore } from '@/lib/food-production/fefo-allocate';
import { findLotConsumeForRejectedLine } from '@/lib/api/vendor-return-decision';

describe('planFefoRestore (shared)', () => {
  it('LIFO dari alokasi sebelumnya sampai returnQty', () => {
    const out = planFefoRestore(7, [
      { batchId: 'a', batchNo: 'A', expiryDate: '2026-01-01', qty: 5 },
      { batchId: 'b', batchNo: 'B', expiryDate: '2026-02-01', qty: 5 },
    ]);
    expect(out).toEqual([
      { batchId: 'b', batchNo: 'B', expiryDate: '2026-02-01', qty: 5 },
      { batchId: 'a', batchNo: 'A', expiryDate: '2026-01-01', qty: 2 },
    ]);
  });
});

describe('preferredLotNo two-phase (logic mirror consumeIngredientLotsFefo)', () => {
  it('ambil preferred dulu meski expiry lebih lambat dari lot lain', () => {
    const asOf = new Date('2026-06-01');
    const preferred = [
      { id: 'late', batchNo: 'PREF', expiryDate: '2026-12-01', qtyRemaining: 10 },
    ];
    const others = [
      { id: 'early', batchNo: 'OTHER', expiryDate: '2026-07-01', qtyRemaining: 10 },
    ];
    const prefPlan = allocateFefo(4, preferred, { asOf });
    const restPlan = allocateFefo(prefPlan.shortfall, others, { asOf });
    const merged = [...prefPlan.allocations, ...restPlan.allocations];
    expect(merged[0]?.batchId).toBe('late');
    expect(merged[0]?.qty).toBe(4);
    // Pure FEFO tanpa preferred akan ambil early dulu:
    const pure = allocateFefo(4, [...preferred, ...others], { asOf });
    expect(pure.allocations[0]?.batchId).toBe('early');
  });
});

describe('findLotConsumeForRejectedLine', () => {
  const lotConsume = [
    {
      lineId: 'rtv-l1',
      invoiceLineId: 'inv-1',
      localStokId: 'p1',
      warehouseKode: 'GKERING',
      needQty: 5,
      allocated: 5,
      shortfall: 0,
      skippedNoLots: false,
      allocations: [{ batchId: 'lot1', expiryDate: '2026-10-01', qty: 5 }],
    },
    {
      lineId: 'rtv-l2',
      invoiceLineId: 'inv-2',
      localStokId: 'p1',
      warehouseKode: 'GKERING',
      needQty: 3,
      allocated: 3,
      shortfall: 0,
      skippedNoLots: false,
      allocations: [{ batchId: 'lot2', expiryDate: '2026-11-01', qty: 3 }],
    },
  ];

  it('match by invoiceLineId — tidak tertukar dengan baris SKU sama', () => {
    const hit = findLotConsumeForRejectedLine(lotConsume, {
      invoiceLineId: 'inv-2',
      lineId: 'rtv-l2',
      localStokId: 'p1',
      gudangKode: 'GKERING',
    });
    expect(hit?.allocations[0]?.batchId).toBe('lot2');
  });

  it('dua baris SKU+gudang sama tanpa identity → tidak fallback (hindari restore salah)', () => {
    const hit = findLotConsumeForRejectedLine(lotConsume, {
      invoiceLineId: null,
      lineId: '',
      localStokId: 'p1',
      gudangKode: 'GKERING',
    });
    expect(hit).toBeUndefined();
  });

  it('fallback SKU+gudang hanya jika unik', () => {
    const hit = findLotConsumeForRejectedLine([lotConsume[0]], {
      invoiceLineId: null,
      lineId: '',
      localStokId: 'p1',
      gudangKode: 'GKERING',
    });
    expect(hit?.lineId).toBe('rtv-l1');
  });
});
