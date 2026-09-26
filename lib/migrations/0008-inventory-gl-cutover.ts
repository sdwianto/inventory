import type { Migration } from '@/lib/migrations/types';
import { writeAuditLog } from '@/lib/api/audit-log';
import { runInTransactionOnDb } from '@/lib/api/transaction';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import { createJournalIfNotExists } from '@/lib/api/journal';
import {
  INVENTORY_CUTOVER_JOURNAL_SOURCE,
  buildInventoryCutoverJournalLines,
  inventoryGlBalance,
  unjournaledConsumptionValue,
} from '@/lib/api/stock-cost-journal';
import { valueInventoryAtAvg } from '@/lib/stock-ledger';

export const INVENTORY_GL_CUTOVER_ID = '0008-inventory-gl-cutover';

/**
 * Samakan saldo GL Persediaan dengan nilai buku stok (qty × avgCost) sekali saat pindah ke costingV2.
 * Nilai kartu RL / PBL yang belum pernah dijurnal dibebankan ke Beban Bahan Baku, sisa selisih ke
 * Penyesuaian Persediaan. Jalankan setelah 0007 diterapkan dan costingV2 menyala; sesudahnya setiap
 * mutasi stok menjurnal nilai kartunya sendiri.
 */
export const inventoryGlCutoverMigration: Migration = {
  id: INVENTORY_GL_CUTOVER_ID,
  description: 'Jurnal cutover: samakan saldo GL Persediaan dengan nilai buku stok rata-rata bergerak',
  async run(ctx) {
    const { db, tenantId } = ctx;
    const actor = ctx.actor || 'system';
    const costingV2 = await isTenantFeatureEnabled(db, tenantId, 'costingV2');
    const valuation = await valueInventoryAtAvg(db, tenantId);
    const glBalance = await inventoryGlBalance(db, tenantId);
    const consumption = await unjournaledConsumptionValue(db, tenantId);
    const stockValue = Math.round(valuation.value);
    const diff = stockValue - glBalance;
    const noDoc = `CUTOVER-${ctx.now.toISOString().slice(0, 10)}`;
    const lines = buildInventoryCutoverJournalLines({ noDoc, diff, consumption });
    const byBasis = { AVG: 0, HARGA_BELI: 0, NONE: 0 };
    for (const r of valuation.rows) byBasis[r.costBasis] += 1;
    const before = {
      costingV2,
      glBalance,
      stockValue,
      diff,
      unjournaledConsumption: consumption,
      journalPreview: lines.map((l) => ({ rekeningKode: l.rekeningKode, debet: l.debet, kredit: l.kredit })),
      products: valuation.rows.length,
      byBasis,
      missingCost: valuation.missingCost,
      memoSkipped: valuation.memoSkipped,
    };
    const rows = [...valuation.rows].sort((a, b) => b.value - a.value);
    const preview = lines.map((l) => `${l.debet ? 'Dr' : 'Cr'} ${l.rekeningKode} ${l.debet || l.kredit}`).join(', ');

    if (!lines.length) {
      return { summary: `GL Persediaan ${glBalance} = nilai stok ${stockValue}; tidak perlu jurnal`, before, after: { rows }, changed: 0 };
    }
    if (ctx.dryRun) {
      return {
        summary: `GL Persediaan ${glBalance} vs nilai stok ${stockValue}: akan jurnal ${preview}`
          + (costingV2 ? '' : ' (apply butuh costingV2 menyala)')
          + (valuation.missingCost ? `; ${valuation.missingCost} produk tanpa harga` : ''),
        before,
        after: { rows },
        changed: 0,
      };
    }
    if (!costingV2) throw new Error('costingV2 belum menyala untuk tenant ini — cutover GL tidak dijalankan');

    const sourceId = `${INVENTORY_GL_CUTOVER_ID}:${ctx.now.getTime()}`;
    const journal = await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const gl = await inventoryGlBalance(txDb, tenantId, session);
      const value = Math.round((await valueInventoryAtAvg(txDb, tenantId, session)).value);
      const used = await unjournaledConsumptionValue(txDb, tenantId, session);
      const details = buildInventoryCutoverJournalLines({ noDoc, diff: value - gl, consumption: used });
      if (!details.length) return null;
      const entry = await createJournalIfNotExists(txDb, {
        tanggal: ctx.now,
        keterangan: `Cutover nilai persediaan (GL ${gl} → buku stok ${value})`,
        sourceType: INVENTORY_CUTOVER_JOURNAL_SOURCE,
        sourceId,
        details,
        userName: `Migrasi (${actor})`,
        tenantId,
      }, session);
      await writeAuditLog(txDb, {
        tenantId,
        action: 'INVENTORY_GL_CUTOVER',
        entityType: 'jurnal',
        entityId: entry?.id || sourceId,
        summary: `Cutover GL Persediaan ${gl} → ${value}; pemakaian historis ${used}`,
        metadata: { migration: INVENTORY_GL_CUTOVER_ID, glBefore: gl, stockValue: value, consumption: used },
        userId: `migration:${actor}`,
        userName: `Migrasi (${actor})`,
      }, session);
      return entry;
    });

    return {
      summary: journal
        ? `Jurnal ${journal.noJurnal}: ${preview} (GL ${glBalance} → ${stockValue})`
        : 'Selisih hilang saat transaksi — tidak ada jurnal',
      before,
      after: { journalId: journal?.id || null, noJurnal: journal?.noJurnal || null, rows },
      changed: journal ? 1 : 0,
    };
  },
};
