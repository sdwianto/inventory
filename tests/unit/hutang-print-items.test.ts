import { describe, expect, it } from 'vitest';
import { buildHutangPrintItemRows } from '@/lib/hutang-print-items';

describe('buildHutangPrintItemRows', () => {
  it('flattens invoice items like acuan pengadaan rows', () => {
    const rows = buildHutangPrintItemRows([
      {
        id: 'h1',
        noInvoice: 'INV1',
        noPO: 'CPO1',
        noDO: 'DO1',
        noSO: 'SO1',
        supplierName: 'UD Dawam',
        tanggalPermintaanKirim: '2026-08-12',
        tanggal: '2026-08-13',
        items: [
          { kode: 'B094783', nama: 'Seledri', satuan: 'ONS', qty: 3, harga: 1000 },
          { kode: 'B154797', nama: 'Daun Pandan', satuan: 'KG', qty: 1, harga: 5000 },
        ],
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kode: 'B094783',
      nama: 'Seledri',
      satuan: 'ONS',
      qty: 3,
      vendor: 'UD Dawam',
      noInvoice: 'INV1',
      noPO: 'CPO1',
      noDO: 'DO1',
    });
    expect(rows[1].kode).toBe('B154797');
  });

  it('prefers itemsFull over items', () => {
    const rows = buildHutangPrintItemRows([
      {
        id: 'h2',
        noInvoice: 'INV2',
        items: [{ kode: 'OLD', nama: 'Old', qty: 1 }],
        itemsFull: [{ kode: 'NEW', nama: 'New', satuan: 'PCS', qty: 2 }],
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kode).toBe('NEW');
    expect(rows[0].qty).toBe(2);
  });
});
