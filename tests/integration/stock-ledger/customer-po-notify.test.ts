/**
 * Notifikasi alur persetujuan PO ke Vendor (ajukan → admin; setujui/tolak → pengaju & pembuat)
 * lewat handler sungguhan pada Mongo replica set. Sinkron vendor & Telegram API di-mock.
 * Suite di-skip bila mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import type { HandlerContext } from '@/types/api/handler';

process.env.TELEGRAM_BOT_TOKEN = 'test-token-123';
process.env.TELEGRAM_BOT_USERNAME = 'inv_test_bot';
process.env.TELEGRAM_WEBHOOK_SECRET = 'secret_abcdefghijklmnop';

let notifyShouldThrow = false;

vi.mock('@/lib/api/transaction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/transaction')>('@/lib/api/transaction');
  const testDb = () => (globalThis as { __cpoNotifyDb?: Db }).__cpoNotifyDb!;
  return {
    ...actual,
    runInTransactionOrFallback: (fn: Parameters<typeof actual.runInTransactionOrFallback>[0]) => (
      actual.runInTransactionOnDb(testDb(), fn)
    ),
  };
});

vi.mock('@/lib/api/customer-po-vendor', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/customer-po-vendor')>('@/lib/api/customer-po-vendor');
  return { ...actual, enrichPoItemsForVendor: async (_db: unknown, _tid: string, items: unknown[]) => ({ items }) };
});

vi.mock('@/lib/api/integration-outbox', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/integration-outbox')>('@/lib/api/integration-outbox');
  return {
    ...actual,
    insertEnsureCreateSoOutbox: async () => ({ id: 'ob-1' }),
    drainEnsureCreateSo: async () => ({ ok: true, vendorNoSO: 'SO-1', vendorSoId: 'so-1', outboxId: 'ob-1' }),
  };
});

vi.mock('@/lib/notifications/notify', async () => {
  const actual = await vi.importActual<typeof import('@/lib/notifications/notify')>('@/lib/notifications/notify');
  return {
    ...actual,
    notifyUsers: async (...args: Parameters<typeof actual.notifyUsers>) => {
      if (notifyShouldThrow) throw new Error('mongo down');
      return actual.notifyUsers(...args);
    },
  };
});

const { handleCustomerPo } = await import('@/lib/api/handlers/customer-po');

type ReplSet = { getUri(): string; stop(): Promise<boolean> };
let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-cpo-notify';
const OTHER = 'it-cpo-notify-other';
const user = (userId: string, role: string, tenantId = TID): AuthContext => ({
  userId, role, tenantId, tenantName: tenantId, name: userId, email: `${userId}@x`, isMaster: false,
} as AuthContext);
const GUDANG = user('u-gudang', 'GUDANG');
const SPV = user('u-spv', 'SUPERVISOR');
const ADMIN = user('u-admin', 'ADMIN');

describe.skipIf(!MongoMemoryReplSet)('Notifikasi persetujuan PO ke Vendor (Mongo replica set)', { timeout: 90_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  async function call(auth: AuthContext, poId: string, action: string, body: Record<string, unknown> = {}) {
    const path = ['customer-purchase-orders', poId, action];
    const url = new URL(`http://local/api/${path.join('/')}`);
    const res = await handleCustomerPo({
      db, route: `/${path.join('/')}`, method: 'POST', path, body, url, auth,
      request: new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    } as unknown as HandlerContext);
    return { status: res!.status, json: await res!.json() as Record<string, unknown> };
  }

  async function seedPo(id: string, extra: Record<string, unknown> = {}) {
    await db.collection('customer_purchase_orders').insertOne({
      id,
      tenantId: TID,
      noPO: `CPO-${id}`,
      status: 'DRAFT',
      tanggal: new Date(Date.UTC(2026, 9, 4, 2)),
      tanggalKedatangan: new Date(Date.UTC(2026, 9, 6)),
      estimasiTotal: 1250000,
      catatan: 'Untuk menu Senin',
      createdBy: { userId: 'u-gudang', userName: 'Andri' },
      items: [
        { lineId: `${id}-1`, kode: 'TLR', nama: 'Telur', satuan: 'KG', qty: 10, vendorTenantId: 'v-dawam' },
        { lineId: `${id}-2`, kode: 'APL', nama: 'Apel', satuan: 'KG', qty: 5, vendorTenantId: 'v-palapa' },
      ],
      ...extra,
    });
  }

  const notifs = (filter: Record<string, unknown>) => db.collection('notifications')
    .find({ tenantId: TID, ...filter }).sort({ userId: 1 }).toArray();

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('cpo_notify_it');
    (globalThis as { __cpoNotifyDb?: Db }).__cpoNotifyDb = db;
    await db.collection('notifications').createIndex({ tenantId: 1, userId: 1, dedupeKey: 1 }, { unique: true });
    await db.collection('notification_outbox').createIndex({ userId: 1, dedupeKey: 1 }, { unique: true });
    await db.collection('vendor_tenants').insertMany([
      { tenantId: TID, vendorTenantId: 'v-dawam', vendorTenantName: 'UD Dawam' },
      { tenantId: TID, vendorTenantId: 'v-palapa', vendorTenantName: 'Toko Palapa' },
    ]);
    await db.collection('users').insertMany([
      { id: 'u-gudang', tenantId: TID, role: 'GUDANG', name: 'Andri', aktif: true },
      { id: 'u-spv', tenantId: TID, role: 'SUPERVISOR', name: 'Spv', aktif: true },
      { id: 'u-admin', tenantId: TID, role: 'ADMIN', name: 'Admin', aktif: true, telegramChatId: '777' },
      { id: 'u-admin2', tenantId: TID, role: 'ADMIN', name: 'Admin Dua', aktif: true },
      { id: 'u-admin-off', tenantId: TID, role: 'ADMIN', name: 'Nonaktif', aktif: false },
      { id: 'u-other-admin', tenantId: OTHER, role: 'ADMIN', name: 'Admin lain', aktif: true, telegramChatId: '888' },
    ]);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await client?.close();
    await rs?.stop();
  });

  beforeEach(() => {
    notifyShouldThrow = false;
  });

  it('ajukan → semua ADMIN aktif tenant yang sama dapat notifikasi + Telegram bagi yang tertaut', async () => {
    await seedPo('p1');
    const res = await call(GUDANG, 'p1', 'request-approval');
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('PENDING_APPROVAL');

    const rows = await notifs({ refId: 'p1', type: 'PO_APPROVAL_REQUESTED' });
    expect(rows.map((r) => r.userId)).toEqual(['u-admin', 'u-admin2']);
    expect(rows[0]).toMatchObject({
      title: 'PO menunggu persetujuan: CPO-p1',
      link: '/pembelian-po?highlight=p1',
      severity: 'warning',
      refType: 'customer_purchase_order',
    });
    expect(rows[0].body).toContain('Diajukan oleh: u-gudang');
    expect(rows[0].body).toContain('Kedatangan: 06/10/2026');
    expect(rows[0].body).toContain('Vendor: UD Dawam, Toko Palapa');
    expect(rows[0].body).toContain('Jumlah item: 2');
    expect(rows[0].body).toMatch(/Estimasi total: Rp 1\.250\.000/);

    expect(await db.collection('notifications').countDocuments({ tenantId: OTHER })).toBe(0);
    const outbox = await db.collection('notification_outbox').find({ dedupeKey: rows[0].dedupeKey }).toArray();
    expect(outbox.map((o) => o.userId)).toEqual(['u-admin']);
    expect(outbox[0].chatId).toBe('777');
  });

  it('ajukan ganda bersamaan → satu yang berhasil, notifikasi tidak dobel', async () => {
    await seedPo('p2');
    const [a, b] = await Promise.all([call(GUDANG, 'p2', 'request-approval'), call(GUDANG, 'p2', 'request-approval')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await db.collection('notifications').countDocuments({ refId: 'p2', userId: 'u-admin' })).toBe(1);
  });

  it('tolak → pengaju & pembuat dikabari dengan alasan; ajukan ulang memicu notifikasi admin baru', async () => {
    await seedPo('p3');
    expect((await call(SPV, 'p3', 'request-approval')).status).toBe(200);
    const rej = await call(ADMIN, 'p3', 'reject', { reason: 'Harga apel terlalu tinggi' });
    expect(rej.status).toBe(200);

    const rejected = await notifs({ refId: 'p3', type: 'PO_REJECTED' });
    expect(rejected.map((r) => r.userId)).toEqual(['u-gudang', 'u-spv']);
    expect(rejected[0].title).toBe('PO ditolak: CPO-p3');
    expect(rejected[0].body).toContain('Alasan: Harga apel terlalu tinggi');
    expect(rejected[0].body).toContain('Ditolak oleh: u-admin');

    expect((await call(SPV, 'p3', 'request-approval')).status).toBe(200);
    expect(await db.collection('notifications').countDocuments({ refId: 'p3', type: 'PO_APPROVAL_REQUESTED', userId: 'u-admin' })).toBe(2);
  });

  it('setujui → pengaju & pembuat dikabari, approver tidak menerima notifikasi atas aksinya sendiri', async () => {
    await seedPo('p4', { createdBy: { userId: 'u-admin2', userName: 'Admin Dua' } });
    expect((await call(SPV, 'p4', 'request-approval')).status).toBe(200);
    const app = await call(user('u-admin2', 'ADMIN'), 'p4', 'approve');
    expect(app.status).toBe(200);

    const approved = await notifs({ refId: 'p4', type: 'PO_APPROVED' });
    expect(approved.map((r) => r.userId)).toEqual(['u-spv']);
    expect(approved[0]).toMatchObject({ title: 'PO disetujui: CPO-p4', severity: 'info' });
    expect(approved[0].body).toContain('PO sudah dikirim ke vendor.');
    expect(await db.collection('notifications').countDocuments({ refId: 'p4', userId: 'u-admin2', type: 'PO_APPROVAL_REQUESTED' })).toBe(1);
  });

  it('notifikasi gagal tidak menggagalkan pengajuan PO', async () => {
    await seedPo('p5');
    notifyShouldThrow = true;
    const res = await call(GUDANG, 'p5', 'request-approval');
    expect(res.status).toBe(200);
    expect((await db.collection('customer_purchase_orders').findOne({ id: 'p5' }))!.status).toBe('PENDING_APPROVAL');
    expect(await db.collection('notifications').countDocuments({ refId: 'p5' })).toBe(0);
  });
});
