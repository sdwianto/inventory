import { describe, expect, it, vi } from 'vitest';
import {
  applyCustomerPoSearch, customerPoSearchOr, CUSTOMER_PO_SEARCH_MAX, parseCustomerPoSearch,
} from '@/lib/api/customer-po-search';

function mockDb(vendors: Array<{ vendorTenantId: string }>) {
  const find = vi.fn(() => ({ limit: () => ({ toArray: async () => vendors }) }));
  return { db: { collection: () => ({ find }) } as never, find };
}

const auth = { tenantId: 'sppg', role: 'ADMIN' } as never;

describe('customer PO search', () => {
  it('parse ?search= / ?q=, trim, batasi panjang', () => {
    expect(parseCustomerPoSearch(new URL('http://x/api?search=%20CP026%20'))).toBe('CP026');
    expect(parseCustomerPoSearch(new URL('http://x/api?q=dawam'))).toBe('dawam');
    expect(parseCustomerPoSearch(new URL(`http://x/api?search=${'a'.repeat(300)}`))).toHaveLength(CUSTOMER_PO_SEARCH_MAX);
  });

  it('regex di-escape (input pengguna bukan pola)', () => {
    const or = customerPoSearchOr('SO.26(1)*');
    expect(or[0]).toEqual({ noPO: { $regex: 'SO\\.26\\(1\\)\\*', $options: 'i' } });
    expect(or.some((c) => 'vendorTenantId' in c)).toBe(false);
  });

  it('nama vendor cocok → cari juga by vendorTenantId (PO lama & multi-vendor)', async () => {
    const { db, find } = mockDb([{ vendorTenantId: 'ud-dawam' }, { vendorTenantId: 'ud-dawam' }]);
    const f = await applyCustomerPoSearch(db, auth, { tenantId: 'sppg' }, 'dawam');
    const vendorFilter = JSON.stringify((find.mock.calls[0] as unknown[])[0]);
    expect(vendorFilter).toContain('"vendorTenantName":{"$regex":"dawam","$options":"i"}');
    expect(vendorFilter).toContain('"tenantId":{"$regex":"^sppg$"');
    const or = ((f.$and as Record<string, unknown>[])[1].$or) as Record<string, unknown>[];
    expect((f.$and as unknown[])[0]).toEqual({ tenantId: 'sppg' });
    expect(or).toContainEqual({ vendorTenantId: { $in: ['ud-dawam'] } });
    expect(or).toContainEqual({ 'vendorSubmissions.vendorTenantId': { $in: ['ud-dawam'] } });
    expect(or).toContainEqual({ 'items.nama': { $regex: 'dawam', $options: 'i' } });
  });

  it('tanpa kata kunci filter tidak berubah dan DB tidak dikueri', async () => {
    const { db, find } = mockDb([]);
    expect(await applyCustomerPoSearch(db, auth, { tenantId: 'sppg' }, '')).toEqual({ tenantId: 'sppg' });
    expect(find).not.toHaveBeenCalled();
  });
});
