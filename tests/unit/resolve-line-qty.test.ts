import { describe, it, expect } from 'vitest';
import {
  resolveLineQtyBaseFromUoms,
  sumQtyBaseByStokId,
  mergeResolvedIntoLine,
  unitCostPerBaseFromLine,
} from '@/lib/uom/resolve-line-qty';
import type { ProductUom } from '@/lib/uom/types';

const uoms: ProductUom[] = [
  {
    id: 'uom-base',
    productId: 'p1',
    tenantId: 't1',
    satuan: 'SACHET',
    isBase: true,
    factorToBase: 1,
    hargaEcer: 2000,
    hargaGrosir: 0,
    hargaSpesial: 0,
    barcode: '',
    sortOrder: 0,
    aktif: true,
  },
  {
    id: 'uom-box',
    productId: 'p1',
    tenantId: 't1',
    satuan: 'BOX',
    isBase: false,
    factorToBase: 10,
    hargaEcer: 18000,
    hargaGrosir: 0,
    hargaSpesial: 0,
    barcode: '',
    sortOrder: 1,
    aktif: true,
  },
];

describe('resolveLineQtyBaseFromUoms', () => {
  it('resolves by uomId to base qty', () => {
    const r = resolveLineQtyBaseFromUoms({ qty: 2, uomId: 'uom-box' }, uoms);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.qtyBase).toBe(20);
      expect(r.satuan).toBe('BOX');
    }
  });

  it('resolves by satuan label', () => {
    const r = resolveLineQtyBaseFromUoms({ qty: 3, satuan: 'box' }, uoms);
    expect('error' in r).toBe(false);
    if (!('error' in r)) expect(r.qtyBase).toBe(30);
  });

  it('legacy line without uom treats qty as base', () => {
    const r = resolveLineQtyBaseFromUoms({ qty: 5 }, uoms);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.qtyBase).toBe(5);
      expect(r.uomId).toBe('uom-base');
    }
  });

  it('rejects unknown uomId', () => {
    const r = resolveLineQtyBaseFromUoms({ qty: 1, uomId: 'missing' }, uoms);
    expect('error' in r).toBe(true);
  });
});

describe('sumQtyBaseByStokId', () => {
  it('aggregates multiple lines per stokId in base unit', async () => {
    const db = {
      collection: () => ({
        find: () => ({
          sort: () => ({
            toArray: async () => uoms.map((u) => ({ ...u })),
          }),
        }),
      }),
    };
    const r = await sumQtyBaseByStokId(db as never, 't1', [
      { stokId: 'p1', qty: 1, uomId: 'uom-box' },
      { stokId: 'p1', qty: 2, satuan: 'SACHET' },
    ]);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.totals.get('p1')).toBe(12);
      expect(r.byLine).toHaveLength(2);
    }
  });
});

describe('helpers', () => {
  it('mergeResolvedIntoLine copies resolved fields', () => {
    const line = { stokId: 'p1', harga: 1000 };
    const resolved = resolveLineQtyBaseFromUoms({ qty: 2, uomId: 'uom-box' }, uoms);
    if ('error' in resolved) throw new Error(resolved.error);
    const merged = mergeResolvedIntoLine(line, resolved);
    expect(merged.qtyBase).toBe(20);
    expect(merged.stokId).toBe('p1');
  });

  it('unitCostPerBaseFromLine spreads line total over base qty', () => {
    const resolved = resolveLineQtyBaseFromUoms({ qty: 2, uomId: 'uom-box' }, uoms);
    if ('error' in resolved) throw new Error(resolved.error);
    expect(unitCostPerBaseFromLine(resolved, 36000)).toBe(1800);
  });
});
