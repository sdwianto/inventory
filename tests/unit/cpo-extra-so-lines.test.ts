import { describe, expect, it } from 'vitest';
import {
  buildExtraPoLine,
  buildVendorLineChangeMessage,
  findExtraSoItems,
  pairRelocations,
  type PoLine,
} from '@/lib/api/cpo-extra-so-lines';
import { detectExtraSoLinesForPo } from '@/lib/recon/po-vendor-line-recon';

// Bentuk data meniru PO CPO2610000081 (multi-vendor) + SO2610000011 zulmy yang ditambah Garam.
const baksoPo: PoLine = {
  lineId: 'po-bakso', vendorTenantId: 'zulmy', vendorKode: 'B165667', kode: 'B165667', vendorStokId: 'v-bakso',
  nama: 'Bakso Sapi Salam', satuan: 'PCS', qty: 1,
};
const isolasiPo: PoLine = {
  lineId: 'po-isolasi', vendorTenantId: 'abiliyan', vendorKode: 'B378322', kode: 'B378322', nama: 'Isolasi', satuan: 'ROL', qty: 8,
};
const soZulmy = [
  { lineId: 'so-bakso', stokId: 'v-bakso', kode: 'B165667', nama: 'Bakso Sapi Salam', qty: 1, satuan: 'PCS', harga: 25000 },
  { lineId: 'so-garam', stokId: 'v-garam', kode: 'B402689', nama: 'Garam 250g Kapal', qty: 5, satuan: 'PCS', uomId: 'v-uom-pcs', harga: 2250 },
];

describe('findExtraSoItems', () => {
  it('item SO vendor yang tidak cocok dengan baris PO vendor itu = baris tambahan', () => {
    const extra = findExtraSoItems([baksoPo, isolasiPo], soZulmy, { vendorTenantId: 'zulmy', multiVendor: true });
    expect(extra.map((e) => e.kode)).toEqual(['B402689']);
  });

  it('baris yang sudah ditambahkan (lineId = lineId SO) tidak ditambahkan lagi', () => {
    const appended: PoLine = { lineId: 'so-garam', vendorTenantId: 'zulmy', vendorKode: 'B402689', kode: 'B402689', qty: 5 };
    expect(findExtraSoItems([baksoPo, appended], soZulmy, { vendorTenantId: 'zulmy', multiVendor: true })).toEqual([]);
  });

  it('baris PO vendor lain tidak dipakai untuk mencocokkan (PO multi-vendor)', () => {
    const garamOtherVendor: PoLine = { lineId: 'po-garam', vendorTenantId: 'toko-palapa', kode: 'B402689', vendorKode: 'B402689', qty: 5 };
    const extra = findExtraSoItems([baksoPo, garamOtherVendor], soZulmy, { vendorTenantId: 'zulmy', multiVendor: true });
    expect(extra.map((e) => e.kode)).toEqual(['B402689']);
  });

  it('baris dibatalkan untuk vendor yang sama tetap dianggap ada (diff SO memulihkannya)', () => {
    const cancelled: PoLine = { lineId: 'po-garam', vendorTenantId: 'zulmy', kode: 'B402689', vendorKode: 'B402689', qty: 5, cancelled: true };
    expect(findExtraSoItems([baksoPo, cancelled], soZulmy, { vendorTenantId: 'zulmy', multiVendor: true })).toEqual([]);
  });

  it('PO single-vendor: baris tanpa vendorTenantId ikut dicocokkan', () => {
    const plain: PoLine = { lineId: 'p1', kode: 'B165667', qty: 1 };
    const extra = findExtraSoItems([plain], soZulmy, { vendorTenantId: 'zulmy', multiVendor: false });
    expect(extra.map((e) => e.kode)).toEqual(['B402689']);
  });

  it('tanpa vendor atau item qty 0 / dibatalkan → tidak ada tambahan', () => {
    expect(findExtraSoItems([baksoPo], soZulmy, { vendorTenantId: '', multiVendor: true })).toEqual([]);
    const zero = [{ ...soZulmy[1], qty: 0 }, { ...soZulmy[1], lineId: 'x', cancelled: true }];
    expect(findExtraSoItems([], zero, { vendorTenantId: 'zulmy', multiVendor: true })).toEqual([]);
  });
});

describe('buildExtraPoLine', () => {
  const now = new Date('2026-10-12T07:00:00Z');

  it('memakai lineId SO, produk & satuan lokal, harga SO, qty progres 0', () => {
    const line = buildExtraPoLine(soZulmy[1], {
      localStokId: 'local-garam', localKode: 'B402689', localNama: 'Garam 250g Kapal', uomId: 'local-uom-pcs', satuan: 'PCS', factorToBase: 1,
    }, { vendorTenantId: 'zulmy', salesOrderId: 'so-1', noSO: 'SO2610000011' }, now);
    expect(line).toMatchObject({
      lineId: 'so-garam', localStokId: 'local-garam', vendorStokId: 'v-garam', vendorTenantId: 'zulmy', vendorKode: 'B402689',
      kode: 'B402689', satuan: 'PCS', uomId: 'local-uom-pcs', vendorUomId: 'v-uom-pcs', qty: 5, estimasiHarga: 2250,
      estimasiJumlah: 11250, qtyShipped: 0, qtyReceived: 0, addedFromVendorSo: true, addedNoSO: 'SO2610000011', addedAt: now,
    });
    expect(line.needsMapping).toBeUndefined();
  });

  it('produk lokal tidak ditemukan → needsMapping, kode vendor dipakai', () => {
    const line = buildExtraPoLine(soZulmy[1], {}, { vendorTenantId: 'zulmy' }, now);
    expect(line).toMatchObject({ localStokId: null, kode: 'B402689', needsMapping: true });
  });
});

