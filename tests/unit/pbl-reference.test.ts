import { describe, expect, it } from 'vitest';
import {
  STOCK_ISSUE_FILTER,
  buildReferenceIssueLines,
  isReferenceIssue,
  poOutstandingQty,
  referenceSourceLabel,
  summarizeReferenceIssueLines,
} from '@/lib/food-production/material-issue';
import { isPblReferenceModeActive, mergeFeatureFlags } from '@/lib/api/feature-flags';
import { analyzeActualCost, type ProductCostRef } from '@/lib/food-production/cost';

const ref = (over: Partial<Parameters<typeof buildReferenceIssueLines>[0][number]> = {}) => ({
  productId: 'gula',
  productIds: ['gula', 'gula-b'],
  productKode: 'GL01',
  productNama: 'Gula',
  satuan: 'KG',
  sumber: 'PO' as const,
  acuanQty: 5,
  poQtyReceived: 5,
  rlPosted: 3,
  pblPosted: 0,
  sisa: 2,
  stockWarehouseKode: 'GKERING',
  ...over,
});

describe('PBL acuan (Fase 1.4)', () => {
  it('mode efektif hanya bila pblReferenceMode dan rlFromPoReference sama-sama aktif', () => {
    expect(isPblReferenceModeActive(mergeFeatureFlags({ features: { pblReferenceMode: true } }))).toBe(false);
    expect(isPblReferenceModeActive(mergeFeatureFlags({ features: { rlFromPoReference: true } }))).toBe(false);
    expect(isPblReferenceModeActive(mergeFeatureFlags({
      features: { pblReferenceMode: true, rlFromPoReference: true },
    }))).toBe(true);
  });

  it('baris dari acuan: qty keluar 0, rencana = acuan, snapshot acuan/RL/sisa, gudang stok', () => {
    const lines = buildReferenceIssueLines([
      ref(),
      ref({ productId: 'garam', productIds: ['garam'], acuanQty: 0, rlPosted: 0, sisa: 0 }),
      ref({ productId: 'minyak', productIds: ['minyak'], sumber: 'MRP', acuanQty: 0, poQtyReceived: 0, rlPosted: 1, sisa: 0 }),
    ]);
    expect(lines.map((l) => l.productId)).toEqual(['gula', 'minyak']);
    expect(lines[0]).toMatchObject({
      productIds: ['gula', 'gula-b'],
      qtyPlanned: 5,
      qtyIssued: 0,
      sumber: 'PO',
      acuanQty: 5,
      poQtyReceived: 5,
      rlPosted: 3,
      sisa: 2,
      warehouseKode: 'GKERING',
    });
    expect(lines[1]).toMatchObject({ sumber: 'MRP', qtyPlanned: 0, rlPosted: 1 });

    expect(summarizeReferenceIssueLines(lines)).toMatchObject({
      lineCount: 2,
      qtyIssuedTotal: 0,
      rlPostedTotal: 4,
      sisaTotal: 2,
      sisaLineCount: 1,
    });
  });

  it('PO yang belum diterima tetap tercatat sebagai baris dan dihitung di ringkasan', () => {
    const lines = buildReferenceIssueLines([
      ref({ productId: 'telur', productIds: ['telur'], acuanQty: 0, poQtyOrdered: 10, poQtyReceived: 0, rlPosted: 0, sisa: 0 }),
      ref({ poQtyOrdered: 5 }),
      ref({ productId: 'sabun', productIds: ['sabun'], sumber: 'NONE', acuanQty: 0, poQtyReceived: 0, rlPosted: 1, sisa: 0 }),
    ]);
    expect(lines.map((l) => l.productId)).toEqual(['telur', 'gula', 'sabun']);
    expect(lines[0]).toMatchObject({ poQtyOrdered: 10, poQtyReceived: 0, sisa: 0 });
    expect(poOutstandingQty(lines[0])).toBe(10);
    expect(poOutstandingQty(lines[1])).toBe(0);
    expect(poOutstandingQty(lines[2])).toBe(0);
    expect(summarizeReferenceIssueLines(lines)).toMatchObject({ sisaLineCount: 1, poOutstandingLineCount: 1 });
    expect(referenceSourceLabel('NONE')).toBe('di luar rencana');
  });

  it('penanda mode dokumen', () => {
    expect(isReferenceIssue({ stockMode: 'REFERENCE' })).toBe(true);
    expect(isReferenceIssue({ stockMode: 'STOCK' })).toBe(false);
    expect(isReferenceIssue({})).toBe(false);
    expect(STOCK_ISSUE_FILTER).toEqual({ stockMode: { $ne: 'REFERENCE' } });
  });
});

