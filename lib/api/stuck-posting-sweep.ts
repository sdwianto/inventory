// Pulihkan GRN macet di status POSTING (proses mati di tengah claim non-TX).

import type { Db } from 'mongodb';

const STUCK_MS = 10 * 60 * 1000;
const SWEEP_LIMIT = 100;

export type StuckGrnPostingSweepResult = {
  grnReverted: number;
  scanned: number;
};

/** GRN stuck POSTING > 10 menit → kembali DRAFT. */
export async function sweepStuckGrnPosting(db: Db): Promise<StuckGrnPostingSweepResult> {
  const cutoff = new Date(Date.now() - STUCK_MS);
  const stuck = await db.collection('goods_receipts')
    .find({
      status: 'POSTING',
      $or: [
        { postingStartedAt: { $lt: cutoff } },
        { postingStartedAt: { $exists: false }, updatedAt: { $lt: cutoff } },
      ],
    })
    .project({ id: 1 })
    .limit(SWEEP_LIMIT)
    .toArray();

  let grnReverted = 0;
  for (const row of stuck) {
    const r = await db.collection('goods_receipts').updateOne(
      { id: row.id, status: 'POSTING' },
      {
        $set: { status: 'DRAFT', updatedAt: new Date() },
        $unset: { postingStartedAt: '' },
      },
    );
    if (r.modifiedCount > 0) grnReverted += 1;
  }
  return { grnReverted, scanned: stuck.length };
}