describe('pairRelocations', () => {
  const cancelledAt = new Date('2026-10-12T06:58:15Z');
  const addedAt = new Date('2026-10-12T07:00:31Z');
  const po077 = {
    id: 'po-77', noPO: 'CPO2610000077',
    items: [{
      lineId: 'po77-garam', localStokId: 'local-garam', kode: 'B402689', vendorTenantId: 'toko-palapa', qty: 5,
      cancelled: true, cancelReason: 'Tidak ada di SO sales.app', cancelledAt,
    }],
  };
  const po081 = {
    id: 'po-81', noPO: 'CPO2610000081',
    items: [
      { ...baksoPo, localStokId: 'local-bakso' },
      { lineId: 'so-garam', localStokId: 'local-garam', kode: 'B402689', vendorTenantId: 'zulmy', qty: 5, addedFromVendorSo: true, addedAt },
    ],
  };

  it('baris tambahan dipasangkan dengan baris yang dibatalkan "Tidak ada di SO" (dari sisi PO tujuan)', () => {
    const pairs = pairRelocations(po081, [po077]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].from.po.noPO).toBe('CPO2610000077');
    expect(pairs[0].from.line.lineId).toBe('po77-garam');
    expect(pairs[0].to.po.noPO).toBe('CPO2610000081');
    expect(pairs[0].to.line.lineId).toBe('so-garam');
  });

  it('dua arah: dari sisi PO asal juga ditemukan', () => {
    const pairs = pairRelocations(po077, [po081]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].to.line.lineId).toBe('so-garam');
  });

  it('produk berbeda, sudah tertaut, atau di luar jendela waktu → tidak dipasangkan', () => {
    const other = { ...po081, items: [{ ...po081.items[1], localStokId: 'local-lain', kode: 'BXXX' }] };
    expect(pairRelocations(po077, [other])).toEqual([]);
    const linked = { ...po081, items: [{ ...po081.items[1], relocatedFrom: { poId: 'x', noPO: 'X', lineId: 'y', at: addedAt } }] };
    expect(pairRelocations(po077, [linked])).toEqual([]);
    const old = { ...po081, items: [{ ...po081.items[1], addedAt: new Date('2026-08-01T00:00:00Z') }] };
    expect(pairRelocations(po077, [old])).toEqual([]);
  });

  it('pembatalan manual (bukan "Tidak ada di SO") tidak dianggap perpindahan', () => {
    const manual = { ...po077, items: [{ ...po077.items[0], cancelReason: 'Dibatalkan pembeli' }] };
    expect(pairRelocations(po081, [manual])).toEqual([]);
  });
});

describe('buildVendorLineChangeMessage', () => {
  it('menyebut perpindahan dan barang tambahan', () => {
    const added = [{ lineId: 'so-garam', kode: 'B402689', nama: 'Garam 250g Kapal', qty: 5, satuan: 'PCS', vendorTenantId: 'zulmy', addedFromVendorSo: true }] as PoLine[];
    const msg = buildVendorLineChangeMessage({ id: 'po-81', noPO: 'CPO2610000081' }, added, [{
      from: { po: { id: 'po-77', noPO: 'CPO2610000077' }, line: { lineId: 'a', vendorTenantId: 'toko-palapa' } },
      to: { po: { id: 'po-81', noPO: 'CPO2610000081' }, line: added[0] },
    }]);
    expect(msg?.title).toBe('PO CPO2610000081: barang tambahan dari vendor');
    expect(msg?.body).toContain('Garam 250g Kapal 5 PCS: dipindah dari PO CPO2610000077 (toko-palapa) ke PO CPO2610000081 (zulmy)');
    expect(msg?.body).not.toContain('ditambahkan vendor zulmy di luar PO');
  });

  it('tanpa perubahan → null', () => {
    expect(buildVendorLineChangeMessage({ noPO: 'X' }, [], [])).toBeNull();
  });
});

describe('detectExtraSoLinesForPo (rekonsiliasi)', () => {
  it('memakai item SO per vendor dari vendorSubmissions', () => {
    const po = {
      noPO: 'CPO2610000081',
      vendorTenantId: 'multi',
      items: [baksoPo, isolasiPo],
      vendorSubmissions: [
        { vendorTenantId: 'abiliyan', status: 'SYNCED', vendorSo: { noSO: 'SO8', items: [{ lineId: 'a1', kode: 'B378322', qty: 8 }] } },
        { vendorTenantId: 'zulmy', status: 'SYNCED', vendorSo: { noSO: 'SO2610000011', items: soZulmy } },
      ],
    };
    const found = detectExtraSoLinesForPo(po);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ vendorTenantId: 'zulmy', noSO: 'SO2610000011', item: { kode: 'B402689' } });
  });

  it('submission CANCELLED diabaikan', () => {
    const po = {
      vendorTenantId: 'multi',
      items: [baksoPo],
      vendorSubmissions: [{ vendorTenantId: 'zulmy', status: 'CANCELLED', vendorSo: { items: soZulmy } }],
    };
    expect(detectExtraSoLinesForPo(po)).toEqual([]);
  });
});
