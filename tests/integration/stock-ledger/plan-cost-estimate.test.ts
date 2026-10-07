/**
 * Estimasi biaya bahan per porsi RPN (kartu RPN + snapshot CPO dari RPN) pada Mongo replica set.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import type { HandlerContext } from '@/types/api/handler';

const { computePlanCostEstimate, planCostEstimateForCpo } = await import('@/lib/api/plan-cost-estimate');
const { handleFoodCosts } = await import('@/lib/api/handlers/food-costs');
const { handleProductionPlans } = await import('@/lib/api/handlers/production-plans');
const { handleCustomerPo } = await import('@/lib/api/handlers/customer-po');

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-cost';
const ADMIN = {
  userId: 'u-admin', role: 'ADMIN', tenantId: TID, name: 'Admin', email: 'a@x', isMaster: false,
} as AuthContext;
const ALL = ['PORSI_KECIL', 'PORSI_BESAR', 'POSYANDU_BALITA', 'POSYANDU_BUMIL', 'POSYANDU_BUSUI', 'ORGANOLEPTIK'];

type Handler = (ctx: HandlerContext) => Promise<Response | null>;

describe.skipIf(!MongoMemoryReplSet)('Estimasi biaya bahan per porsi RPN', { timeout: 90_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  async function call(handler: Handler, method: string, path: string[], body: Record<string, unknown> = {}, query = '') {
    const url = new URL(`http://local/api/${path.join('/')}${query}`);
    const res = await handler({
      db, route: `/${path.join('/')}`, method, path, body, url, auth: ADMIN,
      request: new Request(url, { method }),
    } as unknown as HandlerContext);
    expect(res, `${method} /${path.join('/')} tidak ditangani`).toBeTruthy();
    return { status: res!.status, json: await res!.json() as Record<string, unknown> };
  }

  const plan = {
    id: 'plan-1',
    tenantId: TID,
    noDokumen: 'RPN-IT-1',
    tanggal: '2026-10-07',
    kitchenId: 'k1',
    kategoriPorsiList: ALL,
    status: 'APPROVED',
    history: [],
    lines: [
      ...Array.from({ length: 7 }, (_, i) => ({ recipeId: `r${i}`, targetPorsi: 1222, kategoriPorsiList: ALL })),
      { recipeId: 'alergi', targetPorsi: 3, kategoriPorsiList: ['ORGANOLEPTIK'] },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('plan_cost_it');
    await db.collection('products').insertMany([
      { id: 'beras', tenantId: TID, kode: 'BRS', nama: 'Beras', satuan: 'KG', hargaBeli: 12_000, avgCost: 99_999 },
      { id: 'ayam-old', tenantId: TID, kode: 'AYM-OLD', nama: 'Ayam lama', satuan: 'KG', hargaBeli: 1, mergedInto: 'ayam' },
      { id: 'ayam', tenantId: TID, kode: 'AYM', nama: 'Ayam', satuan: 'KG', hargaBeli: 40_000 },
      { id: 'garam', tenantId: TID, kode: 'GRM', nama: 'Garam', satuan: 'KG' },
      { id: 'gula', tenantId: TID, kode: 'GL', nama: 'Gula', satuan: 'KG', hargaBeli: 0 },
    ]);
    await db.collection('production_plans').insertOne({ ...plan });
    await db.collection('material_requirements').insertOne({
      id: 'mrp-1',
      tenantId: TID,
      productionPlanId: 'plan-1',
      status: 'DRAFT',
      createdAt: new Date(),
      lines: [
        { productId: 'beras', qtyGross: 100, satuan: 'KG' },
        { productId: 'ayam-old', qtyGross: 50, satuan: 'KG' },
        { productId: 'garam', qtyGross: 2, satuan: 'KG' },
        { productId: 'gula', qtyGross: 3, satuan: 'KG' },
      ],
    });
    await db.collection('portion_targets').insertOne({
      id: 'pt-1',
      tenantId: TID,
      tanggal: '2026-10-07',
      kitchenId: 'k1',
      targets: {
        PORSI_KECIL: 343, PORSI_BESAR: 413, POSYANDU_BALITA: 346, POSYANDU_BUMIL: 31, POSYANDU_BUSUI: 76, ORGANOLEPTIK: 13,
      },
    });
  });

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('biaya MRP × harga beli master ÷ total panel Kategori Porsi (1222)', async () => {
    const est = await computePlanCostEstimate(db, ADMIN, plan as never);
    if ('error' in est) throw new Error(est.error);
    // 100 × 12.000 + 50 × 40.000 (harga produk tujuan merge); garam tanpa harga, gula harga 0
    expect(est.totalCost).toBe(3_200_000);
    expect(est.penerimaPorsi).toBe(1222);
    expect(est.perPorsi).toBeCloseTo(3_200_000 / 1222, 2);
    expect(est.missingPriceCount).toBe(2);
    expect(est.source).toBe('MRP');
    expect(est.priceBasis).toBe('HARGA_BELI');
  });

  it('endpoint kartu RPN dan header porsi memakai angka penerima yang sama', async () => {
    const res = await call(handleFoodCosts as Handler, 'GET', ['food-costs', 'plan-estimate'], {}, '?id=plan-1');
    expect(res.status).toBe(200);
    expect(res.json.penerimaPorsi).toBe(1222);

    const list = await call(handleProductionPlans as Handler, 'GET', ['production-plans'], {}, '?tanggal=2026-10-07');
    expect(list.status).toBe(200);
    const row = (list.json as unknown as Array<Record<string, unknown>>).find((r) => r.id === 'plan-1');
    expect(row?.totalTargetPorsi).toBe(7 * 1222 + 3);
    expect(row?.penerimaPorsi).toBe(1222);

    const one = await call(handleProductionPlans as Handler, 'GET', ['production-plans', 'plan-1']);
    expect(one.json.penerimaPorsi).toBe(1222);
  });

  it('tanpa panel Kategori Porsi: cadangan dari baris resep', async () => {
    const est = await computePlanCostEstimate(db, ADMIN, { ...plan, tanggal: '2026-10-08' } as never);
    if ('error' in est) throw new Error(est.error);
    expect(est.penerimaPorsi).toBe(1222);
  });

  it('CPO: snapshot diperbarui saat diajukan lalu tidak berubah lagi', async () => {
    expect(await planCostEstimateForCpo(db, ADMIN, 'tidak-ada')).toBeNull();
    expect(await planCostEstimateForCpo(db, ADMIN, '')).toBeNull();

    await db.collection('customer_purchase_orders').insertOne({
      id: 'cpo-1',
      tenantId: TID,
      noPO: 'CPO-IT-1',
      status: 'DRAFT',
      productionPlanId: 'plan-1',
      tanggal: new Date(),
      tanggalKedatangan: new Date(),
      items: [{ lineId: 'l1', stokId: 'beras', kode: 'BRS', nama: 'Beras', qty: 10, satuan: 'KG' }],
      estimasiBiayaPorsi: { perPorsi: 1, totalCost: 1, penerimaPorsi: 1, productionPlanId: 'plan-1' },
      createdBy: { userId: 'u-admin', userName: 'Admin' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await call(handleCustomerPo as unknown as Handler, 'POST', ['customer-purchase-orders', 'cpo-1', 'request-approval']);
    expect(res.status).toBe(200);
    const after = await db.collection('customer_purchase_orders').findOne({ id: 'cpo-1' });
    expect(after?.status).toBe('PENDING_APPROVAL');
    expect(after?.estimasiBiayaPorsi).toMatchObject({ totalCost: 3_200_000, penerimaPorsi: 1222, planNo: 'RPN-IT-1' });

    await db.collection('products').updateOne({ id: 'beras' }, { $set: { hargaBeli: 99_000 } });
    const later = await db.collection('customer_purchase_orders').findOne({ id: 'cpo-1' });
    expect(later?.estimasiBiayaPorsi).toMatchObject({ totalCost: 3_200_000 });
  });
});
