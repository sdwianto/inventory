import { describe, expect, it } from 'vitest';
import { buildReleasePrefill, type PrefillProduct } from '@/lib/food-production/release-prefill';
import type { PlanReference, PlanReferenceLine } from '@/lib/food-production/plan-reference';
import { mergePrefillIntoReleaseItems, type ReleaseFormItem } from '@/lib/pengeluaran-stok/release-form-items';

function refLine(p: Partial<PlanReferenceLine> & { productId: string }): PlanReferenceLine {
  return {
    productIds: [p.productId],
    satuan: 'KG',
    sumber: 'PO',
    acuanQty: 0,
    qtyMrp: 0,
    poQtyOrdered: 0,
    poQtyReceived: 0,
    poRefs: [],
    rlPosted: 0,
    rlRefs: [],
    rlPending: 0,
    pblPosted: 0,
    sisa: 0,
    ...p,
  };
}

function reference(lines: PlanReferenceLine[]): PlanReference {
  return {
    productionPlanId: 'p1',
    tenantId: 't1',
    mrpSource: 'MRP_DOC',
    lines,
    summary: { lineCount: 0, poLineCount: 0, mrpLineCount: 0, acuanTotal: 0, rlPostedTotal: 0, sisaTotal: 0 },
  };
}

function product(id: string, gudangKode = 'GKERING', factors: Record<string, number> = {}): PrefillProduct {
  return { id, kode: id.toUpperCase(), nama: id, gudangKode, baseUomId: `${id}-KG`, baseSatuan: 'KG', factorBySatuan: new Map(Object.entries(factors)) };
}

describe('buildReleasePrefill', () => {
  it('qty = min(sisa − RL menunggu, stok tersedia) dalam satuan dasar, dengan tampilan satuan PO', () => {
    const out = buildReleasePrefill(
      reference([refLine({
        productId: 'gula',
        acuanQty: 24,
        rlPosted: 2,
        rlPending: 4,
        sisa: 22,
        poRefs: [{ poId: 'po', noPO: 'CPO-1', status: 'RECEIVED', satuan: 'DUS', qtyOrdered: 2, qtyReceived: 2 }],
      })]),
      'gkering',
      { products: new Map([['gula', product('gula', 'GKERING', { DUS: 12, KG: 1 })]]), availableById: new Map([['gula', 50]]) },
    );
    expect(out.skipped).toEqual([]);
    expect(out.lines).toEqual([expect.objectContaining({
      stokId: 'gula', uomId: 'gula-KG', satuan: 'KG', qty: 18, qtyBase: 18,
      display: { qty: 1.5, satuan: 'DUS' }, rlPending: 4, sisa: 22, stokAvail: 50, cappedByStock: false,
    })]);
  });

  it('membagi kebutuhan ke salinan katalog berurutan dan menandai bila dibatasi stok', () => {
    const out = buildReleasePrefill(
      reference([refLine({ productId: 'a', productIds: ['a', 'b'], acuanQty: 20, sisa: 20 })]),
      'GKERING',
      { products: new Map([['a', product('a')], ['b', product('b')]]), availableById: new Map([['a', 3], ['b', 10]]) },
    );
    expect(out.lines.map((l) => [l.stokId, l.qty, l.cappedByStock])).toEqual([['a', 3, true], ['b', 10, true]]);
  });

  it('stok di salinan katalog lama tidak diisi, hanya diperingatkan', () => {
    const out = buildReleasePrefill(
      reference([refLine({ productId: 'gula', aliasProductIds: ['gula-lama'], acuanQty: 5, sisa: 5 })]),
      'GKERING',
      {
        products: new Map([['gula', product('gula')], ['gula-lama', product('gula-lama')]]),
        availableById: new Map([['gula', 2], ['gula-lama', 4]]),
      },
    );
    expect(out.lines.map((l) => [l.stokId, l.qty, l.cappedByStock])).toEqual([['gula', 2, true]]);
    expect(out.lines[0].warnings?.[0]).toMatch(/Stok 4 KG masih di salinan katalog lama GULA-LAMA/);
  });

  it('melewati baris selesai, menunggu RL, gudang lain, dan stok kosong dengan alasannya', () => {
    const out = buildReleasePrefill(
      reference([
        refLine({ productId: 'belum', poQtyOrdered: 4, poQtyReceived: 0, acuanQty: 0, sisa: 0 }),
        refLine({ productId: 'selesai', acuanQty: 3, rlPosted: 3, sisa: 0 }),
        refLine({ productId: 'menunggu', acuanQty: 5, sisa: 5, rlPending: 5 }),
        refLine({ productId: 'basah', acuanQty: 5, sisa: 5 }),
        refLine({ productId: 'kosong', acuanQty: 5, sisa: 5 }),
        refLine({ productId: 'nol', sumber: 'MRP', acuanQty: 0, sisa: 0 }),
      ]),
      'GKERING',
      {
        products: new Map([
          ['belum', product('belum')],
          ['selesai', product('selesai')],
          ['menunggu', product('menunggu')],
          ['basah', product('basah', 'GBASAH')],
          ['kosong', product('kosong')],
        ]),
        availableById: new Map([['menunggu', 9], ['basah', 9], ['kosong', 0]]),
      },
    );
    expect(out.lines).toEqual([]);
    expect(out.skipped.map((s) => [s.productId, s.reason, s.warehouseKode])).toEqual([
      ['belum', 'BELUM_DITERIMA', undefined],
      ['selesai', 'SELESAI', undefined],
      ['menunggu', 'MENUNGGU_RL', undefined],
      ['basah', 'GUDANG_LAIN', 'GBASAH'],
      ['kosong', 'STOK_KOSONG', undefined],
    ]);
  });
});

describe('mergePrefillIntoReleaseItems', () => {
  const item = (stokId: string, uomId: string, qty: number): ReleaseFormItem => ({
    stokId, kode: stokId, nama: stokId, uomId, satuan: uomId, qty, stokAvail: 0, stokByWarehouse: {},
  });

  it('mengganti baris produk yang sama (satuan apa pun) dan mempertahankan item lain', () => {
    const merged = mergePrefillIntoReleaseItems(
      [item('gula', 'DUS', 1), item('gula', 'KG', 2), item('sabun', 'PCS', 3)],
      [{ stokId: 'gula', kode: 'GL', nama: 'Gula', uomId: 'gula-KG', satuan: 'KG', qty: 18, stokAvail: 20 }],
      'gkering',
    );
    expect(merged.map((m) => [m.stokId, m.uomId, m.qty])).toEqual([['sabun', 'PCS', 3], ['gula', 'gula-KG', 18]]);
    expect(merged[1].stokByWarehouse).toEqual({ GKERING: 20 });
  });
});
