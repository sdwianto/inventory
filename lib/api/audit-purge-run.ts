/** Purge audit_log lebih dari ~7 tahun (P3 compliance retensi). */

import type { Db } from 'mongodb';
import { auditCompliancePurgeCutoff } from '@/lib/api/audit-log';

export async function runAuditLogPurgeJob(db: Db): Promise<Record<string, unknown>> {
  const cutoff = auditCompliancePurgeCutoff();
  const result = await db.collection('audit_log').deleteMany({
    createdAt: { $lt: cutoff },
  });
  return {
    purged: result.deletedCount || 0,
    cutoff: cutoff.toISOString(),
  };
}
