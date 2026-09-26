/**
 * Fase 6 — rekonsiliasi harian: setiap jenis anomali sintetis muncul di laporan, panel ops, metrik
 * Prometheus, dan /api/health; tenant bersih (data lewat jalur posting asli) tidak menghasilkan temuan.
 * Juga laporan varians per rencana (MRP vs PO vs RL, qty & rupiah).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import { postStockMovements } from '@/lib/stock-ledger';
import { syncCpoOnGrnPosted } from '@/lib/api/cpo-status-sync';
import { runRecon, runReconJobPayload } from '@/lib/recon/run';
import { ALL_RECON_KINDS, RECON_KINDS } from '@/lib/recon/types';
import { RECON_REPORTS_COLLECTION } from '@/lib/recon/reports';
import { refreshReconGauges } from '@/lib/recon/metrics';
import { buildHealthResponse } from '@/lib/api/health';
import { handleOpsDashboard } from '@/lib/api/handlers/ops-dashboard';
import { handleProductionPlans } from '@/lib/api/handlers/production-plans';
import { executionMetricRegistry } from '@sdwianto/metrics';
import type { JsonObject } from '@/types/json';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-f6-bad';
const CLEAN = 'it-f6-clean';
const TODAY = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const now = Date.now();
const ago = (ms: number) => new Date(now - ms);
const H = 3600_000;
const D = 24 * H;

const MASTER: AuthContext = {
  userId: 'u-master', email: 'm@x', name: 'master', role: 'MASTER', tenantId: 'master', tenantName: 'master', isMaster: true,
};
const ADMIN: AuthContext = {
  userId: 'u-admin', email: 'a@x', name: 'admin', role: 'ADMIN', tenantId: TID, tenantName: TID, isMaster: false,
};

describe.skipIf(!MongoMemoryReplSet)('Fase 6 rekonsiliasi harian', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  const product = (tenantId: string, id: string, extra: Record<string, unknown> = {}) => db.collection('products').insertOne({
    id, tenantId, kode: id.toUpperCase(), nama: id, satuan: 'KG', itemRole: 'INGREDIENT', aktif: true,
    gudangKode: 'GKERING', hargaBeli: 10, stok: 0, mergedInto: null, ...extra,
  });
  const lokasi = (tenantId: string, stokId: string, qty: number, lokasiKode = 'GKERING') => db.collection('stok_lokasi')
    .insertOne({ id: `${stokId}-${lokasiKode}`, tenantId, stokId, lokasiKode, qty });
  const kartu = (tenantId: string, stokId: string, row: Record<string, unknown>) => db.collection('stok_kartu').insertOne({
    id: `k-${stokId}-${Math.random()}`, tenantId, stokId, lokasiKode: 'GKERING', masuk: 0, keluar: 0,
    tanggal: ago(2 * D), hargaSatuan: 10, costSource: 'LINE', ...row,
  });
  const journal = (tenantId: string, row: Record<string, unknown>) => db.collection('jurnal').insertOne({
    id: `j-${Math.random()}`, tenantId, tanggal: row.createdAt, ...row,
  });

  async function seedAnomalies() {
    await db.collection('tenant_settings').insertOne({
      tenantId: TID, features: { rlFromPoReference: true, costingV2: true },
    });

    // Stok: gudang ≠ kartu dan master ≠ gudang.
    await product(TID, 'p-drift', { stok: 10 });
    await lokasi(TID, 'p-drift', 8);
    await kartu(TID, 'p-drift', { masuk: 10 });
    // Stok di gudang selain gudang produk.
    await product(TID, 'p-phantom', { stok: 2 });
    await lokasi(TID, 'p-phantom', 2, 'GBASAH');
    // Kartu negatif.
    await product(TID, 'p-neg');
    await kartu(TID, 'p-neg', { keluar: 5 });
    // Σ lot > gudang.
    await product(TID, 'p-lot', { stok: 3 });
    await lokasi(TID, 'p-lot', 3);
    await kartu(TID, 'p-lot', { masuk: 3 });
    await db.collection('ingredient_lots').insertOne({
      id: 'lot-1', tenantId: TID, productId: 'p-lot', warehouseKode: 'GKERING', status: 'ACTIVE',
      qty: 5, qtyRemaining: 5, expiryDate: '2099-01-01', lotNo: 'L1',
    });
    // Σ bin > gudang.
    await product(TID, 'p-bin', { stok: 4 });
    await lokasi(TID, 'p-bin', 4);
    await kartu(TID, 'p-bin', { masuk: 4 });
    await db.collection('stok_bin').insertOne({ id: 'bin-1', tenantId: TID, stokId: 'p-bin', warehouseKode: 'GKERING', binKode: 'A1', qty: 6 });
    // Float dust di gudang, master, dan kartu 7 hari terakhir.
    const dust = 0.1 + 0.2;
    await product(TID, 'p-dust', { stok: dust });
    await lokasi(TID, 'p-dust', dust);
    await kartu(TID, 'p-dust', { masuk: dust, tanggal: ago(H) });
    // Keluar tanpa harga sesudah cutover costingV2.
    await product(TID, 'p-zero', { stok: 1 });
    await lokasi(TID, 'p-zero', 1);
    await kartu(TID, 'p-zero', { masuk: 2 });
    await kartu(TID, 'p-zero', { keluar: 1, hargaSatuan: 0, costSource: 'NONE', tanggal: ago(H), noTransaksi: 'RL-Z' });

    // Cutover costingV2 10 hari lalu; GL Persediaan sengaja jauh dari nilai stok.
    await journal(TID, {
      sourceType: 'AUTO_INVENTORY_CUTOVER', sourceId: 'cut-1', createdAt: ago(10 * D),
      details: [{ rekeningKode: '10310', debet: 1_000_000, kredit: 0 }, { rekeningKode: '40060', debet: 0, kredit: 1_000_000 }],
    });

    // PO: qty diterima ≠ replay GRN, GRN belum diterapkan, pembalik belum diterapkan.
    await product(TID, 'p-po');
    await db.collection('customer_purchase_orders').insertMany([
      {
        id: 'po-1', tenantId: TID, noPO: 'PO-1', status: 'PARTIAL_RECEIVED', appliedReceiveGrnIds: ['g1'],
        items: [{ lineId: 'L1', localStokId: 'p-po', kode: 'P-PO', satuan: 'KG', qty: 10, qtyReceived: 7, qtyRejected: 0 }],
      },
      {
        id: 'po-2', tenantId: TID, noPO: 'PO-2', status: 'RECEIVED', appliedReceiveGrnIds: ['g4'],
        items: [{ lineId: 'L2', localStokId: 'p-po', kode: 'P-PO', satuan: 'KG', qty: 3, qtyReceived: 3, qtyRejected: 0 }],
      },
    ]);
    const grnItem = (lineId: string, qty: number) => ({ lineId, localStokId: 'p-po', satuan: 'KG', qtyReceived: qty, qtyReceivedBase: qty, harga: 100 });
    await db.collection('goods_receipts').insertMany([
      { id: 'g1', tenantId: TID, noGRN: 'GRN-1', noPO: 'PO-1', status: 'POSTED', postedAt: ago(2 * H), items: [grnItem('L1', 5)], hutangId: 'h-x' },
      { id: 'g2', tenantId: TID, noGRN: 'GRN-2', noPO: 'PO-1', status: 'POSTED', postedAt: ago(2 * H), items: [grnItem('L1', 1)], hutangId: 'h-x' },
      { id: 'g3', tenantId: TID, noGRN: 'GRN-3', noPO: 'PO-1', status: 'POSTED', postedAt: ago(60_000), items: [grnItem('L1', 1)], hutangId: 'h-x' },
      { id: 'g4', tenantId: TID, noGRN: 'GRN-4', noPO: 'PO-2', status: 'REVERSED', postedAt: ago(5 * H), reversedAt: ago(2 * H), items: [grnItem('L2', 3)], hutangId: 'h-x' },
    ]);

    // GRNI: tagihan mengkliring 1000, akrual GRN tertaut 900; GRN 40 hari belum ditagih.
    await db.collection('hutang').insertOne({ id: 'h1', tenantId: TID, noHutang: 'HT-1', noDO: 'DO-1' });
    await db.collection('goods_receipts').insertMany([
      { id: 'g5', tenantId: TID, noGRN: 'GRN-5', noDO: 'DO-1', status: 'POSTED', postedAt: ago(3 * D), hutangId: 'h1', items: [] },
      { id: 'g6', tenantId: TID, noGRN: 'GRN-6', noDO: 'DO-6', status: 'POSTED', postedAt: ago(40 * D), items: [] },
    ]);
    const accrual = (sourceId: string, amount: number) => journal(TID, {
      sourceType: 'AUTO_GRN_ACCRUAL', sourceId, createdAt: ago(3 * D),
      details: [{ rekeningKode: '10310', debet: amount, kredit: 0 }, { rekeningKode: '20020', debet: 0, kredit: amount }],
    });
    await accrual('g5', 900);
    await accrual('g6', 500);
    await journal(TID, {
      sourceType: 'AUTO_HUTANG_VENDOR', sourceId: 'h1', createdAt: ago(2 * D),
      details: [{ rekeningKode: '20020', debet: 1000, kredit: 0 }, { rekeningKode: '20010', debet: 0, kredit: 1000 }],
    });

    // Rencana vs RL.
    await product(TID, 'gula');
    await db.collection('product_uom').insertOne({
      id: 'gula-KG', tenantId: TID, productId: 'gula', satuan: 'KG', factorToBase: 1, isBase: true, aktif: true, sortOrder: 0,
    });
    for (const planId of ['plan-x', 'plan-y']) {
      await db.collection('production_plans').insertOne({
        id: planId, tenantId: TID, noDokumen: planId.toUpperCase(), status: 'APPROVED', tanggal: TODAY, kitchenId: 'k1', lines: [],
      });
      await db.collection('material_requirements').insertOne({
        id: `mrp-${planId}`, tenantId: TID, productionPlanId: planId, status: 'APPROVED', createdAt: new Date(),
        lines: [{ productId: 'gula', productNama: 'Gula', satuan: 'KG', qtyGross: 5 }],
      });
      await db.collection('customer_purchase_orders').insertOne({
        id: `po-${planId}`, tenantId: TID, noPO: `CPO-${planId}`, productionPlanId: planId, status: 'RECEIVED',
        items: [{ localStokId: 'gula', kode: 'GULA', satuan: 'KG', qty: 5, qtyReceived: 5, estimasiHarga: 10 }],
      });
    }
    await db.collection('inventory_releases').insertMany([
      {
        id: 'rl-x', tenantId: TID, noRelease: 'RL-X', status: 'POSTED', productionPlanId: 'plan-x', tanggal: new Date(),
        keperluan: 'Masak menu produksi', lokasiKode: 'GKERING', items: [{ stokId: 'gula', qty: 8, qtyBase: 8, satuan: 'KG' }],
      },
      {
        id: 'rl-y', tenantId: TID, noRelease: 'RL-Y', status: 'POSTED', productionPlanId: 'plan-y', tanggal: new Date(),
        keperluan: 'Masak menu produksi', lokasiKode: 'GKERING', items: [{ stokId: 'gula', qty: 8, qtyBase: 8, satuan: 'KG' }],
        overIssue: { productionPlanId: 'plan-y', tolerancePct: 0, checkedAt: new Date(), lines: [{ productId: 'gula', overQty: 3, reasons: ['tambah porsi'] }] },
      },
      {
        id: 'rl-free', tenantId: TID, noRelease: 'RL-FREE', status: 'POSTED', tanggal: new Date(),
        keperluan: 'Masak menu produksi', lokasiKode: 'GKERING', items: [{ stokId: 'gula', qty: 2, qtyBase: 2, satuan: 'KG' }],
      },
    ]);
    await db.collection('stok_kartu').insertOne({
      id: 'k-rl-x', tenantId: TID, stokId: 'gula', lokasiKode: 'GKERING', sourceType: 'RELEASE', sourceId: 'rl-x',
      noTransaksi: 'RL-X', masuk: 0, keluar: 8, hargaSatuan: 12, costSource: 'PRODUCT_AVG', tanggal: ago(10 * D),
    });
    await db.collection('stok_kartu').insertOne({
      id: 'k-gula-in', tenantId: TID, stokId: 'gula', lokasiKode: 'GKERING', sourceType: 'GRN',
      noTransaksi: 'GRN-G', masuk: 8, keluar: 0, hargaSatuan: 12, costSource: 'LINE', tanggal: ago(11 * D),
    });
    await db.collection('material_issues').insertOne({
      id: 'pbl-x', tenantId: TID, noDokumen: 'PBL-X', productionPlanId: 'plan-x', status: 'COMPLETED', stockMode: 'STOCK',
      stockPostedAt: ago(H), lines: [{ productId: 'gula', qtyIssued: 0 }],
    });
  }

  async function seedClean() {
    await db.collection('tenant_settings').insertOne({ tenantId: CLEAN, features: { rlFromPoReference: true } });
    await product(CLEAN, 'c-1');
    const posted = await postStockMovements(db, undefined, {
      tenantId: CLEAN, sourceType: 'GRN', sourceId: 'cg-1', noTransaksi: 'CGRN-1', keterangan: 'seed', postingDate: new Date(),
      lines: [{ lineRef: '1', productId: 'c-1', warehouseKode: 'GKERING', deltaQtyBase: 2.5, unitCost: 1000 }],
    });
    if (!posted.ok) throw new Error(posted.error);
    await db.collection('customer_purchase_orders').insertOne({
      id: 'cpo-1', tenantId: CLEAN, noPO: 'CPO-C1', status: 'SUBMITTED',
      items: [{ lineId: 'CL1', localStokId: 'c-1', kode: 'C-1', satuan: 'KG', qty: 5, qtyReceived: 0, qtyRejected: 0 }],
    });
    const grn = {
      id: 'cg-1', tenantId: CLEAN, noGRN: 'CGRN-1', noPO: 'CPO-C1', status: 'POSTED', postedAt: ago(3 * H), hutangId: 'ch-1',
      items: [{ lineId: 'CL1', localStokId: 'c-1', satuan: 'KG', qtyReceived: 2.5, qtyReceivedBase: 2.5, harga: 1000 }],
    };
    await db.collection('goods_receipts').insertOne({ ...grn });
    const synced = await syncCpoOnGrnPosted(db, grn as unknown as JsonObject);
    expect(synced.action).toBe('updated');
  }

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('phase6_recon_it');
    await db.collection('stok_lokasi').createIndex({ tenantId: 1, stokId: 1, lokasiKode: 1 }, { unique: true, name: 'uniq_stok_lokasi' });
    await seedAnomalies();
    await seedClean();
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('setiap jenis anomali sintetis terdeteksi di laporan tenant', async () => {
    const result = await runRecon(db, { jobs: ['stock', 'po-receipt', 'grni', 'plan-issue'], tenantId: TID });
    expect(result.errors).toBe(0);
    const reports = await db.collection(RECON_REPORTS_COLLECTION).find({ tenantId: TID }).toArray();
    expect(reports).toHaveLength(4);
    const summary: Record<string, number> = {};
    for (const r of reports) Object.assign(summary, r.summary);
    for (const kind of ALL_RECON_KINDS) {
      expect(summary[kind], kind).toBeGreaterThan(0);
    }

    const find = (job: string) => reports.find((r) => r.job === job)!;
    const stock = find('stock');
    expect(stock.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'STOCK_HOME_VS_LEDGER', productId: 'p-drift', expected: 10, actual: 8 }),
      expect.objectContaining({ kind: 'STOCK_MASTER_VS_LOKASI', productId: 'p-drift', expected: 8, actual: 10 }),
      expect.objectContaining({ kind: 'STOCK_PHANTOM_WAREHOUSE', productId: 'p-phantom', lokasiKode: 'GBASAH' }),
      expect.objectContaining({ kind: 'STOCK_LEDGER_NEGATIVE', productId: 'p-neg', actual: -5 }),
      expect.objectContaining({ kind: 'STOCK_LOT_GT_LOKASI', productId: 'p-lot', expected: 3, actual: 5 }),
      expect.objectContaining({ kind: 'STOCK_BIN_GT_LOKASI', productId: 'p-bin', expected: 4, actual: 6 }),
      expect.objectContaining({ kind: 'STOCK_ZERO_COST_OUT', productId: 'p-zero', kode: 'P-ZERO' }),
    ]));
    expect(stock.summary.STOCK_FLOAT_DUST).toBe(3);
    expect(stock.findings.filter((f: { productId?: string }) => f.productId === 'p-dust').every(
      (f: { kind: string }) => f.kind === 'STOCK_FLOAT_DUST',
    )).toBe(true);

    const po = find('po-receipt');
    expect(po.summary).toMatchObject({ PO_QTY_RECEIVED_MISMATCH: 1, PO_GRN_NOT_APPLIED: 1, PO_GRN_REVERSAL_NOT_APPLIED: 1 });
    expect(po.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'PO_QTY_RECEIVED_MISMATCH', refNo: 'PO-1', expected: 5, actual: 7 }),
      expect.objectContaining({ kind: 'PO_GRN_NOT_APPLIED', refNo: 'PO-1', detail: expect.stringContaining('GRN-2') }),
      expect.objectContaining({ kind: 'PO_GRN_REVERSAL_NOT_APPLIED', refNo: 'PO-2' }),
    ]));

    const grni = find('grni');
    expect(grni.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'GRNI_BILL_RESIDUAL', refId: 'h1', expected: 900, actual: 1000, delta: 100 }),
      expect.objectContaining({ kind: 'GRNI_UNBILLED_AGED', refId: 'g6', actual: 500 }),
      expect.objectContaining({ kind: 'GL_INVENTORY_VS_VALUATION', refId: TID }),
    ]));
    expect(grni.findings.filter((f: { kind: string }) => f.kind === 'GRNI_UNBILLED_AGED')).toHaveLength(1);

    const plan = find('plan-issue');
    expect(plan.summary).toMatchObject({ RL_UNLINKED: 1, RL_OVER_REFERENCE_UNAPPROVED: 1, PBL_MUTATING_WITH_RL: 1 });
    expect(plan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'RL_UNLINKED', refNo: 'RL-FREE' }),
      expect.objectContaining({ kind: 'RL_OVER_REFERENCE_UNAPPROVED', refId: 'plan-x', expected: 5, actual: 8 }),
      expect.objectContaining({ kind: 'PBL_MUTATING_WITH_RL', refNo: 'PBL-X' }),
    ]));
  });

  it('tenant bersih dari jalur posting asli tidak menghasilkan temuan', async () => {
    const result = await runRecon(db, { jobs: ['stock', 'po-receipt', 'grni', 'plan-issue'], tenantId: CLEAN });
    expect(result.errors).toBe(0);
    const reports = await db.collection(RECON_REPORTS_COLLECTION).find({ tenantId: CLEAN }).toArray();
    expect(reports.map((r) => [r.job, r.totalMismatch, r.findings])).toEqual(
      expect.arrayContaining(['stock', 'po-receipt', 'grni', 'plan-issue'].map((j) => [j, 0, []])),
    );
  });

  it('job INVENTORY_RECON semua tenant, panel ops, metrik, dan health menampilkan anomali', async () => {
    const out = await runReconJobPayload(db, 'system', { job: 'all', allTenants: true });
    expect(out.error).toBeUndefined();
    expect(out.tenants).toBe(2);
    expect(await runReconJobPayload(db, 'system', { job: 'nope' })).toMatchObject({ error: expect.stringContaining('nope') });

    const url = new URL('http://x/api/ops/recon');
    const res = await handleOpsDashboard({ db, route: '/ops/recon', method: 'GET', path: ['ops', 'recon'], body: {}, url, auth: MASTER, request: new Request(url) } as never);
    const panel = await res!.json() as { reports: Array<{ tenantId: string; job: string; id: string }>; totals: Record<string, number> };
    expect(panel.reports.filter((r) => r.tenantId === TID)).toHaveLength(4);
    for (const kind of ALL_RECON_KINDS) expect(panel.totals[kind], kind).toBeGreaterThan(0);
    const denied = await handleOpsDashboard({ db, route: '/ops/recon', method: 'GET', path: ['ops', 'recon'], body: {}, url, auth: ADMIN, request: new Request(url) } as never);
    expect(denied!.status).toBe(403);

    const stockReport = panel.reports.find((r) => r.tenantId === TID && r.job === 'stock')!;
    const rurl = new URL(`http://x/api/ops/recon/report?id=${stockReport.id}`);
    const detail = await handleOpsDashboard({ db, route: '/ops/recon/report', method: 'GET', path: ['ops', 'recon', 'report'], body: {}, url: rurl, auth: MASTER, request: new Request(rurl) } as never);
    const full = await detail!.json() as { findings: unknown[] };
    expect(full.findings.length).toBeGreaterThan(0);

    await refreshReconGauges(db);
    const metric = await executionMetricRegistry.getSingleMetric('inventory_recon_mismatch_total')!.get();
    const byKind = new Map(metric.values.map((v) => [String(v.labels.kind), v.value]));
    for (const kind of RECON_KINDS.stock) expect(byKind.get(kind), kind).toBeGreaterThan(0);
    expect(byKind.get('GRNI_BILL_RESIDUAL')).toBe(1);

    const health = await buildHealthResponse(db, 'inventory');
    expect(health.checks.stockRecon).toMatchObject({ tenants: 2, errors: 0 });
    expect(health.checks.stockRecon!.totalMismatch).toBeGreaterThan(0);
  });

  it('varians rencana: MRP vs PO vs RL aktual, qty dan rupiah', async () => {
    const url = new URL('http://x/api/production-plans/plan-x/variance');
    const path = ['production-plans', 'plan-x', 'variance'];
    const res = await handleProductionPlans({ db, route: `/${path.join('/')}`, method: 'GET', path, body: {}, url, auth: ADMIN, request: new Request(url) } as never);
    expect(res!.status).toBe(200);
    const v = await res!.json() as { lines: Array<Record<string, unknown>>; summary: Record<string, number> };
    expect(v.lines).toHaveLength(1);
    expect(v.lines[0]).toMatchObject({
      productId: 'gula', sumber: 'PO', qtyMrp: 5, qtyPoReceived: 5, acuanQty: 5, qtyRl: 8, qtyActual: 8,
      varianceQty: 3, variancePct: 60, unitCost: 12, costBasis: 'KARTU',
      amountMrp: 50, amountPo: 50, amountActual: 96, amountAcuan: 60, varianceAmount: 36,
    });
    expect(v.summary).toMatchObject({ overCount: 1, amountActual: 96, varianceAmount: 36 });

    const gudang = { ...ADMIN, userId: 'u-g', role: 'GUDANG' };
    const denied = await handleProductionPlans({ db, route: `/${path.join('/')}`, method: 'GET', path, body: {}, url, auth: gudang, request: new Request(url) } as never);
    expect(denied!.status).toBe(403);
  });
});
