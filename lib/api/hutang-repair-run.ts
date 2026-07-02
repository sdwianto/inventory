import type { Db } from 'mongodb';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import { repairStaleVendorHutangs } from '@/lib/api/hutang-reconcile';
import { enqueueJob, JOB_TYPES, scheduleJobProcessing } from '@/lib/api/bg-jobs';
import type { JsonObject } from '@/types/json';

const REPAIR_PAGE_SIZE = 500;

export async function runHutangRepairJob(db: Db, job: JsonObject & { tenantId?: string; payload?: JsonObject }) {
  const tid = normalizeTenantId(job.tenantId || 'default');
  const grnSkip = Math.max(0, parseInt(String(job.payload?.grnSkip || 0), 10) || 0);

  const result = await repairStaleVendorHutangs(db, tid, {
    grnSkip,
    grnLimit: REPAIR_PAGE_SIZE,
  });

  if (result.hasMore) {
    const nextSkip = grnSkip + result.processed;
    await enqueueJob(db, {
      type: JOB_TYPES.HUTANG_REPAIR,
      tenantId: tid,
      payload: {
        grnSkip: nextSkip,
        dedupeKey: `hutang-repair:${tid}:${nextSkip}`,
      },
    });
    scheduleJobProcessing(db, { limit: 2 });
  }

  return {
    tenantId: tid,
    grnSkip,
    ...result,
    chained: result.hasMore,
  };
}
