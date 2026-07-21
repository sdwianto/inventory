/** Inventory business gauges for Prometheus scrape (GRN invoice sync wait). */

import type { Db } from 'mongodb';
import {
  grnInvoiceSyncPendingGauge,
  grnInvoiceSyncOldestAgeSeconds,
} from '@sdwianto/metrics';

export async function refreshGrnInvoiceSyncGauges(db: Db): Promise<void> {
  const rows = await db.collection('goods_receipts')
    .find({
      status: 'POSTED',
      invoiceSyncStatus: { $in: ['PENDING', 'SYNCING'] },
      $or: [
        { noInvoice: { $exists: false } },
        { noInvoice: null },
        { noInvoice: '' },
      ],
    })
    .project({ invoiceSyncAt: 1, postedAt: 1, updatedAt: 1 })
    .limit(500)
    .toArray();

  const now = Date.now();
  let oldestAge = 0;
  for (const row of rows) {
    const raw = row.invoiceSyncAt || row.postedAt || row.updatedAt;
    if (!raw) continue;
    const age = Math.max(0, Math.round((now - new Date(raw as Date).getTime()) / 1000));
    if (age > oldestAge) oldestAge = age;
  }

  grnInvoiceSyncPendingGauge.labels('inventory').set(rows.length);
  grnInvoiceSyncOldestAgeSeconds.labels('inventory').set(oldestAge);
}
