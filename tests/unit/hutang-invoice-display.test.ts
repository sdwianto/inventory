import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  lineNetQty,
  lineReturnedQty,
  normalizeInvoiceLineId,
  returnedQtyByInvoiceLine,
  summarizeHutangCreditDisplay,
} from '@/lib/hutang-invoice-display';

describe('hutang-invoice-display', () => {
  it('normalizes inv: prefixed line ids', () => {
    expect(normalizeInvoiceLineId('inv:abc')).toBe('abc');
    expect(normalizeInvoiceLineId('abc')).toBe('abc');
  });

  it('summarizes RTV CN trail and per-line returned qty', () => {
    const summary = summarizeHutangCreditDisplay({
      total: 4_940_000,
      terbayar: 260_000,
      sisa: 4_680_000,
      creditNotes: [
        {
          noCN: 'CN2609000001',
          amount: 260_000,
          source: 'inventory_return',
          noReturn: 'RTV2609000001',
          items: [
            { lineId: '9e224eec-a407-4355-bdf3-3c9ef4f3204e', qty: 1, satuan: 'DUS' },
          ],
        },
      ],
    });

    expect(summary.hasCredits).toBe(true);
    expect(summary.hasPhysicalReturnQty).toBe(true);
    expect(summary.creditTotal).toBe(260_000);
    expect(summary.netTagihan).toBe(4_680_000);
    expect(summary.sisa).toBe(4_680_000);
    expect(summary.returnedQtyByLineId['9e224eec-a407-4355-bdf3-3c9ef4f3204e']).toBe(1);

    const line = { lineId: '9e224eec-a407-4355-bdf3-3c9ef4f3204e', qty: 19 };
    expect(lineReturnedQty(summary, line)).toBe(1);
    expect(lineNetQty(19, 1)).toBe(18);
  });

  it('aggregates multiple RTV CNs on the same line', () => {
    const byLine = returnedQtyByInvoiceLine([
      { source: 'inventory_return', items: [{ lineId: 'L1', qty: 1 }] },
      { noReturn: 'RTV2', items: [{ lineId: 'inv:L1', qty: 2 }] },
    ]);
    expect(byLine.L1).toBe(3);
  });

  it('ignores price-adjustment CN qty for Diretur columns', () => {
    const byLine = returnedQtyByInvoiceLine([
      {
        source: 'price_adjustment',
        amount: 50_000,
        items: [{ lineId: 'L1', qty: 2 }],
      },
      {
        source: 'inventory_return',
        amount: 260_000,
        items: [{ lineId: 'L1', qty: 1 }],
      },
    ]);
    expect(byLine.L1).toBe(1);

    const priceOnly = summarizeHutangCreditDisplay({
      total: 1_000_000,
      terbayar: 50_000,
      sisa: 950_000,
      creditNotes: [
        { source: 'price_adjustment', amount: 50_000, items: [{ lineId: 'L1', qty: 2 }] },
      ],
    });
    expect(priceOnly.hasCredits).toBe(true);
    expect(priceOnly.hasPhysicalReturnQty).toBe(false);
    expect(priceOnly.creditTotal).toBe(50_000);
    expect(Object.keys(priceOnly.returnedQtyByLineId)).toHaveLength(0);
  });

  it('matches returned qty when UI rows come from itemsFull (with lineId)', () => {
    const summary = summarizeHutangCreditDisplay({
      total: 100,
      terbayar: 10,
      sisa: 90,
      creditNotes: [
        { source: 'inventory_return', amount: 10, items: [{ lineId: 'line-1', qty: 2 }] },
      ],
    });
    // itemsFull shape after enrich fix
    expect(lineReturnedQty(summary, { lineNo: 1, lineId: 'line-1', qty: 5 })).toBe(2);
    // without lineId — no match (do not use lineNo as id)
    expect(lineReturnedQty(summary, { lineNo: 1, qty: 5 })).toBe(0);
  });

  it('enrichInvoiceItems passes lineId for itemsFull netting', () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/api/hutang-detail-enrich.ts'), 'utf8');
    expect(src).toMatch(/lineId:\s*it\.lineId/);
  });

  it('VendorInvoiceDocument / Thermal / list wire credit netting', () => {
    const doc = readFileSync(resolve(process.cwd(), 'components/VendorInvoiceDocument.tsx'), 'utf8');
    expect(doc).toContain('hasPhysicalReturnQty');
    expect(doc).toContain('Qty netto');
    expect(doc).toContain('Total Tagihan');
    expect(doc).toContain('netTagihan');
    expect(doc).not.toContain('Tagihan − Credit note');
    const thermal = readFileSync(resolve(process.cwd(), 'components/VendorInvoiceThermal.tsx'), 'utf8');
    expect(thermal).toContain('TOTAL TAGIHAN');
    expect(thermal).toContain('netTagihan');
    const list = readFileSync(resolve(process.cwd(), 'app/hutang/page.tsx'), 'utf8');
    expect(list).toContain('Sisa');
    expect(list).toContain('ada CN/retur');
  });
});
