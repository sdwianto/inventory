import { describe, it, expect } from 'vitest';
import { buildLineVarianceByUom } from '@/lib/api/hutang-variance-enrich';

describe('buildLineVarianceByUom', () => {
  it('computes per-UOM qty variance', () => {
    const rows = buildLineVarianceByUom({
      poItems: [
        { kode: 'SKU1', uomId: 'uom-box', satuan: 'BOX', qty: 2 },
        { kode: 'SKU1', uomId: 'uom-pcs', satuan: 'PCS', qty: 24 },
      ],
      soItems: [
        { kode: 'SKU1', uomId: 'uom-box', satuan: 'BOX', qty: 2 },
        { kode: 'SKU1', uomId: 'uom-pcs', satuan: 'PCS', qty: 20 },
      ],
      invoiceItems: [
        { kode: 'SKU1', uomId: 'uom-box', satuan: 'BOX', qty: 2 },
        { kode: 'SKU1', uomId: 'uom-pcs', satuan: 'PCS', qty: 18 },
      ],
    });
    expect(rows).toHaveLength(2);
    const pcs = rows.find((r) => r.satuan === 'PCS');
    expect(pcs?.variancePoToSo).toBe(-4);
    expect(pcs?.varianceSoToInvoice).toBe(-2);
  });

  it('merges PO (uomId) and invoice (satuan only) into one row', () => {
    const rows = buildLineVarianceByUom({
      poItems: [{ kode: 'B887155', uomId: 'local-uom-pcs', satuan: 'PCS', qty: 1 }],
      soItems: [],
      invoiceItems: [{ kode: 'B887155', satuan: 'PCS', qty: 1 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kode: 'B887155',
      satuan: 'PCS',
      poQty: 1,
      soQty: 0,
      invoiceQty: 1,
      variancePoToSo: -1,
      varianceSoToInvoice: 1,
    });
  });

  it('drops rows with zero qty across PO, SO, and invoice', () => {
    const rows = buildLineVarianceByUom({
      poItems: [{ kode: 'B397767', uomId: 'uom-a', satuan: 'PCS', qty: 1 }],
      soItems: [],
      invoiceItems: [{ kode: 'B397767', satuan: 'PCS', qty: 0 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].poQty).toBe(1);
    expect(rows[0].invoiceQty).toBe(0);
  });
});
