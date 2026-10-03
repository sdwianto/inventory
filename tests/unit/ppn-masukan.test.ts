import { describe, expect, it } from 'vitest';
import {
  buildPpnMasukanRow,
  classifyPpnMasukan,
  masaRangeWib,
  summarizePpnMasukan,
} from '@/lib/api/ppn-masukan';
import type { HutangDoc } from '@/types/documents';

const faktur = (over: Record<string, unknown> = {}) => ({
  fakturId: 'f1', status: 'DISETUJUI', aktif: true, nomorFaktur: '0400002612345678', masa: '2026-10', dpp: 100000, ppn: 11000, ...over,
});

const h = (over: Partial<HutangDoc> = {}): HutangDoc => ({
  id: 'h1', noHutang: 'HT-1', noInvoice: 'INV-1', tanggal: '2026-10-05T03:00:00.000Z',
  supplierName: 'Vendor A', total: 111000, ppn: 11000, dpp: 100000, ppnRate: 11,
  vendorBillingSnapshot: { companyNPWP: '0012345678901000' },
  ...over,
});

describe('masaRangeWib', () => {
  it('rentang bulan WIB, Desember ke Januari', () => {
    expect(masaRangeWib('2026-10')).toEqual({
      from: new Date('2026-09-30T17:00:00.000Z'),
      to: new Date('2026-10-31T17:00:00.000Z'),
    });
    expect(masaRangeWib('2026-12')?.to.toISOString()).toBe('2026-12-31T17:00:00.000Z');
    expect(masaRangeWib('2026-13')).toBeNull();
    expect(masaRangeWib('')).toBeNull();
  });
});

describe('classifyPpnMasukan', () => {
  it('status sesuai faktur dan PKP', () => {
    expect(classifyPpnMasukan(h({ fakturPajak: faktur() }))).toBe('SIAP_DIKREDITKAN');
    expect(classifyPpnMasukan(h())).toBe('MENUNGGU_FAKTUR');
    expect(classifyPpnMasukan(h({ fakturPajak: faktur({ status: 'DRAFT', nomorFaktur: null }) }))).toBe('MENUNGGU_FAKTUR');
    expect(classifyPpnMasukan(h({ fakturPajak: faktur({ status: 'BATAL', aktif: false }) }))).toBe('FAKTUR_BATAL');
    expect(classifyPpnMasukan(h({ ppnDikreditkan: false, fakturPajak: faktur() }))).toBe('TIDAK_DIKREDITKAN');
  });

  it('NPWP pembeli di faktur harus sama dengan NPWP tenant', () => {
    const npwp = '0987654321098765';
    expect(classifyPpnMasukan(h({ fakturPajak: faktur({ buyerNpwp: npwp }) }), npwp)).toBe('SIAP_DIKREDITKAN');
    // NPWP lama 15 digit = 16 digit berawalan 0.
    expect(classifyPpnMasukan(h({ fakturPajak: faktur({ buyerNpwp: '012345678901234' }) }), '0012345678901234')).toBe('SIAP_DIKREDITKAN');
    expect(classifyPpnMasukan(h({ fakturPajak: faktur({ buyerNpwp: '' }) }), npwp)).toBe('NPWP_TIDAK_SESUAI');
    expect(classifyPpnMasukan(h({ fakturPajak: faktur({ buyerNpwp: '1111111111111111' }) }), npwp)).toBe('NPWP_TIDAK_SESUAI');
    expect(classifyPpnMasukan(h({ fakturPajak: faktur({ buyerNpwp: npwp }) }), '')).toBe('NPWP_TIDAK_SESUAI');
    // Event vendor lama tanpa buyerNpwp tidak bisa dicek.
    expect(classifyPpnMasukan(h({ fakturPajak: faktur() }), npwp)).toBe('SIAP_DIKREDITKAN');
    // Belum bernomor: tetap menunggu faktur.
    expect(classifyPpnMasukan(h({ fakturPajak: faktur({ status: 'DRAFT', nomorFaktur: null, buyerNpwp: '' }) }), npwp)).toBe('MENUNGGU_FAKTUR');
  });
});

describe('buildPpnMasukanRow / summarize', () => {
  it('tagihan tanpa PPN tidak masuk laporan', () => {
    expect(buildPpnMasukanRow(h({ ppn: 0, total: 100000 }))).toBeNull();
  });

  it('selisih PPN faktur vs tagihan ditandai', () => {
    const row = buildPpnMasukanRow(h({ fakturPajak: faktur({ ppn: 10000 }) }))!;
    expect(row.selisihPpn).toBe(-1000);
    expect(row.vendorNPWP).toBe('0012345678901000');
    const s = summarizePpnMasukan([row, buildPpnMasukanRow(h({ id: 'h2' }))!]);
    expect(s.total).toEqual({ count: 2, dpp: 200000, ppn: 22000 });
    expect(s.SIAP_DIKREDITKAN.count).toBe(1);
    expect(s.MENUNGGU_FAKTUR.ppn).toBe(11000);
    expect(s.selisihCount).toBe(1);
  });

  it('NPWP tidak sesuai masuk bucket sendiri dan NPWP faktur tampil', () => {
    const row = buildPpnMasukanRow(h({ fakturPajak: faktur({ buyerNpwp: '' }) }), '0987654321098765')!;
    expect(row.status).toBe('NPWP_TIDAK_SESUAI');
    expect(row.buyerNpwpFaktur).toBe('');
    expect(summarizePpnMasukan([row]).NPWP_TIDAK_SESUAI).toEqual({ count: 1, dpp: 100000, ppn: 11000 });
  });

  it('NPWP tidak sesuai masuk bucket sendiri dan NPWP faktur tampil', () => {
    const row = buildPpnMasukanRow(h({ fakturPajak: faktur({ buyerNpwp: '' }) }), '0987654321098765')!;
    expect(row.status).toBe('NPWP_TIDAK_SESUAI');
    expect(row.buyerNpwpFaktur).toBe('');
    expect(summarizePpnMasukan([row]).NPWP_TIDAK_SESUAI).toEqual({ count: 1, dpp: 100000, ppn: 11000 });
  });

  it('PPN debit note tidak ikut PPN invoice (faktur per invoice)', () => {
    const row = buildPpnMasukanRow(h({
      total: 122100, ppn: 12100, glPostingBase: { subTotal: 100000, ppn: 11000, total: 111000 },
    }))!;
    expect(row.ppn).toBe(11000);
  });
});
