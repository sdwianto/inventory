/**
 * Ketersediaan item PO di vendor + notifikasi H-1 + Telegram, pada Mongo replica set.
 * Client sales & Telegram API di-mock. Suite di-skip bila mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import type { HandlerContext } from '@/types/api/handler';
import { IntegrationError } from '@/lib/integration/errors';

process.env.TELEGRAM_BOT_TOKEN = 'test-token-123';
process.env.TELEGRAM_BOT_USERNAME = 'inv_test_bot';
process.env.TELEGRAM_WEBHOOK_SECRET = 'secret_abcdefghijklmnop';

const salesCalls: Array<Record<string, unknown>> = [];
let salesImpl: (input: Record<string, unknown>) => Promise<Record<string, unknown>> = async () => ({});

vi.mock('@/lib/api/integration-links', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/integration-links')>('@/lib/api/integration-links');
  return {
    ...actual,
    resolveSalesApiAccess: async (_db: unknown, _tid: string, vid?: string) => (
      vid === 'v-unlinked' ? null : { salesAppUrl: 'http://sales.test', salesApiKey: 'k' }
    ),
  };
});

vi.mock('@/lib/integration/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/integration/client')>('@/lib/integration/client');
  return {
    ...actual,
    createIntegrationClient: () => ({
      getCustomerPoAvailability: async (input: Record<string, unknown>) => {
        salesCalls.push(input);
        return salesImpl(input);
      },
    }),
  };
});

const { refreshPoVendorAvailability, applyVendorAvailabilityPush, runPoVendorAvailabilityRefresh } = await import('@/lib/api/cpo-vendor-availability');
const { processWebhookInboxEvent } = await import('@/lib/api/webhook-inbox-process');
const { handleCustomerPo } = await import('@/lib/api/handlers/customer-po');
const { handleNotifications, handleTelegramWebhook } = await import('@/lib/api/handlers/notifications');
const { runPoArrivalRiskAlert, wibDateKey } = await import('@/lib/api/po-arrival-risk');
const telegram = await import('@/lib/notifications/telegram');

type ReplSet = { getUri(): string; stop(): Promise<boolean> };
let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-avail';
const TID_OFF = 'it-avail-off';
const OTHER = 'it-avail-other';
const user = (userId: string, role: string, tenantId = TID): AuthContext => ({
  userId, role, tenantId, tenantName: tenantId, name: userId, email: `${userId}@x`, isMaster: false,
});
const ADMIN = user('u-admin', 'ADMIN');
const GUDANG = user('u-gudang', 'GUDANG');

const tgRequests: Array<{ method: string; body: Record<string, unknown> }> = [];
let tgStatus = 200;

function arrivalDate(daysFromNow: number): Date {
  const key = wibDateKey(new Date(Date.now() + daysFromNow * 86_400_000));
  return new Date(`${key}T12:00:00.000Z`);
}

function salesBody(lines: Array<Record<string, unknown>>, computedAt = new Date().toISOString()) {
  return { vendorTenantId: 'v1', noSO: 'SO-1', soStatus: 'CONFIRMED', computedAt, lines };
}

describe.skipIf(!MongoMemoryReplSet)('Monitor ketersediaan item PO (Mongo replica set)', { timeout: 90_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  async function seedPo(id: string, extra: Record<string, unknown> = {}) {
    await db.collection('customer_purchase_orders').insertOne({
      id,
      tenantId: TID,
      noPO: `CPO-${id}`,
      status: 'CONFIRMED',
      vendorTenantId: 'v1',
      vendorSubmissions: [{ vendorTenantId: 'v1', status: 'SYNCED', vendorNoSO: 'SO-1' }],
      tanggal: new Date(),
      tanggalKedatangan: arrivalDate(1),
      createdBy: { userId: 'u-gudang', userName: 'Gudang' },
      items: [
        { lineId: `${id}-l1`, kode: 'TLR', nama: 'Telur', satuan: 'KG', qty: 10, vendorStokId: 's1' },
        { lineId: `${id}-l2`, kode: 'SLK', nama: 'Salak', satuan: 'KG', qty: 5, vendorStokId: 's2' },
      ],
      ...extra,
    });
    return db.collection('customer_purchase_orders').findOne({ id }) as Promise<Record<string, unknown>>;
  }

  async function callPo(auth: AuthContext, method: string, path: string[], query = '') {
    const url = new URL(`http://local/api/${path.join('/')}${query}`);
    const res = await handleCustomerPo({
      db, route: `/${path.join('/')}`, method, path, body: {}, url, auth, request: new Request(url, { method }),
    } as unknown as HandlerContext);
    return { status: res!.status, json: await res!.json() as Record<string, unknown> };
  }

  async function callNotif(auth: AuthContext, method: string, path: string[], query = '') {
    const url = new URL(`http://local/api/${path.join('/')}${query}`);
    const res = await handleNotifications({
      db, route: `/${path.join('/')}`, method, path, body: {}, url, auth, request: new Request(url, { method }),
    } as unknown as HandlerContext);
    return { status: res!.status, json: await res!.json() as Record<string, unknown> };
  }

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('po_vendor_availability_it');
    await db.collection('notifications').createIndex({ tenantId: 1, userId: 1, dedupeKey: 1 }, { unique: true });
    await db.collection('notification_outbox').createIndex({ userId: 1, dedupeKey: 1 }, { unique: true });
    await db.collection('telegram_link_tokens').createIndex({ tokenHash: 1 }, { unique: true });
    await db.collection('telegram_updates').createIndex({ updateId: 1 }, { unique: true });
    await db.collection('tenant_settings').insertMany([
      { tenantId: TID, features: {} },
      { tenantId: TID_OFF, features: { poArrivalRiskAlert: false } },
    ]);
    await db.collection('users').insertMany([
      { id: 'u-gudang', tenantId: TID, role: 'GUDANG', name: 'Gudang', aktif: true },
      { id: 'u-spv', tenantId: TID, role: 'SUPERVISOR', name: 'Spv', aktif: true, telegramChatId: '111' },
      { id: 'u-admin', tenantId: TID, role: 'ADMIN', name: 'Admin', aktif: true },
      { id: 'u-admin-off', tenantId: TID, role: 'ADMIN', name: 'Nonaktif', aktif: false },
      { id: 'u-gudang2', tenantId: TID, role: 'GUDANG', name: 'Gudang lain', aktif: true },
      { id: 'u-other-admin', tenantId: OTHER, role: 'ADMIN', name: 'Admin lain', aktif: true },
    ]);

    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const method = String(url).split('/').pop() || '';
      tgRequests.push({ method, body: JSON.parse(String(init.body || '{}')) });
      if (tgStatus !== 200) {
        return new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }), { status: tgStatus });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await client?.close();
    await rs?.stop();
  });

  beforeEach(() => {
    salesCalls.length = 0;
    tgRequests.length = 0;
    tgStatus = 200;
  });

  it('pull: petakan baris, cache, TTL & rate limit', async () => {
    const po = await seedPo('p1');
    salesImpl = async () => salesBody([
      { customerPoLineId: 'p1-l1', stokId: 's1', qtyOrdered: 10, qtySiap: 10, reserved: true },
      { stokId: 's2', qtyOrdered: 5, qtyBelum: 5 },
    ]);
    const r1 = await refreshPoVendorAvailability(db, po);
    expect(r1.refreshed).toBe(true);
    const cache = (r1.po.vendorAvailability as Record<string, any>).vendors.v1;
    expect(cache.state).toBe('OK');
    expect(cache.lines['p1-l1'].qtySiap).toBe(10);
    expect(cache.lines['p1-l2'].qtyBelum).toBe(5);
    expect(salesCalls[0]).toMatchObject({ customerTenantId: TID, customerPoId: 'p1', vendorTenantId: 'v1' });

    expect((await refreshPoVendorAvailability(db, r1.po)).skipped).toBe('fresh');
    expect((await refreshPoVendorAvailability(db, r1.po, { force: true })).skipped).toBe('rate_limited');
    expect(salesCalls).toHaveLength(1);
  });

  it('404 → UNSUPPORTED / NO_SO; error lain mempertahankan data terakhir', async () => {
    const po = await seedPo('p2');
    salesImpl = async () => { throw new IntegrationError('HTTP 404', { httpStatus: 404, code: 'HTTP_ERROR' }); };
    let r = await refreshPoVendorAvailability(db, po);
    expect((r.po.vendorAvailability as Record<string, any>).vendors.v1.state).toBe('UNSUPPORTED');

    salesImpl = async () => { throw new IntegrationError('SO tidak ada', { httpStatus: 404, code: 'SO_NOT_FOUND' }); };
    r = await refreshPoVendorAvailability(db, r.po, { force: true, now: new Date(Date.now() + 60_000) });
    expect((r.po.vendorAvailability as Record<string, any>).vendors.v1.state).toBe('NO_SO');

    salesImpl = async () => salesBody([{ customerPoLineId: 'p2-l1', qtySiap: 10 }]);
    r = await refreshPoVendorAvailability(db, r.po, { force: true, now: new Date(Date.now() + 120_000) });
    salesImpl = async () => { throw new IntegrationError('timeout', { httpStatus: 503 }); };
    r = await refreshPoVendorAvailability(db, r.po, { force: true, now: new Date(Date.now() + 180_000) });
    const seg = (r.po.vendorAvailability as Record<string, any>).vendors.v1;
    expect(seg.state).toBe('ERROR');
    expect(seg.lines['p2-l1'].qtySiap).toBe(10);
  });

  it('vendor belum terhubung → NOT_LINKED', async () => {
    const po = await seedPo('p3', {
      vendorTenantId: 'v-unlinked',
      vendorSubmissions: [{ vendorTenantId: 'v-unlinked', status: 'SYNCED' }],
    });
    const r = await refreshPoVendorAvailability(db, po);
    expect((r.po.vendorAvailability as Record<string, any>).vendors['v-unlinked'].state).toBe('NOT_LINKED');
  });

  it('push webhook: computedAt lebih lama diabaikan, vendor asing ditolak', async () => {
    await seedPo('p4');
    const newer = new Date(Date.now() + 10_000).toISOString();
    const older = new Date(Date.now() - 10_000).toISOString();
    const r1 = await processWebhookInboxEvent(db, {
      event: 'sales_order.availability_changed',
      customerTenantId: TID,
      vendorTenantId: 'v1',
      payload: { customerPoId: 'p4', ...salesBody([{ customerPoLineId: 'p4-l1', qtyDiadakan: 10 }], newer) },
    });
    expect(r1.action).toBe('applied');
    const r2 = await applyVendorAvailabilityPush(db, TID, {
      customerPoId: 'p4', ...salesBody([{ customerPoLineId: 'p4-l1', qtyBelum: 10 }], older),
    }, 'v1');
    expect(r2.action).toBe('stale_ignored');
    const r3 = await applyVendorAvailabilityPush(db, TID, { customerPoId: 'p4', lines: [] }, 'v-lain');
    expect(r3.reason).toBe('vendor_not_on_po');

    const po = await db.collection('customer_purchase_orders').findOne({ id: 'p4' });
    expect((po!.vendorAvailability as Record<string, any>).vendors.v1.lines['p4-l1'].qtyDiadakan).toBe(10);
  });

  it('SO vendor lama yang digantikan edit PO: push diabaikan, pull dianggap belum ada SO', async () => {
    const po = await seedPo('p6', {
      vendorSubmissions: [{ vendorTenantId: 'v1', status: 'SYNCED', vendorSoId: 'so-new', vendorNoSO: 'SO-2' }],
      supersededVendorSos: [{ vendorTenantId: 'v1', salesOrderId: 'so-old', noSO: 'SO-1' }],
    });
    const pushed = await applyVendorAvailabilityPush(db, TID, {
      customerPoId: 'p6', salesOrderId: 'so-old', ...salesBody([{ customerPoLineId: 'p6-l1', qtySiap: 10 }]),
    }, 'v1');
    expect(pushed).toMatchObject({ action: 'skipped', reason: 'superseded_so' });

    salesImpl = async () => ({ salesOrderId: 'so-old', ...salesBody([{ customerPoLineId: 'p6-l1', qtySiap: 10 }]) });
    const r = await refreshPoVendorAvailability(db, po);
    expect((r.po.vendorAvailability as Record<string, any>).vendors.v1).toMatchObject({ state: 'NO_SO', lines: {} });
  });

  it('hasil tarik non-OK tidak menimpa push OK yang lebih baru', async () => {
    const po = await seedPo('p7');
    const future = new Date(Date.now() + 60_000).toISOString();
    await applyVendorAvailabilityPush(db, TID, {
      customerPoId: 'p7', ...salesBody([{ customerPoLineId: 'p7-l1', qtySiap: 10 }], future),
    }, 'v1');
    salesImpl = async () => { throw new IntegrationError('SO tidak ada', { httpStatus: 404, code: 'SO_NOT_FOUND' }); };
    const fresh = await db.collection('customer_purchase_orders').findOne({ id: 'p7' });
    const r = await refreshPoVendorAvailability(db, { ...fresh!, vendorAvailability: {} } as Record<string, unknown>);
    expect(r.refreshed).toBe(true);
    const seg = (r.po.vendorAvailability as Record<string, any>).vendors.v1;
    expect(seg.state).toBe('OK');
    expect(seg.lines['p7-l1'].qtySiap).toBe(10);
  });

  it('payload push tanpa referensi PO dilewati (tidak gagal-ulang)', async () => {
    expect(await applyVendorAvailabilityPush(db, TID, { lines: [] }, 'v1')).toMatchObject({ action: 'skipped', reason: 'missing_po_ref' });
  });

  it('API: GET vendor-availability + list memuat vendorAvailabilityView tanpa cache mentah', async () => {
    await seedPo('p5');
    salesImpl = async () => salesBody([{ customerPoLineId: 'p5-l1', qtyBelum: 10 }]);
    const res = await callPo(ADMIN, 'GET', ['customer-purchase-orders', 'p5', 'vendor-availability']);
    expect(res.status).toBe(200);
    const view = res.json.view as Record<string, any>;
    expect(view.summary.belum).toBe(1);
    expect(JSON.stringify(res.json)).not.toContain('noSupplier');

    const list = await callPo(ADMIN, 'GET', ['customer-purchase-orders']);
    const row = (list.json as unknown as Array<Record<string, unknown>>).find((p) => p.id === 'p5')!;
    expect(row.vendorAvailability).toBeUndefined();
    expect((row.vendorAvailabilityView as Record<string, any>).summary.belum).toBe(1);

    const other = await callPo(user('x', 'ADMIN', OTHER), 'GET', ['customer-purchase-orders', 'p5', 'vendor-availability']);
    expect(other.status).toBe(404);
  });

  it('job terjadwal hanya menyentuh PO terbuka yang cache-nya basi', async () => {
    await db.collection('customer_purchase_orders').deleteMany({});
    await seedPo('j1');
    await seedPo('j2', { status: 'RECEIVED' });
    await seedPo('j3', { tanggalKedatangan: arrivalDate(30) });
    salesImpl = async () => salesBody([]);
    const out = await runPoVendorAvailabilityRefresh(db, { allTenants: true });
    expect(out).toMatchObject({ scanned: 1, refreshed: 1 });
  });

  it('H-1: notifikasi ke pembuat + SUPERVISOR/ADMIN, Telegram terkirim, run sore dedupe', async () => {
    await db.collection('customer_purchase_orders').deleteMany({});
    await seedPo('h1');
    await seedPo('h-off', { tenantId: TID_OFF });
    salesImpl = async () => salesBody([
      { customerPoLineId: 'h1-l1', qtyBelum: 10 },
      { customerPoLineId: 'h1-l2', qtySiap: 5 },
    ]);

    const first = await runPoArrivalRiskAlert(db, { allTenants: true });
    expect(first).toMatchObject({ scanned: 2, atRisk: 1, notified: 1, disabled: 1, telegramQueued: 1 });
    const notifs = await db.collection('notifications').find({ refId: 'h1' }).toArray();
    expect(notifs.map((n) => n.userId).sort()).toEqual(['u-admin', 'u-gudang', 'u-spv']);
    expect(notifs[0].body).toContain('Telur (10 KG)');
    expect(notifs[0].severity).toBe('critical');
    // Job batch hanya mengantre; pengiriman oleh cron drain.
    expect(tgRequests.filter((r) => r.method === 'sendMessage')).toHaveLength(0);
    await telegram.drainNotificationOutbox(db);
    expect(tgRequests.filter((r) => r.method === 'sendMessage')).toHaveLength(1);
    expect(tgRequests[0].body.chat_id).toBe('111');

    const second = await runPoArrivalRiskAlert(db, { allTenants: true });
    expect(second).toMatchObject({ notified: 0, deduped: 1, telegramQueued: 0 });
    expect(await db.collection('notifications').countDocuments({ refId: 'h1' })).toBe(3);

    await db.collection('customer_purchase_orders').updateOne(
      { id: 'h1' },
      { $set: { 'vendorAvailability.fetchedAt': new Date(0) } },
    );
    salesImpl = async () => salesBody([{ customerPoLineId: 'h1-l1', qtyBelum: 4, qtySiap: 6 }]);
    const third = await runPoArrivalRiskAlert(db, { allTenants: true });
    expect(third).toMatchObject({ notified: 1 });
    expect(await db.collection('notifications').countDocuments({ refId: 'h1' })).toBe(6);
  });

  it('API notifikasi: list, unread, read, read-all hanya milik sendiri', async () => {
    const spv = user('u-spv', 'SUPERVISOR');
    const before = await callNotif(spv, 'GET', ['notifications', 'unread-count']);
    expect(Number(before.json.unread)).toBeGreaterThan(0);
    const list = await callNotif(spv, 'GET', ['notifications']);
    const first = (list.json.items as Array<Record<string, unknown>>)[0];
    expect(first.dedupeKey).toBeUndefined();

    const foreign = await callNotif(GUDANG, 'POST', ['notifications', String(first.id), 'read']);
    expect(foreign.json.updated).toBe(0);
    const mine = await callNotif(spv, 'POST', ['notifications', String(first.id), 'read']);
    expect(mine.json.updated).toBe(1);

    await callNotif(spv, 'POST', ['notifications', 'read-all']);
    expect((await callNotif(spv, 'GET', ['notifications', 'unread-count'])).json.unread).toBe(0);
    expect(Number((await callNotif(GUDANG, 'GET', ['notifications', 'unread-count'])).json.unread)).toBeGreaterThan(0);
  });

  it('Telegram: tautkan via token sekali pakai, update ganda diabaikan, /stop memutus', async () => {
    const link = await callNotif(user('u-admin', 'ADMIN'), 'POST', ['notifications', 'telegram', 'link']);
    const token = String(link.json.deepLink).split('start=')[1];
    expect(String(link.json.deepLink)).toContain('t.me/inv_test_bot');
    const stored = await db.collection('telegram_link_tokens').findOne({ userId: 'u-admin' });
    expect(stored!.tokenHash).not.toBe(token);

    async function hook(update: Record<string, unknown>, secret = 'secret_abcdefghijklmnop') {
      const url = new URL('http://local/api/telegram/webhook');
      const res = await handleTelegramWebhook({
        db, route: '/telegram/webhook', method: 'POST', path: ['telegram', 'webhook'], body: update, url, auth: null,
        request: new Request(url, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret } }),
      } as unknown as HandlerContext);
      return { status: res!.status, json: await res!.json() as Record<string, unknown> };
    }

    const msg = (id: number, text: string) => ({
      update_id: id, message: { text, chat: { id: 999, type: 'private' }, from: { username: 'adm' } },
    });
    expect((await hook(msg(1, `/start ${token}`), 'salah_salah_salah_salah')).status).toBe(401);
    expect((await hook(msg(1, `/start ${token}`))).json.action).toBe('linked');
    expect((await hook(msg(1, `/start ${token}`))).json.action).toBe('duplicate');
    expect((await hook(msg(2, `/start ${token}`))).json.action).toBe('invalid_token');
    expect((await db.collection('users').findOne({ id: 'u-admin' }))!.telegramChatId).toBe('999');

    expect((await hook(msg(3, '/stop'))).json.action).toBe('unlinked');
    expect((await db.collection('users').findOne({ id: 'u-admin' }))!.telegramChatId).toBeUndefined();
    const audits = await db.collection('audit_log').find({ entityId: 'u-admin' }).map((a) => a.action).toArray();
    expect(audits).toEqual(expect.arrayContaining(['TELEGRAM_LINK_REQUEST', 'TELEGRAM_LINK', 'TELEGRAM_UNLINK']));
    expect(JSON.stringify(await db.collection('audit_log').find({}).toArray())).not.toContain('test-token-123');
  });

  it('Telegram: 403 → outbox DEAD + tautan diputus otomatis', async () => {
    await db.collection('users').updateOne({ id: 'u-gudang2' }, { $set: { telegramChatId: '222' } });
    tgStatus = 403;
    const queued = await telegram.enqueueTelegramSend(db, {
      tenantId: TID, userId: 'u-gudang2', chatId: '222', dedupeKey: 'x-1', title: 'T', body: 'B',
    });
    expect(queued).toBe(true);
    const row = await db.collection('notification_outbox').findOne({ dedupeKey: 'x-1' });
    expect(row!.status).toBe('DEAD');
    expect(row!.lastError).not.toContain('test-token-123');
    expect((await db.collection('users').findOne({ id: 'u-gudang2' }))!.telegramChatId).toBeUndefined();
  });

  it('tanggalKedatangan string YYYY-MM-DD ikut dipindai job refresh & H-1', async () => {
    await db.collection('customer_purchase_orders').deleteMany({});
    const tomorrowKey = wibDateKey(new Date(Date.now() + 86_400_000));
    await seedPo('s1', { tanggalKedatangan: tomorrowKey });
    await seedPo('s2', { tanggalKedatangan: wibDateKey(new Date(Date.now() + 30 * 86_400_000)) });
    salesImpl = async () => salesBody([{ customerPoLineId: 's1-l1', qtyBelum: 10 }]);

    const refresh = await runPoVendorAvailabilityRefresh(db, { allTenants: true });
    expect(refresh).toMatchObject({ scanned: 1, refreshed: 1 });

    const alert = await runPoArrivalRiskAlert(db, { allTenants: true });
    expect(alert).toMatchObject({ scanned: 1, atRisk: 1, notified: 1 });
    expect(await db.collection('notifications').countDocuments({ refId: 's1' })).toBe(3);
  });

  it('refresh=1 hanya untuk role pembuat PO; baca cache tetap boleh', async () => {
    await seedPo('r1', { vendorAvailability: { fetchedAt: new Date(), vendors: {} } });
    const driver = user('u-driver', 'DRIVER');
    const forced = await callPo(driver, 'GET', ['customer-purchase-orders', 'r1', 'vendor-availability'], '?refresh=1');
    expect(forced.status).toBe(403);
    const read = await callPo(driver, 'GET', ['customer-purchase-orders', 'r1', 'vendor-availability']);
    expect(read.status).toBe(200);
  });

  it('outbox: PROCESSING basi di batas percobaan → DEAD; baris baru punya expireAt', async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    await db.collection('notification_outbox').insertOne({
      id: 'stuck-1', channel: 'TELEGRAM', userId: 'u-x', chatId: '1', dedupeKey: 'stuck', text: 't',
      status: 'PROCESSING', attempts: 6, nextAttemptAt: old, createdAt: old, updatedAt: old,
    });
    const stats = await telegram.drainNotificationOutbox(db);
    expect(stats.dead).toBeGreaterThanOrEqual(1);
    expect((await db.collection('notification_outbox').findOne({ id: 'stuck-1' }))!.status).toBe('DEAD');

    await telegram.enqueueTelegramSend(db, {
      tenantId: TID, userId: 'u-spv', chatId: '111', dedupeKey: 'ttl-1', title: 'T', body: 'B',
    });
    const fresh = await db.collection('notification_outbox').findOne({ dedupeKey: 'ttl-1' });
    expect(fresh!.expireAt).toBeInstanceOf(Date);
  });

  it('notifikasi sudah tersimpan tapi Telegram belum diantre (proses mati) → pengulangan melengkapi', async () => {
    const { notifyUsers, resolveRecipients } = await import('@/lib/notifications/notify');
    const recipients = await resolveRecipients(db, TID, { roles: ['SUPERVISOR'] });
    const input = { tenantId: TID, recipients, type: 'TEST', title: 'T', body: 'B', dedupeKey: 'crash-1' };
    await notifyUsers(db, { ...input, telegram: false });
    const again = await notifyUsers(db, { ...input, telegramSendNow: false });
    expect(again).toMatchObject({ inserted: 0, telegramQueued: 1 });
    expect(await db.collection('notification_outbox').countDocuments({ dedupeKey: 'crash-1' })).toBe(1);
    expect((await notifyUsers(db, { ...input, telegramSendNow: false })).telegramQueued).toBe(0);
  });

  it('notifyUsers paralel dengan dedupeKey sama tidak melempar & tidak menggandakan', async () => {
    const { notifyUsers, resolveRecipients } = await import('@/lib/notifications/notify');
    const recipients = await resolveRecipients(db, TID, { roles: ['SUPERVISOR', 'ADMIN'] });
    const input = {
      tenantId: TID, recipients, type: 'TEST', title: 'T', body: 'B', dedupeKey: 'race-1', telegram: false,
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => notifyUsers(db, input)));
    const totalInserted = results.reduce((n, r) => n + r.inserted, 0);
    const count = await db.collection('notifications').countDocuments({ dedupeKey: 'race-1' });
    expect(count).toBe(recipients.length);
    expect(totalInserted).toBe(recipients.length);
  });
});
