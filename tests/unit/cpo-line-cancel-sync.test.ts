import { describe, expect, it } from 'vitest';
import {
  applyCancelledLinesToPoItems,
  applySoCancelledWebhookToPoItems,
  diffPoItemsAgainstActiveSo,
  syncCpoFromSoPayload,
} from '@/lib/api/cpo-line-cancel-sync';

describe('cpo-line-cancel-sync', () => {
  const poItems = [
    { lineId: 'l1', kode: 'B950648', nama: 'Jambu Merah', qty: 1, satuan: 'PCS' },
    { lineId: 'l2', kode: 'B397767', nama: 'Kedondong', qty: 1, satuan: 'PCS' },
    { lineId: 'l3', kode: 'B887155', nama: 'Pisang', qty: 1, satuan: 'PCS' },
  ];

  it('marks explicit cancelled line by kode', () => {
    const rows = applyCancelledLinesToPoItems(
      poItems,
      [{ kode: 'B950648', qty: 1, reason: 'Stok tidak ada' }],
      { salesOrderId: 'so-1', noSO: 'SO001' },
    );
    expect(rows[0].cancelled).toBe(true);
    expect(rows[0].cancelReason).toContain('Stok');
    expect(rows[1].cancelled).toBeFalsy();
  });

  it('diffs PO items against active SO items', () => {
    const rows = diffPoItemsAgainstActiveSo(
      poItems,
      [{ kode: 'B397767', qty: 1, satuan: 'PCS' }],
      { noSO: 'SO2607000004' },
    );
    expect(rows.filter((r) => r.cancelled)).toHaveLength(2);
    expect(rows.find((r) => r.kode === 'B397767')?.cancelled).toBeFalsy();
  });

  it('does not cancel other-vendor lines when scoped to one vendor SO', () => {
    const rows = diffPoItemsAgainstActiveSo(
      [
        { lineId: 'l1', kode: 'B553057', nama: 'Abon', qty: 1, vendorTenantId: 'uddawam' },
        { lineId: 'l2', kode: 'B711755', nama: 'Tempe', qty: 1, vendorTenantId: 'tempe' },
      ],
      [{ kode: 'B553057', qty: 1 }],
      { noSO: 'SO-DAWAM', vendorTenantId: 'uddawam' },
      new Date(),
      { vendorTenantId: 'uddawam', onlyVendorLines: true },
    );
    expect(rows.find((r) => r.kode === 'B553057')?.cancelled).toBeFalsy();
    expect(rows.find((r) => r.kode === 'B711755')?.cancelled).toBeFalsy();
  });

  it('syncs qty/satuan/uom from matched SO item (estimate unit differs from confirmed SO unit)', () => {
    const rows = diffPoItemsAgainstActiveSo(
      [{ lineId: 'l1', kode: 'B463855', nama: 'Semangka', qty: 204, satuan: 'KG' }],
      [{ kode: 'B463855', qty: 2700, satuan: 'ONS', uomId: 'uom-ons', factorToBase: 1 }],
      { noSO: 'SO2608000005' },
    );
    const row = rows.find((r) => r.kode === 'B463855');
    expect(row?.qty).toBe(2700);
    expect(row?.satuan).toBe('ONS');
    expect(row?.uomId).toBe('uom-ons');
    expect(row?.factorToBase).toBe(1);
  });

  it('does not touch qtyShipped/qtyReceived/harga when syncing qty/uom from matched SO', () => {
    const rows = diffPoItemsAgainstActiveSo(
      [{
        lineId: 'l1', kode: 'B463855', nama: 'Semangka', qty: 204, satuan: 'KG',
        harga: 1500, qtyShipped: 2700, qtyReceived: 2700,
      }],
      [{ kode: 'B463855', qty: 2700, satuan: 'ONS', uomId: 'uom-ons' }],
      { noSO: 'SO2608000005' },
    );
    const row = rows.find((r) => r.kode === 'B463855');
    expect(row?.qty).toBe(2700);
    expect(row?.harga).toBe(1500);
    expect(row?.qtyShipped).toBe(2700);
    expect(row?.qtyReceived).toBe(2700);
  });

  it('restores auto-cancelled line when it reappears on SO', () => {
    const rows = diffPoItemsAgainstActiveSo(
      [{
        lineId: 'l1',
        kode: 'B950648',
        nama: 'Jambu',
        qty: 1,
        cancelled: true,
        cancelReason: 'Tidak ada di SO sales.app',
        cancelledSource: 'sales.app',
        qtyOriginal: 1,
      }],
      [{ kode: 'B950648', qty: 1 }],
      { noSO: 'SO001' },
    );
    expect(rows[0].cancelled).toBeFalsy();
    expect(rows[0].cancelReason).toBeFalsy();
  });

  it('syncCpoFromSoPayload sets PARTIAL_CANCELLED status', () => {
    const result = syncCpoFromSoPayload(
      { id: 'cpo-1', status: 'SUBMITTED', items: poItems },
      {
        salesOrderId: 'so-1',
        noSO: 'SO001',
        items: [{ kode: 'B397767', qty: 1 }],
        cancelledLine: { kode: 'B950648', qty: 1 },
      },
    );
    expect(result.status).toBe('PARTIAL_CANCELLED');
    expect(result.items?.filter((r) => r.cancelled)).toHaveLength(2);
    expect(result.cancelledSoLines?.length).toBeGreaterThan(0);
  });
});

