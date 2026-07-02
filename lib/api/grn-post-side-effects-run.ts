/** Side-effects setelah GRN post — CPO sync + auto-complete WR. */

import type { Db } from 'mongodb';
import type { GrnDoc } from '@/types/documents';
import { syncCpoOnGrnPosted } from '@/lib/api/cpo-status-sync';
import { tryAutoCompleteWrFromGrn } from '@/lib/api/maintenance-wr-loop';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';

export async function runGrnPostSideEffects(db: Db, tenantId: string, grnId: string) {
  const grn = await db.collection('goods_receipts').findOne({ id: grnId }) as GrnDoc | null;
  if (!grn) return { error: 'GRN tidak ditemukan' };

  const cpoSync = await syncCpoOnGrnPosted(db, grn);
  const wrLoop = await tryAutoCompleteWrFromGrn(db, grn);
  await invalidateDashboardSnapshot(db, tenantId);

  return { grnId, cpoSync, wrLoop };
}
