import { describe, expect, it } from 'vitest';
import { hutangInvoicePayload, planHutangGrnRepair } from '@/lib/api/hutang-reconcile';
import type { GrnDoc, HutangDoc } from '@/types/documents';

const hutang = (over: Partial<HutangDoc> = {}): HutangDoc => ({
  id: 'h1',
  tenantId: 't1',
  subTotal: 200000,
  diskonNota: 0,
  ppn: 22000,
  total: 222000,
  ppnRate: 11,
  items: [
    { lineId: 'a', qty: 10, harga: 10000, jumlah: 100000, ppn: 11000 },
    { lineId: 'b', qty: 5, harga: 20000, jumlah: 100000, ppn: 11000 },
  ],
  ...over,
});

const grn = (qtyA: number, qtyB = 5): GrnDoc => ({
  id: 'g1',
  status: 'POSTED',
  items: [
    { lineId: 'a', qtyReceived: qtyA, harga: 10000 },
    { lineId: 'b', qtyReceived: qtyB, harga: 20000 },
  ],
} as unknown as GrnDoc);

describe('planHutangGrnRepair', () => {
  it('hutang ber-PPN yang qty-nya sudah sesuai GRN TIDAK dikoreksi (regresi: total ber-PPN vs Σ baris)', () => {
    expect(planHutangGrnRepair(hutang(), grn(10))).toBeNull();
  });

  it('qty GRN lebih kecil: baris, diskon, PPN, dan total dihitung ulang', () => {
    const plan = planHutangGrnRepair(hutang({ diskonNota: 20000, ppn: 19800, total: 199800 }), grn(5))!;
    expect(plan).not.toBeNull();
    expect(plan.tax.subTotal).toBe(150000);
    expect(plan.tax.diskonNota).toBe(15000);
    expect(plan.tax.ppn).toBe(4950 + 9900);
    expect(plan.tax.total).toBe(150000 - 15000 + 14850);
    expect(plan.tax.glPostingBase).toEqual({ subTotal: 135000, ppn: 14850, total: 149850 });
    expect(plan.items?.[0]).toMatchObject({ lineId: 'a', qty: 5, jumlah: 50000, ppn: 4950 });
  });

  it('hutang lama tanpa diskonNota: diskon disimpulkan dari header', () => {
    const p = hutangInvoicePayload(hutang({ diskonNota: undefined, ppn: 19800, total: 199800 }));
    expect(p.diskonNota).toBe(20000);
  });

  it('debit note tidak ikut basis hitung ulang', () => {
    const h = hutang({
      total: 233100,
      ppn: 23100,
      glPostingBase: { subTotal: 200000, ppn: 22000, total: 222000 },
      debitNotes: [{ amount: 11100 }],
    });
    const p = hutangInvoicePayload(h);
    expect(p.total).toBe(222000);
    expect(p.ppn).toBe(22000);
  });

  it('tanpa lineId cocok: bandingkan nilai terima GRN dengan subtotal baris (bukan total ber-PPN)', () => {
    const noLines = hutang({ items: [{ qty: 10, harga: 20000, jumlah: 200000 }] });
    const recvSame = { id: 'g', status: 'POSTED', receivedTotal: 200000, items: [] } as unknown as GrnDoc;
    expect(planHutangGrnRepair(noLines, recvSame)).toBeNull();
    const recvLess = { id: 'g', status: 'POSTED', receivedTotal: 100000, items: [] } as unknown as GrnDoc;
    const plan = planHutangGrnRepair(noLines, recvLess)!;
    expect(plan.items).toBeNull();
    expect(plan.tax.ppn).toBe(11000);
    expect(plan.tax.total).toBe(111000);
  });
});
