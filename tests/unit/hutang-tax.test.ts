import { describe, expect, it } from 'vitest';
import {
  allocateCumulative,
  computeHutangFromInvoice,
  hutangLineSubTotal,
  hutangMatchVerdict,
  hutangNetBeforePpn,
  noteTaxPayloadFields,
  roundRupiah,
  TAX_TOTAL_MISMATCH,
} from '@/lib/api/hutang-tax';

describe('roundRupiah / allocateCumulative', () => {
  it('membulatkan setengah ke atas dengan koreksi float', () => {
    expect(roundRupiah(0.5)).toBe(1);
    expect(roundRupiah(1.005 * 1000)).toBe(1005);
    expect(roundRupiah(-0.4)).toBe(0);
  });

  it('alokasi kumulatif berjumlah tepat sama dengan nilai yang dibagi', () => {
    const parts = allocateCumulative(100, [1, 1, 1]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(100);
    expect(parts).toEqual([33, 34, 33]);
  });
});

describe('computeHutangFromInvoice', () => {
  const lines = [
    { lineId: 'a', qty: 10, harga: 10000, jumlah: 100000, ppn: 11000 },
    { lineId: 'b', qty: 5, harga: 20000, jumlah: 100000, ppn: 11000 },
  ];

  it('tanpa koreksi memakai header invoice vendor apa adanya', () => {
    const r = computeHutangFromInvoice(
      { subTotal: 200000, diskonNota: 0, ppn: 22000, total: 222000, ppnRate: 11, items: lines },
      lines,
      false,
    );
    expect(r).toMatchObject({ subTotal: 200000, ppn: 22000, total: 222000, dpp: 200000, ppnRate: 11 });
    expect(r.glPostingBase).toEqual({ subTotal: 200000, ppn: 22000, total: 222000 });
    expect(r.taxCheck.ok).toBe(true);
  });

  it('koreksi qty GRN menghitung ulang PPN per baris dan memprorata diskon nota', () => {
    const payload = { subTotal: 200000, diskonNota: 20000, ppn: 19800, total: 199800, ppnRate: 11, items: lines };
    const corrected = [{ ...lines[0], qty: 5, jumlah: 50000 }, lines[1]];
    const r = computeHutangFromInvoice(payload, corrected, true);
    // diskon prorata: 20000 × 150000 / 200000 = 15000 → baris a 5000, b 10000
    expect(r.subTotal).toBe(150000);
    expect(r.diskonNota).toBe(15000);
    expect(r.ppn).toBe(roundRupiah(45000 * 0.11) + roundRupiah(90000 * 0.11));
    expect(r.total).toBe(150000 - 15000 + r.ppn);
    expect(r.items.map((it) => it.ppn)).toEqual([4950, 9900]);
    expect(r.glPostingBase.total).toBe(r.total);
  });

  it('harga termasuk PPN: total = subTotal − diskon, DPP diekstrak per baris', () => {
    const inc = [{ lineId: 'a', jumlah: 111000, ppn: 11000 }];
    const r = computeHutangFromInvoice(
      { subTotal: 222000, ppn: 22000, total: 222000, ppnRate: 11, hargaTermasukPajak: true, items: [...inc, { lineId: 'b', jumlah: 111000, ppn: 11000 }] },
      inc,
      true,
    );
    expect(r.total).toBe(111000);
    expect(r.dpp).toBe(100000);
    expect(r.ppn).toBe(11000);
  });

  it('baris bebas PPN (ppn 0) tetap tanpa PPN setelah koreksi', () => {
    const mixed = [
      { lineId: 'a', jumlah: 100000, ppn: 11000 },
      { lineId: 'b', jumlah: 50000, ppn: 0 },
    ];
    const r = computeHutangFromInvoice(
      { subTotal: 150000, ppn: 11000, total: 161000, ppnRate: 11, items: mixed },
      [mixed[0], { ...mixed[1], jumlah: 25000 }],
      true,
    );
    expect(r.ppn).toBe(11000);
    expect(r.total).toBe(125000 + 11000);
  });

  it('payload lama tanpa ppnRate: diskon & PPN diprorata dari subTotal', () => {
    const r = computeHutangFromInvoice(
      { subTotal: 200000, diskonNota: 10000, ppn: 20900, total: 210900, items: lines },
      [{ ...lines[0], jumlah: 50000 }, lines[1]],
      true,
    );
    expect(r.ppnRate).toBeNull();
    expect(r.diskonNota).toBe(7500);
    expect(r.ppn).toBe(15675);
    expect(r.total).toBe(150000 - 7500 + 15675);
  });

  it('header tidak konsisten → verdict EXCEPTION TAX_TOTAL_MISMATCH', () => {
    const r = computeHutangFromInvoice(
      { subTotal: 200000, ppn: 22000, total: 230000, ppnRate: 11, items: lines },
      lines,
      false,
    );
    expect(r.taxCheck).toEqual({ ok: false, expectedTotal: 222000, payloadTotal: 230000 });
    const v = hutangMatchVerdict({ ok: true }, r);
    expect(v.ok).toBe(false);
    expect(v.code).toBe(TAX_TOTAL_MISMATCH);
  });

  it('selisih pembulatan Rp1 masih diterima', () => {
    const r = computeHutangFromInvoice({ subTotal: 200000, ppn: 22000, total: 222001, items: lines }, lines, false);
    expect(r.taxCheck.ok).toBe(true);
    expect(hutangMatchVerdict({ ok: true }, r)).toEqual({ ok: true, error: null, code: null });
  });

  it('match 3-way gagal tetap diteruskan apa adanya', () => {
    const r = computeHutangFromInvoice({ subTotal: 200000, ppn: 0, total: 200000, items: lines }, lines, false);
    expect(hutangMatchVerdict({ ok: false, error: 'qty', code: 'QTY' }, r)).toEqual({ ok: false, error: 'qty', code: 'QTY' });
  });
});

describe('basis banding variance', () => {
  it('nilai sebelum PPN = total − PPN', () => {
    expect(hutangNetBeforePpn({ total: 222000, ppn: 22000 })).toBe(200000);
  });

  it('subtotal baris memakai subTotal, lalu Σ jumlah, lalu total − PPN', () => {
    expect(hutangLineSubTotal({ subTotal: 150000, total: 166500, ppn: 16500 })).toBe(150000);
    expect(hutangLineSubTotal({ items: [{ jumlah: 1000 }, { jumlah: 2000 }], total: 3330, ppn: 330 })).toBe(3000);
    expect(hutangLineSubTotal({ total: 3330, ppn: 330 })).toBe(3000);
  });
});

describe('audit Fase 2', () => {
  it('hutang legacy tanpa diskonNota: Σ baris diutamakan atas subTotal basi', () => {
    expect(hutangLineSubTotal({ subTotal: 5000, items: [{ jumlah: 3000 }], total: 3000, ppn: 0 })).toBe(3000);
    expect(hutangLineSubTotal({ subTotal: 5000, diskonNota: 0, items: [{ jumlah: 3000 }], total: 3000, ppn: 0 })).toBe(5000);
  });

  it('koreksi qty: baris terdiskon penuh (DPP 0) tetap kena PPN, baris bebas PPN tetap bebas', () => {
    const payload = { subTotal: 2000, diskonNota: 0, ppn: 110, total: 2110, ppnRate: 11, items: [] };
    const r = computeHutangFromInvoice(payload, [
      { jumlah: 1000, dpp: 0, ppn: 0 },
      { jumlah: 1000, dpp: 1000, ppn: 0 },
    ], true);
    expect(r.items[0].ppn).toBe(110);
    expect(r.items[1].ppn).toBe(0);
    expect(r.ppn).toBe(110);
    expect(r.total).toBe(2110);
  });

  it('noteTaxPayloadFields: hanya diteruskan bila ada kontrak pajak (ppnRate)', () => {
    expect(noteTaxPayloadFields(null)).toEqual({});
    expect(noteTaxPayloadFields({ ppn: 110, subTotal: 1000 })).toEqual({});
    expect(noteTaxPayloadFields({ ppnRate: 11, ppn: 110, subTotal: 1000, dpp: 1000, hargaTermasukPajak: false }))
      .toEqual({ ppnRate: 11, ppn: 110, subTotal: 1000, dpp: 1000, hargaTermasukPajak: false });
  });
});
