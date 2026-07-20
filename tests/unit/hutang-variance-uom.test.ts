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

  it('screenshot-like: PO has satuan, invoice lacks satuan, SO snapshot empty', () => {
    const rows = buildLineVarianceByUom({
      poItems: [
        { kode: 'B050569', satuan: 'KG', qty: 1.5 },
        { kode: 'B151724', satuan: 'BTL', qty: 2 },
      ],
      soItems: [],
      invoiceItems: [
        { kode: 'B050569', qty: 1.5, nama: 'Knoor' },
        { kode: 'B151724', qty: 2, nama: 'Kecap' },
      ],
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.soLineMissing).toBe(true);
      expect(row.invLineMissing).toBe(false);
      expect(row.variancePoToSo).toBeNull();
      expect(row.invoiceQty).toBe(row.poQty);
      expect(row.varianceSoToInvoice).toBe(0);
    }
  });

  it('collapses invoice _default into PO satuan when qty uniquely matches', () => {
    const rows = buildLineVarianceByUom({
      poItems: [
        { kode: 'SKU1', satuan: 'BOX', qty: 2 },
        { kode: 'SKU1', satuan: 'PCS', qty: 24 },
      ],
      soItems: [
        { kode: 'SKU1', satuan: 'BOX', qty: 2 },
        { kode: 'SKU1', satuan: 'PCS', qty: 24 },
      ],
      invoiceItems: [
        { kode: 'SKU1', qty: 24 }, // no satuan — should land on PCS
      ],
    });
    const pcs = rows.find((r) => r.satuan === 'PCS');
    const box = rows.find((r) => r.satuan === 'BOX');
    expect(pcs?.invoiceQty).toBe(24);
    expect(pcs?.varianceSoToInvoice).toBe(0);
    expect(box?.invoiceQty).toBe(0);
    expect(box?.invLineMissing).toBe(true);
  });

  it('treats explicit SO qty 0 as matched zero, not missing', () => {
    const rows = buildLineVarianceByUom({
      poItems: [{ kode: 'A1', satuan: 'PCS', qty: 2 }],
      soItems: [{ kode: 'A1', satuan: 'PCS', qty: 0 }],
      invoiceItems: [{ kode: 'A1', satuan: 'PCS', qty: 2 }],
    });
    expect(rows[0]).toMatchObject({
      soLineMissing: false,
      soQty: 0,
      variancePoToSo: -2,
      varianceSoToInvoice: 2,
    });
  });
});

describe('poItemsForHutang', () => {
  it('filters multi-vendor PO items to the invoiced vendor', async () => {
    const { poItemsForHutang } = await import('@/lib/api/hutang-variance-enrich');
    const po = {
      vendorTenantId: 'multi',
      vendorSubmissions: [
        { vendorTenantId: 'vendor-a', vendorNoSO: 'SO-A' },
        { vendorTenantId: 'vendor-b', vendorNoSO: 'SO-B' },
      ],
      items: [
        { kode: 'A', satuan: 'PCS', qty: 1, vendorTenantId: 'vendor-a' },
        { kode: 'B', satuan: 'PCS', qty: 2, vendorTenantId: 'vendor-b' },
      ],
    };
    const rows = poItemsForHutang(po, { vendorTenantId: 'vendor-b', noSO: 'SO-B' } as never);
    expect(rows).toHaveLength(1);
    expect(rows[0].kode).toBe('B');
  });
});
