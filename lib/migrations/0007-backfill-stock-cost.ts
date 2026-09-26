import type { Migration } from '@/lib/migrations/types';
import { writeAuditLog } from '@/lib/api/audit-log';
import { runInTransactionOnDb } from '@/lib/api/transaction';
import {
  applyStockCostBackfill,
  listProductsWithKartu,
  planStockCostBackfill,
  roundMoney,
  type StockCostBackfillPlan,
} from '@/lib/stock-ledger';

export const BACKFILL_STOCK_COST_ID = '0007-backfill-stock-cost';

export type StockCostBackfillRow = Omit<StockCostBackfillPlan, 'updates'> & {
  result: 'NOOP' | 'WOULD_FILL' | 'FILLED' | 'FAILED';
  error?: string;
};

function toRow(plan: StockCostBackfillPlan): StockCostBackfillRow {
  const { updates: _updates, ...rest } = plan;
  void _updates;
  const changes = plan.fill > 0 || (!plan.memo && plan.avgAfter !== plan.avgBefore);
  return { ...rest, result: changes ? 'WOULD_FILL' : 'NOOP' };
}

function totals(rows: StockCostBackfillRow[]) {
  const acc = { products: rows.length, toChange: 0, linesFilled: 0, fillValue: 0, unresolved: 0, qtyDrift: 0, valueAtHargaBeli: 0, valueAtAvg: 0 };
  for (const r of rows) {
    if (r.result !== 'NOOP') acc.toChange += 1;
    acc.linesFilled += r.fill;
    acc.fillValue += r.fillValue;
    acc.unresolved += r.unresolved;
    if (Math.abs(r.replayQty - r.ledgerQty) > 1e-4) acc.qtyDrift += 1;
    acc.valueAtHargaBeli += r.valueAtHargaBeli;
    acc.valueAtAvg += r.valueAtAvg;
  }
  return {
    ...acc,
    fillValue: roundMoney(acc.fillValue),
    valueAtHargaBeli: roundMoney(acc.valueAtHargaBeli),
    valueAtAvg: roundMoney(acc.valueAtAvg),
    valueDelta: roundMoney(acc.valueAtAvg - acc.valueAtHargaBeli),
  };
}

/**
 * Isi harga baris kartu yang masih 0 lewat replay kronologis rata-rata bergerak per produk, lalu set
 * products.avgCost. Harga historis yang sudah ada tidak diubah. Satu transaksi + audit per produk.
 * Laporan: nilai persediaan pada hargaBeli vs rata-rata, dan produk yang replay qty-nya ≠ saldo gudang.
 */
export const backfillStockCostMigration: Migration = {
  id: BACKFILL_STOCK_COST_ID,
  description: 'Isi harga kartu stok yang kosong dengan rata-rata bergerak (replay kronologis) dan set avgCost produk',
  async run(ctx) {
    const { db, tenantId } = ctx;
    const actor = ctx.actor || 'system';
    const auditActor = { userId: `migration:${actor}`, userName: `Migrasi (${actor})` };

    const products = await listProductsWithKartu(db, tenantId);
    const rows: StockCostBackfillRow[] = [];
    for (const p of products) rows.push(toRow(await planStockCostBackfill(db, tenantId, p)));
    const before = totals(rows);

    let changed = 0;
    if (!ctx.dryRun) {
      const byId = new Map(products.map((p) => [p.id, p]));
      for (const row of rows) {
        if (row.result === 'NOOP') continue;
        try {
          await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
            const fresh = await planStockCostBackfill(txDb, tenantId, byId.get(row.productId)!, session);
            await applyStockCostBackfill(txDb, session, tenantId, fresh, { now: ctx.now, migrationId: BACKFILL_STOCK_COST_ID });
            await writeAuditLog(txDb, {
              tenantId,
              action: 'STOCK_COST_BACKFILL',
              entityType: 'product',
              entityId: row.productId,
              summary: `${row.kode || row.productId}: ${fresh.fill} baris kartu diisi harga, avgCost ${fresh.avgBefore ?? '—'} → ${fresh.avgAfter}`,
              metadata: {
                migration: BACKFILL_STOCK_COST_ID,
                fill: fresh.fill,
                fillValue: fresh.fillValue,
                avgBefore: fresh.avgBefore,
                avgAfter: fresh.avgAfter,
              },
              ...auditActor,
            }, session);
          });
          row.result = 'FILLED';
          changed += 1;
        } catch (e) {
          row.result = 'FAILED';
          row.error = e instanceof Error ? e.message : String(e);
        }
      }
    }

    const failed = rows.filter((r) => r.result === 'FAILED').length;
    const verb = ctx.dryRun ? 'akan diisi' : 'diisi';
    return {
      summary: `${before.toChange}/${before.products} produk: ${before.linesFilled} baris kartu ${verb} (nilai ${before.fillValue})`
        + `; nilai persediaan hargaBeli ${before.valueAtHargaBeli} → rata-rata ${before.valueAtAvg} (selisih ${before.valueDelta})`
        + (before.qtyDrift ? `; ${before.qtyDrift} produk replay qty ≠ saldo gudang` : '')
        + (before.unresolved ? `; ${before.unresolved} baris tanpa harga sama sekali` : '')
        + (failed ? `; ${failed} GAGAL` : ''),
      before,
      after: { rows: rows.filter((r) => r.result !== 'NOOP' || Math.abs(r.replayQty - r.ledgerQty) > 1e-4) },
      changed,
    };
  },
};
