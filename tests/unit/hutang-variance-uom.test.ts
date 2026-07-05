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
});
