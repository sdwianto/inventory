import { describe, expect, it } from 'vitest';
import { qtyAtWarehouse } from '@/lib/api/warehouse-qty';

describe('qtyAtWarehouse', () => {
  it('returns 0 when warehouse key missing', () => {
    expect(qtyAtWarehouse({ GKERING: 5 }, 'GBASAH')).toBe(0);
    expect(qtyAtWarehouse(undefined, 'GKERING')).toBe(0);
  });

  it('returns lokasi qty without global fallback', () => {
    expect(qtyAtWarehouse({ GKERING: 12 }, 'GKERING')).toBe(12);
    expect(qtyAtWarehouse({ GKERING: 0 }, 'GKERING')).toBe(0);
  });
});
