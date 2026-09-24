/**
 * Fase 0.3 — kerangka migrasi + invariant buku stok pada MongoDB replica set sungguhan.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { executeMigration } from '@/lib/migrations/runner';
import { MIGRATION_RUNS_COLLECTION, type Migration } from '@/lib/migrations/types';
import { postStockMovements, roundStockQty } from '@/lib/stock-ledger';
import type { FefoAllocation } from '@/lib/food-production/fefo-allocate';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-03';

describe.skipIf(!MongoMemoryReplSet)('Fase 0.3 flag/migrasi/invariant', { timeout: 60_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;
  const reportDir = mkdtempSync(path.join(tmpdir(), 'mig-'));

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('phase03_it');
    await db.collection('stok_kartu').createIndex(
      { tenantId: 1, sourceType: 1, sourceId: 1, lineRef: 1 },
      {
        name: 'uniq_stok_kartu_source_line',
        unique: true,
        partialFilterExpression: { sourceId: { $type: 'string', $gt: '' }, lineRef: { $type: 'string', $gt: '' } },
      },
    );
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  const stamp: Migration = {
    id: 'it-stamp',
    description: 'tanda tenant sekali',
    async run({ db: tx, tenantId, dryRun }) {
      const before = await tx.collection('markers').countDocuments({ tenantId });
      if (!dryRun && before === 0) {
        await tx.collection('markers').insertOne({ tenantId, stamped: true });
      }
      const after = await tx.collection('markers').countDocuments({ tenantId });
      return {
        summary: before === 0 ? 'tenant ditandai' : 'sudah ditandai',
        before: { count: before },
        after: { count: after },
        changed: after - before,
      };
    },
  };

  describe('kerangka migrasi', () => {
    beforeEach(async () => {
      await db.collection('markers').deleteMany({});
      await db.collection(MIGRATION_RUNS_COLLECTION).deleteMany({});
    });

    it('dry-run default tidak menulis data, tetapi mencatat run + hash laporan', async () => {
      const res = await executeMigration({
        db, migration: stamp, tenantId: TID, actor: 'auditor', reportDir,
      });
      expect(res.mode).toBe('DRY_RUN');
      expect(res.status).toBe('OK');
      expect(res.changed).toBe(0);
      expect(res.reportHash).toMatch(/^[a-f0-9]{64}$/);
      expect(res.reportPath && res.reportPath.startsWith(reportDir)).toBe(true);
      expect(await db.collection('markers').countDocuments({ tenantId: TID })).toBe(0);
      const row = await db.collection(MIGRATION_RUNS_COLLECTION).findOne({ id: res.id });
      expect(row).toMatchObject({ actor: 'auditor', mode: 'DRY_RUN', status: 'OK', reportHash: res.reportHash });
    });

    it('apply idempoten: kedua kali dilewati tanpa menulis ulang', async () => {
      const first = await executeMigration({
        db, migration: stamp, tenantId: TID, apply: true, actor: 'auditor', reportDir,
      });
      expect(first.status).toBe('OK');
      expect(first.changed).toBe(1);
      const second = await executeMigration({
        db, migration: stamp, tenantId: TID, apply: true, actor: 'auditor', reportDir,
      });
      expect(second.status).toBe('SKIPPED');
      expect(await db.collection('markers').countDocuments({ tenantId: TID })).toBe(1);
      const forced = await executeMigration({
        db, migration: stamp, tenantId: TID, apply: true, force: true, actor: 'auditor', reportDir,
      });
      expect(forced.status).toBe('OK');
      expect(forced.changed).toBe(0);
      expect(await db.collection('markers').countDocuments({ tenantId: TID })).toBe(1);
    });

    it('apply paralel: tepat satu yang menulis', async () => {
      const results = await Promise.all([
        executeMigration({ db, migration: stamp, tenantId: 'race', apply: true, actor: 'a', reportDir }),
        executeMigration({ db, migration: stamp, tenantId: 'race', apply: true, actor: 'b', reportDir }),
      ]);
      expect(results.filter((r) => r.status === 'OK')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'SKIPPED')).toHaveLength(1);
      expect(await db.collection('markers').countDocuments({ tenantId: 'race' })).toBe(1);
    });

    it('gagal tetap tercatat FAILED lalu error diteruskan', async () => {
      const boom: Migration = {
        id: 'it-boom',
        description: 'gagal',
        async run() { throw new Error('sengaja gagal'); },
      };
      await expect(executeMigration({
        db, migration: boom, tenantId: TID, apply: true, actor: 'auditor', reportDir,
      })).rejects.toThrow('sengaja gagal');
      const row = await db.collection(MIGRATION_RUNS_COLLECTION).findOne({ migrationId: 'it-boom' });
      expect(row?.status).toBe('FAILED');
    });
  });

  describe('invariant buku stok', () => {
    beforeEach(async () => {
      for (const c of ['products', 'stok_lokasi', 'stok_kartu', 'ingredient_lots', 'audit_log']) {
        await db.collection(c).deleteMany({});
      }
      await db.collection('products').insertOne({
        id: 'gula', tenantId: TID, kode: 'GM', nama: 'Gula Merah', gudangKode: 'GKERING', hargaBeli: 18, stok: 0,
      });
    });

    async function assertInvariant(step: string) {
      const lok = Number((await db.collection('stok_lokasi').findOne({ tenantId: TID, stokId: 'gula' }))?.qty ?? 0);
      const kartu = await db.collection('stok_kartu').find({ tenantId: TID, stokId: 'gula' }).toArray();
      const saldo = roundStockQty(kartu.reduce((s, k) => s + Number(k.masuk || 0) - Number(k.keluar || 0), 0));
      const lots = await db.collection('ingredient_lots').find({ tenantId: TID, productId: 'gula' }).toArray();
      const lotSum = roundStockQty(lots.reduce((s, l) => s + Number(l.qtyRemaining || 0), 0));
      const prod = await db.collection('products').findOne({ id: 'gula' });
      expect(lok, step).toBeGreaterThanOrEqual(0);
      expect(lok, step).toBe(saldo);
      expect(prod?.stok, step).toBe(lok);
      expect(lotSum, step).toBe(lok);
      for (const row of [lok, ...kartu.flatMap((k) => [Number(k.masuk || 0), Number(k.keluar || 0)]), ...lots.map((l) => Number(l.qtyRemaining || 0))]) {
        expect(row, step).toBeGreaterThanOrEqual(0);
        expect(Math.abs(roundStockQty(row) - row), step).toBeLessThan(1e-9);
      }
    }

    it('urutan acak GRN, RL, penyesuaian, dan pembalik menjaga invariant', async () => {
      let seed = 7;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed / 2 ** 31;
      };
      let onHand = 0;
      const history: Array<{ kind: 'GRN' | 'RL' | 'PS'; qty: number; allocations: FefoAllocation[] }> = [];
      const counts = { GRN: 0, RL: 0, PS: 0, REVERSAL: 0 };

      for (let i = 0; i < 80; i += 1) {
        const qty = roundStockQty(rand() * 2 + 0.0001);
        const roll = rand();
        let delta = qty;
        let sourceType = 'GRN';
        let reversal = false;
        let lotPolicy: Record<string, unknown> = {
          mode: 'CREATE',
          lot: { lotNo: `L-${i}`, receivedAt: '2026-09-01', expiryDate: '2027-09-01' },
        };
        if (roll >= 0.35 && roll < 0.6) {
          if (onHand < qty) continue;
          delta = -qty;
          sourceType = 'RELEASE';
          lotPolicy = { mode: 'FEFO_CONSUME', allowExpired: true };
        } else if (roll >= 0.6 && roll < 0.8) {
          sourceType = 'PENYESUAIAN';
          delta = rand() < 0.5 || onHand < qty ? qty : -qty;
          lotPolicy = { mode: 'VARIANCE' };
        } else if (roll >= 0.8) {
          const reversible = history.filter((h) => (h.kind === 'RL' && h.allocations.length) || onHand >= h.qty);
          if (!reversible.length) continue;
          const past = reversible[Math.floor(rand() * reversible.length)];
          reversal = true;
          if (past.kind === 'RL' && past.allocations.length) {
            delta = past.qty;
            sourceType = 'RELEASE';
            lotPolicy = { mode: 'RESTORE', restores: past.allocations };
          } else {
            delta = -past.qty;
            sourceType = past.kind === 'PS' ? 'PENYESUAIAN' : 'GRN';
            lotPolicy = past.kind === 'PS' ? { mode: 'VARIANCE' } : { mode: 'FEFO_CONSUME', allowExpired: true };
          }
        }
        const res = await postStockMovements(db, undefined, {
          tenantId: TID,
          sourceType,
          sourceId: `m-${i}`,
          noTransaksi: `M-${i}`,
          keterangan: 'acak',
          lines: [{
            lineRef: '1',
            productId: 'gula',
            warehouseKode: 'GKERING',
            deltaQtyBase: delta,
            binPolicy: 'NONE',
            lotPolicy: lotPolicy as never,
          }],
        });
        if (!res.ok) continue;
        const lot = res.lines[0]?.lot;
        if (lot && lot.shortfall > 0) {
          throw new Error(`langkah ${i}: lot shortfall ${lot.shortfall} pada ${sourceType}`);
        }
        onHand = roundStockQty(onHand + delta);
        const kind = sourceType === 'RELEASE' ? 'RL' : sourceType === 'PENYESUAIAN' ? 'PS' : 'GRN';
        counts[reversal ? 'REVERSAL' : kind] += 1;
        history.push({ kind, qty: Math.abs(delta), allocations: lot?.allocations || [] });
        await assertInvariant(`langkah ${i}`);
      }
      expect(counts.GRN).toBeGreaterThan(0);
      expect(counts.RL).toBeGreaterThan(0);
      expect(counts.PS).toBeGreaterThan(0);
      expect(counts.REVERSAL).toBeGreaterThan(0);
    });
  });
});
