/** Canonical scheduled tasks for Inventory VPS (EE-9E subset — wave 1 empty). */

import type { ScheduledTaskInput } from '@sdwianto/contracts';
import { JOB_TYPES } from '@/lib/api/bg-jobs';

/** Enabled when maintenance worker runs with SCHEDULER_ENABLED=1 (post wave-3). */
export const DEFAULT_INVENTORY_SCHEDULED_TASKS: ScheduledTaskInput[] = [
  {
    id: 'audit-purge:weekly',
    cronExpr: '0 3 * * 0',
    jobType: JOB_TYPES.AUDIT_LOG_PURGE,
    domain: 'inventory',
    tenantId: 'system',
    payload: {},
    dedupeKey: 'audit-purge:weekly',
  },
  {
    id: 'integration-reconcile:daily',
    cronExpr: '0 2 * * *',
    jobType: JOB_TYPES.INTEGRATION_RECONCILE,
    domain: 'inventory',
    tenantId: 'system',
    payload: { allTenants: true },
    dedupeKey: 'integration-reconcile:daily',
  },
  /**
   * Permanent fix for "Menunggu faktur" stuck after Fase A (no Sales job poll):
   * every 2 minutes, sweep PENDING/SYNCING GRNs → pull-reconcile / preferSync notify.
   */
  {
    id: 'grn-invoice-sweep:2m',
    cronExpr: '*/2 * * * *',
    jobType: JOB_TYPES.INTEGRATION_RECONCILE,
    domain: 'inventory',
    tenantId: 'system',
    payload: { grnInvoiceSweepOnly: true, limit: 40 },
    dedupeKey: 'grn-invoice-sweep:2m',
  },
];
