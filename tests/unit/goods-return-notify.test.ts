import { beforeEach, describe, expect, it, vi } from 'vitest';

const applyCreditNoteFromVendor = vi.fn();
const postGoodsReturnPosted = vi.fn();

vi.mock('@/lib/api/integration-links', () => ({
  getSalesApiKeyForVendor: async () => 'sk_test',
}));
vi.mock('@/lib/api/sales-app-url', () => ({
  resolveEffectiveSalesAppUrl: () => 'http://sales.test',
}));
vi.mock('@/lib/integration/client', () => ({
  createIntegrationClient: () => ({ postGoodsReturnPosted }),
}));
vi.mock('@/lib/api/hutang-from-vendor', () => ({
  applyCreditNoteFromVendor: (...args: unknown[]) => applyCreditNoteFromVendor(...args),
}));

import { notifySalesGoodsReturnPosted } from '@/lib/api/goods-return-notify-sales';
import type { VendorReturnDoc } from '@/types/vendor-return';

const doc: VendorReturnDoc = {
  id: 'rtv-1',
  tenantId: 'sppg',
  noReturn: 'RTV1',
  status: 'POSTED',
  vendorTenantId: 'vendor-a',
  vendorInvoiceId: 'inv-1',
  noInvoice: 'INV-1',
  reason: 'Rusak',
  items: [{
    lineId: 'inv:l1',
    invoiceLineId: 'l1',
    localStokId: 'p1',
    localKode: 'B1',
    localNama: 'Beras',
    satuan: 'SAK',
    vendorUomId: 'u-sak',
    qty: 1,
    qtyBase: 25,
    harga: 100,
    jumlah: 100,
    gudangKode: 'GKERING',
  }],
  subTotal: 100,
  total: 100,
  cnSyncStatus: 'SYNCING',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('notifySalesGoodsReturnPosted', () => {
  beforeEach(() => {
    applyCreditNoteFromVendor.mockReset();
    postGoodsReturnPosted.mockReset();
    postGoodsReturnPosted.mockResolvedValue({
      creditNoteId: 'cn-1',
      noCN: 'CN1',
      amount: 100,
      status: 'POSTED',
      posted: true,
      invoiceId: 'inv-1',
      noInvoice: 'INV-1',
    });
  });

  it('FAILED jika Sales CN belum POSTED — tidak apply hutang', async () => {
    postGoodsReturnPosted.mockResolvedValue({
      creditNoteId: 'cn-draft',
      noCN: 'CN-D',
      amount: 100,
      status: 'DRAFT',
      posted: false,
    });
    const r = await notifySalesGoodsReturnPosted({} as never, 'sppg', doc);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/belum POSTED/i);
    expect(applyCreditNoteFromVendor).not.toHaveBeenCalled();
  });

  it('FAILED jika hutang tidak ditemukan setelah CN POSTED', async () => {
    applyCreditNoteFromVendor.mockResolvedValue({ action: 'no_hutang', invoiceId: 'inv-1' });
    const r = await notifySalesGoodsReturnPosted({} as never, 'sppg', doc);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Hutang terkait tidak ditemukan/);
    expect(r.creditNoteId).toBe('cn-1');
  });

  it('sukses jika hutang already_applied (idempotent)', async () => {
    applyCreditNoteFromVendor.mockResolvedValue({ action: 'already_applied', hutangId: 'h1' });
    const r = await notifySalesGoodsReturnPosted({} as never, 'sppg', doc);
    expect(r.ok).toBe(true);
    expect(r.creditNoteId).toBe('cn-1');
    expect(postGoodsReturnPosted).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        items: [expect.objectContaining({ lineId: 'l1', uomId: 'u-sak' })],
      }),
    }));
  });

  it('FAILED jika baris tanpa vendorUomId — tidak panggil Sales', async () => {
    const bad = {
      ...doc,
      items: [{ ...doc.items[0], vendorUomId: '', invoiceLineId: '' }],
    };
    const r = await notifySalesGoodsReturnPosted({} as never, 'sppg', bad);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/vendorUomId|lineId/i);
    expect(postGoodsReturnPosted).not.toHaveBeenCalled();
  });
});
