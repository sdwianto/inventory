/**
 * Pencarian daftar PO ke Vendor (`GET /customer-purchase-orders?search=`) pada Mongo replica set.
 * Suite di-skip bila mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import type { HandlerContext } from '@/types/api/handler';

const { handleCustomerPo } = await import('@/lib/api/handlers/customer-po');

type ReplSet = { getUri(): string; stop(): Promise<boolean> };
let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-cpo-search';
const OTHER = 'it-cpo-search-other';
const ADMIN: AuthContext = {
  userId: 'u-admin', role: 'ADMIN', tenantId: TID, tenantName: TID, name: 'Admin', email: 'a@x', isMaster: false,
} as AuthContext;

describe.skipIf(!MongoMemoryReplSet)('Pencarian PO ke Vendor (Mongo replica set)', { timeout: 90_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  async function list(query: string) {
    const url = new URL(`http://local/api/customer-purchase-orders?pageMode=cursor&limit=50${query}`);
    const res = await handleCustomerPo({
      db, route: '/customer-purchase-orders', method: 'GET', path: ['customer-purchase-orders'], body: {}, url, auth: ADMIN,
      request: new Request(url),
    } as unknown as HandlerContext);
    expect(res!.status).toBe(200);
    const json = await res!.json() as { items: Array<Record<string, unknown>>; hasMore: boolean; nextCursor: string | null };
    return json;
  }
  const nos = (items: Array<Record<string, unknown>>) => items.map((p) => p.noPO).sort();

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('cpo_search_it');
    await db.collection('vendor_tenants').insertMany([
      { tenantId: TID, vendorTenantId: 'v-dawam', vendorTenantName: 'UD Dawam' },
      { tenantId: TID, vendorTenantId: 'v-palapa', vendorTenantName: 'Toko Palapa' },
      { tenantId: OTHER, vendorTenantId: 'v-lain', vendorTenantName: 'UD Dawam Cabang' },
    ]);
    const base = (i: number) => ({ tanggal: new Date(Date.UTC(2026, 9, 1, i)), tanggalKedatangan: new Date(Date.UTC(2026, 9, 2)), status: 'SUBMITTED' });
    await db.collection('customer_purchase_orders').insertMany([
      {
        id: 'p1', tenantId: TID, noPO: 'CP02610000057', ...base(1), vendorTenantId: 'multi',
        vendorSubmissions: [{ vendorTenantId: 'v-dawam', vendorNoSO: 'SO2610000002' }, { vendorTenantId: 'v-palapa', vendorNoSO: 'SO2610000009' }],
        createdBy: { userName: 'Andri - Asisten Lapangan' }, items: [{ nama: 'Telur Ayam', kode: 'TLR-01', qty: 1 }],
      },
      {
        id: 'p2', tenantId: TID, noPO: 'CP02610000056', ...base(2), vendorTenantId: 'v-palapa', vendorNoSO: 'SO2610000003',
        createdBy: { userName: 'Budi' }, catatan: 'Untuk menu (khusus) Senin', items: [{ nama: 'Salak', qty: 1 }],
      },
      {
        id: 'p3', tenantId: TID, noPO: 'CP02609000053', ...base(3), vendorTenantId: 'v-palapa',
        createdBy: { userName: 'Citra' }, items: [{ nama: 'Beras', qty: 1 }],
      },
      {
        id: 'o1', tenantId: OTHER, noPO: 'CP02610000057', ...base(4), vendorTenantId: 'v-lain',
        createdBy: { userName: 'Andri' }, items: [{ nama: 'Telur Ayam', qty: 1 }],
      },
    ]);
  });

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('tanpa search: semua PO tenant sendiri', async () => {
    expect(nos((await list('')).items)).toEqual(['CP02609000053', 'CP02610000056', 'CP02610000057']);
  });

  it('cari no PO, SO vendor (lama & per vendor), pembuat, item, catatan — case-insensitive', async () => {
    expect(nos((await list('&search=cp0261000005')).items)).toEqual(['CP02610000056', 'CP02610000057']);
    expect(nos((await list('&search=SO2610000009')).items)).toEqual(['CP02610000057']);
    expect(nos((await list('&search=SO2610000003')).items)).toEqual(['CP02610000056']);
    expect(nos((await list('&search=andri')).items)).toEqual(['CP02610000057']);
    expect(nos((await list('&search=telur')).items)).toEqual(['CP02610000057']);
    expect(nos((await list('&search=tlr-01')).items)).toEqual(['CP02610000057']);
    expect(nos((await list(`&search=${encodeURIComponent('(khusus)')}`)).items)).toEqual(['CP02610000056']);
  });

  it('cari nama vendor → PO lama (vendorTenantId) & multi-vendor (vendorSubmissions); tenant lain tidak bocor', async () => {
    expect(nos((await list('&search=palapa')).items)).toEqual(['CP02609000053', 'CP02610000056', 'CP02610000057']);
    expect(nos((await list('&search=dawam')).items)).toEqual(['CP02610000057']);
  });

  it('input regex berbahaya diperlakukan literal', async () => {
    expect((await list(`&search=${encodeURIComponent('.*')}`)).items).toEqual([]);
  });

  it('cursor pagination tetap memakai filter search', async () => {
    const urlBase = '&search=palapa';
    const url = new URL(`http://local/api/customer-purchase-orders?pageMode=cursor&limit=2${urlBase}`);
    const res = await handleCustomerPo({
      db, route: '/customer-purchase-orders', method: 'GET', path: ['customer-purchase-orders'], body: {}, url, auth: ADMIN,
      request: new Request(url),
    } as unknown as HandlerContext);
    const page1 = await res!.json() as { items: Array<Record<string, unknown>>; hasMore: boolean; nextCursor: string };
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const page2 = await list(`${urlBase}&cursor=${encodeURIComponent(page1.nextCursor)}`);
    expect(nos([...page1.items, ...page2.items])).toEqual(['CP02609000053', 'CP02610000056', 'CP02610000057']);
  });
});
