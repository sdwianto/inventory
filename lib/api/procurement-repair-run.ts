/** Perbaikan procurement — URL integrasi, job stuck/dead-letter (dipanggil API MASTER/ADMIN). */

import type { Db } from 'mongodb';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import {
  recoverStaleRunningJobs,
  requeueDeadLetterJobs,
  scheduleJobProcessing,
} from '@/lib/api/bg-jobs';
import { resolveEffectiveSalesAppUrl } from '@/lib/api/sales-app-url';
import { runIntegrationReconcile } from '@/lib/api/integration-reconcile-run';
import { backfillHutangVarianceFields } from '@/lib/api/hutang-variance-enrich';

export async function runProcurementRepair(db: Db, tenantId: string) {
  const tid = normalizeTenantId(tenantId);
  const salesUrl = resolveEffectiveSalesAppUrl('');

  const linkFilter = {
    customerTenantId: tid,
    salesAppUrl: { $regex: 'localhost|127\\.0\\.0\\.1', $options: 'i' },
  };
  const linkPatch = await db.collection('integration_links').updateMany(linkFilter, {
    $set: { salesAppUrl: salesUrl, updatedAt: new Date() },
  });

  const settingsPatch = await db.collection('integration_settings').updateMany(
    { tenantId: tid, salesAppUrl: { $regex: 'localhost|127\\.0\\.0\\.1', $options: 'i' } },
    { $set: { salesAppUrl: salesUrl, updatedAt: new Date() },
    },
  );

  const recovered = await recoverStaleRunningJobs(db);
  const requeued = await requeueDeadLetterJobs(db, { tenantId: tid });
  const variance = await backfillHutangVarianceFields(db, tid);
  const reconcile = await runIntegrationReconcile(db, tid);

  scheduleJobProcessing(db, { limit: 10 });

  return {
    salesUrl,
    integrationLinksPatched: linkPatch.modifiedCount,
    integrationSettingsPatched: settingsPatch.modifiedCount,
    recoveredStaleRunning: recovered,
    deadLetterRequeued: requeued,
    varianceUpdated: variance.updated,
    varianceScanned: variance.scanned,
    grnReconcileEnqueued: reconcile.autoFixEnqueued,
    grnStale: reconcile.grnInvoiceNotDone.length,
    cpoMismatch: reconcile.cpoStatusMismatch.length,
  };
}
