// Fase 3.2 — pemusnahan lot ditolak QC yang tidak diretur (mis. vendor menolak retur / bahan busuk):
// stok keluar dari lot itu saja + jurnal kerugian persediaan + audit, satu transaksi.

import type { Db } from 'mongodb';
import { runInTransactionOnDb } from '@/lib/api/transaction';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { writeAuditLog } from '@/lib/api/audit-log';
import { createJournalIfNotExists } from '@/lib/api/journal';
import { buildPenyesuaianJournalLines } from '@/lib/api/journal-lines';
import { effectiveIngredientQtyRemaining } from '@/lib/food-production/ingredient-lot';
import { postStockMovements } from '@/lib/stock-ledger/post-stock-movements';
import { loadRejectedLotForFollowUp, markRejectedLotDisposed } from '@/lib/stock-ledger/lot-qc';
import type { StockActor } from '@/lib/stock-ledger/kartu';

export const QC_DISPOSAL_SOURCE = 'QC_DISPOSAL';

export type DisposeRejectedLotResult =
  | { ok: true; noDokumen: string; lotId: string; qty: number; amount: number }
  | { ok: false; error: string; status: number };

class DisposeAbort extends Error {
  constructor(readonly result: { error: string; status: number }) {
    super(result.error);
  }
}

export async function disposeRejectedLot(
  db: Db,
  input: { tenantId: string; lotId: string; reason: unknown; actor: StockActor & { userId: string } },
): Promise<DisposeRejectedLotResult> {
  const tid = input.tenantId || 'default';
  const reason = String(input.reason ?? '').trim().slice(0, 500);
  if (reason.length < 3) return { ok: false, error: 'Alasan pemusnahan wajib diisi', status: 400 };
  try {
    return await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const lot = await loadRejectedLotForFollowUp(txDb, tid, input.lotId, session);
      if ('error' in lot) throw new DisposeAbort(lot);
      const qty = effectiveIngredientQtyRemaining(lot);
      const noDokumen = await nextDocNumber(txDb, tid, 'QCD', 'QCD', session);
      const posted = await postStockMovements(txDb, session, {
        tenantId: tid,
        sourceType: QC_DISPOSAL_SOURCE,
        sourceId: lot.id,
        noTransaksi: noDokumen,
        keterangan: `Pemusnahan lot ditolak QC ${lot.lotNo}: ${reason}`,
        actor: input.actor,
        lines: [{
          lineRef: '1',
          productId: lot.productId,
          warehouseKode: lot.warehouseKode,
          deltaQtyBase: -qty,
          satuan: lot.satuan,
          lotPolicy: { mode: 'FEFO_CONSUME', preferredLotNo: lot.lotNo, qcHeld: 'PREFERRED', allowExpired: true },
        }],
      });
      if (!posted.ok) throw new DisposeAbort({ error: posted.error, status: 400 });
      const line = posted.lines[0];
      if (!line?.lot || line.lot.shortfall > 0) {
        throw new DisposeAbort({ error: 'Lot berubah bersamaan — muat ulang lalu ulangi pemusnahan', status: 409 });
      }
      const marked = await markRejectedLotDisposed(txDb, session, { tenantId: tid, lotId: lot.id, noDokumen, reason });
      if (!marked) throw new DisposeAbort({ error: 'Lot berubah bersamaan — muat ulang lalu ulangi pemusnahan', status: 409 });

      const amount = Math.round(qty * (line.unitCost || 0));
      const jLines = buildPenyesuaianJournalLines({ noDoc: `${noDokumen}/${lot.productKode || lot.productId}`, amount, increase: false });
      if (jLines.length) {
        await createJournalIfNotExists(txDb, {
          tanggal: new Date(),
          keterangan: `Pemusnahan lot ditolak QC ${lot.lotNo} (${noDokumen})`,
          sourceType: 'AUTO_QC_DISPOSAL',
          sourceId: lot.id,
          details: jLines,
          userName: input.actor.userName || '',
          tenantId: tid,
        }, session);
      }
      await writeAuditLog(txDb, {
        tenantId: tid,
        action: 'LOT_QC_DISPOSAL',
        entityType: 'ingredient_lot',
        entityId: lot.id,
        summary: `${noDokumen}: musnahkan lot ditolak ${lot.lotNo} ${lot.productNama || lot.productKode || ''} ${qty} ${lot.satuan || ''}`.trim(),
        userId: input.actor.userId,
        userName: input.actor.userName,
        metadata: { noDokumen, lotNo: lot.lotNo, qty, amount, reason, noInspeksi: lot.noInspeksi },
      }, session);
      return { ok: true as const, noDokumen, lotId: lot.id, qty, amount };
    });
  } catch (e) {
    if (e instanceof DisposeAbort) return { ok: false, ...e.result };
    throw e;
  }
}