describe('HPP aktual dari kartu stok', () => {
  const productsById = new Map<string, ProductCostRef>([
    ['gula', { productId: 'gula', productNama: 'Gula', satuan: 'KG', hargaBeli: 10 }],
    ['garam', { productId: 'garam', productNama: 'Garam', satuan: 'KG' }],
    ['minyak', { productId: 'minyak', productNama: 'Minyak', satuan: 'L', hargaBeli: 20 }],
  ]);
  const line = (productId: string, qty: number) => ({ productId, qtyPlanned: qty, qtyIssued: qty });

  it('kartu berharga menggantikan harga master', () => {
    const res = analyzeActualCost({
      planId: 'p1',
      issueLines: [line('gula', 3)],
      resultLines: [],
      productsById,
      kartuCostByProduct: new Map([['gula', { qtyOut: 3, amount: 36, zeroCostQty: 0 }]]),
    });
    expect(res.actualLines?.[0]).toMatchObject({ qty: 3, unitCost: 12, amount: 36, costSource: 'KARTU' });
    expect(res.actual?.totalCost).toBe(36);
    expect(res.warnings.some((w) => w.includes('hargaBeli master'))).toBe(false);
  });

  it('kartu tanpa harga / qty di luar kartu dinilai harga master dengan peringatan', () => {
    const res = analyzeActualCost({
      planId: 'p1',
      issueLines: [line('gula', 4), line('minyak', 2)],
      resultLines: [],
      productsById,
      kartuCostByProduct: new Map([['gula', { qtyOut: 3, amount: 24, zeroCostQty: 1 }]]),
    });
    // gula: 2 KG berharga (24) + 1 KG kartu Rp0 + 1 KG di luar kartu → 2 × 10.
    expect(res.actualLines?.find((l) => l.productId === 'gula')).toMatchObject({ amount: 44, costSource: 'KARTU_MASTER' });
    expect(res.actualLines?.find((l) => l.productId === 'minyak')).toMatchObject({ amount: 40, costSource: 'MASTER' });
    expect(res.actual?.totalCost).toBe(84);
    expect(res.warnings.some((w) => w.includes('2 bahan dinilai (sebagian) dengan hargaBeli master'))).toBe(true);
  });

  it('sisa tanpa harga kartu & tanpa hargaBeli master ditandai missingPrice', () => {
    const res = analyzeActualCost({
      planId: 'p1',
      issueLines: [line('garam', 2)],
      resultLines: [],
      productsById,
      kartuCostByProduct: new Map([['garam', { qtyOut: 2, amount: 0, zeroCostQty: 2 }]]),
    });
    expect(res.actualLines?.[0]).toMatchObject({ amount: 0, missingPrice: true, costSource: 'KARTU_MASTER' });
    expect(res.actual?.missingPriceCount).toBe(1);
  });

  it('tanpa kartu: perilaku lama (harga master, tanpa costSource)', () => {
    const res = analyzeActualCost({ planId: 'p1', issueLines: [line('gula', 3)], resultLines: [], productsById });
    expect(res.actualLines?.[0]).toMatchObject({ amount: 30, unitCost: 10 });
    expect(res.actualLines?.[0].costSource).toBeUndefined();
  });
});
