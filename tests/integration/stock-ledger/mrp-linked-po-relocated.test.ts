/**
 * MRP dengan target PO tertaut (`useLinkedPoAsTarget`): baris PO rencana yang dibatalkan karena
 * vendor memindahkannya ke PO lain tetap dihitung dari baris tujuan (lihat cpo-relocated-lines).
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';

const { buildPlanMaterialExplosion } = await import('@/lib/api/handlers/material-requirements');

type ReplSet = { getUri(): string; stop(): Promise<boolean> };
let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-mrp-reloc';
const TODAY = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const ADMIN = {
  userId: 'u-admin', role: 'ADMIN', tenantId: TID, name: 'Admin', email: 'a@x', isMaster: false,
} as AuthContext;

type MrpLine = {
  productId: string;
  qtyNet: number;
  shortage: boolean;
  sourceOfTruth?: string;
  poQtyOrdered?: number;
  poQtyReceived?: number;
};

describe.skipIf(!MongoMemoryReplSet)('MRP target PO tertaut — baris dipindah vendor (Mongo replica set)', { timeout: 90_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  const plan = (id: string) => ({
    id, tenantId: TID, noDokumen: `RPN-${id}`, status: 'APPROVED', tanggal: TODAY, kitchenId: 'k1',
    kitchenWarehouseKode: 'GKERING', lines: [{ recipeId: 'rcp-gula', targetPorsi: 100 }],
  });
  const gulaLine = async (planId: string) => {
    const built = await buildPlanMaterialExplosion(db, { ...ADMIN }, plan(planId) as never, { useLinkedPoAsTarget: true });
    if ('error' in built) throw new Error(String(built.error));
    return (built.lines as MrpLine[]).find((l) => l.productId === 'gula')!;
  };
  const insertPos = (planId: string, targetStatus: string) => db.collection('customer_purchase_orders').insertMany([
    {
      id: `${planId}-asal`, tenantId: TID, noPO: `CPO-${planId}-A`, productionPlanId: planId, status: 'CONFIRMED',
      createdAt: new Date(),
      items: [{
        lineId: 'a-gula', localStokId: 'gula', kode: 'GL01', satuan: 'KG', qty: 2, qtyReceived: 0, cancelled: true,
        relocatedTo: { poId: `${planId}-tujuan`, noPO: `CPO-${planId}-T`, lineId: 't-gula' },
      }],
    },
    {
      id: `${planId}-tujuan`, tenantId: TID, noPO: `CPO-${planId}-T`, status: targetStatus, createdAt: new Date(0),
      items: [{ lineId: 't-gula', localStokId: 'gula', kode: 'GL01', satuan: 'KG', qty: 2, qtyReceived: 1.5 }],
    },
  ]);

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('mrp_linked_po_relocated_it');
    await db.collection('products').insertOne({
      id: 'gula', tenantId: TID, kode: 'GL01', nama: 'Gula Pasir', satuan: 'KG', itemRole: 'INGREDIENT', aktif: true,
      updatedAt: new Date('2026-01-01'),
    });
    await db.collection('kitchens').insertOne({ id: 'k1', tenantId: TID, defaultWarehouseKode: 'GKERING' });
    await db.collection('recipes').insertOne({
      id: 'rcp-gula', tenantId: TID, kode: 'RSP-GL', nama: 'Bubur Manis', aktif: true, yieldQty: 100, updatedAt: new Date(),
      lines: [{
        productId: 'gula', productKode: 'GL01', qty: 2000, qtyBesar: 2000, pctKecil: 100, qtyKecil: 2000,
        satuan: 'GR', qtyBaseBesar: 2, qtyBaseKecil: 2, factorToBase: 0.001, baseSatuan: 'KG', factorSource: 'SI',
      }],
    });
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('tanpa PO: acuan resep-vs-stok', async () => {
    expect(await gulaLine('plan-none')).toMatchObject({ qtyNet: 2, shortage: true });
    expect((await gulaLine('plan-none')).sourceOfTruth).not.toBe('PO');
  });

  it('baris dipindah: target dari PO tujuan (dipesan − diterima)', async () => {
    await insertPos('plan-reloc', 'RECEIVED');
    expect(await gulaLine('plan-reloc')).toMatchObject({
      sourceOfTruth: 'PO', poQtyOrdered: 2, poQtyReceived: 1.5, qtyNet: 0.5, shortage: true,
    });
  });

  it('PO tujuan DRAFT/REJECTED/CANCELLED: baris asal tetap batal → kembali ke resep-vs-stok', async () => {
    for (const status of ['DRAFT', 'REJECTED', 'CANCELLED']) {
      const planId = `plan-${status.toLowerCase()}`;
      await insertPos(planId, status);
      const line = await gulaLine(planId);
      expect(line.sourceOfTruth, status).not.toBe('PO');
      expect(line.qtyNet, status).toBe(2);
    }
  });
});
