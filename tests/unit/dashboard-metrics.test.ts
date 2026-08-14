import { describe, expect, it } from 'vitest';
import { withTenantFilter } from '@/lib/api/tenant-master';
import {
  approvedVendorInvoiceMatch,
  buildSpendingMonths,
  foldInventoryByWarehouse,
  grnSummaryFromAgg,
  resolveDashboardUnitCost,
} from '@/lib/api/dashboard-metrics';
import type { AuthContext } from '@/types/auth';

function adminAuth(tenantId = 'sppg-penarukan-2'): AuthContext {
  return {
    tenantId,
    tenantName: 'SPPG',
    role: 'ADMIN',
    isMaster: false,
    userId: 'u1',
    email: 'admin@test.local',
    name: 'Admin',
  };
}

describe('dashboard inventory value', () => {
  it('filter stok $and tidak bisa di-strip lokasiKode — penyebab nilai Rp 0', () => {
    const stockScope = withTenantFilter(adminAuth(), {
      lokasiKode: { $in: ['GKERING', 'GBASAH'] },
    });
    const { lokasiKode: _drop, ...tenantOnly } = stockScope as { lokasiKode?: unknown };
    expect(_drop).toBeUndefined();
    expect(JSON.stringify(tenantOnly)).toContain('lokasiKode');
  });

  it('resolveDashboardUnitCost memakai hargaBeli, fallback vendorHargaBeli', () => {
    expect(resolveDashboardUnitCost({ hargaBeli: 12000, vendorHargaBeli: 9000 })).toBe(12000);
    expect(resolveDashboardUnitCost({ hargaBeli: 0, vendorHargaBeli: 9000 })).toBe(9000);
    expect(resolveDashboardUnitCost({ hargaBeli: '', vendorHargaBeli: '15000' })).toBe(15000);
    expect(resolveDashboardUnitCost({})).toBe(0);
  });

  it('foldInventoryByWarehouse menghitung qty × harga per gudang', () => {
    const rows = [
      { lokasiKode: 'GKERING', stokId: 'a', qty: 10 },
      { lokasiKode: 'GKERING', stokId: 'b', qty: 2 },
      { lokasiKode: 'GBASAH', stokId: 'c', qty: 4 },
      { lokasiKode: 'GBASAH', stokId: 'empty', qty: 0 },
    ];
    const prices = new Map([
      ['a', 1000],
      ['b', 500],
      ['c', 2500],
    ]);
    const folded = foldInventoryByWarehouse(rows, prices);
    const kering = folded.find((r) => r._id === 'GKERING');
    const basah = folded.find((r) => r._id === 'GBASAH');
    const janitor = folded.find((r) => r._id === 'GJANITOR');
    expect(kering).toMatchObject({ qty: 12, nilai: 11000, skuCount: 2 });
    expect(basah).toMatchObject({ qty: 4, nilai: 10000, skuCount: 1 });
    expect(janitor).toMatchObject({ qty: 0, nilai: 0, skuCount: 0 });
  });
});

describe('dashboard GRN & belanja', () => {
  it('grnSummary mengabaikan CANCELLED/VOID dari total', () => {
    expect(grnSummaryFromAgg([
      { _id: 'POSTED', count: 80 },
      { _id: 'DRAFT', count: 1 },
      { _id: 'UNKNOWN_PRODUCT', count: 2 },
      { _id: 'CANCELLED', count: 5 },
    ])).toEqual({
      grn: 83,
      draft: 1,
      unknownProduct: 2,
    });
  });

  it('KPI belanja dan grafik memakai status approval yang sama', () => {
    const match = approvedVendorInvoiceMatch();
    const or = match.$or as Array<Record<string, unknown>>;
    expect(or[0]).toMatchObject({
      approvalStatus: { $in: ['APPROVED', 'PAID_EXTERNAL', 'OUTSTANDING', 'PARTIAL', 'LUNAS'] },
    });
  });

  it('buildSpendingMonths mengisi 6 bulan termasuk yang kosong', () => {
    const now = new Date(2026, 7, 15);
    const months = buildSpendingMonths(now, [
      { _id: '2026-08', total: 172797343, count: 10 },
    ]);
    expect(months).toHaveLength(6);
    expect(months[0].month).toBe('2026-03');
    expect(months[5]).toMatchObject({ month: '2026-08', total: 172797343, count: 10 });
    expect(months[4].total).toBe(0);
  });
});