describe('applySoCancelledWebhookToPoItems', () => {
  it('marks scoped vendor lines and returns PARTIAL_CANCELLED for multi-vendor PO', () => {
    const result = applySoCancelledWebhookToPoItems(
      [
        { lineId: 'l1', kode: 'B553057', nama: 'Abon', qty: 1, vendorTenantId: 'uddawam' },
        { lineId: 'l2', kode: 'B711755', nama: 'Tempe', qty: 1, vendorTenantId: 'tempe' },
      ],
      { cancelledItems: [{ kode: 'B711755', qty: 1, reason: 'Batal' }], vendorTenantId: 'tempe' },
      { salesOrderId: 'so-1', noSO: 'SO001' },
      'CONFIRMED',
    );
    expect(result.status).toBe('PARTIAL_CANCELLED');
    expect(result.items.find((r) => r.kode === 'B711755')?.cancelled).toBe(true);
    expect(result.items.find((r) => r.kode === 'B553057')?.cancelled).toBeFalsy();
  });

  it('falls back to vendor-scoped cancel when cancelledItems lineIds do not match', () => {
    const result = applySoCancelledWebhookToPoItems(
      [
        { lineId: 'po-l1', kode: 'B553057', nama: 'Abon', qty: 2, vendorTenantId: 'uddawam' },
        { lineId: 'po-l2', kode: 'B711755', nama: 'Tempe', qty: 1, vendorTenantId: 'tempe' },
      ],
      {
        cancelledItems: [{ lineId: 'sales-line-x', kode: '', qty: 2, reason: 'Batal vendor' }],
        vendorTenantId: 'uddawam',
      },
      { salesOrderId: 'so-1', noSO: 'SO001' },
      'SUBMITTED',
    );
    expect(result.status).toBe('PARTIAL_CANCELLED');
    expect(result.items.find((r) => r.kode === 'B553057')?.cancelled).toBe(true);
    expect(result.items.find((r) => r.kode === 'B711755')?.cancelled).toBeFalsy();
  });

  it('returns CANCELLED when all vendor lines are cancelled', () => {
    const result = applySoCancelledWebhookToPoItems(
      [
        { lineId: 'l1', kode: 'B553057', nama: 'Abon', qty: 1, vendorTenantId: 'uddawam' },
      ],
      { vendorTenantId: 'uddawam', reason: 'SO dibatalkan' },
      { salesOrderId: 'so-1', noSO: 'SO001' },
      'SUBMITTED',
    );
    expect(result.status).toBe('CANCELLED');
    expect(result.items.every((r) => r.cancelled)).toBe(true);
  });
});
