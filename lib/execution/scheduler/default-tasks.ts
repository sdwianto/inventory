/** Canonical scheduled tasks for Inventory VPS (EE-9E subset — wave 1 empty). */

import type { ScheduledTaskInput } from '@dawam/contracts';
import { JOB_TYPES } from '@/lib/api/bg-jobs';

/** Enabled when maintenance worker runs with SCHEDULER_ENABLED=1 (post wave-3). */
export const DEFAULT_INVENTORY_SCHEDULED_TASKS: ScheduledTaskInput[] = [
  {
    id: 'audit-purge:weekly',
    cronExpr: '0 3 * * 0',
    jobType: JOB_TYPES.AUDIT_LOG_PURGE,
    tenantId: 'system',
    payload: {},
    dedupeKey: 'audit-purge:weekly',
  },
  {
    id: 'integration-reconcile:daily',
    cronExpr: '0 2 * * *',
    jobType: JOB_TYPES.INTEGRATION_RECONCILE,
    tenantId: 'system',
    payload: { allTenants: true },
    dedupeKey: 'integration-reconcile:daily',
  },
];
