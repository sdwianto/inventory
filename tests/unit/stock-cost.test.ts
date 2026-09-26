import { describe, expect, it } from 'vitest';
import { applyLineCost, legacyLineCost, type AvgCostState } from '@/lib/stock-ledger/cost';

const run = (state: AvgCostState, lines: Array<Parameters<typeof applyLineCost>[1]>) => {
  let s = state;
  const out = [];
  for (const l of lines) {
    const r = applyLineCost(s, l);
    out.push(r);
    s = r.next;
  }
  return { out, state: s };
};

describe('Fase 4 — biaya rata-rata bergerak', () => {
  it('GRN mengubah rata-rata tertimbang; keluar dinilai pada rata-rata', () => {
    const { out, state } = run({ qty: 10, avg: 1000 }, [
      { sourceType: 'GRN', delta: 30, lineUnitCost: 1400 },
      { sourceType: 'RELEASE', delta: -8, lineUnitCost: 999 },
      { sourceType: 'FP_ISSUE', delta: -2 },
    ]);
    expect(out[0]).toMatchObject({ unitCost: 1400, costSource: 'LINE', next: { qty: 40, avg: 1300 } });
    expect(out[1]).toMatchObject({ unitCost: 1300, costSource: 'AVG' });
    expect(out[2]).toMatchObject({ unitCost: 1300, costSource: 'AVG' });
    expect(state).toEqual({ qty: 30, avg: 1300 });
  });

  it('stok lama ≤ 0: rata-rata = harga masuk', () => {
    const r = applyLineCost({ qty: -3, avg: 500 }, { sourceType: 'GRN', delta: 10, lineUnitCost: 800 });
    expect(r.next).toEqual({ qty: 7, avg: 800 });
  });

  it('pindah gudang & hitung fisik netral: masuk pada rata-rata walau pemanggil kirim hargaBeli', () => {
    const { out, state } = run({ qty: 20, avg: 1250.5 }, [
      { sourceType: 'TRANSFER', delta: -5, lineUnitCost: 9999 },
      { sourceType: 'TRANSFER', delta: 5, lineUnitCost: 9999 },
      { sourceType: 'PENYESUAIAN', delta: 2, lineUnitCost: 9999 },
      { sourceType: 'RELOKASI_GUDANG', delta: 3 },
    ]);
    expect(out.map((o) => o.unitCost)).toEqual([1250.5, 1250.5, 1250.5, 1250.5]);
    expect(state).toEqual({ qty: 25, avg: 1250.5 });
  });

  it('pembalik GRN / retur vendor keluar pada harga beli sendiri dan menghitung ulang rata-rata sisa', () => {
    const r = applyLineCost({ qty: 40, avg: 1300 }, { sourceType: 'GRN_REVERSAL', delta: -30, lineUnitCost: 1400 });
    expect(r).toMatchObject({ unitCost: 1400, costSource: 'LINE', next: { qty: 10, avg: 1000 } });
    const all = applyLineCost({ qty: 30, avg: 1400 }, { sourceType: 'VENDOR_RETURN', delta: -30, lineUnitCost: 1400 });
    expect(all.next).toEqual({ qty: 0, avg: 1400 });
  });

  it('rata-rata belum terbentuk: keluar memakai hargaBeli, tanpa harga sama sekali = NONE', () => {
    expect(applyLineCost({ qty: 5, avg: 0 }, { sourceType: 'RELEASE', delta: -1, hargaBeli: 700 }))
      .toMatchObject({ unitCost: 700, costSource: 'PRODUCT_AVG' });
    expect(applyLineCost({ qty: 5, avg: 0 }, { sourceType: 'RELEASE', delta: -1 }))
      .toMatchObject({ unitCost: 0, costSource: 'NONE' });
    expect(applyLineCost({ qty: 0, avg: 0 }, { sourceType: 'PENYESUAIAN', delta: 4, lineUnitCost: 900 }).next)
      .toEqual({ qty: 4, avg: 900 });
  });

  it('barang jadi / setengah jadi = memo tanpa nilai', () => {
    expect(applyLineCost({ qty: 0, avg: 0 }, { sourceType: 'FP_RESULT', delta: 100, itemRole: 'FINISHED_GOOD', lineUnitCost: 5000 }))
      .toMatchObject({ unitCost: 0, costSource: 'NON_INVENTORY' });
    expect(applyLineCost({ qty: 100, avg: 0 }, { sourceType: 'FP_DIST', delta: -100, itemRole: 'SEMI_FINISHED' }))
      .toMatchObject({ unitCost: 0, costSource: 'NON_INVENTORY', next: { qty: 0, avg: 0 } });
  });

  it('GRN bonus Rp0 masuk pada Rp0 dan menurunkan rata-rata; harga kosong tetap dinilai rata-rata', () => {
    const bonus = applyLineCost({ qty: 10, avg: 1200 }, { sourceType: 'GRN', delta: 2, lineUnitCost: 0 });
    expect(bonus).toMatchObject({ unitCost: 0, costSource: 'LINE', next: { qty: 12, avg: 1000 } });
    expect(applyLineCost({ qty: 0, avg: 0 }, { sourceType: 'GRN', delta: 5, lineUnitCost: 0 }))
      .toMatchObject({ unitCost: 0, costSource: 'LINE', next: { qty: 5, avg: 0 } });
    expect(applyLineCost({ qty: 10, avg: 1200 }, { sourceType: 'GRN', delta: 2 }))
      .toMatchObject({ unitCost: 1200, costSource: 'AVG', next: { qty: 12, avg: 1200 } });
    // Penyesuaian Rp0 bukan pembelian: tetap netral pada rata-rata.
    expect(applyLineCost({ qty: 10, avg: 1200 }, { sourceType: 'PENYESUAIAN', delta: 2, lineUnitCost: 0 }))
      .toMatchObject({ unitCost: 1200, costSource: 'AVG' });
  });

  it('mutasi hasil produksi / distribusi selalu memo walau itemRole bahan; rata-rata bahan tidak diubah', () => {
    for (const sourceType of ['FP_RESULT', 'FP_RESULT_WASTE', 'FP_DIST', 'FP_DIST_RETURN']) {
      const delta = sourceType === 'FP_RESULT' || sourceType === 'FP_DIST_RETURN' ? 4 : -4;
      expect(applyLineCost({ qty: 10, avg: 800 }, { sourceType, delta, itemRole: 'INGREDIENT', lineUnitCost: 5000 }))
        .toMatchObject({ unitCost: 0, costSource: 'NON_INVENTORY', next: { avg: 800 } });
    }
  });

  it('presisi 4 desimal', () => {
    const r = applyLineCost({ qty: 3, avg: 1000 }, { sourceType: 'GRN', delta: 7, lineUnitCost: 1333.3333 });
    expect(r.next.avg).toBe(1233.3333);
  });

  it('perilaku lama tetap saat costingV2 mati', () => {
    expect(legacyLineCost({ sourceType: 'RELEASE', delta: -1, lineUnitCost: 999, hargaBeli: 700 })).toEqual({ unitCost: 999, costSource: 'LINE' });
    expect(legacyLineCost({ sourceType: 'FP_ISSUE', delta: -1, hargaBeli: 700 })).toEqual({ unitCost: 700, costSource: 'PRODUCT_AVG' });
    expect(legacyLineCost({ sourceType: 'FP_RESULT', delta: 1 })).toEqual({ unitCost: 0, costSource: 'NONE' });
  });
});
