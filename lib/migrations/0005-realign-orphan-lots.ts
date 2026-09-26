import type { Migration } from '@/lib/migrations/types';
import { writeAuditLog } from '@/lib/api/audit-log';
import { runInTransactionOnDb } from '@/lib/api/transaction';
import { applyLotRealign, planLotRealign, type LotRealignApplied, type LotRealignPlan } from '@/lib/stock-ledger';

export const REALIGN_ORPHAN_LOTS_ID = '0005-realign-orphan-lots';

export type LotRealignRow = LotRealignPlan & {
  result: 'WOULD_FIX' | 'FIXED' | 'FAILED';
  applied?: LotRealignApplied;
  error?: string;
};

function totals(plans: LotRealignPlan[]) {
  let consume = 0;
  let relocate = 0;
  for (const p of plans) for (const l of p.lines) { consume += l.consume; relocate += l.relocate; }
  return { products: plans.length, lines: plans.reduce((n, p) => n + p.lines.length, 0), consume, relocate };
}

/**
 * Σ sisa lot bahan per gudang disamakan dengan saldo gudang (stok_lokasi = kebenaran buku stok).
 * Lot yang tertinggal di gudang lama dipindah ke gudang home sebanyak kekurangan lot di sana, sisanya
 * dihabiskan FEFO. Satu transaksi + audit per produk. Idempoten: setelah apply rencana kosong.
 */
export const realignOrphanLotsMigration: Migration = {
  id: REALIGN_ORPHAN_LOTS_ID,
  description: 'Samakan sisa lot bahan dengan saldo gudang (pindah lot tertinggal ke gudang home, habiskan kelebihan FEFO)',
  async run(ctx) {
    const { db, tenantId } = ctx;
    const actor = ctx.actor || 'system';
    const auditActor = { userId: `migration:${actor}`, userName: `Migrasi (${actor})` };
    const noDokumen = `MIG-0005-${ctx.now.getTime()}`;

    const plans = await planLotRealign(db, tenantId);
    const rows: LotRealignRow[] = plans.map((p) => ({ ...p, result: 'WOULD_FIX' }));
    const before = totals(plans);

    let changed = 0;
    if (!ctx.dryRun) {
      for (const row of rows) {
        try {
          row.applied = await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
            const fresh = (await planLotRealign(txDb, tenantId, session)).find((p) => p.productId === row.productId);
            if (!fresh) return { consumed: 0, consumeShortfall: 0, relocated: 0, relocateShortfall: 0 };
            const applied = await applyLotRealign(txDb, session, tenantId, fresh, { now: ctx.now, noDokumen });
            await writeAuditLog(txDb, {
              tenantId,
              action: 'LOT_REALIGN',
              entityType: 'product',
              entityId: row.productId,
              summary: `${row.kode || row.productId}: lot disamakan dengan saldo gudang — pindah ${applied.relocated} ke ${fresh.homeGudang}, habiskan ${applied.consumed}`,
              metadata: { migration: REALIGN_ORPHAN_LOTS_ID, noDokumen, lines: fresh.lines, applied },
              ...auditActor,
            }, session);
            return applied;
          });
          row.result = 'FIXED';
          changed += 1;
        } catch (e) {
          row.result = 'FAILED';
          row.error = e instanceof Error ? e.message : String(e);
        }
      }
    }

    const remaining = ctx.dryRun ? plans : await planLotRealign(db, tenantId);
    const failed = rows.filter((r) => r.result === 'FAILED').length;
    const verb = ctx.dryRun ? 'akan disamakan' : 'disamakan';
    return {
      summary: `${before.products} produk lot > saldo gudang ${verb}: pindah ${before.relocate} ke gudang home, habiskan ${before.consume}`
        + (failed ? `; ${failed} GAGAL` : '')
        + (ctx.dryRun ? '' : `; sisa ${remaining.length} produk`),
      before,
      after: { rows, remaining: ctx.dryRun ? undefined : remaining },
      changed,
    };
  },
};
