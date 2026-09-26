import type { Migration } from '@/lib/migrations/types';
import { writeAuditLog } from '@/lib/api/audit-log';
import { runInTransactionOnDb } from '@/lib/api/transaction';
import { applyStockDustNormalize, planStockDust, type StockDustRow } from '@/lib/stock-ledger';

export const NORMALIZE_STOCK_DUST_ID = '0009-normalize-stock-dust';

function summarize(rows: StockDustRow[]) {
  const byTarget: Record<string, { dust: number; real: number }> = {};
  for (const r of rows) {
    const k = `${r.collection}.${r.field}`;
    byTarget[k] = byTarget[k] || { dust: 0, real: 0 };
    if (r.dust) byTarget[k].dust += 1; else byTarget[k].real += 1;
  }
  return { rows: rows.length, dust: rows.filter((r) => r.dust).length, real: rows.filter((r) => !r.dust).length, byTarget };
}

/**
 * Saldo lama (stok_lokasi, stok_bin, lot, products.stok) yang tersimpan dengan galat float (≤ 1e-6 dari
 * pembulatan 4 dp) dibulatkan; master dihitung ulang dari Σ stok_lokasi. Selisih di atas toleransi tidak
 * disentuh dan dilaporkan sebagai `real` (perlu penyesuaian/pembalik). Satu transaksi + audit. Idempoten.
 */
export const normalizeStockDustMigration: Migration = {
  id: NORMALIZE_STOCK_DUST_ID,
  description: 'Bulatkan float dust saldo stok lama (≤ 1e-6) ke 4 desimal dan hitung ulang stok master',
  async run(ctx) {
    const { db, tenantId } = ctx;
    const actor = ctx.actor || 'system';
    const rows = await planStockDust(db, tenantId);
    const before = { ...summarize(rows), sample: rows.slice(0, 200) };
    if (ctx.dryRun || !rows.some((r) => r.dust)) {
      return {
        summary: `${before.dust} saldo dust akan dibulatkan, ${before.real} selisih nyata dilaporkan`,
        before,
        after: null,
        changed: 0,
      };
    }
    const applied = await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const fresh = await planStockDust(txDb, tenantId, session);
      const result = await applyStockDustNormalize(txDb, session, tenantId, fresh);
      await writeAuditLog(txDb, {
        tenantId,
        action: 'STOCK_DUST_NORMALIZE',
        entityType: 'tenant',
        entityId: tenantId,
        summary: `Float dust saldo stok dibulatkan: ${result.normalized} baris, master diperbarui ${result.masterUpdated}`,
        metadata: { migration: NORMALIZE_STOCK_DUST_ID, ...result },
        userId: `migration:${actor}`,
        userName: `Migrasi (${actor})`,
      }, session);
      return result;
    });
    const remaining = await planStockDust(db, tenantId);
    return {
      summary: `${applied.normalized} saldo dust dibulatkan, master diperbarui ${applied.masterUpdated}, ${summarize(remaining).real} selisih nyata tersisa`,
      before,
      after: { ...applied, remaining: summarize(remaining), remainingSample: remaining.slice(0, 200) },
      changed: applied.normalized + applied.masterUpdated,
    };
  },
};
