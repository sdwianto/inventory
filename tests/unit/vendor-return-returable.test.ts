import { describe, expect, it } from 'vitest';
import {
  assertReturnQtyWithinMax,
  buildReturableLines,
  sumPostedReturnQtyByLine,
} from '@/lib/api/vendor-return-returable';
import { hutangLineIdentityError } from '@/lib/api/vendor-return-map';

describe('vendor-return returable qty', () => {
  const hutang = {
    items: [
      { lineId: 'l1', stokId: 's1', kode: 'B1', nama: 'Beras', satuan: 'SAK', uomId: 'u1', qty: 10, harga: 1000 },
      { lineId: 'l2', stokId: 's2', kode: 'B2', nama: 'Minyak', satuan: 'PCS', uomId: 'u2', qty: 4, harga: 500 },
    ],
  };

  it('sisa = qty invoice jika belum ada RTV', () => {
    const rows = buildReturableLines(hutang, []);
    expect(rows[0].maxQty).toBe(10);
    expect(rows[1].maxQty).toBe(4);
  });

  it('mengurangi qty RTV POSTED/POSTING', () => {
    const rows = buildReturableLines(hutang, [
      { id: 'r1', status: 'POSTED', items: [{ invoiceLineId: 'l1', qty: 3 }] },
      { id: 'r2', status: 'POSTING', items: [{ invoiceLineId: 'l1', qty: 1 }] },
      { id: 'r3', status: 'DRAFT', items: [{ invoiceLineId: 'l1', qty: 9 }] },
    ]);
    expect(rows[0].maxQty).toBe(6);
    expect(rows[1].maxQty).toBe(4);
  });

  it('menolak qty di atas sisa', () => {
    const returable = buildReturableLines(hutang, [
      { status: 'POSTED', items: [{ invoiceLineId: 'l1', qty: 8 }] },
    ]);
    expect(assertReturnQtyWithinMax([
      { qty: 3, invoiceLineId: 'l1', localStokId: 'p1', localKode: 'B1' },
    ], returable)).toMatch(/melebihi sisa/);
    expect(assertReturnQtyWithinMax([
      { qty: 2, invoiceLineId: 'l1', localStokId: 'p1', localKode: 'B1' },
    ], returable)).toBeNull();
  });

  it('sumPostedReturnQtyByLine mengabaikan DRAFT', () => {
    const sum = sumPostedReturnQtyByLine([
      { status: 'DRAFT', items: [{ invoiceLineId: 'l1', qty: 99 }] },
      { status: 'POSTED', items: [{ invoiceLineId: 'l1', qty: 2 }] },
    ]);
    expect(sum['inv:l1']).toBe(2);
  });

  it('menolak hutang tanpa lineId atau uomId', () => {
    expect(hutangLineIdentityError({ kode: 'B1' })).toMatch(/lineId/);
    expect(hutangLineIdentityError({ lineId: 'l1', kode: 'B1' })).toMatch(/uomId/);
    expect(hutangLineIdentityError({ lineId: 'l1', uomId: 'u1', kode: 'B1' })).toBeNull();
  });
});
