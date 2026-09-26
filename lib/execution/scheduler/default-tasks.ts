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
  ...([
    // Cron UTC: 18:30–19:10 UTC = 01:30–02:10 WIB, di luar jam operasional dapur.
    ['stock-recon:daily', '30 18 * * *', 'stock'],
    ['po-receipt-recon:daily', '40 18 * * *', 'po-receipt'],
    ['grni-recon:daily', '50 18 * * *', 'grni'],
    ['plan-issue-recon:daily', '0 19 * * *', 'plan-issue'],
    ['controls-recon:daily', '10 19 * * *', 'controls'],
  ] as const).map(([id, cronExpr, job]): ScheduledTaskInput => ({
    id,
    cronExpr,
    jobType: JOB_TYPES.INVENTORY_RECON,
    domain: 'inventory',
    tenantId: 'system',
    payload: { job, allTenants: true },
    dedupeKey: id,
  })),
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
