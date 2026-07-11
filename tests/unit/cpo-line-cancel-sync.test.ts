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
});
