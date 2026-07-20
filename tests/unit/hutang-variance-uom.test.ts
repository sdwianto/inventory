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
    expect(pcs?.soLineMissing).toBe(false);
    expect(pcs?.invLineMissing).toBe(false);
  });

  it('reads qtyOrdered when qty missing on SO snapshot lines', () => {
    const rows = buildLineVarianceByUom({
      poItems: [{ kode: 'B618394', satuan: 'PCS', qty: 2 }],
      soItems: [{ kode: 'B618394', satuan: 'PCS', qtyOrdered: 2 }],
      invoiceItems: [{ kode: 'B618394', satuan: 'PCS', qty: 2 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      poQty: 2,
      soQty: 2,
      invoiceQty: 2,
      soLineMissing: false,
      invLineMissing: false,
      variancePoToSo: 0,
      varianceSoToInvoice: 0,
    });
  });

  it('merges PO (uomId) and invoice (satuan only) into one row', () => {
    const rows = buildLineVarianceByUom({
      poItems: [{ kode: 'B887155', uomId: 'local-uom-pcs', satuan: 'PCS', qty: 1 }],
      soItems: [{ kode: 'B887155', satuan: 'PCS', qty: 1 }],
      invoiceItems: [{ kode: 'B887155', satuan: 'PCS', qty: 1 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kode: 'B887155',
      satuan: 'PCS',
      poQty: 1,
      soQty: 1,
      invoiceQty: 1,
      variancePoToSo: 0,
      varianceSoToInvoice: 0,
    });
  });

  it('inherits PO satuan when invoice line has no satuan', () => {
    const rows = buildLineVarianceByUom({
      poItems: [{ kode: 'B050569', satuan: 'KG', qty: 1.5 }],
      soItems: [{ kode: 'B050569', satuan: 'KG', qty: 1.5 }],
      invoiceItems: [{ kode: 'B050569', qty: 1.5 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      satuan: 'KG',
      poQty: 1.5,
      soQty: 1.5,
      invoiceQty: 1.5,
      soLineMissing: false,
      invLineMissing: false,
      variancePoToSo: 0,
      varianceSoToInvoice: 0,
    });
  });

  it('does not treat missing SO line as qty 0', () => {
    const rows = buildLineVarianceByUom({
      poItems: [{ kode: 'B397767', satuan: 'PCS', qty: 1 }],
      soItems: [],
      invoiceItems: [{ kode: 'B397767', satuan: 'PCS', qty: 1 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      poQty: 1,
      soQty: 0,
      invoiceQty: 1,
      soLineMissing: true,
      invLineMissing: false,
      variancePoToSo: null,
      // Fallback: Inv − PO when SO line absent
      varianceSoToInvoice: 0,
    });
  });

  it('matches kode case-insensitively', () => {
    const rows = buildLineVarianceByUom({
      poItems: [{ kode: 'b151724', satuan: 'btl', qty: 2 }],
      soItems: [{ kode: 'B151724', satuan: 'BTL', qty: 2 }],
      invoiceItems: [{ kode: 'B151724', satuan: 'BTL', qty: 2 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].variancePoToSo).toBe(0);
    expect(rows[0].varianceSoToInvoice).toBe(0);
  });
});
