import { describe, expect, it } from 'vitest';
import { parseVendorFakturPajak, pickInvoiceFaktur } from '@/lib/api/vendor-faktur-pajak';

const base = {
  fakturId: 'f-1',
  invoiceId: 'inv-1',
  noInvoice: 'INV-1',
  status: 'DISETUJUI',
  aktif: true,
  nomorFaktur: '0400.0026-12345678',
  tanggal: '2026-10-02T03:00:00.000Z',
  masa: '2026-10',
  trxCode: '04',
  ppnRate: 11,
  dpp: 100000,
  dppLain: 91666.67,
  ppn: 11000,
  updatedAt: '2026-10-02T04:00:00.000Z',
};

describe('parseVendorFakturPajak', () => {
  it('menormalkan nomor faktur dan tanggal', () => {
    const f = parseVendorFakturPajak(base)!;
    expect(f.nomorFaktur).toBe('04000026123456' + '78');
    expect(f.updatedAt).toBeInstanceOf(Date);
    expect(f.aktif).toBe(true);
    expect(f.masa).toBe('2026-10');
  });

  it('menolak payload tanpa id, status tak dikenal, atau updatedAt tidak valid', () => {
    expect(parseVendorFakturPajak({ ...base, fakturId: '' })).toBeNull();
    expect(parseVendorFakturPajak({ ...base, invoiceId: '' })).toBeNull();
    expect(parseVendorFakturPajak({ ...base, status: 'LUNAS' })).toBeNull();
    expect(parseVendorFakturPajak({ ...base, updatedAt: 'bukan-tanggal' })).toBeNull();
    expect(parseVendorFakturPajak(null)).toBeNull();
  });

  it('DISETUJUI wajib bernomor 16–17 digit', () => {
    expect(parseVendorFakturPajak({ ...base, nomorFaktur: null })).toBeNull();
    expect(parseVendorFakturPajak({ ...base, nomorFaktur: '123' })).toBeNull();
    expect(parseVendorFakturPajak({ ...base, status: 'DRAFT', nomorFaktur: null })?.nomorFaktur).toBeNull();
  });

  it('status BATAL/DIGANTI tidak pernah aktif walau payload bilang aktif', () => {
    expect(parseVendorFakturPajak({ ...base, status: 'BATAL', aktif: true })?.aktif).toBe(false);
    expect(parseVendorFakturPajak({ ...base, status: 'DIGANTI', aktif: true })?.aktif).toBe(false);
  });
});

describe('pickInvoiceFaktur', () => {
  const at = (iso: string) => new Date(iso);
  it('faktur aktif mengalahkan yang tidak aktif walau lebih lama', () => {
    const r = pickInvoiceFaktur([
      { id: 'lama', aktif: false, updatedAt: at('2026-10-03T00:00:00Z') },
      { id: 'pengganti', aktif: true, updatedAt: at('2026-10-02T00:00:00Z') },
    ]);
    expect(r?.id).toBe('pengganti');
  });

  it('tanpa faktur aktif → yang terbaru', () => {
    const r = pickInvoiceFaktur([
      { id: 'a', aktif: false, updatedAt: at('2026-10-01T00:00:00Z') },
      { id: 'b', aktif: false, updatedAt: at('2026-10-02T00:00:00Z') },
    ]);
    expect(r?.id).toBe('b');
  });

  it('kosong → null', () => {
    expect(pickInvoiceFaktur([])).toBeNull();
  });
});
